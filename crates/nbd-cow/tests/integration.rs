#![cfg(test)]

//! Root-required NBD device integration tests for the nbd-cow crate.
//!
//! These tests are marked `#[ignore]` and require root privileges plus the
//! `nbd` kernel module.
//! Run with:
//!
//! ```sh
//! sudo modprobe nbd nbds_max=4096
//! cargo test \
//!   --config 'target."cfg(target_os = \"linux\")".runner = "sudo"' \
//!   -p nbd-cow --test integration -- --ignored --test-threads=1
//! ```

use std::fs;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::process::Command;
use std::time::Duration;

use nix::sys::socket::{Shutdown, shutdown as shutdown_socket};
use tokio::io::AsyncReadExt;

mod nbd_fixture;

use nbd_fixture::{NbdTestFixture, default_device_pool};

#[derive(Default)]
struct RecordingCreateObserver {
    stages: Vec<(nbd_cow::NbdCowCreateStage, Duration, bool)>,
    netlink_connect_stages: Vec<(nbd_cow::NbdNetlinkConnectStage, Duration, bool)>,
    outcomes: Vec<nbd_cow::NbdCowCreateOutcome>,
}

impl nbd_cow::NbdCowCreateObserver for RecordingCreateObserver {
    fn record_stage(
        &mut self,
        stage: nbd_cow::NbdCowCreateStage,
        duration: Duration,
        success: bool,
    ) {
        self.stages.push((stage, duration, success));
    }

    fn record_netlink_connect_stage(
        &mut self,
        stage: nbd_cow::NbdNetlinkConnectStage,
        duration: Duration,
        success: bool,
    ) {
        self.netlink_connect_stages.push((stage, duration, success));
    }

    fn record_outcome(&mut self, outcome: nbd_cow::NbdCowCreateOutcome) {
        self.outcomes.push(outcome);
    }
}

impl RecordingCreateObserver {
    fn stage_duration(&self, expected: nbd_cow::NbdCowCreateStage) -> Duration {
        let matches: Vec<_> = self
            .stages
            .iter()
            .filter(|(stage, _, _)| *stage == expected)
            .collect();
        assert_eq!(matches.len(), 1, "stage {expected:?}: {:?}", self.stages);
        let (_, duration, success) = matches[0];
        assert!(*success, "stage {expected:?} should succeed");
        *duration
    }

    fn netlink_connect_stage_duration(
        &self,
        expected: nbd_cow::NbdNetlinkConnectStage,
    ) -> Duration {
        let matches: Vec<_> = self
            .netlink_connect_stages
            .iter()
            .filter(|(stage, _, _)| *stage == expected)
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "netlink connect stage {expected:?}: {:?}",
            self.netlink_connect_stages,
        );
        let (_, duration, success) = matches[0];
        assert!(
            *success,
            "netlink connect stage {expected:?} should succeed"
        );
        *duration
    }
}

fn nbd_test_available() -> bool {
    if !nix::unistd::getuid().is_root() {
        eprintln!("skipping: requires root");
        return false;
    }

    let modules = std::fs::read_to_string("/proc/modules").unwrap_or_default();
    if !modules.lines().any(|l| l.starts_with("nbd ")) {
        eprintln!("skipping: nbd kernel module not loaded");
        return false;
    }

    true
}

fn destroy_policy() -> nbd_cow::DestroyRetryPolicy {
    nbd_cow::DestroyRetryPolicy {
        attempts: 1,
        delay: Duration::ZERO,
    }
}

fn keep_cow_policy() -> nbd_cow::DestroyRetryPolicy {
    destroy_policy()
}

fn claim_free_device_for_direct_connect() -> nbd_cow::device_lock::NbdDeviceClaim {
    for index in 0..nbd_cow::netlink::nbds_max() {
        if !nbd_cow::netlink::device_appears_free(index) {
            continue;
        }

        match nbd_cow::device_lock::try_acquire_device_claim(index) {
            Ok(Some(claim)) if nbd_cow::netlink::device_appears_free(index) => return claim,
            Ok(Some(_)) | Ok(None) => {}
            Err(e) => eprintln!("skipping nbd{index}: failed to acquire device lock: {e}"),
        }
    }

    panic!("no free NBD device");
}

fn nbd_pid(device_index: u32) -> Option<u32> {
    let pid_path = format!("/sys/block/nbd{device_index}/pid");
    std::fs::read_to_string(pid_path)
        .ok()
        .and_then(|contents| contents.trim().parse().ok())
}

