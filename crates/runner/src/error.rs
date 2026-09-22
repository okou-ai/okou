use std::time::Duration;

use reqwest::StatusCode;

use runner_types::ids::RunId;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiStatusError {
    pub endpoint_label: &'static str,
    pub status: StatusCode,
    pub body: String,
}

impl std::fmt::Display for ApiStatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.endpoint_label, self.status, self.body)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiRequestContext {
    pub endpoint_label: &'static str,
    pub method: String,
    pub host: String,
    pub path: String,
    pub client_request_id: String,
    pub client_session_id: String,
    pub client_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiFailureKind {
    Timeout,
    Connect,
    Request,
    Body,
    Unknown,
}

impl ApiFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::Request => "request",
            Self::Body => "body",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiTransportCause {
    Timeout,
    ConnectionRefused,
    ConnectionReset,
    ConnectionAborted,
    NetworkUnreachable,
    HostUnreachable,
    NotConnected,
    BrokenPipe,
    UnexpectedEof,
    HttpIncompleteMessage,
    HttpCanceled,
    HttpClosed,
    HttpParse,
    HttpBodyWriteAborted,
    HttpShutdown,
    Io,
    Unknown,
}

impl ApiTransportCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::ConnectionRefused => "connection_refused",
            Self::ConnectionReset => "connection_reset",
            Self::ConnectionAborted => "connection_aborted",
            Self::NetworkUnreachable => "network_unreachable",
            Self::HostUnreachable => "host_unreachable",
            Self::NotConnected => "not_connected",
            Self::BrokenPipe => "broken_pipe",
            Self::UnexpectedEof => "unexpected_eof",
            Self::HttpIncompleteMessage => "http_incomplete_message",
            Self::HttpCanceled => "http_canceled",
            Self::HttpClosed => "http_closed",
            Self::HttpParse => "http_parse",
            Self::HttpBodyWriteAborted => "http_body_write_aborted",
            Self::HttpShutdown => "http_shutdown",
            Self::Io => "io",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiTransportError {
    pub request: ApiRequestContext,
    pub failure_kind: ApiFailureKind,
    pub failure_cause: ApiTransportCause,
    pub summary: String,
}

impl std::fmt::Display for ApiTransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: send API request failed: {}; cause={}",
            self.request.endpoint_label,
            self.summary,
            self.failure_cause.as_str()
        )
    }
}

/// Safe diagnostics for a response that failed before JSON parsing.
#[derive(Debug)]
pub struct ApiBodyReadError {
    pub endpoint_label: &'static str,
    pub status: StatusCode,
    /// An allowlisted media type, or `other`, `invalid`, or `missing`.
    pub content_type: &'static str,
    pub content_length: Option<u64>,
    pub received_bytes: u64,
    pub failure_cause: ApiTransportCause,
}

impl std::fmt::Display for ApiBodyReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} read response body: cause={}, status={}, content_type={}, content_length={:?}, received_bytes={}",
            self.endpoint_label,
            self.failure_cause.as_str(),
            self.status.as_u16(),
            self.content_type,
            self.content_length,
            self.received_bytes,
        )
    }
}

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
