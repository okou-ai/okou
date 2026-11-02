//! Structured diagnostics shared by guest agents and runners.

use serde::{Deserialize, Serialize};

/// Process exit code used for the runner-owned agent execution timeout.
pub const AGENT_EXECUTION_TIMEOUT_EXIT_CODE: i32 = 124;

/// User-visible reason for an agent process killed by the guest OOM killer.
pub const GUEST_MEMORY_OOM_KILLED_ERROR: &str =
    "The agent process ran out of memory and was terminated by the sandbox out-of-memory killer";

// These are stable Unix signal numbers in the serialized diagnostic contract.
const UNIX_SIGHUP_SIGNAL_NUMBER: i32 = 1;
const UNIX_SIGINT_SIGNAL_NUMBER: i32 = 2;
const UNIX_SIGQUIT_SIGNAL_NUMBER: i32 = 3;
const UNIX_SIGKILL_SIGNAL_NUMBER: i32 = 9;
const UNIX_SIGTERM_SIGNAL_NUMBER: i32 = 15;
const UNIX_SIGPIPE_SIGNAL_NUMBER: i32 = 13;
const SHELL_SIGNAL_EXIT_CODE_OFFSET: i32 = 128;

/// Structured information describing why a guest agent run failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureDiagnostic {
    /// Coarse failure category used by runner-side handling.
    pub failure_class: FailureClass,
    /// CLI framework that produced the diagnostic.
    pub framework: AgentFramework,
    /// Exit code observed from the CLI process, when available.
    pub cli_exit_code: Option<i32>,
    /// Raw CLI process exit observation before signal exits are flattened.
    pub cli_observed_exit: Option<CliObservedExitDiagnostic>,
    /// Guest-agent termination details for the CLI process, when available.
    pub cli_termination: Option<CliTerminationDiagnostic>,
    /// Number of turns reported by Claude Code, when available.
    pub claude_num_turns: Option<u64>,
    /// Source that supplied the detailed failure reason, when available.
    pub failure_detail_source: Option<FailureDetailSource>,
    /// Parsed detailed failure reason, when available.
    pub failure_reason: Option<FailureReason>,
    /// Observed model-request, causal transport and completed retry evidence, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_request: Option<ModelRequestDiagnostic>,
    /// Available native evidence from the selected direct Codex terminal error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_failure: Option<crate::codex_failure::CodexFailureEvidence>,
    /// Conservative session-history target status recorded during failure handling.
    pub session_history_status: SessionHistoryStatus,
    /// Content-safe shape classification for the submitted prompt.
    pub prompt_shape: PromptShape,
    /// Prompt length in bytes.
    pub prompt_bytes: u64,
    /// First prompt line length in bytes after stripping a trailing carriage return.
    pub first_line_bytes: u64,
    /// Bounded event-delivery failure details, when delivery was terminally incomplete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_delivery: Option<EventDeliveryDiagnostic>,
    /// Bounded heartbeat failure details, when the control path stopped making progress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat: Option<HeartbeatFailureDiagnostic>,
    /// Workload-local hard-limit counters observed for the failed CLI process.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workload_resource_limit: Option<WorkloadResourceLimitDiagnostic>,
}

/// Content-free evidence from the final failed model call and its session retries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestDiagnostic {
    /// HTTP status actually observed on the final transport attempt, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    /// Fetch attempts made by the final model call, including transport failures.
    pub transport_attempts: u32,
    /// Completed session retries, including the final failed response; excludes scheduled sleeps.
    #[serde(default)]
    pub retry_attempts: u32,
    /// Session retry maximum observed from an SDK retry event, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_limit: Option<u32>,
    /// Original transport exception reduced to fixed values before SDK normalization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport_failure: Option<crate::model_transport::ModelTransportFailure>,
}