fn nbd_backend(device_index: u32) -> Option<String> {
    let backend_path = format!("/sys/block/nbd{device_index}/backend");
    std::fs::read_to_string(backend_path)
        .ok()
        .map(|contents| contents.trim().to_owned())
}

// ---------------------------------------------------------------------------
// Full device lifecycle tests (require root + nbd module)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn create_and_destroy() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");

    let pool = default_device_pool();
    let mut observer = RecordingCreateObserver::default();
    let device = pool
        .create_cow_device_with_observer(fixture.base(), &cow, fixture.size(), &mut observer)
        .await
        .expect("create");

    for stage in [
        nbd_cow::NbdCowCreateStage::CowLayerCreate,
        nbd_cow::NbdCowCreateStage::DeviceAcquire,
        nbd_cow::NbdCowCreateStage::DeviceScan,
        nbd_cow::NbdCowCreateStage::DispatchSetup,
        nbd_cow::NbdCowCreateStage::NetlinkConnect,
        nbd_cow::NbdCowCreateStage::SizeVerify,
    ] {
        observer.stage_duration(stage);
    }
    assert!(
        observer.stage_duration(nbd_cow::NbdCowCreateStage::DeviceScan)
            <= observer.stage_duration(nbd_cow::NbdCowCreateStage::DeviceAcquire),
        "device scan is nested inside device acquire: {:?}",
        observer.stages,
    );
    let netlink_child_duration: Duration = nbd_cow::NbdNetlinkConnectStage::ALL
        .into_iter()
        .map(|stage| observer.netlink_connect_stage_duration(stage))
        .sum();
    assert!(
        netlink_child_duration
            <= observer.stage_duration(nbd_cow::NbdCowCreateStage::NetlinkConnect),
        "netlink connect children are nested inside their parent: {:?}",
        observer.netlink_connect_stages,
    );
    assert!(
        observer
            .outcomes
            .contains(&nbd_cow::NbdCowCreateOutcome::AcquireSourceDemandScan)
    );
    assert!(
        observer
            .outcomes
            .contains(&nbd_cow::NbdCowCreateOutcome::EbusyRetriesNone)
    );
    assert_eq!(
        observer
            .outcomes
            .iter()
            .filter(|outcome| {
                matches!(
                    outcome,
                    nbd_cow::NbdCowCreateOutcome::EbusyRetriesNone
                        | nbd_cow::NbdCowCreateOutcome::EbusyRetriesOne
                        | nbd_cow::NbdCowCreateOutcome::EbusyRetriesMultiple
                )
            })
            .count(),
        1,
        "expected one EBUSY retry bucket: {:?}",
        observer.outcomes,
    );
    assert!(
        observer
            .outcomes
            .contains(&nbd_cow::NbdCowCreateOutcome::SizeZeroRetriesNone)
    );
    assert_eq!(
        observer
            .outcomes
            .iter()
            .filter(|outcome| {
                matches!(
                    outcome,
                    nbd_cow::NbdCowCreateOutcome::SizeZeroRetriesNone
                        | nbd_cow::NbdCowCreateOutcome::SizeZeroRetriesOne
                        | nbd_cow::NbdCowCreateOutcome::SizeZeroRetriesMultiple
                )
            })
            .count(),
        1,
        "expected one size-zero retry bucket: {:?}",
        observer.outcomes,
    );

    let dev_path = device.device_path().to_owned();
    assert!(dev_path.exists(), "device should exist: {dev_path:?}");
    assert!(
        dev_path.to_string_lossy().contains("/dev/nbd"),
        "path should be /dev/nbdN"
    );

    device
        .destroy_with_retries(destroy_policy())
        .await
        .expect("destroy");
    // After destroy, the COW file should be removed
    assert!(!cow.exists(), "COW file should be removed after destroy");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn destroy_keep_cow_preserves_file() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");

    let pool = default_device_pool();
    let device = pool
        .create_cow_device(fixture.base(), &cow, fixture.size())
        .await
        .expect("create");

    // Write a small amount so the COW file is actually created on disk
    let dev_path = device.device_path().to_owned();
    let status = Command::new("dd")
        .args([
            "if=/dev/urandom",
            &format!("of={}", dev_path.to_string_lossy()),
            "bs=4096",
            "count=1",
            "conv=notrunc",
        ])
        .status()
        .expect("dd write");
    assert!(status.success(), "dd write should succeed");

    // Sync to flush the write buffer to the COW file
    let status = Command::new("sync").status().expect("sync");
    assert!(status.success());
    device
        .destroy_keep_cow_with_retries(keep_cow_policy())
        .await
        .expect("destroy_keep_cow");
    assert!(cow.exists(), "COW file should be preserved");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn connected_device_survives_cow_path_relocation() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let source_cow = fixture.cow_path("pool-slot/cow.img");
    let target_cow = fixture.cow_path("sandbox/cow.img");
    fs::create_dir_all(source_cow.parent().expect("source parent")).expect("create source parent");
    fs::create_dir_all(target_cow.parent().expect("target parent")).expect("create target parent");
    fs::File::create(&source_cow)
        .expect("create source COW file")
        .set_len(fixture.size())
        .expect("size source COW file");

    let pool = default_device_pool();
    let mut device = pool
        .create_cow_device(fixture.base(), &source_cow, fixture.size())
        .await
        .expect("create");
    let dev_path = device.device_path().to_owned();

    fs::rename(&source_cow, &target_cow).expect("relocate connected COW file");
    device
        .relocate_cow_file_after_rename(target_cow.clone())
        .expect("record relocated COW path");

    let marker = "NBD_COW_RELOCATED";
    let write = Command::new("bash")
        .args([
            "-c",
            &format!(
                "echo -n '{}' | dd of={} bs=1 count={} conv=notrunc",
                marker,
                dev_path.to_string_lossy(),
                marker.len()
            ),
        ])
        .status()
        .expect("write relocated COW");
    assert!(
        write.success(),
        "write through relocated device should succeed"
    );

    let read = Command::new("dd")
        .args([
            &format!("if={}", dev_path.to_string_lossy()),
            "bs=1",
            &format!("count={}", marker.len()),
        ])
        .output()
        .expect("read relocated COW");
    assert!(
        read.status.success(),
        "read through relocated device should succeed"
    );
    assert_eq!(String::from_utf8_lossy(&read.stdout), marker);

    let kept = device
        .destroy_keep_cow_with_retries(keep_cow_policy())
        .await
        .expect("destroy relocated COW");
    assert_eq!(kept.cow_file, target_cow);
    assert!(kept.cow_file.exists());
    assert!(kept.bitmap_file.exists());
    assert!(!source_cow.exists());
    pool.cleanup().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn write_and_read_back_via_block_device() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");

    let pool = default_device_pool();
    let device = pool
        .create_cow_device(fixture.base(), &cow, fixture.size())
        .await
        .expect("create");
    let dev_path = device.device_path().to_owned();

    // Write a marker via dd
    let marker = "NBD_COW_TEST_MARKER_12345678";
    let status = Command::new("dd")
        .args([
            "if=/dev/zero",
            &format!("of={}", dev_path.to_string_lossy()),
            "bs=4096",
            "count=1",
            "conv=notrunc",
        ])
        .status()
        .expect("dd zero");
    assert!(status.success());

    let status = Command::new("bash")
        .args([
            "-c",
            &format!(
                "echo -n '{}' | dd of={} bs=1 count={} conv=notrunc",
                marker,
                dev_path.to_string_lossy(),
                marker.len()
            ),
        ])
        .status()
        .expect("dd marker");
    assert!(status.success());

    // Read back
    let output = Command::new("dd")
        .args([
            &format!("if={}", dev_path.to_string_lossy()),
            "bs=1",
            &format!("count={}", marker.len()),
        ])
        .output()
        .expect("dd read");
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        marker,
        "marker should survive write/read"
    );

    device
        .destroy_with_retries(destroy_policy())
        .await
        .expect("destroy");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn cow_file_is_sparse() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");

    let pool = default_device_pool();
    let device = pool
        .create_cow_device(fixture.base(), &cow, fixture.size())
        .await
        .expect("create");

    // Write a small amount (16KB)
    let dev_path = device.device_path().to_owned();
    let status = Command::new("dd")
        .args([
            "if=/dev/urandom",
            &format!("of={}", dev_path.to_string_lossy()),
            "bs=4096",
            "count=4",
            "conv=notrunc",
        ])
        .status()
        .expect("dd");
    assert!(status.success());

    // Flush to disk
    let status = Command::new("sync").status().expect("sync");
    assert!(status.success());

    device
        .destroy_keep_cow_with_retries(keep_cow_policy())
        .await
        .expect("destroy");

    // Check COW file is sparse — actual disk usage should be much less than 64MB
    let meta = fs::metadata(&cow).expect("metadata");
    let actual_bytes = meta.blocks() * 512;
    assert!(
        actual_bytes < 1024 * 1024,
        "COW file disk usage ({actual_bytes} bytes) should be < 1 MiB for 16KB write"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn device_path_format() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");

    let pool = default_device_pool();
    let device = pool
        .create_cow_device(fixture.base(), &cow, fixture.size())
        .await
        .expect("create");

    let path_str = device.device_path().to_string_lossy();
    assert!(
        path_str.starts_with("/dev/nbd"),
        "device path should start with /dev/nbd, got: {path_str}"
    );

    device
        .destroy_with_retries(destroy_policy())
        .await
        .expect("destroy");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn multiple_devices_from_same_base() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow1 = fixture.cow_path("cow1.img");
    let cow2 = fixture.cow_path("cow2.img");

    let pool = default_device_pool();
    let dev1 = pool
        .create_cow_device(fixture.base(), &cow1, fixture.size())
        .await
        .expect("create 1");
    let dev2 = pool
        .create_cow_device(fixture.base(), &cow2, fixture.size())
        .await
        .expect("create 2");

    assert_ne!(dev1.device_path(), dev2.device_path());
    assert!(dev1.device_path().exists());
    assert!(dev2.device_path().exists());

    dev1.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy 1");
    dev2.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy 2");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn snapshot_restore_round_trip() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");

    let marker = b"NBD_SNAPSHOT_RESTORE_TEST_1234";

    let pool = default_device_pool();

    // Phase 1: create device, write data, destroy_keep_cow
    {
        let device = pool
            .create_cow_device(fixture.base(), &cow, fixture.size())
            .await
            .expect("create");

        let dev_path = device.device_path().to_owned();

        // Write a full 4K block with the marker at the start (block-aligned I/O)
        let mut write_buf = vec![0u8; 4096];
        write_buf[..marker.len()].copy_from_slice(marker);

        let status = Command::new("dd")
            .args([
                "if=/dev/stdin",
                &format!("of={}", dev_path.to_string_lossy()),
                "bs=4096",
                "count=1",
                "conv=notrunc",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(&write_buf).unwrap();
                child.wait()
            })
            .expect("dd write");
        assert!(status.success(), "dd write should succeed");

        // Sync to flush to COW file
        let status = Command::new("sync").status().expect("sync");
        assert!(status.success());
        device.log_status().await;
        device
            .destroy_keep_cow_with_retries(keep_cow_policy())
            .await
            .expect("destroy_keep_cow");
    }

    // Verify COW file and bitmap exist
    assert!(cow.exists(), "COW file should be preserved");
    let mut bitmap_name = cow.as_os_str().to_os_string();
    bitmap_name.push(".bitmap");
    let bitmap = std::path::PathBuf::from(bitmap_name);
    assert!(bitmap.exists(), "bitmap file should be created");

    // Verify COW file has data (direct file read, independent of NBD)
    {
        use std::os::unix::fs::FileExt;
        let cow_fd = fs::File::open(&cow).expect("open COW file for verification");
        let mut verify_buf = vec![0u8; marker.len()];
        cow_fd
            .read_at(&mut verify_buf, 0)
            .expect("read COW file at offset 0");
        assert_eq!(
            &verify_buf, marker,
            "COW file should contain marker data at offset 0"
        );
    }

    // Phase 2: create new device with same base + COW — data should persist
    {
        let device = pool
            .create_cow_device(fixture.base(), &cow, fixture.size())
            .await
            .expect("restore create");

        let dev_path = device.device_path().to_owned();
        device.log_status().await;

        // Read first 4K block from the device
        let output = Command::new("dd")
            .args([
                &format!("if={}", dev_path.to_string_lossy()),
                "bs=4096",
                "count=1",
            ])
            .output()
            .expect("dd read");
        assert!(
            output.status.success(),
            "dd read failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stdout.len() >= marker.len(),
            "dd read returned {} bytes, expected at least {}",
            output.stdout.len(),
            marker.len()
        );
        assert_eq!(
            output.stdout.get(..marker.len()),
            Some(marker.as_slice()),
            "marker should survive snapshot restore"
        );

        device
            .destroy_with_retries(destroy_policy())
            .await
            .expect("destroy");
    }

    // After destroy, COW and bitmap should both be cleaned up
    assert!(!cow.exists(), "COW file should be removed after destroy");
    assert!(
        !bitmap.exists(),
        "bitmap file should be removed after destroy"
    );
}

