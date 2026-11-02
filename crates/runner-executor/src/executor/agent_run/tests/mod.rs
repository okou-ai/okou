mod cancellation;

use super::*;
use guest_contracts::diagnostics::{
    AgentFramework, CliTerminationDiagnostic, FailureClass, PromptMetadata,
};

fn control_path_failure(reason: CliTerminationReason) -> ExecutionFailure {
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliExecutionError,
        AgentFramework::Codex,
        PromptMetadata::from_prompt("continue"),
    )
    .with_cli_exit_code(1)
    .with_cli_termination(CliTerminationDiagnostic::new(reason));
    ExecutionFailure::new(1, "heartbeat failed", Some(diagnostic))
}

fn nonzero_process_exit() -> sandbox::ProcessExit {
    sandbox::ProcessExit::new(42, 1, Vec::new(), Vec::new())
}

const TEST_WORKLOAD_CGROUP: &str = "/vm0-exec/exec-281-10-3/workload";
const TEST_OPERATION_STARTED_US: u64 = 1_000_000;

fn test_memory_snapshot(role: &str, cgroup: &str) -> guest_contracts::oom_evidence::MemorySnapshot {
    guest_contracts::oom_evidence::MemorySnapshot {
        role: role.to_string(),
        cgroup: cgroup.to_string(),
        inode: None,
        status: guest_contracts::oom_evidence::EvidenceStatus::Available,
        current: None,
        peak: None,
        limit: None,
        initial_limit: None,
        anon: None,
        file: None,
        kernel: None,
        baseline: guest_contracts::oom_evidence::MemoryEvents::default(),
        events: guest_contracts::oom_evidence::MemoryEvents::default(),
        delta: guest_contracts::oom_evidence::MemoryEvents::default(),
        local_baseline: guest_contracts::oom_evidence::MemoryEvents::default(),
        local_events: guest_contracts::oom_evidence::MemoryEvents::default(),
        local_delta: guest_contracts::oom_evidence::MemoryEvents::default(),
    }
}

fn test_memory_groups() -> [guest_contracts::oom_evidence::MemorySnapshot; 3] {
    [
        test_memory_snapshot("workload", TEST_WORKLOAD_CGROUP),
        test_memory_snapshot("runtime", &format!("{TEST_WORKLOAD_CGROUP}/runtime")),
        test_memory_snapshot("tools", &format!("{TEST_WORKLOAD_CGROUP}/tools")),
    ]
}

fn test_kernel_event(
    task_cgroup: &str,
    boottime_us: u64,
) -> guest_contracts::oom_evidence::KernelOomEvent {
    guest_contracts::oom_evidence::KernelOomEvent {
        source: "guest".to_string(),
        sequence: 7,
        boottime_us,
        constraint: "CONSTRAINT_NONE".to_string(),
        oom_cgroup: None,
        victim_pid: 4242,
        victim_comm: "tsc".to_string(),
        task_cgroup: task_cgroup.to_string(),
    }
}

fn test_oom_evidence(
    kernel_status: guest_contracts::oom_evidence::EvidenceStatus,
    kernel_events: Vec<guest_contracts::oom_evidence::KernelOomEvent>,
) -> guest_contracts::oom_evidence::OomEvidence {
    guest_contracts::oom_evidence::OomEvidence {
        operation_id: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e".to_string(),
        guest_boot_id: None,
        started_boottime_us: TEST_OPERATION_STARTED_US,
        sampled_at: "2026-09-09T10:34:57.253Z".to_string(),
        kernel_cursor: None,
        kernel_status,
        groups: test_memory_groups(),
        incidents: vec![guest_contracts::oom_evidence::OomIncident {
            id: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e:1".to_string(),
            captured_at: "2026-09-09T10:34:57.253Z".to_string(),
            reason: guest_contracts::oom_evidence::CaptureReason::Cleanup,
            after_observation: true,
            before_cleanup: true,
            kernel_status,
            kernel_events,
            groups: test_memory_groups(),
        }],
        dropped_incidents: 0,
    }
}

fn sigkill_process_exit() -> sandbox::ProcessExit {
    // Production observes the launcher's 137 exit translation, not a
    // signal field, so the exit shape here matches the recorded incident.
    sandbox::ProcessExit::new(42, EXIT_SIGKILL, Vec::new(), Vec::new())
}

