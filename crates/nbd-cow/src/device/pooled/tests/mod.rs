use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use crate::{BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD, cow, cow_io, pool};
use tokio_util::sync::CancellationToken;

use super::*;

const TEST_DEVICE_INDEX: u32 = 1_000_000;
const TEST_COW_DATA: [u8; BLOCK_SIZE] = [0x5a; BLOCK_SIZE];

fn create_test_base_image(path: &Path) {
    let file = std::fs::File::create(path).expect("create base image");
    file.set_len(BLOCK_SIZE as u64).expect("size base image");
}

struct PooledDestroyHarness {
    _tmp: tempfile::TempDir,
    cow_file: PathBuf,
    bitmap_file: PathBuf,
    bitmap_tmp_path: PathBuf,
    pool: pool::DevicePoolHandle,
    device: PooledNbdCowDevice,
}

impl PooledDestroyHarness {
    fn new() -> Self {
        Self::with_cow_setup(|_| ()).0
    }

    fn with_cow_setup<T>(setup: impl FnOnce(&mut cow::CowLayer) -> T) -> (Self, T) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let base = tmp.path().join("base.img");
        let cow_file = tmp.path().join("cow.img");
        let bitmap_file = cow::bitmap_path_for(&cow_file);
        let bitmap_tmp_path = cow::bitmap_tmp_path_for(&bitmap_file);
        let lock_dir = tmp.path().join("locks");
        std::fs::create_dir(&lock_dir).expect("create lock dir");
        create_test_base_image(&base);
        std::fs::write(&cow_file, b"cow").expect("write cow file");

        let pool = pool::DevicePoolHandle::new(pool::DevicePoolConfig::default());
        let mut cow = cow::CowLayer::new(
            &base,
            &cow_file,
            BLOCK_SIZE as u64,
            BLOCK_SIZE,
            DEFAULT_FLUSH_THRESHOLD,
        )
        .expect("create cow layer");
        let setup_result = setup(&mut cow);
        let device = PooledNbdCowDevice {
            device: NbdCowDevice {
                device_index: TEST_DEVICE_INDEX,
                device_path: PathBuf::from(format!("/dev/nbd{TEST_DEVICE_INDEX}")),
                cow_file: cow_file.clone(),
                cow: cow_io::CowIo::new(cow),
                server_handles: Vec::new(),
                shutdown: CancellationToken::new(),
                disconnected: true,
                connection_id: uuid::Uuid::nil(),
            },
            lease: LeaseGuard::new(
                pool::DeviceLease::new_for_test(TEST_DEVICE_INDEX, &lock_dir),
                pool.clone(),
            ),
            pool: pool.clone(),
        };

        (
            Self {
                _tmp: tmp,
                cow_file,
                bitmap_file,
                bitmap_tmp_path,
                pool,
                device,
            },
            setup_result,
        )
    }

    fn write_bitmap_sidecar(&self) {
        std::fs::write(&self.bitmap_file, b"bitmap").expect("write bitmap file");
    }

    fn create_blocking_bitmap_tmp_dir(&self) {
        std::fs::create_dir(&self.bitmap_tmp_path).expect("create bitmap tmp dir");
    }

    fn with_transient_bitmap_failure() -> (Self, Arc<AtomicUsize>) {
        Self::with_cow_setup(|cow| {
            cow.write(0, &TEST_COW_DATA).expect("buffer COW data");
            cow.fail_first_bitmap_rename()
        })
    }

    fn replace_cow_file_with_directory(&self) {
        std::fs::remove_file(&self.cow_file).expect("remove cow file");
        std::fs::create_dir(&self.cow_file).expect("create cow directory");
    }
}

fn zero_attempt_destroy_policy() -> DestroyRetryPolicy {
    DestroyRetryPolicy {
        attempts: 0,
        delay: std::time::Duration::from_secs(60),
    }
}

#[tokio::test]
async fn destroy_with_retries_zero_attempts_runs_once_and_removes_files() {
    let harness = PooledDestroyHarness::new();
    harness.write_bitmap_sidecar();
    let PooledDestroyHarness {
        _tmp,
        cow_file,
        bitmap_file,
        pool,
        device,
        ..
    } = harness;

    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        device.destroy_with_retries(zero_attempt_destroy_policy()),
    )
    .await
    .expect("destroy should not sleep before first attempt")
    .expect("destroy");

    assert!(!cow_file.exists());
    assert!(!bitmap_file.exists());
    pool.cleanup().await;
}

