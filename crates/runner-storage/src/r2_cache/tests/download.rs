use std::{
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
    time::Duration,
};

use super::super::{
    R2DownloadError, R2Error,
    archive::{MAX_TEMPLATE_METADATA_BYTES, TEMPLATE_FILE},
    download::{file_staging_dir, finish_file_staging_error},
    io_other,
};
use super::fixtures::{
    archive_limits, archive_with_type, deterministic_bytes, empty_template_archive,
    get_object_body, get_object_body_for_key, get_object_body_then_error,
    get_object_body_with_content_length, mock_cache, nested_template_archive,
    production_template_archive, regular_template_archive, sparse_template_archive,
    sparse_template_archive_with_extensions, template_archive_with_extra,
    template_archive_with_trailing_decompressed_data, zstd_bytes,
};
use aws_sdk_s3::primitives::ByteStream;
use aws_smithy_mocks::mock;
use bytes::Bytes;
use http_body::{Body, Frame};
use tokio::sync::Notify;

const SMALL_TEMPLATE_BYTES: u64 = 5;
const BODY_CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct ControlledBodyState {
    released: AtomicBool,
    blocked: Notify,
    dropped: Notify,
    waker: Mutex<Option<Waker>>,
}

impl ControlledBodyState {
    fn release(&self) {
        self.released.store(true, Ordering::Release);
        let waker = self.waker.lock().unwrap().take();
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

struct ControlledBodyController {
    state: Arc<ControlledBodyState>,
}

impl ControlledBodyController {
    fn new() -> Self {
        Self {
            state: Arc::new(ControlledBodyState::default()),
        }
    }

    async fn wait_until_blocked(&self) {
        tokio::time::timeout(BODY_CONTROL_TIMEOUT, self.state.blocked.notified())
            .await
            .expect("timed out waiting for R2 body extraction to block");
    }

    async fn wait_until_dropped(&self) {
        tokio::time::timeout(BODY_CONTROL_TIMEOUT, self.state.dropped.notified())
            .await
            .expect("timed out waiting for detached R2 extraction to release its body");
    }

    fn release(&self) {
        self.state.release();
    }
}

impl Drop for ControlledBodyController {
    fn drop(&mut self) {
        self.state.release();
    }
}

struct ControlledBody {
    bytes: Option<Bytes>,
    state: Arc<ControlledBodyState>,
}

impl Body for ControlledBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        if let Some(bytes) = self.bytes.take() {
            return Poll::Ready(Some(Ok(Frame::data(bytes))));
        }

        // This post-frame poll proves that the real extraction worker consumed
        // the R2 archive frame. Hold EOF so its async waiter can be cancelled.
        self.state.blocked.notify_one();
        if self.state.released.load(Ordering::Acquire) {
            return Poll::Ready(None);
        }

        let mut waker = self.state.waker.lock().unwrap();
        *waker = Some(cx.waker().clone());
        if self.state.released.load(Ordering::Acquire) {
            waker.take();
            Poll::Ready(None)
        } else {
            Poll::Pending
        }
    }
}

impl Drop for ControlledBody {
    fn drop(&mut self) {
        self.state.dropped.notify_one();
    }
}

#[tokio::test]
async fn downloads_exact_regular_template_from_template_key() {
    let get = get_object_body_for_key(
        "test-bucket",
        "runner-templates/hash.tar.zst",
        regular_template_archive(b"hello"),
    );
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");

    let downloaded = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap();

    assert!(downloaded);
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
    assert!(!file_staging_dir(&destination).exists());
    assert_eq!(get.num_calls(), 1);
}