impl FailureDiagnostic {
    /// Whether a Codex execution error retains a naturally observed child SIGKILL.
    /// This corroborates a child kill, not its cause; OOM attribution also
    /// requires independent, trusted main-runtime OOM evidence.
    #[must_use]
    pub fn is_codex_app_server_sigkill(&self) -> bool {
        self.failure_class == FailureClass::CliExecutionError
            && self.framework == AgentFramework::Codex
            && self.cli_exit_code
                == Some(SHELL_SIGNAL_EXIT_CODE_OFFSET + UNIX_SIGKILL_SIGNAL_NUMBER)
            && self.cli_termination.is_none()
            && self.heartbeat.is_none()
            && self.failure_reason.is_none()
            && self.cli_observed_exit.as_ref().is_some_and(|exit| {
                exit.is_sigkill()
                    && exit.exit_code.is_none()
                    && exit.mapped_exit_code
                        == SHELL_SIGNAL_EXIT_CODE_OFFSET + UNIX_SIGKILL_SIGNAL_NUMBER
            })
    }

    /// Create a diagnostic with required fields and empty optional details.
    #[must_use]
    pub fn new(
        failure_class: FailureClass,
        framework: AgentFramework,
        prompt: PromptMetadata,
    ) -> Self {
        Self {
            failure_class,
            framework,
            cli_exit_code: None,
            cli_observed_exit: None,
            cli_termination: None,
            claude_num_turns: None,
            failure_detail_source: None,
            failure_reason: None,
            model_request: None,
            codex_failure: None,
            session_history_status: SessionHistoryStatus::Unknown,
            prompt_shape: prompt.prompt_shape,
            prompt_bytes: prompt.prompt_bytes,
            first_line_bytes: prompt.first_line_bytes,
            event_delivery: None,
            heartbeat: None,
            workload_resource_limit: None,
        }
    }

    /// Attach the CLI process exit code.
    #[must_use]
    pub fn with_cli_exit_code(mut self, cli_exit_code: i32) -> Self {
        self.cli_exit_code = Some(cli_exit_code);
        self
    }

    /// Attach the raw CLI process exit observation.
    #[must_use]
    pub fn with_cli_observed_exit(mut self, cli_observed_exit: CliObservedExitDiagnostic) -> Self {
        self.cli_observed_exit = Some(cli_observed_exit);
        self
    }

    /// Attach CLI termination details.
    #[must_use]
    pub fn with_cli_termination(mut self, cli_termination: CliTerminationDiagnostic) -> Self {
        self.cli_termination = Some(cli_termination);
        self
    }

    /// Attach the Claude Code turn count, preserving absence when unknown.
    #[must_use]
    pub fn with_claude_num_turns(mut self, claude_num_turns: Option<u64>) -> Self {
        self.claude_num_turns = claude_num_turns;
        self
    }

    /// Attach the source that supplied the detailed failure reason.
    #[must_use]
    pub fn with_failure_detail_source(
        mut self,
        failure_detail_source: FailureDetailSource,
    ) -> Self {
        self.failure_detail_source = Some(failure_detail_source);
        self
    }

    /// Attach the detailed failure reason.
    #[must_use]
    pub fn with_failure_reason(mut self, failure_reason: FailureReason) -> Self {
        self.failure_reason = Some(failure_reason);
        self
    }

    /// Attach the session history status.
    #[must_use]
    pub fn with_session_history_status(
        mut self,
        session_history_status: SessionHistoryStatus,
    ) -> Self {
        self.session_history_status = session_history_status;
        self
    }

    /// Attach bounded event-delivery failure details.
    #[must_use]
    pub fn with_event_delivery(mut self, event_delivery: EventDeliveryDiagnostic) -> Self {
        self.event_delivery = Some(event_delivery);
        self
    }

    /// Attach bounded heartbeat failure details.
    #[must_use]
    pub fn with_heartbeat(mut self, heartbeat: HeartbeatFailureDiagnostic) -> Self {
        self.heartbeat = Some(heartbeat);
        self
    }

    /// Attach workload-local hard-limit counters.
    #[must_use]
    pub fn with_workload_resource_limit(
        mut self,
        workload_resource_limit: WorkloadResourceLimitDiagnostic,
    ) -> Self {
        self.workload_resource_limit = Some(workload_resource_limit);
        self
    }
}

/// Bounded structured details for terminal heartbeat failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatFailureDiagnostic {
    /// Consecutive failed heartbeat cycles since the last successful cycle.
    pub failed_cycles: Vec<HeartbeatFailedCycleDiagnostic>,
}