#[test]
fn user_visible_oom_failure_follows_the_shared_agent_domain_predicate() {
    // Attribution itself is owned and tested by `guest-contracts`; this
    // pins the user-facing failure to that predicate's verdict.
    let agent_domain = test_oom_evidence(
        guest_contracts::oom_evidence::EvidenceStatus::Available,
        vec![test_kernel_event(
            TEST_WORKLOAD_CGROUP,
            TEST_OPERATION_STARTED_US,
        )],
    );
    // A reclaimed shell tool is the ordinary case in production and must
    // keep the run's original terminal outcome.
    let tool_leaf = test_oom_evidence(
        guest_contracts::oom_evidence::EvidenceStatus::Available,
        vec![test_kernel_event(
            &format!("{TEST_WORKLOAD_CGROUP}/tools/tool-281-10-3-1"),
            TEST_OPERATION_STARTED_US + 10,
        )],
    );

    assert!(agent_domain.agent_domain_oom_kill());
    assert!(guest_memory_oom_killed_agent(
        agent_domain.agent_domain_oom_kill(),
        &sigkill_process_exit(),
        None,
    ));
    assert!(!tool_leaf.agent_domain_oom_kill());
    assert!(!guest_memory_oom_killed_agent(
        tool_leaf.agent_domain_oom_kill(),
        &sigkill_process_exit(),
        None,
    ));
}

#[test]
fn guest_memory_oom_attribution_requires_a_kill_shaped_exit() {
    assert!(guest_memory_oom_killed_agent(
        true,
        &sigkill_process_exit(),
        None
    ));
    assert!(!guest_memory_oom_killed_agent(
        true,
        &nonzero_process_exit(),
        None,
    ));
    assert!(!guest_memory_oom_killed_agent(
        false,
        &sigkill_process_exit(),
        None,
    ));
    assert!(!guest_memory_oom_killed_agent(
        true,
        &sandbox::ProcessExit {
            termination: ExecTermination::TimedOut,
            ..sigkill_process_exit()
        },
        None,
    ));
}

#[test]
fn oom_killed_agent_reports_the_termination_reason_over_captured_stderr() {
    let error = agent_failure_error(
        true,
        "{\"type\":\"pi_preparation_timing\",\"phase\":\"model_runtime\"} Killed".to_string(),
        Some("guest error file".to_string()),
        EXIT_SIGKILL,
    );

    assert_eq!(error, GUEST_MEMORY_OOM_KILLED_ERROR);
    assert!(!error.contains("pi_preparation_timing"));
}

#[test]
fn ordinary_failures_keep_their_existing_error_selection() {
    assert_eq!(
        agent_failure_error(false, "boom".to_string(), None, 1),
        "boom"
    );
    assert_eq!(
        agent_failure_error(
            false,
            String::new(),
            Some("guest error file".to_string()),
            1
        ),
        "guest error file"
    );
    assert_eq!(
        agent_failure_error(false, String::new(), None, EXIT_SIGKILL),
        agent_exit_failure_message(EXIT_SIGKILL)
    );
}

#[test]
fn heartbeat_control_failures_reject_sandbox_reuse() {
    for reason in [
        CliTerminationReason::HeartbeatError,
        CliTerminationReason::HeartbeatPanic,
    ] {
        let failure = control_path_failure(reason);
        let disposition = sandbox_reuse_disposition_for_process_exit(
            &nonzero_process_exit(),
            CancellationDisposition::None,
            Some(&failure),
        );

        assert_eq!(
            disposition,
            SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ControlPathFailure)
        );
        assert_eq!(disposition.as_str(), "control_path_failure");
        assert_eq!(
            disposition.telemetry_action(),
            "runner_terminal_sandbox_reuse_rejected_control_path_failure"
        );
    }
}

#[test]
fn ordinary_nonzero_exit_remains_reusable() {
    let failure = ExecutionFailure::new(1, "ordinary failure", None);

    assert_eq!(
        sandbox_reuse_disposition_for_process_exit(
            &nonzero_process_exit(),
            CancellationDisposition::None,
            Some(&failure),
        ),
        SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit)
    );
}

