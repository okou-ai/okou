//! Errors produced by host-local Runner primitives.

/// Failure from Runner host filesystem, process, path, or configuration work.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// Invalid host configuration or an unsafe host path/state input.
    #[error("config error: {0}")]
    Config(String),

    /// A host operation failed without a more specific I/O error contract.
    #[error("internal error: {0}")]
    Internal(String),

    /// An underlying host I/O operation failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Result returned by Runner host primitives.
pub type HostResult<T> = Result<T, HostError>;
