//! Storage planning, archive delivery, and host/R2 caches for Runner.

mod archive_connection_attempt;
mod archive_size_mismatch;
mod error;
mod object_download_policy;
pub mod r2_cache;
pub mod storage_cache;
pub mod storage_fingerprints;
pub mod storage_plan;
mod telemetry;
#[cfg(test)]
mod test_telemetry;

pub use archive_connection_attempt::ArchiveConnectionAttempt;
pub use archive_size_mismatch::ArchiveSizeMismatch;
pub use error::{StorageError, StorageResult};
pub use object_download_policy::OBJECT_DOWNLOAD_TIMEOUT;
pub use telemetry::{SandboxOpRecord, SandboxOpReporter, StorageTelemetry};

#[cfg(test)]
mod test_fixtures {
    pub(crate) mod http_body;
    pub(crate) mod ignored_child;
    pub(crate) mod raw_http;
}
