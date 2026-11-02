use super::*;
use crate::threading::ThreadTask;
use crate::threading::test_support::FailingThreadSpawner;
use std::cell::Cell;
use std::fs::File;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::process::Command;
use std::time::Duration;

thread_local! {
    pub(super) static STDIN_POLL_READY: Cell<Option<mpsc::Sender<()>>> = const { Cell::new(None) };
}

#[derive(Clone)]
struct StdinPollReadySpawner {
    ready: mpsc::Sender<()>,
}

impl ThreadSpawner for StdinPollReadySpawner {
    fn spawn<T: Send + 'static>(
        &self,
        name: &'static str,
        task: ThreadTask<T>,
    ) -> io::Result<JoinHandle<T>> {
        let ready = self.ready.clone();
        SystemThreadSpawner.spawn(
            name,
            Box::new(move || {
                STDIN_POLL_READY.set(Some(ready));
                task()
            }),
        )
    }
}

fn read_message(stream: &mut UnixStream) -> guest_control_proto::RawMessage {
    let mut hdr = [0u8; 4];
    stream.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    stream.read_exact(&mut body).unwrap();

    let mut full = Vec::with_capacity(4 + body_len);
    full.extend_from_slice(&hdr);
    full.extend_from_slice(&body);
    let mut decoder = guest_control_proto::Decoder::new();
    let mut messages = decoder.decode(&full).unwrap();
    assert_eq!(messages.len(), 1);
    messages.remove(0)
}

fn request(seq: u32, command: &str) -> ExecOperationWorkerRequest {
    ExecOperationWorkerRequest {
        seq,
        lifecycle: ExecOperationLifecycle::OneShot,
        process: ExecOperationProcess::Workload,
        timeout: ExecOperationTimeout::Duration { timeout_ms: 0 },
        command: command.to_string(),
        env: Vec::new(),
        sudo: false,
        label: "test".to_string(),
        stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        expected_exit_codes: Vec::new(),
        stdin_bytes: None,
        control: ExecControlPolicy::Disabled,
        exec_control_guard: None,
        exec_control_bootstrap_endpoint: None,
        guest_agent_program: GuestAgentProgram::production(),
        process_containment_mode: ProcessContainmentMode::BuildConfigured,
        drain_deadline: EXEC_OUTPUT_DRAIN_DEADLINE,
    }
}

fn decoded_request(
    role: ExecProcessRole,
    lifecycle: ExecLifecyclePolicy,
    control: ExecControlPolicy,
) -> guest_control_proto::DecodedExecStart<'static> {
    guest_control_proto::DecodedExecStart {
        lifecycle,
        role,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
        command: "true",
        env: Vec::new(),
        sudo: false,
        label: "test",
        stdout: ExecOutputPolicy::Discard,
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: Vec::new(),
        control,
        stdin_bytes: None,
    }
}

fn operation_guard() -> OperationGuard {
    crate::quiesce::OperationState::default().acquire().unwrap()
}

