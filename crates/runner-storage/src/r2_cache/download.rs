use std::{
    error::Error as _,
    future::Future as _,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, OnceLock},
    task::{Context, Poll},
    time::Duration,
};

use aws_sdk_s3::error::SdkError;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::time::{Instant, Sleep};

use super::{
    R2DownloadError, R2Error, R2ImageCache,
    archive::{
        TEMPLATE_FILE, TemplateArchiveLimits, TemplateUnpackError, unpack_template_into_staging,
    },
    io_other,
    keys::key_for_template_hash,
};

// Leave time for verification/customization before CI's 600-second SSH budget.
// The same deadline covers SDK retries, response headers and streamed body reads.
pub(super) const TEMPLATE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(8 * 60);
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_secs(30);

impl R2ImageCache {
    /// Download one bounded `runner-templates/{hash}.tar.zst` object and
    /// publish its exact-size `template.ext4` member at `destination`.
    /// Request retries and body reads share an eight-minute deadline. The
    /// extractor finishes before timeout cleanup; existing destinations survive.
    pub async fn try_download_template_to_file(
        &self,
        hash: &str,
        destination: &Path,
        expected_template_bytes: u64,
    ) -> Result<bool, R2DownloadError> {
        let key = key_for_template_hash(hash);
        self.try_download_template_file_by_key(&key, destination, expected_template_bytes)
            .await
    }

    async fn try_download_template_file_by_key(
        &self,
        key: &str,
        destination: &Path,
        expected_template_bytes: u64,
    ) -> Result<bool, R2DownloadError> {
        let started = Instant::now();
        let deadline = started + TEMPLATE_TRANSFER_TIMEOUT;
        let staging = file_staging_dir(destination);
        // Clean stale residue from a previously crashed download even if this
        // attempt later turns into a cache miss or request error. Successful
        // downloads also recreate this directory from scratch below.
        remove_dir_all_if_exists(&staging)
            .await
            .map_err(R2DownloadError::Local)?;
        let limits =
            TemplateArchiveLimits::new(expected_template_bytes).map_err(R2DownloadError::Local)?;

        tracing::info!(r2_key = key, "starting template download");
        let response = tokio::time::timeout_at(
            deadline,
            self.client
                .get_object()
                .bucket(&self.bucket)
                .key(key)
                .send(),
        )
        .await
        .map_err(|_| R2DownloadError::DeadlineExceeded { key: key.into() })?;
        let resp = match response {
            Ok(r) => r,
            Err(SdkError::ServiceError(e))
                if matches!(
                    e.err(),
                    aws_sdk_s3::operation::get_object::GetObjectError::NoSuchKey(_)
                ) =>
            {
                return Ok(false);
            }
            Err(e) => {
                return Err(R2DownloadError::Request(R2Error::S3(format!(
                    "get_object {key}: {e:?}"
                ))));
            }
        };

        if let Some(content_length) = resp.content_length() {
            let content_length = u64::try_from(content_length).map_err(|_| {
                R2DownloadError::InvalidObject(R2Error::Io(io_other(format!(
                    "get_object {key} returned negative content length {content_length}"
                ))))
            })?;
            if content_length > limits.max_compressed_bytes() {
                return Err(R2DownloadError::InvalidObject(R2Error::Io(io_other(
                    format!(
                        "get_object {key} content length {content_length} exceeds template archive limit {}",
                        limits.max_compressed_bytes()
                    ),
                ))));
            }
        }

        let Some(parent) = destination.parent() else {
            return Err(R2DownloadError::Local(R2Error::Io(io_other(format!(
                "destination has no parent: {}",
                destination.display()
            )))));
        };
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| R2DownloadError::Local(R2Error::Io(e)))?;

        tracing::info!(
            r2_key = key,
            content_length = resp.content_length(),
            "template response received; extracting archive"
        );
        let (body_reader, body_read_failure) =
            TrackedBodyReader::new(resp.body.into_async_read(), key, started, deadline);

        let attempt: Result<(), R2DownloadError> = async {
            tokio::fs::create_dir_all(&staging)
                .await
                .map_err(|e| R2DownloadError::Local(R2Error::Io(e)))?;

            unpack_template_into_staging(body_reader, &staging, expected_template_bytes, limits)
                .await
                .map_err(|error| match body_read_failure.request_error(key) {
                    Some(error) => error,
                    None => match error {
                        TemplateUnpackError::Invalid(error) => R2DownloadError::InvalidObject(error),
                        TemplateUnpackError::Local(error) => R2DownloadError::Local(error),
                    },
                })?;

            let unpacked_template = staging.join(TEMPLATE_FILE);
            match tokio::fs::symlink_metadata(&unpacked_template).await {
                Ok(metadata)
                    if metadata.file_type().is_file()
                        && metadata.len() == expected_template_bytes => {}
                Ok(metadata) if metadata.file_type().is_file() => {
                    return Err(R2DownloadError::InvalidObject(R2Error::Io(io_other(format!(
                        "template archive materialized {} bytes, expected {expected_template_bytes}",
                        metadata.len()
                    )))));
                }
                Ok(_) => {
                    return Err(R2DownloadError::InvalidObject(R2Error::Io(io_other(
                        "template archive template.ext4 is not a regular file",
                    ))));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(R2DownloadError::InvalidObject(R2Error::Io(io_other(
                        "template archive missing template.ext4",
                    ))));
                }
                Err(e) => return Err(R2DownloadError::Local(R2Error::Io(e))),
            }

            tokio::fs::rename(&unpacked_template, destination)
                .await
                .map_err(|e| R2DownloadError::Local(R2Error::Io(e)))?;
            Ok(())
        }
        .await;

