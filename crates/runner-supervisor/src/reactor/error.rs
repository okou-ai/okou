//! Typed outcomes of runtime orchestration, without executable CLI errors.

/// A runtime orchestration failure. Domain errors retain their original display
/// and source until the executable converts them to its command error category.
#[derive(Debug, thiserror::Error)]
pub enum ReactorError {
    #[error(transparent)]
    Host(#[from] runner_host::HostError),
    #[error(transparent)]
    Provider(#[from] runner_provider::ProviderError),
    #[error(transparent)]
    Storage(#[from] runner_storage::StorageError),
    #[error(transparent)]
    Lifecycle(#[from] runner_lifecycle::LifecycleError),
    #[error(transparent)]
    Network(#[from] runner_network::NetworkError),
    #[error(transparent)]
    Executor(#[from] runner_executor::ExecutorError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sandbox error: {0}")]
    Sandbox(#[from] sandbox::SandboxError),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<crate::heartbeat::HeartbeatError> for ReactorError {
    fn from(error: crate::heartbeat::HeartbeatError) -> Self {
        Self::Internal(error.to_string())
    }
}

/// The result of a concrete reactor operation.
pub type ReactorResult<T> = Result<T, ReactorError>;