#[test]
fn worker_boundary_rejects_invalid_process_contracts() {
    for decoded in [
        decoded_request(
            ExecProcessRole::Agent,
            ExecLifecyclePolicy::OneShot,
            ExecControlPolicy::Disabled,
        ),
        decoded_request(
            ExecProcessRole::Workload,
            ExecLifecyclePolicy::Supervised,
            ExecControlPolicy::Enabled {
                control_nonce: [1; guest_control_proto::EXEC_CONTROL_NONCE_LEN],
                sink: true,
            },
        ),
    ] {
        let error = match ExecOperationWorkerRequest::from_decoded(
            1,
            decoded,
            ProcessContainmentMode::TestNoop,
            EXEC_OUTPUT_DRAIN_DEADLINE,
            GuestAgentProgram::production(),
        ) {
            Ok(_) => panic!("worker accepted invalid process contract"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}

#[test]
fn worker_boundary_rejects_role_and_control_endpoint_mismatches() {
    let mut workload = request(1, "true");
    workload.exec_control_bootstrap_endpoint = Some("endpoint".to_string());
    assert_eq!(
        workload.validate_control_attachment().unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );

    let mut agent = request(2, "true");
    agent.process = ExecOperationProcess::Agent;
    agent.lifecycle = ExecOperationLifecycle::Supervised;
    agent.control = ExecControlPolicy::Enabled {
        control_nonce: [2; guest_control_proto::EXEC_CONTROL_NONCE_LEN],
        sink: true,
    };
    assert_eq!(
        agent.validate_control_attachment().unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
}

fn register_test_operation(
    registry: &ExecOperationRegistry,
    seq: u32,
    label: &str,
) -> Result<ExecOperationRegistration, ()> {
    registry.register(seq, label, "contained_workload", "exec")
}

fn assert_registry_released(registry: &ExecOperationRegistry, seq: u32) {
    let registration = register_test_operation(registry, seq, "test");
    assert!(
        registration.is_ok(),
        "exec operation registry entry for seq={seq} was not released"
    );
}

#[test]
fn control_bootstrap_environment_uses_trusted_canonical_values_once() {
    let mut env = vec![
        ("FIRST_USER_KEY", "first-user-value"),
        ("SECOND_USER_KEY", "second-user-value"),
        (
            CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            "stale-canonical-workload-endpoint",
        ),
        (
            CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            "duplicate-canonical-workload-endpoint",
        ),
        (
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            "stale-canonical-process-control-endpoint",
        ),
        ("THIRD_USER_KEY", "third-user-value"),
        (
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            "duplicate-canonical-process-control-endpoint",
        ),
        (
            CANONICAL_TOOL_CGROUP_PROCS_ENV,
            "stale-canonical-tool-endpoint",
        ),
        (
            CANONICAL_TOOL_CGROUP_PROCS_ENV,
            "duplicate-canonical-tool-endpoint",
        ),
    ];

    append_exec_control_environment(
        &mut env,
        "process-control-endpoint",
        Some(("workload-endpoint", "tool-endpoint")),
    );

    assert_eq!(
        env,
        [
            ("FIRST_USER_KEY", "first-user-value"),
            ("SECOND_USER_KEY", "second-user-value"),
            ("THIRD_USER_KEY", "third-user-value"),
            (
                process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
                "process-control-endpoint"
            ),
            (CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, "workload-endpoint"),
            (CANONICAL_TOOL_CGROUP_PROCS_ENV, "tool-endpoint"),
        ]
    );
    for canonical_key in [
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        CANONICAL_TOOL_CGROUP_PROCS_ENV,
    ] {
        assert_eq!(
            env.iter().filter(|(key, _)| *key == canonical_key).count(),
            1
        );
    }
}

#[test]
fn exec_termination_notable_tracks_nonzero_exit() {
    assert!(!exec_termination_is_notable(
        ExecTermination::Exited { exit_code: 0 },
        &[]
    ));
    assert!(exec_termination_is_notable(
        ExecTermination::Exited { exit_code: 1 },
        &[]
    ));
    assert!(!exec_termination_is_notable(
        ExecTermination::Exited { exit_code: 66 },
        &[66]
    ));
    assert!(exec_termination_is_notable(
        ExecTermination::TimedOut,
        &[124]
    ));
}

#[test]
fn wait_outcome_selects_containment_cleanup_mode() {
    let status = Command::new("true").status().unwrap();
    assert_eq!(
        ProcessContainmentCleanupMode::for_wait_outcome(&WaitOutcome::Exited(status), false),
        ProcessContainmentCleanupMode::Graceful
    );
    assert_eq!(
        ProcessContainmentCleanupMode::for_wait_outcome(&WaitOutcome::TimedOut, false),
        ProcessContainmentCleanupMode::Forced
    );
    assert_eq!(
        ProcessContainmentCleanupMode::for_wait_outcome(&WaitOutcome::Cancelled, false),
        ProcessContainmentCleanupMode::Forced
    );
    assert_eq!(
        ProcessContainmentCleanupMode::for_wait_outcome(
            &WaitOutcome::WaitFailed("wait failed".to_string()),
            false,
        ),
        ProcessContainmentCleanupMode::Forced
    );
    let status = Command::new("true").status().unwrap();
    assert_eq!(
        ProcessContainmentCleanupMode::for_wait_outcome(&WaitOutcome::Exited(status), true),
        ProcessContainmentCleanupMode::Forced
    );
}

#[test]
fn one_shot_containment_failure_overrides_terminal_result() {
    let (termination, diagnostic) = resolve_exec_result(
        WaitOutcome::TimedOut,
        ExecOperationLifecycle::OneShot,
        Some("wait for cgroup.kill: timed out"),
    );

    assert_eq!(termination, ExecTermination::WaitFailed);
    assert!(diagnostic.contains("Failed to clean process containment"));
    assert!(diagnostic.contains("wait for cgroup.kill"));
}

#[test]
fn terminal_oom_evidence_cannot_overflow_diagnostic() {
    let evidence = format!("{}{{}}", guest_contracts::oom_evidence::EVIDENCE_PREFIX);
    let diagnostic = "x".repeat(u16::MAX as usize);
    assert_eq!(
        successful_containment_evidence_diagnostic(
            ExecOperationLifecycle::Supervised,
            "guest-agent",
            ExecTermination::TimedOut,
            diagnostic.clone(),
            Some(&evidence)
        ),
        diagnostic
    );
}

#[test]
fn one_shot_containment_failure_preserves_wait_diagnostic() {
    let (termination, diagnostic) = resolve_exec_result(
        WaitOutcome::WaitFailed("wait observer failed".to_string()),
        ExecOperationLifecycle::OneShot,
        Some("wait for cgroup.kill: timed out"),
    );

    assert_eq!(termination, ExecTermination::WaitFailed);
    assert!(diagnostic.contains("Failed to wait: wait observer failed"));
    assert!(diagnostic.contains("failed to clean process containment"));
    assert!(diagnostic.contains("wait for cgroup.kill"));
}

#[test]
fn supervised_containment_failure_preserves_terminal_result() {
    let (termination, diagnostic) = resolve_exec_result(
        WaitOutcome::TimedOut,
        ExecOperationLifecycle::Supervised,
        Some("wait for cgroup.kill: timed out"),
    );

    assert_eq!(termination, ExecTermination::TimedOut);
    assert!(diagnostic.is_empty());
}

#[test]
fn successful_exec_result_carries_containment_evidence() {
    let evidence = "exec process containment cleaned cgroup_kill_used=true";

    assert_eq!(
        successful_containment_evidence_diagnostic(
            ExecOperationLifecycle::OneShot,
            "runner-exec",
            ExecTermination::Exited { exit_code: 0 },
            String::new(),
            Some(evidence),
        ),
        evidence
    );
}

#[test]
fn containment_evidence_does_not_replace_terminal_failure_diagnostic() {
    assert_eq!(
        successful_containment_evidence_diagnostic(
            ExecOperationLifecycle::OneShot,
            "runner-exec",
            ExecTermination::WaitFailed,
            "wait failed".to_owned(),
            Some("cleanup evidence"),
        ),
        "wait failed"
    );
}

#[test]
fn containment_evidence_is_only_attached_to_one_shot_runner_exec_results() {
    let evidence = Some("cleanup evidence");

    assert_eq!(
        successful_containment_evidence_diagnostic(
            ExecOperationLifecycle::Supervised,
            "runner-exec",
            ExecTermination::Exited { exit_code: 0 },
            String::new(),
            evidence,
        ),
        ""
    );
    assert_eq!(
        successful_containment_evidence_diagnostic(
            ExecOperationLifecycle::OneShot,
            "benchmark-exec",
            ExecTermination::Exited { exit_code: 0 },
            String::new(),
            evidence,
        ),
        ""
    );
}

#[test]
fn exec_terminal_log_message_marks_slow_only_result_as_latency_only() {
    let stdout = BoundedDrainResult::default();
    let stderr = BoundedDrainResult::default();

    for (lifecycle, operation_kind) in [
        (ExecLifecyclePolicy::OneShot, "exec"),
        (ExecLifecyclePolicy::Supervised, "start_process"),
    ] {
        let request = ExecOperationWorkerRequest::from_decoded(
            7,
            decoded_request(
                ExecProcessRole::Workload,
                lifecycle,
                ExecControlPolicy::Disabled,
            ),
            ProcessContainmentMode::TestNoop,
            EXEC_OUTPUT_DRAIN_DEADLINE,
            GuestAgentProgram::production(),
        )
        .unwrap();
        let message = exec_terminal_log_message(ExecTerminalLogMessageInput {
            request: &request,
            elapsed_ms: 6000,
            termination: ExecTermination::Exited { exit_code: 0 },
            stdout_result: &stdout,
            stderr_result: &stderr,
            diagnostic_present: false,
            oom_evidence: false,
            oom_evidence_proof: false,
            contained_tool_oom: false,
            slow: true,
            notable: false,
        })
        .unwrap();

        assert!(message.contains("seq=7"), "message={message}");
        assert!(message.contains("label=test"), "message={message}");
        assert!(
            message.contains("process_class=contained_workload "),
            "message={message}"
        );
        assert!(
            message.contains(&format!("operation_kind={operation_kind} ")),
            "message={message}"
        );
        assert!(message.contains("slow=true"), "message={message}");
        assert!(message.contains("notable=false"), "message={message}");
        assert!(
            message.contains("terminal_reason=slow"),
            "message={message}"
        );
        assert!(
            message.contains("diagnostic_present=false"),
            "message={message}"
        );
    }
}

#[test]
fn slow_storage_download_log_is_informational_only_for_clean_success() {
    let mut request = request(7, "private command must not be logged");
    request.label = "storage-download".into();
    let clean = BoundedDrainResult::default();
    let truncated = BoundedDrainResult {
        capture_truncated: true,
        ..Default::default()
    };
    let overflowed = BoundedDrainResult {
        stream_truncated: true,
        ..Default::default()
    };
    let proof = format!(
        "{}{}",
        guest_contracts::oom_evidence::EVIDENCE_PREFIX,
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../../guest-contracts/tests/fixtures/oom-evidence-v1.json"
        ))
        .unwrap(),
    );
    assert!(guest_contracts::oom_evidence::split_diagnostic(&proof).has_proof());
    let malformed = format!("{}bad", guest_contracts::oom_evidence::EVIDENCE_PREFIX);
    for (termination, stdout, stderr, diagnostic, expected) in [
        (
            ExecTermination::Exited { exit_code: 0 },
            &clean,
            &clean,
            "",
            "INFO",
        ),
        (
            ExecTermination::Exited { exit_code: 1 },
            &clean,
            &clean,
            "",
            "WARN",
        ),
        (ExecTermination::TimedOut, &clean, &clean, "", "WARN"),
        (ExecTermination::Cancelled, &clean, &clean, "", "WARN"),
        (ExecTermination::StartFailed, &clean, &clean, "", "WARN"),
        (ExecTermination::WaitFailed, &clean, &clean, "", "WARN"),
        (
            ExecTermination::Exited { exit_code: 0 },
            &truncated,
            &clean,
            "",
            "WARN",
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            &clean,
            &truncated,
            "",
            "WARN",
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            &overflowed,
            &clean,
            "",
            "WARN",
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            &clean,
            &overflowed,
            "",
            "WARN",
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            &clean,
            &clean,
            "cleanup failed",
            "WARN",
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            &clean,
            &clean,
            proof.as_str(),
            "WARN",
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            &clean,
            &clean,
            malformed.as_str(),
            "WARN",
        ),
    ] {
        let (level, message) = exec_terminal_log_message_for_diagnostic(
            &request,
            Duration::from_millis(5226),
            termination,
            stdout,
            stderr,
            diagnostic,
        )
        .unwrap();
        assert_eq!(level, expected, "{message}");
        assert!(message.contains("label=storage-download"));
        assert!(!message.contains(&request.command));
        if level == "INFO" {
            assert!(
                message.contains("elapsed_ms=5226 slow=true notable=false terminal_reason=slow")
            );
        }
    }
    assert!(
        exec_terminal_log_message_for_diagnostic(
            &request,
            Duration::from_millis(10),
            ExecTermination::Exited { exit_code: 0 },
            &clean,
            &clean,
            "",
        )
        .is_none()
    );
    for label in ["storage-download-extra", "workspace-unmount"] {
        request.label = label.into();
        assert_eq!(
            exec_terminal_log_message_for_diagnostic(
                &request,
                Duration::from_secs(6),
                ExecTermination::Exited { exit_code: 0 },
                &clean,
                &clean,
                "",
            )
            .unwrap()
            .0,
            "WARN"
        );
    }
}

#[test]
fn exec_terminal_log_message_marks_notable_result() {
    let request = request(8, "false");
    let stdout = BoundedDrainResult::default();
    let stderr = BoundedDrainResult {
        captured: Some(b"stderr".to_vec()),
        capture_truncated: true,
        stream_truncated: false,
    };

    let message = exec_terminal_log_message(ExecTerminalLogMessageInput {
        request: &request,
        elapsed_ms: 10,
        termination: ExecTermination::Exited { exit_code: 1 },
        stdout_result: &stdout,
        stderr_result: &stderr,
        diagnostic_present: true,
        oom_evidence: false,
        oom_evidence_proof: false,
        contained_tool_oom: false,
        slow: false,
        notable: true,
    })
    .unwrap();

    assert!(message.contains("slow=false"), "message={message}");
    assert!(message.contains("notable=true"), "message={message}");
    assert!(
        message.contains("terminal_reason=notable"),
        "message={message}"
    );
    assert!(
        message.contains("stderr_truncated=true"),
        "message={message}"
    );
    assert!(
        message.contains("diagnostic_present=true"),
        "message={message}"
    );
}

#[test]
fn exec_terminal_log_message_suppresses_fast_clean_result() {
    let request = request(9, "true");
    let stdout = BoundedDrainResult::default();
    let stderr = BoundedDrainResult::default();

    assert!(
        exec_terminal_log_message(ExecTerminalLogMessageInput {
            request: &request,
            elapsed_ms: 10,
            termination: ExecTermination::Exited { exit_code: 0 },
            stdout_result: &stdout,
            stderr_result: &stderr,
            diagnostic_present: false,
            oom_evidence: false,
            oom_evidence_proof: false,
            contained_tool_oom: false,
            slow: false,
            notable: false,
        })
        .is_none()
    );
}

/// Guest Control Client mirrors this decision on the Runner host. Both
/// emitters must reach the same verdict for the same evidence; the host-side
/// half is pinned by
/// `terminal_severity_matches_the_guest_side_mirror_for_the_same_evidence`
/// in `guest-control-client`, which reads these same two fixtures.
#[test]
fn contained_tool_oom_terminal_logging_keeps_failures_actionable() {
    let mut request = request(7, "private command must not be logged");
    request.process = ExecOperationProcess::Agent;
    request.lifecycle = ExecOperationLifecycle::Supervised;
    // Production records that proved containment exited 1 and 124. Those
    // codes reach this branch only when the request declares them expected;
    // an undeclared nonzero exit stays notable, which this change leaves
    // alone.
    request.expected_exit_codes = vec![1, 124];
    let evidence: guest_contracts::oom_evidence::OomEvidence = serde_json::from_str(include_str!(
        "../../../../guest-contracts/tests/fixtures/contained-tool-oom.json"
    ))
    .unwrap();
    let metadata = format!(
        "{}{}",
        guest_contracts::oom_evidence::EVIDENCE_PREFIX,
        serde_json::to_string(&evidence).unwrap()
    );
    for (termination, truncated, residual, expected) in [
        (ExecTermination::Exited { exit_code: 0 }, false, "", "INFO"),
        (ExecTermination::Exited { exit_code: 1 }, false, "", "INFO"),
        (
            ExecTermination::Exited { exit_code: 124 },
            false,
            "",
            "INFO",
        ),
        (
            ExecTermination::Exited { exit_code: 137 },
            false,
            "",
            "WARN",
        ),
        (ExecTermination::TimedOut, false, "", "WARN"),
        (ExecTermination::WaitFailed, false, "", "WARN"),
        (ExecTermination::Exited { exit_code: 0 }, true, "", "WARN"),
        (
            ExecTermination::Exited { exit_code: 0 },
            false,
            "cleanup failed\n",
            "WARN",
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            false,
            "OKOU_OOM_EVIDENCE_V1 bad\n",
            "WARN",
        ),
    ] {
        let stdout = BoundedDrainResult {
            stream_truncated: truncated,
            ..Default::default()
        };
        let (level, message) = exec_terminal_log_message_for_diagnostic(
            &request,
            Duration::from_millis(10),
            termination,
            &stdout,
            &BoundedDrainResult::default(),
            &format!("{residual}{metadata}"),
        )
        .unwrap();
        assert_eq!(level, expected, "{message}");
        assert!(message.contains(&format!("operation_id={}", evidence.operation_id)));
        assert!(!message.contains(&request.command));
        if level == "INFO" {
            assert!(message.contains("terminal_reason=contained_tool_oom"));
        }
    }

    // The same evidence carrying an agent-domain victim is a warning.
    let agent_domain: guest_contracts::oom_evidence::OomEvidence = serde_json::from_str(
        include_str!("../../../../guest-contracts/tests/fixtures/oom-evidence-v1.json"),
    )
    .unwrap();
    let (level, message) = exec_terminal_log_message_for_diagnostic(
        &request,
        Duration::ZERO,
        ExecTermination::Exited { exit_code: 0 },
        &BoundedDrainResult::default(),
        &BoundedDrainResult::default(),
        &format!(
            "{}{}",
            guest_contracts::oom_evidence::EVIDENCE_PREFIX,
            serde_json::to_string(&agent_domain).unwrap()
        ),
    )
    .unwrap();
    assert_eq!(level, "WARN");
    assert!(message.contains("terminal_reason=oom_evidence"));
}

#[test]
fn truncated_tool_records_with_runtime_counters_are_not_contained() {
    use guest_contracts::oom_evidence::{EVIDENCE_PREFIX, OomEvidence};
    let fixture: OomEvidence = serde_json::from_str(include_str!(
        "../../../../guest-contracts/tests/fixtures/runtime-counter-oom.json"
    ))
    .unwrap();
    let mut request = request(7, "private command must not be logged");
    request.process = ExecOperationProcess::Agent;
    request.lifecycle = ExecOperationLifecycle::Supervised;
    for (known_runtime_counter, expected) in
        [(true, "agent_oom_kill"), (false, "unproven_containment")]
    {
        let mut evidence = fixture.clone();
        if !known_runtime_counter {
            evidence.groups[1].local_baseline.oom_kill = None;
            for incident in &mut evidence.incidents {
                incident.groups[1].local_baseline.oom_kill = None;
            }
        }
        let metadata = format!(
            "{EVIDENCE_PREFIX}{}",
            serde_json::to_string(&evidence).unwrap()
        );
        let (level, message) = exec_terminal_log_message_for_diagnostic(
            &request,
            Duration::ZERO,
            ExecTermination::Exited { exit_code: 0 },
            &BoundedDrainResult::default(),
            &BoundedDrainResult::default(),
            &metadata,
        )
        .unwrap();
        assert_eq!(level, "WARN");
        assert!(
            message.contains(&format!("oom_classification={expected}")),
            "{message}"
        );
        assert!(!message.contains("terminal_reason=contained_tool_oom"));
        assert!(!message.contains(&request.command));
    }
}

#[test]
fn exec_terminal_log_message_separates_oom_metadata_from_diagnostics() {
    let request = request(10, "true");
    let stdout = BoundedDrainResult::default();
    let stderr = BoundedDrainResult::default();
    let evidence: guest_contracts::oom_evidence::OomEvidence = serde_json::from_str(include_str!(
        "../../../../guest-contracts/tests/fixtures/oom-evidence-v1.json"
    ))
    .unwrap();
    let evidence_line = |evidence: &guest_contracts::oom_evidence::OomEvidence| {
        format!(
            "{}{}",
            guest_contracts::oom_evidence::EVIDENCE_PREFIX,
            serde_json::to_string(evidence).unwrap()
        )
    };
    let message_for = |diagnostic: &str| {
        exec_terminal_log_message_for_diagnostic(
            &request,
            Duration::from_millis(10),
            ExecTermination::Exited { exit_code: 0 },
            &stdout,
            &stderr,
            diagnostic,
        )
        .map(|(_, message)| message)
    };

    let proof_message = message_for(&evidence_line(&evidence)).unwrap();
    assert!(
        proof_message.contains("terminal_reason=oom_evidence"),
        "message={proof_message}"
    );
    assert!(proof_message.contains("diagnostic_present=false"));
    assert!(proof_message.contains("oom_evidence=true"));
    assert!(proof_message.contains("oom_evidence_proof=true"));
    assert!(!proof_message.contains("OKOU_OOM_EVIDENCE_V1"));

    let mut candidate = evidence.clone();
    for incident in &mut candidate.incidents {
        incident.kernel_events.clear();
        for group in &mut incident.groups {
            group.delta = guest_contracts::oom_evidence::MemoryEvents::default();
            group.local_delta = guest_contracts::oom_evidence::MemoryEvents::default();
        }
    }
    assert!(
        message_for(&evidence_line(&candidate)).is_none(),
        "an inspected-empty candidate is not a terminal warning"
    );

    let diagnostic_message = message_for(&format!(
        "Failed to wait: no child processes\n{}",
        evidence_line(&candidate)
    ))
    .unwrap();
    assert!(diagnostic_message.contains("terminal_reason=notable"));
    assert!(diagnostic_message.contains("diagnostic_present=true"));

    let malformed_message = message_for(&format!(
        "{}not json",
        guest_contracts::oom_evidence::EVIDENCE_PREFIX
    ))
    .unwrap();
    assert!(malformed_message.contains("terminal_reason=notable"));
    assert!(malformed_message.contains("diagnostic_present=false"));
    assert!(malformed_message.contains("oom_evidence=false"));
}

#[test]
fn registry_rejects_duplicate_active_sequence_and_cleans_on_drop() {
    let registry = ExecOperationRegistry::default();
    let first = register_test_operation(&registry, 7, "first").unwrap();
    assert!(register_test_operation(&registry, 7, "duplicate").is_err());
    drop(first);
    assert!(register_test_operation(&registry, 7, "second").is_ok());
}

#[test]
fn registry_cancel_sets_token_and_unknown_cancel_is_noop() {
    let registry = ExecOperationRegistry::default();
    let registration = register_test_operation(&registry, 8, "cancel-me").unwrap();
    assert_eq!(
        registry.cancel(8),
        Some(("cancel-me".to_string(), "contained_workload", "exec"))
    );
    assert!(registration.cancel.load(Ordering::Acquire));
    assert!(registry.cancel(9).is_none());
}

#[test]
fn registry_cancel_returns_truncated_label_preview() {
    let registry = ExecOperationRegistry::default();
    let long_label = format!("{}🔥tail", "a".repeat(99));
    let registration = register_test_operation(&registry, 10, &long_label).unwrap();

    let (preview, process_class, operation_kind) = registry.cancel(10).unwrap();
    assert_eq!(preview, truncate_command_preview(&long_label));
    assert_eq!(process_class, "contained_workload");
    assert_eq!(operation_kind, "exec");
    assert!(preview.ends_with("..."));
    assert!(preview.len() < long_label.len());
    assert!(!preview.contains('🔥'));
    assert!(registration.cancel.load(Ordering::Acquire));
}

#[test]
fn exec_operation_worker_spawn_failure_returns_start_failed_and_cleans_registry() {
    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let writer = GuestWriter::new(guest);
    let registry = ExecOperationRegistry::default();

    start_exec_operation_with_spawner(
        request(42, "echo should-not-run"),
        operation_guard(),
        writer,
        Arc::new(AtomicBool::new(false)),
        registry.clone(),
        FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_WORKER),
    )
    .unwrap();

    let msg = read_message(&mut host);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, 42);
    let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(result.diagnostic.contains("exec operation worker thread"));
    assert_registry_released(&registry, 42);
}

