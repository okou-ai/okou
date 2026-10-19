//! Shared guest exec terminal-cleanup budgets.

use std::time::Duration;

use api_contracts::generated::constants::runners::{
    GUEST_EXEC_OUTPUT_DRAIN_DEADLINE_MS, GUEST_EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT_MS,
    GUEST_EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT_MS, GUEST_EXEC_PROCESS_CONTAINMENT_TERM_GRACE_MS,
    GUEST_EXEC_TERMINAL_CLEANUP_BUDGET_MS,
};

/// Graceful wait after signaling contained descendants with `SIGTERM`.
pub const EXEC_PROCESS_CONTAINMENT_TERM_GRACE: Duration =
    Duration::from_millis(GUEST_EXEC_PROCESS_CONTAINMENT_TERM_GRACE_MS);

/// Maximum wait for a contained cgroup to become empty after `cgroup.kill`.
pub const EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT: Duration =
    Duration::from_millis(GUEST_EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT_MS);

/// Maximum retry window for removing an empty exec cgroup.
pub const EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT: Duration =
    Duration::from_millis(GUEST_EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT_MS);

/// Maximum time to drain a guest-managed child's stdout/stderr after exit.
pub const EXEC_OUTPUT_DRAIN_DEADLINE: Duration =
    Duration::from_millis(GUEST_EXEC_OUTPUT_DRAIN_DEADLINE_MS);

/// Maximum configured wait budget before a guest exec terminal result is built.
///
/// This conservatively includes the graceful containment path followed by the
/// output-drain deadline. Forced cancellation and timeout cleanup skip
/// [`EXEC_PROCESS_CONTAINMENT_TERM_GRACE`]. Scheduling, syscall, drain-poll,
/// and terminal-frame delivery latency are not part of this configured budget.
pub const EXEC_TERMINAL_CLEANUP_BUDGET: Duration = EXEC_PROCESS_CONTAINMENT_TERM_GRACE
    .saturating_add(EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT)
    .saturating_add(EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT)
    .saturating_add(EXEC_OUTPUT_DRAIN_DEADLINE);

const _: () = assert!(
    EXEC_TERMINAL_CLEANUP_BUDGET.as_nanos()
        == Duration::from_millis(GUEST_EXEC_TERMINAL_CLEANUP_BUDGET_MS).as_nanos(),
    "guest exec terminal cleanup budget must match shared timeout derivation"
);