#[tokio::test]
async fn valid_template_replaces_existing_destination_only_after_validation() {
    let get = get_object_body(regular_template_archive(b"hello"));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");
    tokio::fs::write(&destination, b"old-rootfs").await.unwrap();

    cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap();

    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn production_writer_round_trips_incompressible_template_within_limit() {
    const TEMPLATE_BYTES: usize = 2 * 1024 * 1024;

    let source_dir = tempfile::tempdir().unwrap();
    let source = source_dir.path().join("arbitrary-source-name");
    let expected = deterministic_bytes(TEMPLATE_BYTES);
    tokio::fs::write(&source, &expected).await.unwrap();
    let archive = production_template_archive(&source).await;
    assert!(
        archive.len() as u64 <= archive_limits(TEMPLATE_BYTES as u64).max_compressed_bytes(),
        "controlled streaming writer must fit the downloader's compressed limit"
    );

    let get = get_object_body(archive);
    let cache = mock_cache("test-bucket", &[&get]);
    let destination_dir = tempfile::tempdir().unwrap();
    let destination = destination_dir.path().join("template.ext4");

    cache
        .try_download_template_to_file("hash", &destination, TEMPLATE_BYTES as u64)
        .await
        .unwrap();

    assert_eq!(tokio::fs::read(destination).await.unwrap(), expected);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn downloads_gnu_sparse_template_and_preserves_holes() {
    use std::os::unix::fs::MetadataExt;

    let (archive, expected) = sparse_template_archive();
    let get = get_object_body(archive);
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");

    cache
        .try_download_template_to_file("hash", &destination, expected.len() as u64)
        .await
        .unwrap();

    assert_eq!(tokio::fs::read(&destination).await.unwrap(), expected);
    let metadata = std::fs::metadata(&destination).unwrap();
    assert_eq!(metadata.len(), expected.len() as u64);
    assert!(
        metadata.blocks() * 512 < metadata.len(),
        "GNU sparse extraction must not materialize every hole"
    );
}

#[tokio::test]
async fn cache_miss_cleans_stale_staging_without_touching_destination() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectError;
    use aws_sdk_s3::types::error::NoSuchKey;

    let get = mock!(Client::get_object)
        .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing").await.unwrap();
    let staging = file_staging_dir(&destination);
    tokio::fs::create_dir_all(&staging).await.unwrap();
    tokio::fs::write(staging.join("partial"), b"residue")
        .await
        .unwrap();

    let downloaded = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap();

    assert!(!downloaded);
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"existing");
    assert!(!staging.exists());
}

#[tokio::test]
async fn cancelled_download_recovers_staging_on_next_cache_miss() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::{GetObjectError, GetObjectOutput};
    use aws_sdk_s3::types::error::NoSuchKey;

    let controller = ControlledBodyController::new();
    let body_state = Arc::clone(&controller.state);
    let archive = Bytes::from(regular_template_archive(b"hello"));
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing-rootfs")
        .await
        .unwrap();
    let staging = file_staging_dir(&destination);
    let staging_at_request = staging.clone();
    let get = mock!(Client::get_object)
        .match_requests(move |_| {
            assert!(
                !staging_at_request.exists(),
                "download must remove stale staging before its R2 request"
            );
            true
        })
        .sequence()
        .output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from_body_1_x(ControlledBody {
                    bytes: Some(archive.clone()),
                    state: Arc::clone(&body_state),
                }))
                .build()
        })
        .error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()))
        .build();
    let cache = mock_cache("test-bucket", &[&get]);

    let mut downloads = tokio::task::JoinSet::new();
    let cache_for_download = cache.clone();
    let destination_for_download = destination.clone();
    downloads.spawn(async move {
        cache_for_download
            .try_download_template_to_file("hash", &destination_for_download, SMALL_TEMPLATE_BYTES)
            .await
    });

    controller.wait_until_blocked().await;
    assert!(staging.is_dir());
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );

    downloads.abort_all();
    let cancelled = tokio::time::timeout(BODY_CONTROL_TIMEOUT, downloads.join_next())
        .await
        .expect("timed out joining cancelled R2 download")
        .expect("R2 download task disappeared")
        .expect_err("R2 download completed after its body blocked");
    assert!(
        cancelled.is_cancelled(),
        "unexpected join error: {cancelled}"
    );

    controller.release();
    controller.wait_until_dropped().await;
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );
    assert_eq!(
        tokio::fs::read(staging.join(TEMPLATE_FILE)).await.unwrap(),
        b"hello"
    );

    let mut residue = Vec::new();
    let mut entries = tokio::fs::read_dir(dst.path()).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        residue.push(entry.file_name());
    }
    residue.sort();
    let mut expected_residue = vec![
        destination.file_name().unwrap().to_os_string(),
        staging.file_name().unwrap().to_os_string(),
    ];
    expected_residue.sort();
    assert_eq!(residue, expected_residue);

    let downloaded = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap();

    assert!(!downloaded);
    assert_eq!(get.num_calls(), 2);
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );
    assert!(!staging.exists());
}