#[test]
fn duplicate_active_exec_operation_returns_error() {
    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let writer = GuestWriter::new(guest);
    let registry = ExecOperationRegistry::default();
    let _registration = register_test_operation(&registry, 11, "duplicate").unwrap();

    start_exec_operation_with_spawner(
        request(11, "echo duplicate"),
        operation_guard(),
        writer,
        Arc::new(AtomicBool::new(false)),
        registry,
        SystemThreadSpawner,
    )
    .unwrap();

    let msg = read_message(&mut host);
    assert_eq!(msg.msg_type, MSG_ERROR);
    let error = guest_control_proto::decode_error(&msg.payload).unwrap();
    assert!(error.contains("already active"));
}

#[test]
fn supervised_exec_started_send_failure_releases_without_result() {
    let (guest, mut host) = UnixStream::pair().unwrap();
    guest.shutdown(Shutdown::Write).unwrap();
    let writer = GuestWriter::new(guest);
    let registry = ExecOperationRegistry::default();
    let mut request = request(47, "sleep 60");
    request.lifecycle = ExecOperationLifecycle::Supervised;
    let registration = register_test_operation(&registry, request.seq, &request.label).unwrap();
    let exec_cancel = registration.cancel_token();

    run_exec_operation_worker(
        request,
        writer,
        Arc::new(AtomicBool::new(false)),
        exec_cancel,
        registration,
        operation_guard(),
        SystemThreadSpawner,
    );

    assert_registry_released(&registry, 47);
    let mut bytes = Vec::new();
    host.read_to_end(&mut bytes).unwrap();
    assert!(bytes.is_empty());
}

