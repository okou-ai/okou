use std::path::PathBuf;
use std::time::Duration;

use ::sandbox::{ExecOutputLimits, ProcessOutputMode, SandboxControlTarget};

/// Behavior override applied to exec calls whose command contains the pattern.
///
/// The matcher configures an ordinary [`ExecResult`](::sandbox::ExecResult).
/// The result remains subject to the executing
/// [`ExecRequest`](::sandbox::ExecRequest)'s output limits.
pub struct ExecMatcher {
    /// Substring to match against `ExecRequest.cmd`.
    pub pattern: String,
    /// Exit code reported by the configured `ExecTermination::Exited` result.
    pub exit_code: i32,
    /// Stdout bytes configured before the request's output limits are applied.
    pub stdout: Vec<u8>,
    /// Stderr bytes configured before the request's output limits are applied.
    pub stderr: Vec<u8>,
}

/// Captured `exec_remote` call fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteExecCall {
    /// Identity scope passed to `SandboxControl::exec_remote`.
    pub target: SandboxControlTarget,
    /// Command string passed to `SandboxControl::exec_remote`.
    pub command: String,
    /// Timeout passed to `SandboxControl::exec_remote`.
    pub timeout: Duration,
    /// Whether the remote command requested sudo privileges.
    pub sudo: bool,
}

/// Captured `exec` request fields recorded for test assertions.
///
/// The record intentionally keeps environment variable names but not their
/// values. Expected exits, stdin bytes, and output limits are captured because
/// downstream tests assert those request properties directly.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecCall {
    /// Command string passed to `ExecRequest.cmd`.
    pub cmd: String,
    /// Timeout passed to `ExecRequest.timeout`.
    pub timeout: Duration,
    /// Environment variable names from `ExecRequest.env`.
    ///
    /// Environment values are not recorded in this field.
    pub env_keys: Vec<String>,
    /// Whether the exec request was made with sudo privileges.
    pub sudo: bool,
    /// Additional expected exit codes supplied to the exec request.
    pub expected_exit_codes: Vec<i32>,
    /// Stdin bytes supplied to the exec request, when present.
    pub stdin_bytes: Option<Vec<u8>>,
    /// Output limits supplied to the exec request.
    pub output_limits: ExecOutputLimits,
}

/// Captured fixed storage-manifest request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageManifestCall {
    /// Canonical manifest JSON supplied to the provider operation.
    pub manifest_json: Vec<u8>,
    /// Run identity supplied to the fixed guest helper.
    pub run_id: String,
    /// Absolute guest runtime directory supplied to the fixed helper.
    pub runtime_dir: String,
    /// Helper timeout supplied by the caller.
    pub timeout: Duration,
}

/// Captured fixed live session-history identity verifier request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionHistoryIdentityVerifyCall {
    /// Final identity metadata path supplied to the verifier.
    pub metadata_path: String,
    /// Canonical guest runtime directory supplied to the verifier.
    pub runtime_dir: String,
    /// Stable framework spelling supplied to the verifier.
    pub framework: String,
    /// Expected normalized session-id hash supplied to the verifier.
    pub session_id_hash: String,
    /// Stable history-reference-kind spelling supplied to the verifier.
    pub history_ref_kind: String,
    /// Expected final history hash supplied to the verifier.
    pub history_hash: String,
    /// Expected final history byte length supplied to the verifier.
    pub history_size_bytes: u64,
    /// Helper timeout supplied by the caller.
    pub timeout: Duration,
}

/// Captured fixed reused-Codex session cleanup request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexSessionCleanupCall {
    /// Canonical Codex thread identifier supplied to the cleanup helper.
    pub session_id: String,
    /// Canonical logical rollout path relative to the fixed Codex home.
    pub fallback_relative_path: String,
    /// Helper timeout supplied by the caller.
    pub timeout: Duration,
}

/// Owned timezone behavior recorded for a fixed guest-state restore call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GuestStateRestoreTimezoneCall {
    /// The request left the timezone unchanged.
    None,
    /// The request used best-effort timezone synchronization.
    BestEffort(String),
    /// The request required timezone synchronization.
    Required(String),
}

/// Captured fixed guest-state restore request fields.
///
/// Entropy contents are intentionally omitted from observations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuestStateRestoreCall {
    /// Whole Unix timestamp seconds supplied to the fixed helper.
    pub unix_seconds: u64,
    /// Nanoseconds within the timestamp second.
    pub unix_nanoseconds: u32,
    /// Entropy payload length without the entropy bytes themselves.
    pub entropy_len: usize,
    /// Requested timezone behavior.
    pub timezone: GuestStateRestoreTimezoneCall,
    /// Helper timeout supplied by the caller.
    pub timeout: Duration,
}

/// Captured `start_process` request fields recorded for test assertions.
///
/// Unlike [`ExecCall`], this record captures environment values as well as
/// names because tests use it to assert guest-agent bootstrap environment
/// construction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartProcessCall {
    /// Whether the caller classifies clean guest timeouts as expected.
    pub timeout_is_expected: bool,
    /// Command string passed to `StartProcessRequest.cmd`.
    pub cmd: String,
    /// Timeout passed to `StartProcessRequest.timeout`.
    pub timeout: Duration,
    /// Start acknowledgement deadline passed to `StartProcessRequest.start_timeout`.
    pub start_timeout: Duration,
    /// Environment variable names and values from `StartProcessRequest.env`.
    pub env: Vec<(String, String)>,
    /// Whether the process request was made with sudo privileges.
    pub sudo: bool,
    /// Output mode requested for the guest process.
    pub output: ProcessOutputMode,
}

/// Captured controlled-Agent request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartAgentProcessCall {
    /// Timeout passed to `StartAgentProcessRequest.timeout`.
    pub timeout: Duration,
    /// Environment variable names and values from `StartAgentProcessRequest.env`.
    pub env: Vec<(String, String)>,
    /// Output mode requested for the Guest Agent.
    pub output: ProcessOutputMode,
}

/// Captured `wait_process` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WaitProcessCall {
    /// Timeout passed to `Sandbox::wait_process`.
    pub timeout: Duration,
}

/// Captured process-cancel request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessCancelCall {
    /// Timeout supplied to the process cancel handle.
    pub timeout: Duration,
}

/// Captured process-control request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessControlCall {
    /// Message id supplied to the process-control handle.
    pub message_id: String,
    /// Payload bytes supplied to the process-control handle.
    pub payload: Vec<u8>,
    /// Timeout supplied to the process-control handle.
    pub timeout: Duration,
}

/// Captured `write_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteFileCall {
    /// Caller-selected compression; content remains the final raw file bytes.
    pub compression: sandbox::FileCompression,
    /// Guest path passed to `write_file`.
    pub path: String,
    /// Content bytes passed to `write_file`.
    pub content: Vec<u8>,
}

/// Captured `write_files` batch request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteFilesCall {
    /// Guest files passed to `write_files`.
    pub files: Vec<WriteFileCall>,
}

/// Captured `read_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadFileCall {
    /// Guest path passed to `read_file`.
    pub path: String,
    /// Maximum byte count passed to `read_file`.
    pub max_bytes: u64,
}

/// Captured `copy_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CopyFileCall {
    /// Guest path requested as the copy source.
    pub path: String,
    /// Host path requested as the copy destination.
    pub host_path: PathBuf,
    /// Maximum byte count requested for the copy.
    pub max_bytes: u64,
    /// Timeout requested for the copy operation.
    pub timeout: Duration,
    /// Whether a backend-reported missing or non-regular guest source should
    /// succeed without writing the host destination.
    pub missing_ok: bool,
}
