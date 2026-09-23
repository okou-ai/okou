use std::{
    error::Error as _,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, OnceLock},
    task::{Context, Poll},
};

use aws_sdk_s3::error::SdkError;
use tokio::io::{AsyncRead, ReadBuf};

use super::{
    R2DownloadError, R2Error, R2ImageCache,
    archive::{
        TEMPLATE_FILE, TemplateArchiveLimits, TemplateUnpackError, unpack_template_into_staging,
    },
    io_other,
    keys::key_for_template_hash,
};

impl R2ImageCache {
    /// Download one bounded `runner-templates/{hash}.tar.zst` object and
    /// publish its exact-size `template.ext4` member at `destination`.
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
        let staging = file_staging_dir(destination);
        // Clean stale residue from a previously crashed download even if this
        // attempt later turns into a cache miss or request error. Successful
        // downloads also recreate this directory from scratch below.
        remove_dir_all_if_exists(&staging)
            .await
            .map_err(R2DownloadError::Local)?;
        let limits =
            TemplateArchiveLimits::new(expected_template_bytes).map_err(R2DownloadError::Local)?;

        let resp = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
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

        let (body_reader, body_read_failure) = TrackedBodyReader::new(resp.body.into_async_read());

        if let Err(e) = tokio::fs::create_dir_all(&staging).await {
            return Err(finish_file_staging_error(
                &staging,
                R2DownloadError::Local(R2Error::Io(e)),
            )
            .await);
        }

        if let Err(error) =
            unpack_template_into_staging(body_reader, &staging, expected_template_bytes, limits)
                .await
        {
            let error = match body_read_failure.request_error(key) {
                Some(error) => error,
                None => match error {
                    TemplateUnpackError::Invalid(error) => R2DownloadError::InvalidObject(error),
                    TemplateUnpackError::Local(error) => R2DownloadError::Local(error),
                },
            };
            return Err(finish_file_staging_error(&staging, error).await);
        }

        let unpacked_template = staging.join(TEMPLATE_FILE);
        match tokio::fs::symlink_metadata(&unpacked_template).await {
            Ok(metadata)
                if metadata.file_type().is_file() && metadata.len() == expected_template_bytes => {}
            Ok(metadata) if metadata.file_type().is_file() => {
                return Err(finish_file_staging_error(
                    &staging,
                    R2DownloadError::InvalidObject(R2Error::Io(io_other(format!(
                        "template archive materialized {} bytes, expected {expected_template_bytes}",
                        metadata.len()
                    )))),
                )
                .await);
            }
            Ok(_) => {
                return Err(finish_file_staging_error(
                    &staging,
                    R2DownloadError::InvalidObject(R2Error::Io(io_other(
                        "template archive template.ext4 is not a regular file",
                    ))),
                )
                .await);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(finish_file_staging_error(
                    &staging,
                    R2DownloadError::InvalidObject(R2Error::Io(io_other(
                        "template archive missing template.ext4",
                    ))),
                )
                .await);
            }
            Err(e) => {
                return Err(finish_file_staging_error(
                    &staging,
                    R2DownloadError::Local(R2Error::Io(e)),
                )
                .await);
            }
        }

        if let Err(e) = tokio::fs::rename(&unpacked_template, destination).await {
            return Err(finish_file_staging_error(
                &staging,
                R2DownloadError::Local(R2Error::Io(e)),
            )
            .await);
        }
        remove_dir_all_if_exists(&staging)
            .await
            .map_err(R2DownloadError::Local)?;

        Ok(true)
    }
}

#[derive(Clone, Default)]
struct BodyReadFailure {
    diagnostic: Arc<OnceLock<String>>,
}

impl BodyReadFailure {
    fn record(&self, error: &io::Error) {
        self.diagnostic.get_or_init(|| error_diagnostic(error));
    }

    fn request_error(&self, key: &str) -> Option<R2DownloadError> {
        self.diagnostic.get().map(|diagnostic| {
            R2DownloadError::Request(R2Error::S3(format!(
                "get_object {key} body read: {diagnostic}"
            )))
        })
    }
}

struct TrackedBodyReader<R> {
    inner: R,
    failure: BodyReadFailure,
}

impl<R> TrackedBodyReader<R> {
    fn new(inner: R) -> (Self, BodyReadFailure) {
        let failure = BodyReadFailure::default();
        (
            Self {
                inner,
                failure: failure.clone(),
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
        match Pin::new(&mut self.inner).poll_read(cx, buffer) {
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

pub(super) async fn finish_file_staging_error(
    staging: &Path,
    original: R2DownloadError,
) -> R2DownloadError {
    match remove_dir_all_if_exists(staging).await {
        Ok(()) => original,
        Err(cleanup_err) => {
            tracing::warn!(
                "failed to remove download staging {} after an earlier error ({original}): {cleanup_err}",
                staging.display()
            );
            original
        }
    }
}