#[test]
fn stdout_drain_spawn_failure_returns_wait_failed_and_cleans_registry() {
    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let writer = GuestWriter::new(guest);
    let registry = ExecOperationRegistry::default();

    start_exec_operation_with_spawner(
        request(43, "sleep 60"),
        operation_guard(),
        writer,
        Arc::new(AtomicBool::new(false)),
        registry.clone(),
        FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDOUT),
    )
    .unwrap();

    let msg = read_message(&mut host);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, 43);
    let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::WaitFailed);
    assert!(result.diagnostic.contains("stdout drain thread"));
    assert_registry_released(&registry, 43);
}

#[test]
fn stdin_writer_spawn_failure_returns_wait_failed_and_cleans_registry() {
    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let writer = GuestWriter::new(guest);
    let registry = ExecOperationRegistry::default();
    let mut request = request(46, "sleep 60");
    request.stdin_bytes = Some(b"stdin".to_vec());

    start_exec_operation_with_spawner(
        request,
        operation_guard(),
        writer,
        Arc::new(AtomicBool::new(false)),
        registry.clone(),
        FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDIN),
    )
    .unwrap();

    let msg = read_message(&mut host);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, 46);
    let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::WaitFailed);
    assert!(result.diagnostic.contains("stdin writer thread"));
    assert_registry_released(&registry, 46);
}