/// One failed heartbeat cycle and its completed HTTP attempts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatFailedCycleDiagnostic {
    /// Delay between the scheduled interval tick and the start of this cycle.
    pub scheduled_lag_ms: u64,
    /// Completed failed attempts, bounded by the heartbeat retry budget.
    pub attempts: Vec<HttpCompletedAttemptDiagnostic>,
}

/// One completed failed HTTP attempt, shared by heartbeat and event delivery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpCompletedAttemptDiagnostic {
    /// One-based attempt number.
    pub attempt: u32,
    /// Exact `x-client-request-id` value sent on the request.
    pub client_request_id: String,
    /// Monotonic elapsed request time in milliseconds.
    pub elapsed_ms: u64,
    /// Stable content-safe failure classification.
    pub failure_kind: HttpAttemptFailureKind,
    /// HTTP response status, when a response was received.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    /// Whether Reqwest identified the response-less failure as timeout-related.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_observed: Option<bool>,
    /// Whether Reqwest identified the response-less failure as connection-related.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_observed: Option<bool>,
}

/// Content-safe failure classification for a completed HTTP attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpAttemptFailureKind {
    /// The request exceeded its transport timeout.
    Timeout,
    /// A connection could not be established.
    Connect,
    /// The API returned a non-success HTTP response.
    HttpStatus,
    /// Another transport failure occurred without an HTTP response.
    Transport,
}

impl HttpAttemptFailureKind {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::HttpStatus => "http_status",
            Self::Transport => "transport",
        }
    }
}

/// Bounded cgroup-v2 hard-limit counters observed for a failed workload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadResourceLimitDiagnostic {
    /// Number of times the workload cgroup's memory usage was about to exceed
    /// `memory.max` (the `max` counter in `memory.events`).
    ///
    /// Direct reclaim may allow the allocation to succeed. This is not a count
    /// of failed allocations and does not by itself imply an OOM event or kill.
    /// See the [kernel definition] for details.
    ///
    /// [kernel definition]: https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files
    pub memory_max_events: u64,
    /// Number of workload OOM events.
    pub memory_oom_events: u64,
    /// Number of workload processes killed by the OOM killer.
    pub memory_oom_kill_events: u64,
    /// Number of workload cgroups killed as an OOM group.
    pub memory_oom_group_kill_events: u64,
    /// Number of workload forks or clones rejected by `pids.max`.
    pub pids_max_events: u64,
}

impl WorkloadResourceLimitDiagnostic {
    /// Whether at least one hard-limit event was observed.
    #[must_use]
    pub const fn has_events(self) -> bool {
        self.memory_max_events > 0
            || self.memory_oom_events > 0
            || self.memory_oom_kill_events > 0
            || self.memory_oom_group_kill_events > 0
            || self.pids_max_events > 0
    }
}

/// Bounded structured details for terminal guest event-delivery failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryDiagnostic {
    /// Logical events included in delivery batches.
    pub total_events: u64,
    /// Logical delivery batches started.
    pub total_batches: u64,
    /// Logical batches that completed with a terminal delivery failure,
    /// including non-retryable HTTP errors and exhausted HTTP retry attempts.
    ///
    /// A batch interrupted by the global drain deadline is reported in
    /// `drain_timeout` instead of being counted as a completed failed batch.
    pub failed_batches: u64,
    /// Highest event sequence acknowledged by the API, allowing gaps from loss.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_acknowledged_sequence: Option<u32>,
    /// First logical batch that completed with a terminal delivery failure.
    ///
    /// Includes non-retryable HTTP errors and exhausted HTTP retry attempts;
    /// the recorded attempt and status details establish the failure path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_failed_batch: Option<EventDeliveryFailedBatchDiagnostic>,
    /// Final delivery state captured at the global drain deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_timeout: Option<EventDeliveryDrainTimeoutDiagnostic>,
}