#[tokio::test]
async fn destroy_with_retries_reports_cow_removal_failure() {
    let harness = PooledDestroyHarness::new();
    harness.replace_cow_file_with_directory();
    let PooledDestroyHarness {
        _tmp,
        cow_file,
        pool,
        device,
        ..
    } = harness;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        device.destroy_with_retries(zero_attempt_destroy_policy()),
    )
    .await
    .expect("destroy should not sleep before returning the first error");

    let err = result.expect_err("destroy should report cow removal failure");
    assert!(
        err.to_string().contains("failed to remove"),
        "unexpected error: {err}"
    );
    assert!(cow_file.is_dir());
    pool.cleanup().await;
}

#[tokio::test]
async fn detailed_destroy_reports_storage_failure_as_safe_to_delete() {
    let harness = PooledDestroyHarness::new();
    harness.replace_cow_file_with_directory();
    let PooledDestroyHarness { pool, device, .. } = harness;

    let err = device
        .destroy_with_retries_detailed(zero_attempt_destroy_policy())
        .await
        .expect_err("destroy should report cow removal failure");

    assert!(
        err.backing_files_safe_to_delete(),
        "storage cleanup errors must not be treated as NBD ownership failures"
    );
    pool.cleanup().await;
}

#[tokio::test]
async fn detailed_destroy_storage_failure_does_not_sleep_before_returning() {
    let harness = PooledDestroyHarness::new();
    harness.replace_cow_file_with_directory();
    let PooledDestroyHarness { pool, device, .. } = harness;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        device.destroy_with_retries_detailed(DestroyRetryPolicy {
            attempts: 2,
            delay: std::time::Duration::from_secs(60),
        }),
    )
    .await
    .expect("storage cleanup failures should not wait for device retry delay");

    let err = result.expect_err("destroy should report cow removal failure");
    assert!(err.backing_files_safe_to_delete());
    pool.cleanup().await;
}

#[tokio::test]
async fn destroy_keep_cow_zero_attempts_returns_preserved_paths() {
    let PooledDestroyHarness {
        _tmp,
        cow_file,
        bitmap_file,
        pool,
        device,
        ..
    } = PooledDestroyHarness::new();

    let kept = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        device.destroy_keep_cow_with_retries(zero_attempt_destroy_policy()),
    )
    .await
    .expect("destroy should not sleep before first attempt")
    .expect("destroy keep cow");

    assert_eq!(kept.cow_file, cow_file);
    assert_eq!(kept.bitmap_file, bitmap_file);
    assert!(kept.cow_file.exists());
    assert!(kept.bitmap_file.exists());
    pool.cleanup().await;
}

#[tokio::test]
async fn relocated_cow_path_controls_keep_cow_bitmap_persistence() {
    let PooledDestroyHarness {
        _tmp,
        cow_file,
        bitmap_file,
        pool,
        mut device,
        ..
    } = PooledDestroyHarness::new();
    let relocated_cow = cow_file.with_file_name("relocated-cow.img");
    let relocated_bitmap = cow::bitmap_path_for(&relocated_cow);
    std::fs::rename(&cow_file, &relocated_cow).expect("relocate cow file");

    device
        .relocate_cow_file_after_rename(relocated_cow.clone())
        .expect("record relocated COW path");
    let kept = device
        .destroy_keep_cow_with_retries(zero_attempt_destroy_policy())
        .await
        .expect("destroy keep relocated cow");

    assert_eq!(kept.cow_file, relocated_cow);
    assert_eq!(kept.bitmap_file, relocated_bitmap);
    assert!(kept.cow_file.exists());
    assert!(kept.bitmap_file.exists());
    assert!(!cow_file.exists());
    assert!(!bitmap_file.exists());
    pool.cleanup().await;
}

#[tokio::test]
async fn relocated_cow_path_controls_destroy_cleanup() {
    let PooledDestroyHarness {
        _tmp,
        cow_file,
        bitmap_file,
        pool,
        mut device,
        ..
    } = PooledDestroyHarness::new();
    let relocated_cow = cow_file.with_file_name("relocated-cow.img");
    let relocated_bitmap = cow::bitmap_path_for(&relocated_cow);
    std::fs::rename(&cow_file, &relocated_cow).expect("relocate cow file");
    std::fs::write(&relocated_bitmap, b"bitmap").expect("write relocated bitmap");

    device
        .relocate_cow_file_after_rename(relocated_cow.clone())
        .expect("record relocated COW path");
    device
        .destroy_with_retries(zero_attempt_destroy_policy())
        .await
        .expect("destroy relocated cow");

    assert!(!relocated_cow.exists());
    assert!(!relocated_bitmap.exists());
    assert!(!cow_file.exists());
    assert!(!bitmap_file.exists());
    pool.cleanup().await;
}