#[test]
fn stdin_writer_cancel_unblocks_full_pipe() {
    // The exec protocol cannot synchronize on this private worker's final
    // pre-poll check, and child cleanup can independently release stdin.
    // Keep the actual writer, full pipe, poll, and cancellation wakeup here.
    let mut fds = [0; 2];
    // SAFETY: `pipe` initializes two file descriptors in `fds` on success.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    // SAFETY: both descriptors were freshly returned by `pipe`.
    let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    // SAFETY: both descriptors were freshly returned by `pipe`.
    let mut write_file = unsafe { File::from_raw_fd(fds[1]) };
    set_nonblocking(write_file.as_raw_fd()).unwrap();

    let fill = [0u8; 4096];
    loop {
        match write_file.write(&fill) {
            Ok(0) => panic!("pipe write returned zero while filling"),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
            Err(e) => panic!("failed to fill pipe: {e}"),
        }
    }

    let (ready_tx, ready_rx) = mpsc::channel();
    let writer = spawn_exec_operation_stdin(
        write_file,
        b"blocked".to_vec(),
        StdinPollReadySpawner { ready: ready_tx },
    )
    .unwrap();
    let ready = ready_rx.recv_timeout(Duration::from_secs(5));
    request_stdin_writer_cancel(&writer);
    let completed = writer.done_rx.recv_timeout(Duration::from_secs(5));

    // Record completion while the peer is still open and undrained. Release
    // it and join before asserting, including readiness and wakeup failures.
    drop(read_fd);
    let result = writer
        .handle
        .join()
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    ready.expect("stdin writer did not reach its blocking poll");
    completed.expect("stdin writer cancel did not wake blocked writer");
    assert!(is_stdin_write_cancelled(&result.unwrap_err()));
}

