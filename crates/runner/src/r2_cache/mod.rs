//! R2 cache for `runner build` template artifacts.
//!
//! The current shared cache stores reusable template objects at
//! `runner-templates/{template_hash}.tar.zst` in the existing
//! `R2_USER_STORAGES_BUCKET_NAME` bucket. Rootfs images are customized locally
//! because they contain guest binaries and host-local CA material.
//! Snapshot files are always created locally because they contain host-specific
//! state (page cache, kernel metadata).
//!
//! ## Lifecycle
//!
//! 1. `runner build` computes a `template_hash` for the shared R2 object and
//!    a separate `rootfs_hash` for local images.
//! 2. `--warm-rootfs-cache` ensures the template R2 object exists. Existing
//!    objects are checked with HEAD only; normal builds still validate the
//!    archive before using it.
//! 3. Normal builds materialize the template object into a per-attempt local
//!    file (or build/upload it on miss), move the verified template into
//!    `rootfs.ext4.staging`, customize the staging image locally, verify it,
//!    and then atomically commit the rootfs.
//!
//! Atomicity guarantees:
//! - Multipart upload is atomic from consumer POV (object only appears after
//!   `CompleteMultipartUpload`); abandoned segments are auto-cleaned by R2's
//!   default 7-day lifecycle.
//! - Template download unpacks into a sibling staging directory and only renames
//!   `template.ext4` into the caller's destination after the archive is fully
//!   decoded and validated.
//!
//! Configuration semantics: `from_env` returns `Ok(None)` only when **all four**
//! `R2_*` env vars are unset or empty (dev/test path). Setting 1-3 of 4 is a
//! fatal `PartialConfig` error — almost certainly a typo'd secret rotation, and
//! silently disabling cache fleet-wide is worse than failing the deploy.
//!
//! Streaming: upload avoids temp files by using a `tokio::io::duplex` pipe to
//! couple the sync tar+zstd producer (on a blocking thread) to the async
//! multipart consumer. Download streams the S3 body through `SyncIoBridge` into
//! a sibling staging directory and validates the complete body before renaming
//! the extracted `template.ext4` to the caller's destination. `Content-Length`
//! is only an early rejection hint; byte limits are enforced on the stream.
//! Callers that coordinate shared output paths should pass an attempt-scoped
//! destination and perform their own final publish step.
//! Memory peak per upload ≈ `(2 + CONCURRENCY + 1) × PART_SIZE` — duplex buffer,
//! in-flight upload chunks, and the part being read — bounded regardless of
//! image size. Currently ~112 MiB with `PART_SIZE` = 16 MiB and `CONCURRENCY` = 4.
//!
//! Image size limit: `PART_SIZE * 10000 ≈ 160 GiB` (S3 multipart hard limit).
//! Current images are well under 30 GiB; revisit if `PART_SIZE` decreases.
//!
//! ## R2 object lifecycle
//!
//! Completed template objects are retained and expired by the bucket's
//! externally managed lifecycle rule for the `runner-templates/` prefix. The
//! configured retention window is 7 days. `runner gc` only cleans host-local
//! state and never lists or deletes R2 objects.
//!
//! Lifecycle expiration is asynchronous, so objects can remain visible after
//! their expiration date. A missing object is a normal cache miss: normal builds
//! rebuild and upload the template, while cache warming recreates it before the
//! staged build. Cleanup of incomplete multipart uploads is governed by a
//! separate bucket lifecycle setting.
//!
//! ## Cancellation safety
//!
//! All operations in this module are safe to cancel (drop the future) at any
//! await point — no permanent state is left in an inconsistent way:
//!
//! - **Local staging directory**: a hard-killed template download may leave a
//!   `*.download.tmp/` directory beside the destination. The next download
//!   removes it as the first action, so the leak is bounded to one stale dir
//!   per destination and self-heals on next attempt.
//! - **R2 multipart upload session**: once `create_multipart_upload` returns,
//!   an owned guard aborts the upload on normal errors and schedules a
//!   best-effort abort if the upload future is cancelled before disarm.
//! - **`spawn_blocking` pack / unpack tasks**: tokio cannot cancel blocking
//!   tasks. After parent cancellation, the task runs until BrokenPipe, natural
//!   EOF, or a compressed/decompressed/metadata limit. Detached extraction is
//!   therefore still resource-bounded.
//!
//! ## Corrupt-object eviction
//!
//! An invalid archive (for example, one written through compromised R2
//! credentials) would otherwise dead-lock the fleet's cache for that hash:
//! every host downloads, rejects, rebuilds locally, then dedup-skips upload
//! because the bad object already exists.
//!
//! `cmd::build::run_build` defends by passing `force = true` to upload
//! whenever template download classifies an object as invalid. That bypasses the
//! dedup check and atomically overwrites the bad object via multipart complete.
//!
//! ## Template archive contract
//!
//! A cache object is one zstd frame containing exactly one top-level
//! `template.ext4` tar member and the standard two-block tar trailer. The member
//! may be regular or old-GNU sparse: the uploader keeps tar's sparse detection
//! enabled because `build-template.sh` creates the ext4 image with `truncate`.
//! Its declared and materialized logical size must equal `rootfs_disk_mb`.
//! PAX/long-name indirection, nested or extra members, continuous files, links,
//! devices, and trailing compressed or decompressed data are invalid.
//!
//! The extractor independently enforces:
//!
//! - a 128 MiB zstd decoder-window ceiling, pinned explicitly rather than
//!   inherited from the dependency default;
//! - an 8 MiB cumulative metadata budget while tar locates the member, parses
//!   GNU sparse extension headers, and validates the trailer;
//! - a decompressed ceiling derived from the expected logical size, metadata,
//!   tar padding, and trailer; and
//! - a compressed ceiling derived from zstd's compression bound plus a separate
//!   8 MiB streaming-encoder allowance.
//!
//! The metadata phase starts before `entries.next()`, because tar 0.4 parses all
//! GNU sparse extension headers and grows its sparse block list before returning
//! the entry. Sparse payload extraction remains streaming and preserves holes.