/// First logical event batch that completed with a terminal delivery failure.
///
/// This includes non-retryable HTTP errors and exhausted HTTP retry attempts.
/// Inspect `attempts` and their failure/status details to distinguish the path;
/// this diagnostic alone does not imply retry exhaustion. A batch interrupted
/// by the global drain deadline is reported separately in
/// [`EventDeliveryDrainTimeoutDiagnostic::active_batch`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryFailedBatchDiagnostic {
    /// First event sequence in the batch.
    pub first_sequence: u32,
    /// Last event sequence in the batch.
    pub last_sequence: u32,
    /// Number of events in the batch.
    pub event_count: u32,
    /// Conservative batch byte accounting used by guest admission control.
    pub conservative_bytes: u64,
    /// Observed response state across the batch's failed attempts.
    pub response_state: EventDeliveryResponseState,
    /// Recent completed failed attempts, retained within a bounded history.
    /// Attempt numbers remain monotonic when earlier history has been dropped.
    pub attempts: Vec<HttpCompletedAttemptDiagnostic>,
}

/// Delivery state captured when the global drain deadline expires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryDrainTimeoutDiagnostic {
    /// Events still waiting in the bounded queue.
    pub queued_events: u32,
    /// Conservative bytes still waiting in the bounded queue.
    pub queued_bytes: u64,
    /// Events held outside the channel for the next batch.
    pub carried_events: u32,
    /// Conservative bytes held outside the channel for the next batch.
    pub carried_bytes: u64,
    /// Logical batch active at the deadline, when one was active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_batch: Option<EventDeliveryActiveBatchDiagnostic>,
}

/// Logical event batch active at the global drain deadline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryActiveBatchDiagnostic {
    /// First event sequence in the batch.
    pub first_sequence: u32,
    /// Last event sequence in the batch.
    pub last_sequence: u32,
    /// Number of events in the batch.
    pub event_count: u32,
    /// Conservative batch byte accounting used by guest admission control.
    pub conservative_bytes: u64,
    /// Completed failed attempts before the drain deadline.
    pub completed_attempts: Vec<HttpCompletedAttemptDiagnostic>,
    /// Request attempt still in flight at the deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_attempt: Option<EventDeliveryActiveAttemptDiagnostic>,
    /// Incomplete while this batch remains active at the drain deadline.
    pub response_state: EventDeliveryResponseState,
}

/// Request attempt active when the global drain deadline expires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeliveryActiveAttemptDiagnostic {
    /// One-based attempt number.
    pub attempt: u32,
    /// Exact `x-client-request-id` value sent on the request.
    pub client_request_id: String,
    /// Monotonic elapsed request time in milliseconds at the deadline.
    pub elapsed_ms: u64,
}

/// Observed HTTP response completeness for failed or interrupted event delivery.
///
/// This state does not establish whether the origin accepted or processed events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventDeliveryResponseState {
    /// A nonempty completed failed batch observed an HTTP error on every attempt.
    AllHttpErrors,
    /// At least one response is missing, or the batch remains active at the drain deadline.
    Incomplete,
}

impl EventDeliveryResponseState {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AllHttpErrors => "all_http_errors",
            Self::Incomplete => "incomplete",
        }
    }
}

/// Raw CLI process exit observation before guest-agent maps it to a numeric exit code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliObservedExitDiagnostic {
    /// Shape of the observed process exit.
    pub kind: CliObservedExitKind,
    /// Normal process exit code, when the process exited normally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Unix signal number, when the process was killed by a signal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal_number: Option<i32>,
    /// Stable snake_case signal name for common Unix signals, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal_name: Option<String>,
    /// Existing shell-style mapped code used by `cliExitCode`.
    pub mapped_exit_code: i32,
}

impl CliObservedExitDiagnostic {
    /// Build a normal exit observation.
    #[must_use]
    pub const fn from_exit_code(exit_code: i32) -> Self {
        Self {
            kind: CliObservedExitKind::Exit,
            exit_code: Some(exit_code),
            signal_number: None,
            signal_name: None,
            mapped_exit_code: exit_code,
        }
    }

    /// Build a Unix signal exit observation.
    #[must_use]
    pub fn from_signal(signal_number: i32) -> Self {
        Self {
            kind: CliObservedExitKind::Signal,
            exit_code: None,
            signal_number: Some(signal_number),
            signal_name: observed_signal_name(signal_number).map(String::from),
            mapped_exit_code: shell_signal_exit_code(signal_number),
        }
    }