// ---------------------------------------------------------------------------
// DevicePool-specific tests (require root + nbd module)
// ---------------------------------------------------------------------------

/// Verify a specifically connected device remains readable after one connection is lost.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn connect_device_survives_connection_loss() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");
    let size = fixture.size();

    let claim = claim_free_device_for_direct_connect();
    let device_index = claim.index();

    let mut client_fds = Vec::new();
    let mut server_handles = Vec::new();
    let shutdown = tokio_util::sync::CancellationToken::new();

    let cow_layer = nbd_cow::cow::CowLayer::new(
        fixture.base(),
        &cow,
        size,
        nbd_cow::BLOCK_SIZE,
        nbd_cow::DEFAULT_FLUSH_THRESHOLD,
    )
    .expect("cow layer");
    let cow = nbd_cow::cow_io::CowIo::new(cow_layer);

    let mut setup_result = Ok::<(), nbd_cow::error::NbdCowError>(());
    for _ in 0..nbd_cow::NUM_CONNECTIONS {
        let (client_fd, server_fd) = match nbd_cow::netlink::create_socketpair() {
            Ok(fds) => fds,
            Err(e) => {
                setup_result = Err(e);
                break;
            }
        };
        client_fds.push(client_fd);
        let cow = cow.clone();
        let token = shutdown.clone();
        server_handles.push(tokio::spawn(async move {
            let _ = nbd_cow::server::dispatch(server_fd, cow, token).await;
        }));
    }

    let connect_tid = unsafe { libc::gettid() } as u32;
    let connect_attempted = setup_result.is_ok();
    let connect_result = setup_result.and_then(|()| {
        nbd_cow::netlink::connect_device(
            device_index,
            &client_fds,
            size,
            nbd_cow::BLOCK_SIZE as u64,
        )
    });
    let connected = connect_result.is_ok();
    let device_has_correct_size = if connected {
        nbd_cow::netlink::verify_device_size(device_index, size).await
    } else {
        false
    };

    let opened_device = if connected {
        // Opening the block device completes the kernel's deferred partition
        // scan while every connection is healthy. Otherwise the injected loss
        // can strand an already in-flight scan request on the removed socket.
        Some(tokio::fs::File::open(format!("/dev/nbd{device_index}")).await)
    } else {
        None
    };

    let connection_shutdown_result = if connected {
        // Closing only the userspace server races with the kernel noticing EOF.
        // Shut down the socket retained after connect so I/O assigned to this
        // NBD queue fails and is requeued immediately.
        Some(shutdown_socket(client_fds[0].as_raw_fd(), Shutdown::Both))
    } else {
        None
    };

    let read_after_connection_loss = if connected {
        let lost_server = server_handles.remove(0);
        lost_server.abort();
        let _ = lost_server.await;

        let device = opened_device.expect("connected device should have an open attempt");
        Some(
            tokio::time::timeout(Duration::from_secs(5), async move {
                let mut device = device?;
                let mut block = vec![1_u8; nbd_cow::BLOCK_SIZE];
                device.read_exact(&mut block).await?;
                Ok::<_, std::io::Error>(block)
            })
            .await,
        )
    } else {
        None
    };

    // Clean up
    shutdown.cancel();
    for h in server_handles {
        h.abort();
        let _ = h.await;
    }
    drop(client_fds);
    if connected || (connect_attempted && nbd_pid(device_index) == Some(connect_tid)) {
        let _ = nbd_cow::netlink::disconnect(device_index);
    }

    connect_result.expect("socketpair setup or connect_device");
    assert!(device_has_correct_size, "device should have correct size");
    connection_shutdown_result
        .expect("connected device should lose a connection")
        .expect("lost client connection should shut down");
    let block = read_after_connection_loss
        .expect("connected device should be read")
        .expect("read after connection loss should not time out")
        .expect("read after connection loss should succeed");
    assert_eq!(
        block,
        vec![0_u8; nbd_cow::BLOCK_SIZE],
        "read after connection loss should return base image data"
    );
}