#[test]
fn write_stdin_rejects_pre_cancelled_input() {
    let mut stdin = tempfile::tempfile().unwrap();
    let (cancel_reader, _cancel_writer) = stdin_cancel_pipe().unwrap();
    let cancel = AtomicBool::new(true);

    let result = write_stdin_cancellable(&mut stdin, b"input", &cancel, cancel_reader.as_raw_fd());

    assert!(is_stdin_write_cancelled(&result.unwrap_err()));
    assert_eq!(stdin.metadata().unwrap().len(), 0);
}

#[test]
fn stdin_cancel_pipe_is_nonblocking_and_close_on_exec() {
    let (read_fd, write_fd) = stdin_cancel_pipe().unwrap();

    for fd in [read_fd.as_raw_fd(), write_fd.as_raw_fd()] {
        // SAFETY: fd is open for the duration of this assertion.
        let status_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert!(status_flags >= 0);
        assert_ne!(status_flags & libc::O_NONBLOCK, 0);

        // SAFETY: fd is open for the duration of this assertion.
        let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(descriptor_flags >= 0);
        assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
    }
}

#[test]
fn stderr_drain_spawn_failure_returns_wait_failed_and_cleans_registry() {
    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let writer = GuestWriter::new(guest);
    let registry = ExecOperationRegistry::default();

    start_exec_operation_with_spawner(
        request(45, "sleep 60"),
        operation_guard(),
        writer,
        Arc::new(AtomicBool::new(false)),
        registry.clone(),
        FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDERR),
    )
    .unwrap();

    let msg = read_message(&mut host);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, 45);
    let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::WaitFailed);
    assert!(result.diagnostic.contains("stderr drain thread"));
    assert_registry_released(&registry, 45);
}

#[test]
fn stream_write_failure_cleans_registry() {
    let (guest, host) = UnixStream::pair().unwrap();
    drop(host);
    let writer = GuestWriter::new(guest);
    let registry = ExecOperationRegistry::default();
    let mut request = request(44, "printf output");
    request.stdout = ExecOutputPolicy::Stream {
        limit_bytes: 64,
        chunk_limit_bytes: 8,
    };
    let seq = request.seq;
    let registration = register_test_operation(&registry, request.seq, &request.label).unwrap();
    let exec_cancel = registration.cancel_token();

    run_exec_operation_worker(
        request,
        writer,
        Arc::new(AtomicBool::new(false)),
        exec_cancel.clone(),
        registration,
        operation_guard(),
        SystemThreadSpawner,
    );

    assert!(exec_cancel.load(Ordering::Acquire));
    assert_registry_released(&registry, seq);
}