#[tokio::test]
async fn request_failure_remains_distinct_from_invalid_object() {
    use aws_sdk_s3::Client;

    let get = mock!(Client::get_object)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::Request(_)));
    assert!(!destination.exists());
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn body_read_failure_is_request_but_same_prefix_clean_eof_is_invalid() {
    const BODY_ERROR: &str = "injected R2 body transport failure";

    let archive = regular_template_archive(b"hello");
    let prefix = archive[..archive.len() / 2].to_vec();
    let get = get_object_body_then_error(prefix.clone(), BODY_ERROR);
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing-rootfs")
        .await
        .unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::Request(_)));
    assert!(error.to_string().contains(BODY_ERROR));
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );
    assert!(!file_staging_dir(&destination).exists());

    assert_invalid_preserves_destination(get_object_body(prefix), SMALL_TEMPLATE_BYTES).await;
}

#[tokio::test]
async fn oversized_declared_content_length_is_rejected_before_staging() {
    let limit = archive_limits(SMALL_TEMPLATE_BYTES).max_compressed_bytes();
    let get = get_object_body_with_content_length(
        regular_template_archive(b"hello"),
        Some(i64::try_from(limit + 1).unwrap()),
    );
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing").await.unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::InvalidObject(_)));
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"existing");
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn negative_declared_content_length_is_invalid() {
    let get = get_object_body_with_content_length(regular_template_archive(b"hello"), Some(-1));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::InvalidObject(_)));
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn trailing_actual_body_is_rejected_without_content_length() {
    let mut archive = regular_template_archive(b"hello");
    archive.extend_from_slice(&zstd_bytes(b"second zstd frame"));
    assert_invalid_preserves_destination(get_object_body(archive), SMALL_TEMPLATE_BYTES).await;
}