#[test]
fn codex_state_backfill_timeout_rejects_sandbox_reuse() {
    let failure = ExecutionFailure::new(
        1,
        "execution: codex app-server child exited while waiting for initialize: exit status: 1; stderr tail: Error: failed to initialize sqlite state runtime under /home/user/.codex: timed out waiting for state db backfill at /home/user/.codex after 30s (status: running)",
        None,
    );

    let disposition = sandbox_reuse_disposition_for_process_exit(
        &nonzero_process_exit(),
        CancellationDisposition::None,
        Some(&failure),
    );
    assert_eq!(
        disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::CodexStateBackfillTimeout)
    );
    assert_eq!(disposition.as_str(), "codex_state_backfill_timeout");
}

#[test]
fn unrelated_initialize_and_backfill_errors_remain_reusable() {
    for error in [
        "execution: codex app-server child exited while waiting for initialize: exit status: 1; stderr tail: provider unavailable",
        "execution: another child exited; stderr tail: timed out waiting for state db backfill",
    ] {
        let failure = ExecutionFailure::new(1, error, None);
        assert_eq!(
            sandbox_reuse_disposition_for_process_exit(
                &nonzero_process_exit(),
                CancellationDisposition::None,
                Some(&failure),
            ),
            SandboxReuseDisposition::Eligible(SandboxReuseTerminal::NonzeroExit)
        );
    }
}

#[test]
fn hard_cancellation_and_resource_failure_precede_control_path_rejection() {
    let failure = control_path_failure(CliTerminationReason::HeartbeatError);
    assert_eq!(
        sandbox_reuse_disposition_for_process_exit(
            &nonzero_process_exit(),
            CancellationDisposition::HardFallback,
            Some(&failure),
        ),
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::HardCancellation)
    );

    let failure = failure.with_resource_diagnostics(Some(
        ResourceFailureDiagnostics::from_failure_kind(ResourceFailureKind::GuestMemoryOomKilled),
    ));
    assert_eq!(
        sandbox_reuse_disposition_for_process_exit(
            &nonzero_process_exit(),
            CancellationDisposition::None,
            Some(&failure),
        ),
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ResourceFailure)
    );
}

fn exec_arg_aggregate_bytes(value: &str) -> usize {
    value.len() + 1
}

fn env_pairs_for_aggregate_bytes(target_bytes: usize) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut remaining = target_bytes;
    let mut index = 0;

    while remaining > 0 {
        let key = format!("TEST_FILL_{index}");
        let overhead = key.len() + 2;
        if remaining <= overhead {
            pairs
                .last_mut()
                .expect("aggregate target must require at least one env pair")
                .1
                .push_str(&"x".repeat(remaining));
            break;
        }

        let value_len = (64 * 1024).min(remaining - overhead);
        pairs.push((key, "x".repeat(value_len)));
        remaining -= overhead + value_len;
        index += 1;
    }

    pairs
}

#[test]
fn bootstrap_exec_boundary_rejects_oversized_env_value_without_value_leak() {
    let secret = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
    let env_pairs = vec![("TEST_OVERSIZED".to_string(), secret.clone())];

    let error = validate_agent_bootstrap_exec_boundary(&env_pairs)
        .unwrap_err()
        .to_string();

    assert!(error.contains("guest-agent bootstrap argv/env too large"));
    assert!(error.contains("TEST_OVERSIZED"));
    assert!(!error.contains(&secret));
}

#[test]
fn bootstrap_exec_boundary_rejects_aggregate_overflow() {
    let value = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES - 16);
    let env_pairs: Vec<(String, String)> = (0..20)
        .map(|index| (format!("TEST_CHUNK_{index}"), value.clone()))
        .collect();

    let error = validate_agent_bootstrap_exec_boundary(&env_pairs)
        .unwrap_err()
        .to_string();

    assert!(error.contains("argv/env aggregate too large"));
}

#[test]
fn bootstrap_exec_boundary_counts_fixed_agent_executable_arg() {
    let executable_arg_bytes = exec_arg_aggregate_bytes(AGENT_PATH);
    let env_pairs = env_pairs_for_aggregate_bytes(
        guest_contracts::exec_limits::EXECVE_ARG_ENV_MAX_BYTES + 1 - executable_arg_bytes,
    );

    let error = validate_agent_bootstrap_exec_boundary(&env_pairs)
        .unwrap_err()
        .to_string();

    assert!(error.contains("argv/env aggregate too large"));
}