/// After destroy + release, the pool should not hand back the same device
/// index immediately (cooldown must expire first).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn pool_cooldown_prevents_immediate_reuse() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();

    // Use a long cooldown so the released device can't be reused
    let pool = nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig {
        cooldown: std::time::Duration::from_secs(60),
    });

    let cow1 = fixture.cow_path("cow1.img");
    let dev1 = pool
        .create_cow_device(fixture.base(), &cow1, fixture.size())
        .await
        .expect("create 1");
    let idx1 = dev1.device_index();

    dev1.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy 1");

    // Immediately create another device — should get a DIFFERENT index
    // because idx1 is still in cooldown (60s)
    let cow2 = fixture.cow_path("cow2.img");
    let dev2 = pool
        .create_cow_device(fixture.base(), &cow2, fixture.size())
        .await
        .expect("create 2");
    let idx2 = dev2.device_index();

    assert_ne!(
        idx1, idx2,
        "pool should not reuse device {idx1} during cooldown"
    );

    dev2.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy 2");
    pool.cleanup().await;
}

/// After cooldown expires, the pool should release the device claim.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn pool_releases_claim_after_cooldown() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();

    // Very short cooldown so we can test claim release
    let pool = nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig {
        cooldown: std::time::Duration::from_millis(50),
    });

    let cow = fixture.cow_path("cow.img");
    let dev = pool
        .create_cow_device(fixture.base(), &cow, fixture.size())
        .await
        .expect("create");
    let device_index = dev.device_index();

    dev.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy");

    let claim_released = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match nbd_cow::device_lock::try_acquire_device_claim(device_index) {
                Ok(Some(claim)) => {
                    drop(claim);
                    return Ok(());
                }
                Ok(None) => tokio::time::sleep(Duration::from_millis(10)).await,
                Err(e) => return Err(e),
            }
        }
    })
    .await;

    pool.cleanup().await;
    claim_released
        .expect("timed out waiting for device claim release")
        .expect("probe device claim release");
}