use aws_sdk_s3::error::SdkError;

mod archive;
mod config;
mod download;
mod keys;
mod multipart;
mod upload;

runner_test_group!(storage; #[cfg(test)]
mod tests;);

#[derive(Debug, thiserror::Error)]
pub enum R2Error {
    #[error("R2 partially configured ({}/4 set), missing: {}", present.len(), missing.join(", "))]
    PartialConfig {
        present: Vec<String>,
        missing: Vec<String>,
    },
    #[error("s3: {0}")]
    S3(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum R2DownloadError {
    #[error("request failed: {0}")]
    Request(#[source] R2Error),
    #[error("invalid cache object: {0}")]
    InvalidObject(#[source] R2Error),
    #[error("local filesystem failed: {0}")]
    Local(#[source] R2Error),
}

impl R2DownloadError {
    pub fn is_invalid_object(&self) -> bool {
        matches!(self, Self::InvalidObject(_))
    }
}

impl<E, R> From<SdkError<E, R>> for R2Error
where
    E: std::fmt::Debug,
    R: std::fmt::Debug,
{
    fn from(e: SdkError<E, R>) -> Self {
        Self::S3(format!("{e:?}"))
    }
}

/// Cache handle. Cheap to clone (the underlying SDK client is `Arc`-internal).
#[derive(Clone)]
pub struct R2ImageCache {
    client: aws_sdk_s3::Client,
    bucket: String,
}

impl std::fmt::Debug for R2ImageCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("R2ImageCache")
            .field("bucket", &self.bucket)
            .finish_non_exhaustive()
    }
}

pub(super) fn io_other<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

runner_test_support!(storage; #[cfg(test)]
impl R2ImageCache {
    /// Test-only constructor. Lets unit tests inject a mock `aws_sdk_s3::Client`
    /// (built via `aws_smithy_mocks::mock_client!`) without going through
    /// `from_env`, which reads process env vars. Production code MUST construct
    /// via `from_env`.
    pub(crate) fn with_client(client: aws_sdk_s3::Client, bucket: String) -> Self {
        Self { client, bucket }
    }
});
