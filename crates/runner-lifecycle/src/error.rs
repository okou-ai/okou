#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    #[error("sandbox error: {0}")]
    Sandbox(#[from] sandbox::SandboxError),
    #[error("config error: {0}")]
    Config(String),
    #[error("internal error: {0}")]
    Internal(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<runner_host::HostError> for LifecycleError {
    fn from(error: runner_host::HostError) -> Self {
        match error {
            runner_host::HostError::Config(message) => Self::Config(message),
            runner_host::HostError::Internal(message) => Self::Internal(message),
            runner_host::HostError::Io(error) => Self::Io(error),
        }
    }
}

pub type LifecycleResult<T> = Result<T, LifecycleError>;