    /// Return the stable signal name derived from the observed signal number.
    #[must_use]
    pub fn known_signal_name(&self) -> Option<&'static str> {
        if self.kind != CliObservedExitKind::Signal {
            return None;
        }

        self.signal_number.and_then(observed_signal_name)
    }

    /// Return true when this observation is an observed SIGKILL.
    #[must_use]
    pub fn is_sigkill(&self) -> bool {
        self.kind == CliObservedExitKind::Signal
            && self.signal_number == Some(UNIX_SIGKILL_SIGNAL_NUMBER)
    }
}

/// Shape of the raw CLI process exit observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliObservedExitKind {
    /// The process exited normally with an exit code.
    Exit,
    /// The process was killed by a Unix signal.
    Signal,
}

impl CliObservedExitKind {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Exit => "exit",
            Self::Signal => "signal",
        }
    }
}

fn observed_signal_name(signal_number: i32) -> Option<&'static str> {
    match signal_number {
        UNIX_SIGHUP_SIGNAL_NUMBER => Some("sighup"),
        UNIX_SIGINT_SIGNAL_NUMBER => Some("sigint"),
        UNIX_SIGQUIT_SIGNAL_NUMBER => Some("sigquit"),
        UNIX_SIGTERM_SIGNAL_NUMBER => Some("sigterm"),
        UNIX_SIGKILL_SIGNAL_NUMBER => Some("sigkill"),
        UNIX_SIGPIPE_SIGNAL_NUMBER => Some("sigpipe"),
        _ => None,
    }
}

const fn shell_signal_exit_code(signal_number: i32) -> i32 {
    SHELL_SIGNAL_EXIT_CODE_OFFSET.saturating_add(signal_number)
}

/// Details about how the guest agent terminated a CLI process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTerminationDiagnostic {
    /// Component that initiated termination.
    pub initiator: CliTerminationInitiator,
    /// Reason termination was requested.
    pub reason: CliTerminationReason,
    /// Signal sent to the process group, when a signal was sent.
    pub signal_sent: Option<CliTerminationSignal>,
    /// Process group ID targeted by the signal, when available.
    pub signal_pgid: Option<i32>,
    /// Grace period in milliseconds associated with the signal, when available.
    pub signal_grace_ms: Option<u64>,
    /// Whether a recorded SIGTERM was followed by SIGKILL.
    ///
    /// A direct SIGKILL is retained in [`Self::signal_sent`] but is not an escalation.
    pub escalated: bool,
    /// Exit code observed after termination, when available.
    pub observed_exit_code: Option<i32>,
}

impl CliTerminationDiagnostic {
    /// Create termination details with the guest agent as initiator.
    #[must_use]
    pub const fn new(reason: CliTerminationReason) -> Self {
        Self {
            initiator: CliTerminationInitiator::GuestAgent,
            reason,
            signal_sent: None,
            signal_pgid: None,
            signal_grace_ms: None,
            escalated: false,
            observed_exit_code: None,
        }
    }

    /// Record the first attempted signal, then only update on SIGTERM -> SIGKILL escalation.
    ///
    /// A direct initial SIGKILL is retained as the first attempted signal without marking the
    /// diagnostic as escalated.
    ///
    /// Multiple watchdog paths may observe the same child before `wait()` completes. Keeping this
    /// monotonic prevents a later duplicate signal from rewriting the original termination
    /// attribution fields.
    #[must_use]
    pub fn record_signal(
        mut self,
        signal_sent: CliTerminationSignal,
        signal_pgid: Option<i32>,
        signal_grace_ms: Option<u64>,
    ) -> Self {
        let is_escalation = match (self.signal_sent, signal_sent) {
            (None, _) => false,
            (Some(CliTerminationSignal::Sigterm), CliTerminationSignal::Sigkill) => true,
            _ => return self,
        };
        if is_escalation {
            self.escalated = true;
        }
        self.signal_sent = Some(signal_sent);
        self.signal_pgid = signal_pgid;
        self.signal_grace_ms = signal_grace_ms;
        self
    }