#[tokio::test]
async fn misleading_content_length_cannot_hide_trailing_actual_body() {
    let mut archive = regular_template_archive(b"hello");
    let declared = archive.len() as i64;
    archive.extend_from_slice(b"trailing bytes after zstd frame");
    assert_invalid_preserves_destination(
        get_object_body_with_content_length(archive, Some(declared)),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn actual_compressed_stream_limit_is_enforced_without_content_length() {
    let limit = archive_limits(0).max_compressed_bytes();
    let skippable_payload_bytes = u32::try_from(limit).unwrap();
    let mut archive = Vec::with_capacity(usize::try_from(limit + 8).unwrap());
    archive.extend_from_slice(&0x184d_2a50u32.to_le_bytes());
    archive.extend_from_slice(&skippable_payload_bytes.to_le_bytes());
    archive.resize(usize::try_from(limit + 8).unwrap(), 0);

    let get = get_object_body(archive);
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing-rootfs")
        .await
        .unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, 0)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::InvalidObject(_)));
    assert!(error.to_string().contains("compressed byte limit"));
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn trailing_decompressed_data_in_same_frame_is_rejected() {
    assert_invalid_preserves_destination(
        get_object_body(template_archive_with_trailing_decompressed_data(b"hello")),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn oversized_logical_template_is_rejected() {
    assert_invalid_preserves_destination(
        get_object_body(regular_template_archive(b"too-long")),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn undersized_logical_template_is_rejected() {
    assert_invalid_preserves_destination(
        get_object_body(regular_template_archive(b"tiny")),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn extra_member_is_rejected_without_publication() {
    assert_invalid_preserves_destination(
        get_object_body(template_archive_with_extra(b"hello")),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn nested_template_path_is_rejected() {
    assert_invalid_preserves_destination(
        get_object_body(nested_template_archive()),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn unsupported_member_and_extension_types_are_rejected() {
    for entry_type in [
        tar::EntryType::Link,
        tar::EntryType::Symlink,
        tar::EntryType::Char,
        tar::EntryType::Block,
        tar::EntryType::Directory,
        tar::EntryType::Fifo,
        tar::EntryType::Continuous,
        tar::EntryType::XGlobalHeader,
        tar::EntryType::XHeader,
        tar::EntryType::GNULongName,
        tar::EntryType::GNULongLink,
    ] {
        assert_invalid_preserves_destination(get_object_body(archive_with_type(entry_type)), 0)
            .await;
    }
}

#[tokio::test]
async fn empty_archive_is_rejected() {
    assert_invalid_preserves_destination(get_object_body(empty_template_archive()), 0).await;
}

#[tokio::test]
async fn corrupt_zstd_is_rejected_and_staging_is_removed() {
    assert_invalid_preserves_destination(
        get_object_body(b"not a valid zstd stream".to_vec()),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn excessive_sparse_metadata_is_rejected_within_budget() {
    // The initial header plus these extensions exceed the metadata budget
    // before payload extraction; the rest of the archive is complete and valid.
    let (archive, expected) =
        sparse_template_archive_with_extensions(MAX_TEMPLATE_METADATA_BYTES / 512);
    let error =
        assert_invalid_preserves_destination(get_object_body(archive), expected.len() as u64).await;

    assert!(
        error
            .to_string()
            .contains("template archive exceeds metadata byte limit"),
        "expected metadata budget rejection, got {error:?}"
    );
}

#[tokio::test]
async fn sparse_metadata_at_budget_is_accepted() {
    // Include the initial header and both trailer blocks in the 8 MiB budget.
    let (archive, expected) =
        sparse_template_archive_with_extensions(MAX_TEMPLATE_METADATA_BYTES / 512 - 3);
    let get = get_object_body(archive);
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join(TEMPLATE_FILE);

    let downloaded = cache
        .try_download_template_to_file("hash", &destination, expected.len() as u64)
        .await
        .unwrap();

    assert!(downloaded);
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), expected);
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn destination_failure_is_classified_as_local() {
    let get = get_object_body(regular_template_archive(b"hello"));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::create_dir_all(&destination).await.unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::Local(R2Error::Io(_))));
    assert!(destination.is_dir());
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn stale_staging_cleanup_failure_is_local() {
    let get = get_object_body(regular_template_archive(b"hello"));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    let staging = file_staging_dir(&destination);
    tokio::fs::write(&staging, b"not a directory")
        .await
        .unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::Local(R2Error::Io(_))));
    assert!(staging.exists());
}

#[tokio::test]
async fn cleanup_failure_does_not_mask_original_invalid_object() {
    let dst = tempfile::tempdir().unwrap();
    let staging = dst.path().join("template.ext4.download.tmp");
    tokio::fs::write(&staging, b"not a directory")
        .await
        .unwrap();

    let error = finish_file_staging_error(
        &staging,
        R2DownloadError::InvalidObject(R2Error::Io(io_other("bad archive"))),
    )
    .await;

    assert!(matches!(error, R2DownloadError::InvalidObject(_)));
    assert!(staging.exists());
}

async fn assert_invalid_preserves_destination(
    get: aws_smithy_mocks::Rule,
    expected_bytes: u64,
) -> R2DownloadError {
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing-rootfs")
        .await
        .unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, expected_bytes)
        .await
        .unwrap_err();

    assert!(
        matches!(error, R2DownloadError::InvalidObject(_)),
        "expected invalid cache object, got {error:?}"
    );
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );
    assert!(!file_staging_dir(&destination).exists());
    error
}
