pub use runner_provider::{
    ApiBodyReadError, ApiFailureKind, ApiRequestContext, ApiStatusError, ApiTransportCause,
    ApiTransportError,
};

#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("api error: {0}")]
    Api(String),
    #[error("api error: {0}")]
    ApiStatus(Box<ApiStatusError>),
    #[error("api error: {0}")]
    ApiTransport(Box<ApiTransportError>),
    #[error("api error: {0}")]
    ApiBodyRead(Box<ApiBodyReadError>),
    #[error("sandbox error: {0}")]
    Sandbox(#[from] sandbox::SandboxError),
    #[error("config error: {0}")]
    Config(String),
    #[error("cancelled")]
    Cancelled,
    #[error("internal error: {0}")]
    Internal(String),
    #[error("snapshot error: {0}")]
    Snapshot(#[from] sandbox::SnapshotError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type ExecutorResult<T> = Result<T, ExecutorError>;

// Keep internal names stable while moving the implementation; only the
// executor-specific names are exported across the crate boundary.
pub(crate) use ExecutorError as RunnerError;
pub(crate) use ExecutorResult as RunnerResult;

impl From<runner_host::HostError> for ExecutorError {
    fn from(error: runner_host::HostError) -> Self {
        match error {
            runner_host::HostError::Config(message) => Self::Config(message),
            runner_host::HostError::Internal(message) => Self::Internal(message),
            runner_host::HostError::Io(error) => Self::Io(error),
        }
    }
}

impl From<runner_provider::ProviderError> for ExecutorError {
    fn from(error: runner_provider::ProviderError) -> Self {
        match error {
            runner_provider::ProviderError::Api(message) => Self::Api(message),
            runner_provider::ProviderError::ApiStatus(error) => Self::ApiStatus(error),
            runner_provider::ProviderError::ApiTransport(error) => Self::ApiTransport(error),
            runner_provider::ProviderError::ApiBodyRead(error) => Self::ApiBodyRead(error),
            runner_provider::ProviderError::Config(message) => Self::Config(message),
            runner_provider::ProviderError::Internal(message) => Self::Internal(message),
            runner_provider::ProviderError::Io(error) => Self::Io(error),
        }
    }
}

impl From<runner_storage::StorageError> for ExecutorError {
    fn from(error: runner_storage::StorageError) -> Self {
        match error {
            runner_storage::StorageError::Sandbox(error) => Self::Sandbox(error),
            runner_storage::StorageError::Cancelled => Self::Cancelled,
            runner_storage::StorageError::Config(message) => Self::Config(message),
            runner_storage::StorageError::Internal(message) => Self::Internal(message),
            runner_storage::StorageError::Io(error) => Self::Io(error),
        }
    }
}

impl From<runner_lifecycle::LifecycleError> for ExecutorError {
    fn from(error: runner_lifecycle::LifecycleError) -> Self {
        match error {
            runner_lifecycle::LifecycleError::Sandbox(error) => Self::Sandbox(error),
            runner_lifecycle::LifecycleError::Config(message) => Self::Config(message),
            runner_lifecycle::LifecycleError::Internal(message) => Self::Internal(message),
            runner_lifecycle::LifecycleError::Io(error) => Self::Io(error),
        }
    }
}

impl From<runner_network::NetworkError> for ExecutorError {
    fn from(error: runner_network::NetworkError) -> Self {
        match error {
            runner_network::NetworkError::Config(message) => Self::Config(message),
            runner_network::NetworkError::Internal(message) => Self::Internal(message),
            runner_network::NetworkError::Io(error) => Self::Io(error),
        }
    }
}