#[tokio::test]
async fn destroy_keep_cow_zero_attempts_returns_first_error_without_retry_sleep() {
    let harness = PooledDestroyHarness::new();
    harness.create_blocking_bitmap_tmp_dir();
    let PooledDestroyHarness {
        _tmp,
        cow_file,
        bitmap_file,
        pool,
        device,
        ..
    } = harness;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        device.destroy_keep_cow_with_retries(zero_attempt_destroy_policy()),
    )
    .await
    .expect("destroy should not sleep before returning the first error");

    assert!(result.is_err());
    assert!(cow_file.exists());
    assert!(!bitmap_file.exists());
    pool.cleanup().await;
}

#[tokio::test]
async fn destroy_keep_cow_exhausts_retries_and_returns_error() {
    let harness = PooledDestroyHarness::new();
    harness.create_blocking_bitmap_tmp_dir();
    let PooledDestroyHarness {
        _tmp,
        cow_file,
        bitmap_file,
        bitmap_tmp_path,
        pool,
        device,
    } = harness;

    let result = device
        .destroy_keep_cow_with_retries(DestroyRetryPolicy {
            attempts: 2,
            delay: std::time::Duration::ZERO,
        })
        .await;

    assert!(result.is_err());
    assert!(cow_file.exists());
    assert!(!bitmap_file.exists());
    assert!(bitmap_tmp_path.is_dir());
    pool.cleanup().await;
}

#[tokio::test]
async fn destroy_keep_cow_retries_after_first_error_and_returns_preserved_paths() {
    let (harness, rename_attempts) = PooledDestroyHarness::with_transient_bitmap_failure();
    let PooledDestroyHarness {
        _tmp: tmp,
        cow_file,
        bitmap_file,
        bitmap_tmp_path,
        pool,
        device,
    } = harness;

    // Bitmap persistence performs real fsyncs on the blocking pool. Await
    // finalization itself; disk and scheduler latency are not the retry contract.
    let result = device
        .destroy_keep_cow_with_retries(DestroyRetryPolicy {
            attempts: 2,
            delay: std::time::Duration::ZERO,
        })
        .await;
    pool.cleanup().await;
    let kept = result.expect("destroy keep cow should retry after the first rename failure");

    assert_eq!(rename_attempts.load(Ordering::Relaxed), 2);
    assert_eq!(kept.cow_file, cow_file);
    assert_eq!(kept.bitmap_file, bitmap_file);
    assert_eq!(std::fs::read(&kept.cow_file).unwrap(), TEST_COW_DATA);
    assert!(kept.bitmap_file.exists());
    assert!(!bitmap_tmp_path.exists());

    let restored = cow::CowLayer::new(
        &tmp.path().join("base.img"),
        &kept.cow_file,
        BLOCK_SIZE as u64,
        BLOCK_SIZE,
        DEFAULT_FLUSH_THRESHOLD,
    )
    .expect("restore the preserved COW and bitmap");
    let mut restored_data = [0; BLOCK_SIZE];
    restored.read(0, &mut restored_data).unwrap();
    assert_eq!(restored_data, TEST_COW_DATA);
}

#[tokio::test]
async fn destroy_keep_cow_single_attempt_returns_transient_bitmap_error() {
    let (harness, rename_attempts) = PooledDestroyHarness::with_transient_bitmap_failure();
    let PooledDestroyHarness {
        _tmp,
        cow_file,
        bitmap_file,
        bitmap_tmp_path,
        pool,
        device,
    } = harness;

    let result = device
        .destroy_keep_cow_with_retries(DestroyRetryPolicy {
            attempts: 1,
            delay: std::time::Duration::ZERO,
        })
        .await;
    pool.cleanup().await;
    let error = result.expect_err("one attempt cannot recover from the injected rename failure");
    let error::NbdCowError::Io(error) = error else {
        panic!("expected the original rename I/O error, got {error:?}");
    };

    assert_eq!(error.raw_os_error(), Some(libc::EIO));
    assert_eq!(rename_attempts.load(Ordering::Relaxed), 1);
    assert_eq!(std::fs::read(&cow_file).unwrap(), TEST_COW_DATA);
    assert!(!bitmap_file.exists());
    assert!(!bitmap_tmp_path.exists());
}