/// Dropping an NbdCowDevice without calling destroy() should still
/// disconnect the kernel device (best-effort cleanup via Drop).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn drop_without_destroy_disconnects() {
    if !nbd_test_available() {
        return;
    }

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");

    let pool = default_device_pool();
    let device = pool
        .create_cow_device(fixture.base(), &cow, fixture.size())
        .await
        .expect("create");

    let device_index = device.device_index();

    // Drop without calling destroy — Drop impl should disconnect.
    // Drop aborts dispatch tasks (which hold server-side socket fds)
    // and then calls netlink::disconnect synchronously. However, the
    // aborted tasks' fds are only closed when tokio processes the abort,
    // and the kernel won't fully release the device until all fds close.
    // Yield to let the runtime process the aborts before dropping.
    drop(device);
    tokio::task::yield_now().await;

    // Poll sysfs until the kernel marks the device as free.
    let mut freed = false;
    for i in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if nbd_cow::netlink::device_appears_free(device_index) {
            freed = true;
            eprintln!(
                "device nbd{device_index} freed after {:.1}s",
                (i + 1) as f64 * 0.1
            );
            break;
        }
    }
    if !freed {
        // Diagnostic: print what the pid file shows
        let pid_path = format!("/sys/block/nbd{device_index}/pid");
        let pid_content =
            std::fs::read_to_string(&pid_path).unwrap_or_else(|e| format!("err: {e}"));
        panic!(
            "device nbd{device_index} should be free after drop (waited 5s), pid file: {pid_content}"
        );
    }

    pool.cleanup().await;
}

