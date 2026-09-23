use std::time::Duration;

use runner_types::ids::RunId;

pub use runner_provider::{
    ApiBodyReadError, ApiFailureKind, ApiRequestContext, ApiStatusError, ApiTransportCause,
    ApiTransportError,
};

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

impl From<runner_host::HostError> for RunnerError {
    fn from(error: runner_host::HostError) -> Self {
        match error {
            runner_host::HostError::Config(message) => Self::Config(message),
            runner_host::HostError::Internal(message) => Self::Internal(message),
            runner_host::HostError::Io(error) => Self::Io(error),
        }
    }
}

impl From<runner_provider::ProviderError> for RunnerError {
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

impl From<runner_storage::StorageError> for RunnerError {
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

impl From<runner_lifecycle::LifecycleError> for RunnerError {
    fn from(error: runner_lifecycle::LifecycleError) -> Self {
        match error {
            runner_lifecycle::LifecycleError::Sandbox(error) => Self::Sandbox(error),
            runner_lifecycle::LifecycleError::Config(message) => Self::Config(message),
            runner_lifecycle::LifecycleError::Internal(message) => Self::Internal(message),
            runner_lifecycle::LifecycleError::Io(error) => Self::Io(error),
        }
    }
}

impl From<runner_network::NetworkError> for RunnerError {
    fn from(error: runner_network::NetworkError) -> Self {
        match error {
            runner_network::NetworkError::Config(message) => Self::Config(message),
            runner_network::NetworkError::Internal(message) => Self::Internal(message),
            runner_network::NetworkError::Io(error) => Self::Io(error),
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
mod tests {
    use super::*;

    #[test]
    fn format_short_duration_cases() {
        assert_eq!(format_short_duration(Duration::from_secs(0)), "0m");
        assert_eq!(format_short_duration(Duration::from_secs(45)), "0m");
        assert_eq!(format_short_duration(Duration::from_secs(600)), "10m");
        assert_eq!(format_short_duration(Duration::from_secs(3600)), "1h00m");
        assert_eq!(format_short_duration(Duration::from_secs(7260)), "2h01m");
    }

    #[test]
    fn active_jobs_error_display_singular() {
        let err = ActiveJobsError {
            unit: "vm0-runner-v0.3.0".into(),
            suffix: "v0.3.0".into(),
            run_ids: vec![RunId::from(uuid::Uuid::nil())],
            runner_uptime: Duration::from_secs(600),
            command_name: "stop",
            draining: false,
        };
        let s = format!("{err}");
        // Singular phrasing, no "(s)" stutter and no "1 jobs"
        assert!(s.contains("1 active job"), "got:\n{s}");
        assert!(!s.contains("job(s)"), "got:\n{s}");
        assert!(!s.contains("1 active jobs"), "got:\n{s}");
        // Uptime is shown once (at the runner level), not per-job
        assert!(s.contains("up 10m"), "got:\n{s}");
        assert!(s.contains("runner service drain --name v0.3.0"));
        assert!(s.contains("--force"));
        assert!(!s.contains("already draining"));
    }

    #[test]
    fn active_jobs_error_display_plural() {
        let err = ActiveJobsError {
            unit: "vm0-runner-v0.3.0".into(),
            suffix: "v0.3.0".into(),
            run_ids: vec![
                RunId::from(uuid::Uuid::nil()),
                RunId::from(uuid::Uuid::nil()),
            ],
            runner_uptime: Duration::from_secs(7260),
            command_name: "uninstall",
            draining: false,
        };
        let s = format!("{err}");
        assert!(s.contains("2 active jobs"), "got:\n{s}");
        assert!(!s.contains("job(s)"), "got:\n{s}");
        assert!(s.contains("up 2h01m"), "got:\n{s}");
        assert!(s.contains("uninstall anyway"));
    }

    #[test]
    fn active_jobs_error_display_draining() {
        let err = ActiveJobsError {
            unit: "vm0-runner-v0.3.0".into(),
            suffix: "v0.3.0".into(),
            run_ids: vec![RunId::from(uuid::Uuid::nil())],
            runner_uptime: Duration::from_secs(1800),
            command_name: "stop",
            draining: true,
        };
        let s = format!("{err}");
        assert!(s.contains("is already draining"), "got:\n{s}");
        assert!(s.contains("1 active job"), "got:\n{s}");
        assert!(!s.contains("job(s)"), "got:\n{s}");
        assert!(s.contains("up 30m"), "got:\n{s}");
        assert!(s.contains("Wait for the drain to finish"));
        assert!(s.contains("--force"));
        assert!(
            !s.contains("runner service drain --name"),
            "should not suggest drain when already draining; got:\n{s}"
        );
    }
}