    /// Attach the exit code observed after termination.
    #[must_use]
    pub fn with_observed_exit_code(mut self, observed_exit_code: i32) -> Self {
        self.observed_exit_code = Some(observed_exit_code);
        self
    }
}

/// Component that initiated CLI termination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliTerminationInitiator {
    /// The guest agent initiated termination.
    GuestAgent,
}

impl CliTerminationInitiator {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GuestAgent => "guest_agent",
        }
    }
}

/// Reason the guest agent terminated a CLI process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliTerminationReason {
    /// The runner-owned agent execution budget elapsed.
    ExecutionTimeout,
    /// The user explicitly cancelled the active run.
    UserCancellation,
    /// The guest agent reaped the process after receiving a final result.
    PostResultReap,
    /// The stuck-tool watchdog terminated the process.
    StuckToolWatchdog,
    /// Heartbeat handling failed and required termination.
    HeartbeatError,
    /// Heartbeat handling panicked and required termination.
    HeartbeatPanic,
    /// Writing the initial prompt to stdin failed and required termination.
    InitialPromptStdin,
    /// Event delivery overloaded or stopped and required termination.
    EventDelivery,
    /// CLI stdout framing or decoding failed and required termination.
    StdoutIngestion,
}

impl CliTerminationReason {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExecutionTimeout => "execution_timeout",
            Self::UserCancellation => "user_cancellation",
            Self::PostResultReap => "post_result_reap",
            Self::StuckToolWatchdog => "stuck_tool_watchdog",
            Self::HeartbeatError => "heartbeat_error",
            Self::HeartbeatPanic => "heartbeat_panic",
            Self::InitialPromptStdin => "initial_prompt_stdin",
            Self::EventDelivery => "event_delivery",
            Self::StdoutIngestion => "stdout_ingestion",
        }
    }
}

/// Signal sent by the guest agent to terminate a CLI process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliTerminationSignal {
    /// SIGTERM was sent.
    Sigterm,
    /// SIGKILL was sent.
    Sigkill,
}

impl CliTerminationSignal {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sigterm => "sigterm",
            Self::Sigkill => "sigkill",
        }
    }
}

/// Coarse failure class for runner-side handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    /// Working directory setup failed before launching the CLI.
    WorkingDirSetupFailed,
    /// The CLI could not be executed.
    CliExecutionError,
    /// The CLI exited with a non-zero status.
    CliNonzero,
    /// Claude Code produced zero turns and no usable session history.
    ClaudeZeroTurnNoHistory,
    /// Publishing session history or artifacts during Run finalization failed.
    FinalizationFailed,
}

impl FailureClass {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WorkingDirSetupFailed => "working_dir_setup_failed",
            Self::CliExecutionError => "cli_execution_error",
            Self::CliNonzero => "cli_nonzero",
            Self::ClaudeZeroTurnNoHistory => "claude_zero_turn_no_history",
            Self::FinalizationFailed => "finalization_failed",
        }
    }
}

/// Detailed failure reason parsed from CLI output or fallback signals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    /// The session history exceeded the native-history upload size limit.
    SessionHistoryLimit,
    /// The run reached its execution time limit.
    ExecutionTimeout,
    /// The vm0 workspace has insufficient credits.
    InsufficientCredits,
    /// The upstream model provider account has insufficient credits.
    ProviderInsufficientCredits,
    /// The configured API key is invalid.
    InvalidApiKey,
    /// The configured credentials are invalid.
    InvalidCredentials,
    /// The provider account must accept updated consumer terms.
    TermsAcceptanceRequired,
    /// The provider requires account verification before replying.
    AccountVerificationRequired,
    /// The model context window was exhausted.
    ContextWindowExceeded,
    /// The Codex app-server input limit was exceeded.
    InputTooLarge,
    /// The provider rejected image input exceeding its size limit.
    ProviderImageTooLarge,
    /// The provider stopped because an output-token limit was reached.
    OutputTokenLimit,
    /// The provider rejected the request because of a rate limit.
    ProviderRateLimited,
    /// The provider reported overload.
    ProviderOverloaded,
    /// The provider stream timed out.
    ProviderStreamTimeout,
    /// The provider explicitly expired a request before processing started.
    ProviderQueueTimeout,
    /// The provider returned a server error.
    ProviderServerError,
    /// Codex returned an opaque HTTP 400 with no more specific cause.
    ProviderBadRequest,
    /// The response connection was lost.
    ResponseConnectionLost,
    /// The provider refused the request under a safety policy.
    SafetyPolicyRefusal,
    /// The CLI requires reconnecting or re-authentication.
    ReconnectRequired,
    /// Codex sent an access-program selector unavailable to the account.
    CodexAccessProgramUnavailable,
    /// The selected model is unsupported for the authenticated provider account.
    UnsupportedModel,
    /// The provider's model policy excluded every candidate endpoint.
    ProviderModelRestricted,
    /// The provider reported a usage limit.
    UsageLimit,
}

