use std::time::Duration;

use runner_types::ids::RunId;

pub use runner_provider::{ApiBodyReadError, ApiStatusError, ApiTransportError};

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
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

    #[error("{0}")]
    ActiveJobs(Box<ActiveJobsError>),
}

impl From<runner_executor::ExecutorError> for RunnerError {
    fn from(error: runner_executor::ExecutorError) -> Self {
        use runner_executor::ExecutorError;
        match error {
            ExecutorError::Api(message) => Self::Api(message),
            ExecutorError::ApiStatus(error) => Self::ApiStatus(error),
            ExecutorError::ApiTransport(error) => Self::ApiTransport(error),
            ExecutorError::ApiBodyRead(error) => Self::ApiBodyRead(error),
            ExecutorError::Sandbox(error) => Self::Sandbox(error),
            ExecutorError::Config(message) => Self::Config(message),
            ExecutorError::Cancelled => Self::Cancelled,
            ExecutorError::Internal(message) => Self::Internal(message),
            ExecutorError::Snapshot(error) => Self::Snapshot(error),
            ExecutorError::Io(error) => Self::Io(error),
        }
    }
}

impl From<runner_host::HostError> for RunnerError {
    fn from(error: runner_host::HostError) -> Self {
        runner_executor::ExecutorError::from(error).into()
    }
}

impl From<runner_provider::ProviderError> for RunnerError {
    fn from(error: runner_provider::ProviderError) -> Self {
        runner_executor::ExecutorError::from(error).into()
    }
}

impl From<runner_storage::StorageError> for RunnerError {
    fn from(error: runner_storage::StorageError) -> Self {
        runner_executor::ExecutorError::from(error).into()
    }
}

impl From<runner_lifecycle::LifecycleError> for RunnerError {
    fn from(error: runner_lifecycle::LifecycleError) -> Self {
        runner_executor::ExecutorError::from(error).into()
    }
}

impl From<runner_supervisor::heartbeat::HeartbeatError> for RunnerError {
    fn from(error: runner_supervisor::heartbeat::HeartbeatError) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<runner_network::NetworkError> for RunnerError {
    fn from(error: runner_network::NetworkError) -> Self {
        runner_executor::ExecutorError::from(error).into()
    }
}

impl From<runner_supervisor::reactor::error::ReactorError> for RunnerError {
    fn from(error: runner_supervisor::reactor::error::ReactorError) -> Self {
        use runner_supervisor::reactor::error::ReactorError;
        match error {
            ReactorError::Host(error) => error.into(),
            ReactorError::Provider(error) => error.into(),
            ReactorError::Lifecycle(error) => error.into(),
            ReactorError::Network(error) => error.into(),
            ReactorError::Executor(error) => error.into(),
            ReactorError::Io(error) => Self::Io(error),
            ReactorError::Sandbox(error) => Self::Sandbox(error),
            ReactorError::Internal(message) => Self::Internal(message),
        }
    }
}

/// Error returned by `service stop` / `service uninstall` when the target
/// runner has active jobs and the user did not pass `--force`.
#[derive(Debug)]
pub struct ActiveJobsError {
    /// Full unit name (e.g. `vm0-runner-v0.3.0`).
    pub unit: String,
    /// Suffix used for the drain hint (e.g. `v0.3.0`).
    pub suffix: String,
    /// Active run IDs from the runner's status.json.
    pub run_ids: Vec<RunId>,
    /// How long the runner process itself has been up. We report this at the
    /// runner level rather than per-run because status.json does not record
    /// per-run start times.
    pub runner_uptime: Duration,
    /// The command that was invoked (`"stop"` or `"uninstall"`).
    pub command_name: &'static str,
    /// Whether the runner's status.json shows `mode == "draining"`.
    /// When true, the error message suppresses the "use drain" suggestion
    /// (the operator already initiated drain) and surfaces wait-or-force.
    pub draining: bool,
}

impl std::fmt::Display for ActiveJobsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n = self.run_ids.len();
        let jobs_phrase = if n == 1 {
            "1 active job".to_string()
        } else {
            format!("{n} active jobs")
        };
        let uptime = format_short_duration(self.runner_uptime);

        if self.draining {
            writeln!(
                f,
                "runner {} is already draining (up {uptime}, {jobs_phrase} still active).",
                self.unit
            )?;
        } else {
            writeln!(
                f,
                "runner {} has {jobs_phrase} (up {uptime}) — they will be killed by forceful {}.",
                self.unit, self.command_name
            )?;
        }
        writeln!(f)?;
        writeln!(f, "  Active runs:")?;
        for id in &self.run_ids {
            writeln!(f, "    - {id}")?;
        }
        writeln!(f)?;
        if self.draining {
            write!(
                f,
                "Wait for the drain to finish, or use --force to {} now.",
                self.command_name
            )?;
        } else {
            writeln!(f, "For graceful shutdown that lets jobs finish, run:")?;
            writeln!(f, "    runner service drain --name {}", self.suffix)?;
            writeln!(f)?;
            write!(
                f,
                "To {} anyway and kill active jobs, rerun with --force.",
                self.command_name
            )?;
        }
        Ok(())
    }
}

/// Render a Duration as a short human-readable string.
///
/// - `<1h`  → `"{M}m"` (e.g. `"10m"`, `"0m"`)
/// - `>=1h` → `"{H}h{MM}m"` (e.g. `"1h00m"`, `"2h01m"`)
pub fn format_short_duration(d: Duration) -> String {
    let secs = d.as_secs();
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    if h > 0 {
        format!("{h}h{m:02}m")
    } else {
        format!("{m}m")
    }
}

pub type RunnerResult<T> = Result<T, RunnerError>;

#[cfg(test)]
mod tests;