        if let Err(original) = attempt {
            if let Err(cleanup_err) = remove_dir_all_if_exists(&staging).await {
                tracing::warn!(
                    "failed to remove download staging {} after an earlier error ({original}): {cleanup_err}",
                    staging.display()
                );
            }
            return Err(original);
        }
        remove_dir_all_if_exists(&staging)
            .await
            .map_err(R2DownloadError::Local)?;

        tracing::info!(
            r2_key = key,
            elapsed_seconds = started.elapsed().as_secs(),
            "template transfer complete"
        );
        Ok(true)
    }
}

#[derive(Clone, Default)]
struct BodyReadFailure {
    diagnostic: Arc<OnceLock<BodyReadError>>,
}

enum BodyReadError {
    Request(String),
    DeadlineExceeded,
}

impl BodyReadFailure {
    fn record(&self, error: &io::Error) {
        self.diagnostic
            .get_or_init(|| BodyReadError::Request(error_diagnostic(error)));
    }

    fn record_deadline_exceeded(&self) {
        self.diagnostic
            .get_or_init(|| BodyReadError::DeadlineExceeded);
    }

    fn request_error(&self, key: &str) -> Option<R2DownloadError> {
        self.diagnostic.get().map(|diagnostic| match diagnostic {
            BodyReadError::DeadlineExceeded => {
                R2DownloadError::DeadlineExceeded { key: key.into() }
            }
            BodyReadError::Request(diagnostic) => R2DownloadError::Request(R2Error::S3(format!(
                "get_object {key} body read: {diagnostic}"
            ))),
        })
    }
}

struct TrackedBodyReader<R> {
    inner: R,
    failure: BodyReadFailure,
    deadline: Pin<Box<Sleep>>,
    key: String,
    started: Instant,
    last_progress: Instant,
    bytes_read: u64,
}

impl<R> TrackedBodyReader<R> {
    fn new(inner: R, key: &str, started: Instant, deadline: Instant) -> (Self, BodyReadFailure) {
        let failure = BodyReadFailure::default();
        (
            Self {
                inner,
                failure: failure.clone(),
                deadline: Box::pin(tokio::time::sleep_until(deadline)),
                key: key.into(),
                started,
                last_progress: started,
                bytes_read: 0,
            },
            failure,
        )
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for TrackedBodyReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        // Expiry is polled by the blocking extractor's actual async reader. The
        // extractor receives an error and exits before its caller cleans staging;
        // dropping a timeout-wrapped spawn_blocking future would not stop it.
        if self.deadline.as_mut().poll(cx).is_ready() {
            self.failure.record_deadline_exceeded();
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "template transfer deadline exceeded",
            )));
        }
        let before = buffer.filled().len();
        match Pin::new(&mut self.inner).poll_read(cx, buffer) {
            Poll::Ready(Ok(())) => {
                self.bytes_read += (buffer.filled().len() - before) as u64;
                let now = Instant::now();
                if now.duration_since(self.last_progress) >= TRANSFER_PROGRESS_INTERVAL {
                    tracing::info!(
                        r2_key = self.key,
                        bytes_read = self.bytes_read,
                        elapsed_seconds = now.duration_since(self.started).as_secs(),
                        "template download progress"
                    );
                    self.last_progress = now;
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => {
                self.failure.record(&error);
                Poll::Ready(Err(error))
            }
            result => result,
        }
    }
}

fn error_diagnostic(error: &io::Error) -> String {
    let mut diagnostic = error.to_string();
    let mut source = error.source();
    while let Some(error) = source {
        diagnostic.push_str(": ");
        diagnostic.push_str(&error.to_string());
        source = error.source();
    }
    diagnostic
}

pub(super) fn file_staging_dir(destination: &Path) -> PathBuf {
    let mut name = destination
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".download.tmp");
    destination.with_file_name(name)
}

async fn remove_dir_all_if_exists(path: &Path) -> Result<(), R2Error> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(R2Error::Io(e)),
    }
}