/// A stale device object must not disconnect a replacement connection even
/// when Tokio reuses the same blocking worker TID for both connects.
#[test]
#[ignore]
fn stale_cleanup_rejects_recycled_tid_with_different_backend_identity() {
    if !nbd_test_available() {
        return;
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .expect("build single-blocking-thread runtime");

    runtime.block_on(async {
        let fixture = NbdTestFixture::new();
        let original_cow = fixture.cow_path("original-cow.img");
        let replacement_cow = fixture.cow_path("replacement-cow.img");
        let pool = default_device_pool();
        let original = pool
            .create_cow_device(fixture.base(), &original_cow, fixture.size())
            .await
            .expect("create original device");
        let device_index = original.device_index();
        let original_tid = nbd_pid(device_index).expect("original sysfs pid");
        let original_backend = nbd_backend(device_index).expect("original sysfs backend");

        nbd_cow::netlink::disconnect(device_index).expect("externally disconnect original");
        tokio::time::timeout(Duration::from_secs(5), async {
            while !nbd_cow::netlink::device_appears_free(device_index) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("original device should be released");

        let replacement_layer = nbd_cow::cow::CowLayer::new(
            fixture.base(),
            &replacement_cow,
            fixture.size(),
            nbd_cow::BLOCK_SIZE,
            nbd_cow::DEFAULT_FLUSH_THRESHOLD,
        )
        .expect("replacement COW layer");
        let replacement_io = nbd_cow::cow_io::CowIo::new(replacement_layer);
        let replacement_shutdown = tokio_util::sync::CancellationToken::new();
        let mut client_fds = Vec::with_capacity(nbd_cow::NUM_CONNECTIONS);
        let mut replacement_servers = Vec::with_capacity(nbd_cow::NUM_CONNECTIONS);
        for _ in 0..nbd_cow::NUM_CONNECTIONS {
            let (client_fd, server_fd) =
                nbd_cow::netlink::create_socketpair().expect("replacement socketpair");
            client_fds.push(client_fd);
            let server_io = replacement_io.clone();
            let server_shutdown = replacement_shutdown.clone();
            replacement_servers.push(tokio::spawn(async move {
                let _ = nbd_cow::server::dispatch(server_fd, server_io, server_shutdown).await;
            }));
        }
        let size = fixture.size();
        let replacement_connect_tid = tokio::task::spawn_blocking(move || {
            let tid = unsafe { libc::gettid() } as u32;
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let result = loop {
                match nbd_cow::netlink::connect_device(
                    device_index,
                    &client_fds,
                    size,
                    nbd_cow::BLOCK_SIZE as u64,
                ) {
                    Err(nbd_cow::error::NbdCowError::NetlinkErrno { errno, .. })
                        if errno == libc::EBUSY && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    result => break result,
                }
            };
            (tid, result)
        })
        .await
        .expect("replacement connect task");
        replacement_connect_tid
            .1
            .expect("connect replacement device");
        let replacement_tid = nbd_pid(device_index).expect("replacement sysfs pid");
        let replacement_backend = nbd_backend(device_index).expect("replacement sysfs backend");
        let replacement_size_matches =
            nbd_cow::netlink::verify_device_size(device_index, fixture.size()).await;

        let stale_cleanup_result = original.destroy_with_retries(destroy_policy()).await;
        let backend_after_stale_cleanup = nbd_backend(device_index);
        let pid_after_stale_cleanup = nbd_pid(device_index);
        // Keep block-device I/O off the single Tokio blocking worker reserved
        // above for deterministic connect TID reuse. NBD request handling also
        // needs that worker, so using tokio::fs here would deadlock the test.
        let (replacement_read_sender, replacement_read_receiver) = tokio::sync::oneshot::channel();
        let replacement_read_thread = std::thread::spawn(move || {
            let result = (|| {
                let mut device = std::fs::File::open(format!("/dev/nbd{device_index}"))?;
                let mut block = vec![1_u8; nbd_cow::BLOCK_SIZE];
                std::io::Read::read_exact(&mut device, &mut block)?;
                Ok::<_, std::io::Error>(block)
            })();
            let _ = replacement_read_sender.send(result);
        });
        let replacement_read =
            tokio::time::timeout(Duration::from_secs(5), replacement_read_receiver).await;

        let replacement_disconnect_result = nbd_cow::netlink::disconnect(device_index);
        replacement_shutdown.cancel();
        for server in replacement_servers {
            server.abort();
            let _ = server.await;
        }
        pool.cleanup().await;
        replacement_read_thread
            .join()
            .expect("replacement read thread");

        assert_eq!(original_tid, replacement_connect_tid.0);
        assert_eq!(replacement_tid, replacement_connect_tid.0);
        assert_ne!(original_backend, replacement_backend);
        assert!(replacement_size_matches);
        stale_cleanup_result.expect("stale device cleanup");
        assert_eq!(
            backend_after_stale_cleanup.as_deref(),
            Some(replacement_backend.as_str())
        );
        assert_eq!(pid_after_stale_cleanup, Some(replacement_tid));
        assert_eq!(
            replacement_read
                .expect("replacement read should not time out")
                .expect("replacement read thread should report its result")
                .expect("replacement read should succeed"),
            vec![0_u8; nbd_cow::BLOCK_SIZE]
        );
        replacement_disconnect_result.expect("disconnect replacement device");
    });
}