impl FailureReason {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SessionHistoryLimit => "session_history_limit",
            Self::ExecutionTimeout => "execution_timeout",
            Self::InsufficientCredits => "insufficient_credits",
            Self::ProviderInsufficientCredits => "provider_insufficient_credits",
            Self::InvalidApiKey => "invalid_api_key",
            Self::InvalidCredentials => "invalid_credentials",
            Self::TermsAcceptanceRequired => "terms_acceptance_required",
            Self::AccountVerificationRequired => "account_verification_required",
            Self::ContextWindowExceeded => "context_window_exceeded",
            Self::InputTooLarge => "input_too_large",
            Self::ProviderImageTooLarge => "provider_image_too_large",
            Self::OutputTokenLimit => "output_token_limit",
            Self::ProviderRateLimited => "provider_rate_limited",
            Self::ProviderOverloaded => "provider_overloaded",
            Self::ProviderStreamTimeout => "provider_stream_timeout",
            Self::ProviderQueueTimeout => "provider_queue_timeout",
            Self::ProviderServerError => "provider_server_error",
            Self::ProviderBadRequest => "provider_bad_request",
            Self::ResponseConnectionLost => "response_connection_lost",
            Self::SafetyPolicyRefusal => "safety_policy_refusal",
            Self::ReconnectRequired => "reconnect_required",
            Self::CodexAccessProgramUnavailable => "codex_access_program_unavailable",
            Self::UnsupportedModel => "unsupported_model",
            Self::ProviderModelRestricted => "provider_model_restricted",
            Self::UsageLimit => "usage_limit",
        }
    }
}

impl From<FailureReason>
    for api_contracts::generated::types::webhooks::agent::complete::RequestFailureReason
{
    fn from(reason: FailureReason) -> Self {
        match reason {
            FailureReason::SessionHistoryLimit => Self::SessionHistoryLimit,
            FailureReason::ExecutionTimeout => Self::ExecutionTimeout,
            FailureReason::InsufficientCredits => Self::InsufficientCredits,
            FailureReason::ProviderInsufficientCredits => Self::ProviderInsufficientCredits,
            FailureReason::InvalidApiKey => Self::InvalidApiKey,
            FailureReason::InvalidCredentials => Self::InvalidCredentials,
            FailureReason::TermsAcceptanceRequired => Self::TermsAcceptanceRequired,
            FailureReason::AccountVerificationRequired => Self::AccountVerificationRequired,
            FailureReason::ContextWindowExceeded => Self::ContextWindowExceeded,
            FailureReason::InputTooLarge => Self::InputTooLarge,
            FailureReason::ProviderImageTooLarge => Self::ProviderImageTooLarge,
            FailureReason::OutputTokenLimit => Self::OutputTokenLimit,
            FailureReason::ProviderRateLimited => Self::ProviderRateLimited,
            FailureReason::ProviderOverloaded => Self::ProviderOverloaded,
            FailureReason::ProviderStreamTimeout => Self::ProviderStreamTimeout,
            FailureReason::ProviderQueueTimeout => Self::ProviderQueueTimeout,
            FailureReason::ProviderServerError => Self::ProviderServerError,
            FailureReason::ProviderBadRequest => Self::ProviderBadRequest,
            FailureReason::ResponseConnectionLost => Self::ResponseConnectionLost,
            FailureReason::SafetyPolicyRefusal => Self::SafetyPolicyRefusal,
            FailureReason::ReconnectRequired => Self::ReconnectRequired,
            FailureReason::CodexAccessProgramUnavailable => Self::CodexAccessProgramUnavailable,
            FailureReason::UnsupportedModel => Self::UnsupportedModel,
            FailureReason::ProviderModelRestricted => Self::ProviderModelRestricted,
            FailureReason::UsageLimit => Self::UsageLimit,
        }
    }
}

