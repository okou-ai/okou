//! Constants.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Heartbeat interval in seconds.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 60;

/// Telemetry upload interval in seconds.
pub const TELEMETRY_INTERVAL_SECS: u64 = 30;

/// Metrics collection interval in seconds.
pub const METRICS_INTERVAL_SECS: u64 = 5;

/// Maximum total HTTP attempts for retryable webhook calls.
pub const HTTP_MAX_ATTEMPTS: u32 = 3;

/// HTTP connect timeout in seconds.
pub const HTTP_CONNECT_TIMEOUT_SECS: u64 = 10;

/// HTTP request timeout in seconds.
pub const HTTP_TIMEOUT_SECS: u64 = 30;

/// HTTP request timeout for uploads in seconds.
pub const HTTP_UPLOAD_TIMEOUT_SECS: u64 = 60;

/// HTTP request timeout for one active-input receipt attempt, including API cold starts.
pub const ACTIVE_INPUT_RECEIPT_TIMEOUT_SECS: u64 = 10;

/// Maximum collected successful Okou API response body size.
///
/// This provides headroom above Vercel's 4.5 MB non-streaming function
/// response limit. Model output and presigned object transfers do not use this
/// control-plane response path.
pub const API_SUCCESS_RESPONSE_BODY_MAX_BYTES: usize = 5 * 1024 * 1024;

/// Maximum collected non-retryable Okou API error response body size.
pub const API_ERROR_RESPONSE_BODY_MAX_BYTES: usize = 64 * 1024;

/// Global active-input receipt finalization budget, allowing one full HTTP attempt.
pub const ACTIVE_INPUT_RECEIPT_FINALIZE_TIMEOUT_SECS: u64 = ACTIVE_INPUT_RECEIPT_TIMEOUT_SECS;

/// Maximum wait for an in-flight delivery-identified CLI sink operation.
pub const ACTIVE_INPUT_SINK_QUIESCENCE_TIMEOUT_SECS: u64 = 5;

/// Workaround for Claude Code bug where WebSearch/WebFetch hang indefinitely.
/// Kill the CLI process if a network tool hasn't returned a result within
/// this duration. Override with the `OKOU_STUCK_TOOL_TIMEOUT_SECS` bootstrap
/// environment variable.
/// See: <https://github.com/anthropics/claude-code/issues/11650>
pub const STUCK_TOOL_TIMEOUT_SECS: u64 = 300;

/// How often (in seconds) to check for stuck tools in the select loop.
pub const STUCK_TOOL_CHECK_INTERVAL_SECS: u64 = 5;

/// After the CLI process exits, continue reading stdout for this many seconds.
/// If EOF is not received within this deadline, break the loop to prevent
/// hanging on orphaned child processes that inherited the stdout fd.
pub const STDOUT_DRAIN_DEADLINE_SECS: u64 = 5;

/// Grace period after observing a `type=result` event before SIGTERM-ing the
/// CLI process group. In the platform's one-shot web-agent integration the turn is
/// complete when the CLI emits its final `result`, but the CLI itself may
/// still be blocked draining long-running backgrounded Bash tasks it spawned
/// via its 2-minute auto-background timeout. Those tasks have been observed
/// holding the sandbox alive for tens of minutes until external cancel.
/// See: <https://github.com/vm0-ai/vm0/issues/10879>
pub const POST_RESULT_SIGTERM_GRACE_SECS: u64 = 10;

/// Absolute cap after observing a `type=result` event before SIGTERM-ing the
/// CLI process group, even if meaningful post-result events keep arriving.
pub const POST_RESULT_TOTAL_CAP_SECS: u64 = 120;

/// Follow-up window after SIGTERM before escalating to SIGKILL when the CLI
/// process group ignores the graceful signal.
pub const POST_RESULT_SIGKILL_GRACE_SECS: u64 = 5;

/// Maximum consecutive heartbeat failures before terminating the run.
/// A failed heartbeat cycle makes at most `HTTP_MAX_ATTEMPTS` total HTTP attempts,
/// so 3 consecutive failures make at most 9 attempts over ~3 minutes.
pub const MAX_CONSECUTIVE_HEARTBEAT_FAILURES: u32 = 3;