/// Source used to derive a detailed failure reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureDetailSource {
    /// The reason came from a Claude result payload.
    ClaudeResult,
    /// The reason came from a Pi result payload.
    PiResult,
    /// The reason came from a Codex compatibility JSONL event.
    CodexJsonl,
    /// The reason came from stderr output.
    Stderr,
    /// The reason was inferred from a fallback exit-code mapping.
    FallbackExitCode,
}

impl FailureDetailSource {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeResult => "claude_result",
            Self::PiResult => "pi_result",
            Self::CodexJsonl => "codex_jsonl",
            Self::Stderr => "stderr",
            Self::FallbackExitCode => "fallback_exit_code",
        }
    }
}

/// Agent CLI framework that produced the diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFramework {
    /// Anthropic Claude Code.
    ClaudeCode,
    /// OpenAI Codex CLI.
    Codex,
    /// Pi native agent loop.
    Pi,
}

impl From<crate::env::CliFramework> for AgentFramework {
    fn from(framework: crate::env::CliFramework) -> Self {
        match framework {
            crate::env::CliFramework::ClaudeCode => Self::ClaudeCode,
            crate::env::CliFramework::Codex => Self::Codex,
            crate::env::CliFramework::Pi => Self::Pi,
        }
    }
}

impl AgentFramework {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }
}

/// Conservative filesystem-probe result for a session-history target.
///
/// When a probe runs, these states describe whether a producer could resolve a
/// target and inspect its metadata. `Unknown` also covers diagnostics created
/// before a probe can run. No status proves that the target is readable or can
/// support recovery finalization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionHistoryStatus {
    /// No history target could be resolved, or the resolved target was not found.
    Missing,
    /// The resolved target was a zero-byte regular file.
    Empty,
    /// Metadata lookup succeeded for any other resolved target.
    ///
    /// This does not validate the target's file type, readability, or content.
    Present,
    /// No probe result was recorded, or target resolution or metadata lookup
    /// failed for a reason other than absence.
    Unknown,
    /// Session history is not applicable to the framework or failure mode.
    NotApplicable,
}

impl SessionHistoryStatus {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Empty => "empty",
            Self::Present => "present",
            Self::Unknown => "unknown",
            Self::NotApplicable => "not_applicable",
        }
    }
}

/// Content-safe prompt shape classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptShape {
    /// The prompt is empty after trimming whitespace.
    Empty,
    /// The prompt starts with a slash after leading whitespace.
    SlashLike,
    /// The prompt contains plain non-slash content.
    Plain,
}

impl PromptShape {
    /// Return the stable snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::SlashLike => "slash_like",
            Self::Plain => "plain",
        }
    }
}

/// Content-safe metadata derived from a prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptMetadata {
    /// Content-safe prompt shape.
    pub prompt_shape: PromptShape,
    /// Prompt length in bytes.
    pub prompt_bytes: u64,
    /// First prompt line length in bytes after stripping a trailing carriage return.
    pub first_line_bytes: u64,
}

impl PromptMetadata {
    /// Build prompt metadata without retaining prompt content.
    #[must_use]
    pub fn from_prompt(prompt: &str) -> Self {
        let raw_first_line = prompt.split_once('\n').map_or(prompt, |(line, _)| line);
        let first_line = raw_first_line.strip_suffix('\r').unwrap_or(raw_first_line);
        let trimmed = prompt.trim();
        let prompt_shape = if trimmed.is_empty() {
            PromptShape::Empty
        } else if prompt.trim_start().starts_with('/') {
            PromptShape::SlashLike
        } else {
            PromptShape::Plain
        };

        Self {
            prompt_shape,
            prompt_bytes: prompt.len() as u64,
            first_line_bytes: first_line.len() as u64,
        }
    }
}

#[cfg(test)]
mod tests;
