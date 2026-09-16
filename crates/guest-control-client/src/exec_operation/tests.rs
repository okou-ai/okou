use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::io;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;
use std::task::Poll;
use std::time::Duration;

use guest_control_proto::{
    ExecCapturedOutput, ExecProcessRole, ExecTermination, MSG_EXEC_CANCEL, MSG_EXEC_RESULT,
    RawMessage,
};
use tokio::sync::oneshot;
use tokio::time::Instant;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use crate::operation_tracker::NormalOperationReadiness;
use crate::tests::support::{
    assert_connection_accepts_exec_operation, is_connected, normal_operation_readiness,
    read_guest_message, route_reservation_count, send_exec_result, setup_host_and_guest,
};
use crate::{ConnectionState, ExecOperationRequest, RouteId, Shared};

use super::diagnostics::*;
use super::dispatch::dispatch_result;
use super::frame::{ExecCancelFrameWriteOutcome, send_exec_cancel_frame_for_wait_with_write_start};
use super::handle::{ExecOperationHandle, ExecWaitCore, ExecWaitLifecycle, send_exec_cancel_frame};
use super::state::*;
use super::types::ExecOperationResult;
use super::{
    EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT, EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES,
    EXEC_OPERATION_STAGE_SLOW_THRESHOLD,
};

fn exec_operation_for_snapshot(seq: u32, label: &str) -> ExecOperation {
    let (result_tx, _result_rx) = oneshot::channel();
    let normal_operations = crate::operation_tracker::NormalOperationTracker::new();
    ExecOperation {
        route_id: RouteId::from_raw(u64::from(seq)),
        normal_operation: Some(ExecOperationNormalTracking::Owned(
            normal_operations.reserve().unwrap(),
        )),
        lifecycle: ExecOperationLifecycle::OneShot,
        diagnostic: ExecOperationDiagnostic::new(
            seq,
            label,
            guest_control_proto::ExecProcessRole::Workload,
            false,
            false,
        ),
        result_tx,
        stream_tx: None,
        stdout_capture: ExecCaptureState::Discard,
        stderr_capture: ExecCaptureState::Discard,
        stdout_stream: None,
        stderr_stream: None,
        expected_output_seq: 0,
        stream_overflowed: false,
        host_cancel_requested: false,
        pending_controls: HashMap::new(),
    }
}

#[tokio::test]
async fn cancel_frame_skips_terminal_operation_after_waiting_for_writer() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            start_write_timeout: Duration::from_secs(5),
            command: "echo done",
            env: &[],
            sudo: false,
            label: "cancel-skip",
            stdout: guest_control_proto::ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: guest_control_proto::ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            stdin_bytes: None,
            stream_queue_capacity: None,
        })
        .await
        .unwrap();
    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, guest_control_proto::MSG_EXEC_START);
    let route_id = handle.wait_core.active_route_id().unwrap();
    let diagnostic = handle.wait_core.diagnostic().clone();
    let writer = host.shared.writer.lock().await;
    let (write_started_tx, mut write_started_rx) = oneshot::channel();
    // Drive the real cancel transport independently of cancel_and_wait's biased
    // result selection, so terminal delivery cannot bypass serialized admission.
    let cancel = send_exec_cancel_frame_for_wait_with_write_start(
        &host.shared,
        route_id,
        &diagnostic,
        Some(write_started_tx),
    );
    tokio::pin!(cancel);
    poll_fn(|cx| {
        assert!(cancel.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(route_reservation_count(&host), 1);

    send_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    drop(writer);

    let outcome = tokio::time::timeout(Duration::from_secs(5), cancel)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome, ExecCancelFrameWriteOutcome::AlreadyTerminal);
    assert_eq!(
        write_started_rx.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    );
    assert_eq!(route_reservation_count(&host), 0);
    assert!(is_connected(&host));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

fn clean_terminal_result() -> guest_control_proto::DecodedExecResult<'static> {
    guest_control_proto::DecodedExecResult {
        termination: ExecTermination::Exited { exit_code: 0 },
        duration_ms: 10,
        stdout: ExecCapturedOutput::Discarded,
        stderr: ExecCapturedOutput::Discarded,
        diagnostic: "",
    }
}

fn memory_snapshot(role: &str) -> guest_contracts::oom_evidence::MemorySnapshot {
    use guest_contracts::oom_evidence::{EvidenceStatus, MemoryEvents, MemorySnapshot};
    MemorySnapshot {
        role: role.to_string(),
        cgroup: format!("/vm0-exec/exec-7-1-1/{role}"),
        inode: Some(4_096),
        status: EvidenceStatus::Available,
        current: Some(4_096),
        peak: Some(8_192),
        limit: Some("8192".to_string()),
        initial_limit: Some("8192".to_string()),
        anon: Some(2_048),
        file: Some(1_024),
        kernel: Some(512),
        baseline: MemoryEvents::default(),
        events: MemoryEvents::default(),
        delta: MemoryEvents::default(),
        local_baseline: MemoryEvents::default(),
        local_events: MemoryEvents::default(),
        local_delta: MemoryEvents::default(),
    }
}

/// One bounded evidence envelope exactly as the guest transports it. `proof`
/// selects between a proven OOM decision and an inspected-and-empty capture
/// candidate, which is the distinction the terminal classifier must make.
fn oom_evidence_diagnostic(proof: bool) -> String {
    use guest_contracts::oom_evidence::{
        CaptureReason, EVIDENCE_PREFIX, EvidenceStatus, KernelOomEvent, OomEvidence, OomIncident,
    };
    let mut groups = [
        memory_snapshot("workload"),
        memory_snapshot("runtime"),
        memory_snapshot("tools"),
    ];
    let mut kernel_events = Vec::new();
    if proof {
        groups[0].delta.oom_kill = Some(1);
        groups[0].events.oom_kill = Some(1);
        kernel_events.push(KernelOomEvent {
            source: "guest".to_string(),
            sequence: 42,
            boottime_us: 1_000_000,
            constraint: "CONSTRAINT_MEMCG".to_string(),
            oom_cgroup: Some("/vm0-exec/exec-7-1-1/workload".to_string()),
            victim_pid: 1234,
            victim_comm: "node".to_string(),
            task_cgroup: "/vm0-exec/exec-7-1-1/workload/tools".to_string(),
        });
    }
    let evidence = OomEvidence {
        operation_id: "11111111-1111-4111-8111-111111111111".to_string(),
        guest_boot_id: Some("22222222-2222-4222-8222-222222222222".to_string()),
        started_boottime_us: 500_000,
        sampled_at: "2026-09-09T07:19:59.000Z".to_string(),
        runtime_progress_at: None,
        kernel_cursor: proof.then_some(42),
        kernel_status: if proof {
            EvidenceStatus::Available
        } else {
            EvidenceStatus::Missing
        },
        groups: groups.clone(),
        incidents: vec![OomIncident {
            id: "11111111-1111-4111-8111-111111111111:1".to_string(),
            captured_at: "2026-09-09T07:19:59.000Z".to_string(),
            reason: if proof {
                CaptureReason::Sample
            } else {
                CaptureReason::CliError
            },
            after_observation: true,
            before_cleanup: true,
            kernel_status: if proof {
                EvidenceStatus::Available
            } else {
                EvidenceStatus::Missing
            },
            kernel_events,
            groups,
        }],
        dropped_incidents: 0,
    };
    assert_eq!(
        guest_contracts::oom_evidence::evidence_has_proof(&evidence),
        proof,
        "fixture must exercise the intended branch"
    );
    format!(
        "{EVIDENCE_PREFIX}{}",
        serde_json::to_string(&evidence).unwrap()
    )
}

fn capture_terminal_log_levels(
    lifecycle: ExecTerminalLogLifecycle,
    slow: bool,
    result: &guest_control_proto::DecodedExecResult<'_>,
) -> Vec<Level> {
    capture_terminal_log_levels_with_context(lifecycle, slow, result, false)
}

fn capture_terminal_log_levels_with_context(
    lifecycle: ExecTerminalLogLifecycle,
    slow: bool,
    result: &guest_control_proto::DecodedExecResult<'_>,
    stream_overflowed: bool,
) -> Vec<Level> {
    capture_terminal_log_events_with_context(lifecycle, slow, result, stream_overflowed, false)
        .into_iter()
        .map(|event| event.level)
        .collect()
}

fn capture_terminal_log_events_with_context(
    lifecycle: ExecTerminalLogLifecycle,
    slow: bool,
    result: &guest_control_proto::DecodedExecResult<'_>,
    stream_overflowed: bool,
    host_cancel_requested: bool,
) -> Vec<CapturedEvent> {
    let mut diagnostic = ExecOperationDiagnostic::new(
        7,
        "terminal-log",
        guest_control_proto::ExecProcessRole::Workload,
        false,
        false,
    );
    if slow {
        diagnostic.registered_at =
            Instant::now() - EXEC_OPERATION_STAGE_SLOW_THRESHOLD - Duration::from_millis(1);
    }
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    tracing::subscriber::with_default(subscriber, || {
        tracing::callsite::rebuild_interest_cache();
        diagnostic.log_terminal(lifecycle, result, stream_overflowed, host_cancel_requested);
    });
    captured.entries()
}

fn assert_terminal_log_field(event: &CapturedEvent, field: &str, expected: &str) {
    let value = event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
    assert_eq!(value, expected, "field {field} mismatch; event={event:#?}");
}

fn terminal_log_field_u128(event: &CapturedEvent, field: &str) -> u128 {
    let value = event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
    value
        .parse()
        .unwrap_or_else(|err| panic!("invalid u128 field {field}={value:?}: {err}"))
}

#[test]
fn exec_termination_warning_tracks_low_level_terminal_states() {
    assert!(!exec_termination_requires_low_level_warning(
        ExecTermination::Exited { exit_code: 0 }
    ));
    assert!(!exec_termination_requires_low_level_warning(
        ExecTermination::Exited { exit_code: 1 }
    ));
    assert!(exec_termination_requires_low_level_warning(
        ExecTermination::TimedOut
    ));
    assert!(exec_termination_requires_low_level_warning(
        ExecTermination::Cancelled
    ));
    assert!(exec_termination_requires_low_level_warning(
        ExecTermination::StartFailed
    ));
    assert!(exec_termination_requires_low_level_warning(
        ExecTermination::WaitFailed
    ));
}

#[test]
fn exec_operation_diagnostic_logs_terminal_result_at_classified_level() {
    let clean = clean_terminal_result();
    assert_eq!(
        capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, true, &clean),
        vec![Level::INFO]
    );
    assert_eq!(
        capture_terminal_log_levels(ExecTerminalLogLifecycle::OneShot, true, &clean),
        vec![Level::WARN]
    );
    assert!(
        capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, false, &clean).is_empty()
    );

    let nonzero_exit = guest_control_proto::DecodedExecResult {
        termination: ExecTermination::Exited { exit_code: 1 },
        ..clean
    };
    assert_eq!(
        capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, true, &nonzero_exit),
        vec![Level::INFO]
    );
}

#[test]
fn exec_operation_diagnostic_preserves_terminal_log_fields() {
    let clean = clean_terminal_result();
    let info_events = capture_terminal_log_events_with_context(
        ExecTerminalLogLifecycle::Supervised,
        true,
        &clean,
        false,
        false,
    );
    assert_eq!(info_events.len(), 1, "captured events: {info_events:#?}");
    let info_event = &info_events[0];
    assert_eq!(info_event.level, Level::INFO);
    assert_terminal_log_field(info_event, "message", "exec operation terminal result");
    assert_terminal_log_field(info_event, "seq", "7");
    assert_terminal_log_field(info_event, "label", "terminal-log");
    assert_terminal_log_field(info_event, "slow", "true");
    assert_terminal_log_field(info_event, "lifecycle", "supervised");
    assert_terminal_log_field(info_event, "terminal_reason", "slow");
    assert!(
        terminal_log_field_u128(info_event, "elapsed_ms")
            >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis(),
        "elapsed_ms should preserve the slow terminal duration; event={info_event:#?}"
    );
    assert_terminal_log_field(info_event, "guest_duration_ms", "10");
    assert_terminal_log_field(info_event, "termination", "Exited { exit_code: 0 }");
    assert_terminal_log_field(info_event, "stream_overflowed", "false");
    assert_terminal_log_field(info_event, "stdout_truncated", "false");
    assert_terminal_log_field(info_event, "stderr_truncated", "false");
    assert_terminal_log_field(info_event, "diagnostic_present", "false");
    assert_terminal_log_field(info_event, "host_cancel_requested", "false");

    let warn_result = guest_control_proto::DecodedExecResult {
        termination: ExecTermination::TimedOut,
        duration_ms: 77,
        stdout: ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        stderr: ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        diagnostic: "guest diagnostic",
    };
    let warn_events = capture_terminal_log_events_with_context(
        ExecTerminalLogLifecycle::Supervised,
        false,
        &warn_result,
        true,
        false,
    );
    assert_eq!(warn_events.len(), 1, "captured events: {warn_events:#?}");
    let warn_event = &warn_events[0];
    assert_eq!(warn_event.level, Level::WARN);
    assert_terminal_log_field(warn_event, "message", "exec operation terminal result");
    assert_terminal_log_field(warn_event, "seq", "7");
    assert_terminal_log_field(warn_event, "label", "terminal-log");
    assert_terminal_log_field(warn_event, "slow", "false");
    assert_terminal_log_field(warn_event, "lifecycle", "supervised");
    assert_terminal_log_field(warn_event, "terminal_reason", "notable");
    let _ = terminal_log_field_u128(warn_event, "elapsed_ms");
    assert_terminal_log_field(warn_event, "guest_duration_ms", "77");
    assert_terminal_log_field(warn_event, "termination", "TimedOut");
    assert_terminal_log_field(warn_event, "stream_overflowed", "true");
    assert_terminal_log_field(warn_event, "stdout_truncated", "true");
    assert_terminal_log_field(warn_event, "stderr_truncated", "true");
    assert_terminal_log_field(warn_event, "diagnostic_present", "true");
    assert_terminal_log_field(warn_event, "host_cancel_requested", "false");
}

#[test]
fn exec_operation_diagnostic_logs_host_requested_cancel_as_info() {
    let cancelled = guest_control_proto::DecodedExecResult {
        termination: ExecTermination::Cancelled,
        ..clean_terminal_result()
    };
    let events = capture_terminal_log_events_with_context(
        ExecTerminalLogLifecycle::Supervised,
        false,
        &cancelled,
        false,
        true,
    );

    assert_eq!(events.len(), 1, "captured events: {events:#?}");
    assert_eq!(events[0].level, Level::INFO);
    assert_terminal_log_field(&events[0], "termination", "Cancelled");
    assert_terminal_log_field(&events[0], "host_cancel_requested", "true");
    assert_terminal_log_field(&events[0], "terminal_reason", "expected_cancel");
}

#[test]
fn exec_operation_diagnostic_warns_for_terminal_result_metadata() {
    let clean = clean_terminal_result();
    let stdout_truncated = guest_control_proto::DecodedExecResult {
        stdout: ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        ..clean
    };
    let stderr_truncated = guest_control_proto::DecodedExecResult {
        stderr: ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        ..clean
    };
    let diagnostic_present = guest_control_proto::DecodedExecResult {
        diagnostic: "guest diagnostic",
        ..clean
    };

    for (result, stream_overflowed) in [
        (stdout_truncated, false),
        (stderr_truncated, false),
        (diagnostic_present, false),
        (clean, true),
    ] {
        assert_eq!(
            capture_terminal_log_levels_with_context(
                ExecTerminalLogLifecycle::Supervised,
                false,
                &result,
                stream_overflowed,
            ),
            vec![Level::WARN]
        );
    }
}

#[test]
fn exec_operation_diagnostic_ignores_non_truncated_captured_output() {
    let captured_output = guest_control_proto::DecodedExecResult {
        stdout: ExecCapturedOutput::Captured {
            bytes: b"stdout",
            truncated: false,
        },
        stderr: ExecCapturedOutput::Captured {
            bytes: b"stderr",
            truncated: false,
        },
        ..clean_terminal_result()
    };

    assert!(
        capture_terminal_log_levels(
            ExecTerminalLogLifecycle::Supervised,
            false,
            &captured_output,
        )
        .is_empty()
    );
    assert_eq!(
        capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, true, &captured_output),
        vec![Level::INFO]
    );
}

#[test]
fn exec_operation_diagnostic_treats_nonzero_exits_as_ordinary_terminal_results() {
    let nonzero_exit = guest_control_proto::DecodedExecResult {
        termination: ExecTermination::Exited { exit_code: 66 },
        ..clean_terminal_result()
    };
    assert_eq!(
        capture_terminal_log_levels(ExecTerminalLogLifecycle::Supervised, true, &nonzero_exit),
        vec![Level::INFO]
    );
    assert!(
        capture_terminal_log_levels(ExecTerminalLogLifecycle::OneShot, false, &nonzero_exit)
            .is_empty()
    );

    let nonzero_exit_with_diagnostic = guest_control_proto::DecodedExecResult {
        diagnostic: "nonzero with diagnostic",
        ..nonzero_exit
    };
    assert_eq!(
        capture_terminal_log_levels(
            ExecTerminalLogLifecycle::Supervised,
            true,
            &nonzero_exit_with_diagnostic
        ),
        vec![Level::WARN]
    );
}

fn capture_dispatch_terminal_log_events_with_lifecycle(
    lifecycle: ExecOperationLifecycle,
    label: &str,
) -> (Vec<CapturedEvent>, ExecOperationResult) {
    capture_dispatch_terminal_log_events_with_options(
        lifecycle,
        label,
        ExecTermination::Exited { exit_code: 0 },
        false,
    )
}

fn capture_dispatch_terminal_log_events_with_options(
    lifecycle: ExecOperationLifecycle,
    label: &str,
    termination: ExecTermination,
    host_cancel_requested: bool,
) -> (Vec<CapturedEvent>, ExecOperationResult) {
    let (result_tx, mut result_rx) = oneshot::channel();
    let (shared, _read_stream, _diagnostic) =
        shared_with_logged_operation(lifecycle, label, result_tx, host_cancel_requested);
    let payload = guest_control_proto::encode_exec_result(
        termination,
        10,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    let msg = RawMessage {
        msg_type: MSG_EXEC_RESULT,
        seq: 7,
        payload,
    };

    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    tracing::subscriber::with_default(subscriber, || {
        tracing::callsite::rebuild_interest_cache();
        dispatch_result(&shared, msg.as_borrowed()).unwrap();
    });

    let events = captured.entries();
    let result = result_rx.try_recv().unwrap().unwrap();
    (events, result)
}

fn shared_with_logged_operation(
    lifecycle: ExecOperationLifecycle,
    label: &str,
    result_tx: oneshot::Sender<io::Result<ExecOperationResult>>,
    host_cancel_requested: bool,
) -> (Arc<Shared>, tokio::net::UnixStream, ExecOperationDiagnostic) {
    let (read_stream, write_stream) = tokio::net::UnixStream::pair().unwrap();
    let fd = write_stream.as_raw_fd();
    let (_read_half, write_half) = write_stream.into_split();
    let shared = Arc::new(Shared {
        writer: tokio::sync::Mutex::new(write_half),
        frame_builder: tokio::sync::Mutex::new(()),
        file_write_gate: tokio::sync::Mutex::new(()),
        fd,
        temp_seq: AtomicU32::new(2),
        state: std::sync::Mutex::new(ConnectionState::Connected {
            next_route_id: 2,
            route_reservations: HashMap::new(),
            pending: HashMap::new(),
            operations: Operations::new(),
        }),
        normal_operations: crate::operation_tracker::NormalOperationTracker::new(),
        close_notify: tokio::sync::Notify::new(),
        exec_output_before_copy_hook: std::sync::Mutex::new(None),
    });
    let mut diagnostic = ExecOperationDiagnostic::new(
        7,
        label,
        guest_control_proto::ExecProcessRole::Workload,
        false,
        false,
    );
    diagnostic.registered_at =
        Instant::now() - EXEC_OPERATION_STAGE_SLOW_THRESHOLD - Duration::from_millis(1);
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let ConnectionState::Connected { operations, .. } = &mut *guard else {
            panic!("test shared state must be connected");
        };
        let route_id = RouteId::from_raw(7);
        operations.insert(
            route_id,
            ExecOperation {
                route_id,
                normal_operation: None,
                lifecycle,
                diagnostic: diagnostic.clone(),
                result_tx,
                stream_tx: None,
                stdout_capture: ExecCaptureState::Discard,
                stderr_capture: ExecCaptureState::Discard,
                stdout_stream: None,
                stderr_stream: None,
                expected_output_seq: 0,
                stream_overflowed: false,
                host_cancel_requested,
                pending_controls: HashMap::new(),
            },
        );
    }
    (shared, read_stream, diagnostic)
}

#[tokio::test]
async fn dispatch_result_logs_terminal_result_with_operation_lifecycle() {
    let (supervised_events, supervised_result) =
        capture_dispatch_terminal_log_events_with_lifecycle(
            ExecOperationLifecycle::SupervisedStarted {
                pid: 42,
                control_nonce: None,
            },
            "dispatch-supervised-terminal-log",
        );
    assert_eq!(
        supervised_events.len(),
        1,
        "captured events: {supervised_events:#?}"
    );
    assert_eq!(supervised_events[0].level, Level::INFO);
    assert_terminal_log_field(
        &supervised_events[0],
        "label",
        "dispatch-supervised-terminal-log",
    );
    assert_terminal_log_field(&supervised_events[0], "lifecycle", "supervised");
    assert_terminal_log_field(&supervised_events[0], "terminal_reason", "slow");
    assert_eq!(
        supervised_result.termination,
        ExecTermination::Exited { exit_code: 0 }
    );

    let (one_shot_events, one_shot_result) = capture_dispatch_terminal_log_events_with_lifecycle(
        ExecOperationLifecycle::OneShot,
        "dispatch-one-shot-terminal-log",
    );
    assert_eq!(
        one_shot_events.len(),
        1,
        "captured events: {one_shot_events:#?}"
    );
    assert_eq!(one_shot_events[0].level, Level::WARN);
    assert_terminal_log_field(
        &one_shot_events[0],
        "label",
        "dispatch-one-shot-terminal-log",
    );
    assert_terminal_log_field(&one_shot_events[0], "lifecycle", "one_shot");
    assert_terminal_log_field(&one_shot_events[0], "terminal_reason", "slow");
    assert_eq!(
        one_shot_result.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
}

#[tokio::test]
async fn dispatch_result_logs_host_requested_cancel_as_info() {
    let lifecycle = ExecOperationLifecycle::SupervisedStarted {
        pid: 42,
        control_nonce: None,
    };
    let (events, result) = capture_dispatch_terminal_log_events_with_options(
        lifecycle,
        "dispatch-host-cancelled-terminal-log",
        ExecTermination::Cancelled,
        true,
    );

    assert_eq!(events.len(), 1, "captured events: {events:#?}");
    assert_eq!(events[0].level, Level::INFO);
    assert_terminal_log_field(&events[0], "termination", "Cancelled");
    assert_terminal_log_field(&events[0], "host_cancel_requested", "true");
    assert_terminal_log_field(&events[0], "terminal_reason", "expected_cancel");
    assert_eq!(result.termination, ExecTermination::Cancelled);
}

#[tokio::test]
async fn supervised_cancel_frame_marks_terminal_result_as_host_requested_cancel() {
    let (result_tx, mut result_rx) = oneshot::channel();
    let lifecycle = ExecOperationLifecycle::SupervisedStarted {
        pid: 42,
        control_nonce: None,
    };
    let (shared, _read_stream, diagnostic) = shared_with_logged_operation(
        lifecycle,
        "supervised-cancel-marker-terminal-log",
        result_tx,
        false,
    );

    send_exec_cancel_frame(
        &shared,
        RouteId::from_raw(7),
        &diagnostic,
        ExecWaitLifecycle::Supervised,
    )
    .await
    .unwrap();

    let payload = guest_control_proto::encode_exec_result(
        ExecTermination::Cancelled,
        10,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    let msg = RawMessage {
        msg_type: MSG_EXEC_RESULT,
        seq: 7,
        payload,
    };

    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    tracing::subscriber::with_default(subscriber, || {
        tracing::callsite::rebuild_interest_cache();
        dispatch_result(&shared, msg.as_borrowed()).unwrap();
    });

    let events = captured.entries();
    assert_eq!(events.len(), 1, "captured events: {events:#?}");
    assert_eq!(events[0].level, Level::INFO);
    assert_terminal_log_field(&events[0], "termination", "Cancelled");
    assert_terminal_log_field(&events[0], "host_cancel_requested", "true");
    assert_eq!(
        result_rx.try_recv().unwrap().unwrap().termination,
        ExecTermination::Cancelled
    );
}

#[tokio::test]
async fn one_shot_cancel_handle_marks_terminal_result_as_host_requested_cancel() {
    let (result_tx, result_rx) = oneshot::channel();
    let (shared, mut read_stream, diagnostic) = shared_with_logged_operation(
        ExecOperationLifecycle::OneShot,
        "one-shot-cancel-marker-terminal-log",
        result_tx,
        false,
    );
    let handle = ExecOperationHandle {
        wait_core: ExecWaitCore::new(
            Arc::clone(&shared),
            RouteId::from_raw(7),
            diagnostic,
            result_rx,
        ),
        stream_rx: None,
    };

    let cancel_future = handle.cancel_and_wait_for_terminal_status(Duration::from_secs(5));
    let peer = async {
        let cancel = read_guest_message(&mut read_stream).await;
        assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
        assert_eq!(cancel.seq, 7);
        guest_control_proto::decode_exec_cancel(&cancel.payload).unwrap();

        let payload = guest_control_proto::encode_exec_result(
            ExecTermination::Cancelled,
            10,
            ExecCapturedOutput::Discarded,
            ExecCapturedOutput::Discarded,
            "",
        )
        .unwrap();
        let msg = RawMessage {
            msg_type: MSG_EXEC_RESULT,
            seq: 7,
            payload,
        };

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::callsite::rebuild_interest_cache();
            dispatch_result(&shared, msg.as_borrowed()).unwrap();
        });

        let events = captured.entries();
        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        assert_eq!(events[0].level, Level::INFO);
        assert_terminal_log_field(&events[0], "termination", "Cancelled");
        assert_terminal_log_field(&events[0], "host_cancel_requested", "true");
    };

    let (wait_result, ()) = tokio::join!(cancel_future, peer);
    let wait_result = wait_result.into_result().unwrap();
    assert_eq!(wait_result.cancel_seq, Some(7));
    assert_eq!(wait_result.result.termination, ExecTermination::Cancelled);
}

#[test]
fn exec_terminal_log_lifecycle_maps_supervised_states() {
    let (start_tx, _start_rx) = oneshot::channel();
    let awaiting_start = ExecOperationLifecycle::SupervisedAwaitingStart {
        start_tx: Some(start_tx),
        role: ExecProcessRole::Workload,
        control_nonce: None,
    };
    let started = ExecOperationLifecycle::SupervisedStarted {
        pid: 42,
        control_nonce: None,
    };

    assert_eq!(
        exec_terminal_log_lifecycle(&ExecOperationLifecycle::OneShot),
        ExecTerminalLogLifecycle::OneShot
    );
    assert_eq!(
        exec_terminal_log_lifecycle(&awaiting_start),
        ExecTerminalLogLifecycle::Supervised
    );
    assert_eq!(
        exec_terminal_log_lifecycle(&started),
        ExecTerminalLogLifecycle::Supervised
    );
}

fn clean_terminal_log_context(
    lifecycle: ExecTerminalLogLifecycle,
    slow: bool,
    termination: ExecTermination,
) -> ExecTerminalLogContext {
    ExecTerminalLogContext {
        lifecycle,
        timeout_is_expected: false,
        slow,
        termination,
        stdout_truncated: false,
        stderr_truncated: false,
        stream_overflowed: false,
        actionable_diagnostic: false,
        evidence_has_proof: false,
        contained_tool_oom: false,
        evidence_malformed: false,
        host_cancel_requested: false,
    }
}

#[test]
fn exec_terminal_log_severity_demotes_slow_clean_supervised_result() {
    let context = clean_terminal_log_context(
        ExecTerminalLogLifecycle::Supervised,
        true,
        ExecTermination::Exited { exit_code: 0 },
    );

    assert_eq!(
        exec_terminal_log_severity(context),
        Some(ExecTerminalLogSeverity::Info)
    );
}

#[test]
fn exec_terminal_log_severity_warns_for_slow_clean_one_shot_result() {
    let context = clean_terminal_log_context(
        ExecTerminalLogLifecycle::OneShot,
        true,
        ExecTermination::Exited { exit_code: 0 },
    );

    assert_eq!(
        exec_terminal_log_severity(context),
        Some(ExecTerminalLogSeverity::Warn)
    );
}

#[test]
fn exec_terminal_log_decision_reports_low_cardinality_reason() {
    let slow_one_shot = clean_terminal_log_context(
        ExecTerminalLogLifecycle::OneShot,
        true,
        ExecTermination::Exited { exit_code: 0 },
    );
    let slow_decision = exec_terminal_log_decision(slow_one_shot).unwrap();
    assert_eq!(slow_decision.severity, ExecTerminalLogSeverity::Warn);
    assert_eq!(slow_decision.reason, ExecTerminalLogReason::Slow);

    let notable = ExecTerminalLogContext {
        actionable_diagnostic: true,
        ..clean_terminal_log_context(
            ExecTerminalLogLifecycle::OneShot,
            true,
            ExecTermination::Exited { exit_code: 0 },
        )
    };
    let notable_decision = exec_terminal_log_decision(notable).unwrap();
    assert_eq!(notable_decision.severity, ExecTerminalLogSeverity::Warn);
    assert_eq!(notable_decision.reason, ExecTerminalLogReason::Notable);

    let expected_cancel = ExecTerminalLogContext {
        host_cancel_requested: true,
        ..clean_terminal_log_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            ExecTermination::Cancelled,
        )
    };
    let cancel_decision = exec_terminal_log_decision(expected_cancel).unwrap();
    assert_eq!(cancel_decision.severity, ExecTerminalLogSeverity::Info);
    assert_eq!(
        cancel_decision.reason,
        ExecTerminalLogReason::ExpectedCancel
    );
}

#[test]
fn exec_terminal_log_severity_suppresses_clean_fast_results() {
    for lifecycle in [
        ExecTerminalLogLifecycle::OneShot,
        ExecTerminalLogLifecycle::Supervised,
    ] {
        let context =
            clean_terminal_log_context(lifecycle, false, ExecTermination::Exited { exit_code: 0 });

        assert_eq!(exec_terminal_log_severity(context), None);
    }
}

#[test]
fn exec_terminal_log_severity_treats_nonzero_exits_as_ordinary_results() {
    let fast_nonzero = clean_terminal_log_context(
        ExecTerminalLogLifecycle::Supervised,
        false,
        ExecTermination::Exited { exit_code: 66 },
    );
    let slow_nonzero = ExecTerminalLogContext {
        slow: true,
        ..fast_nonzero
    };
    let fast_one_shot_nonzero = ExecTerminalLogContext {
        lifecycle: ExecTerminalLogLifecycle::OneShot,
        ..fast_nonzero
    };
    let slow_one_shot_nonzero = ExecTerminalLogContext {
        lifecycle: ExecTerminalLogLifecycle::OneShot,
        ..slow_nonzero
    };

    assert_eq!(exec_terminal_log_severity(fast_nonzero), None);
    assert_eq!(exec_terminal_log_severity(fast_one_shot_nonzero), None);
    assert_eq!(
        exec_terminal_log_severity(slow_nonzero),
        Some(ExecTerminalLogSeverity::Info)
    );
    assert_eq!(
        exec_terminal_log_severity(slow_one_shot_nonzero),
        Some(ExecTerminalLogSeverity::Warn)
    );
}

#[test]
fn exec_terminal_log_severity_suppresses_fast_nonzero_exits() {
    for lifecycle in [
        ExecTerminalLogLifecycle::OneShot,
        ExecTerminalLogLifecycle::Supervised,
    ] {
        let context =
            clean_terminal_log_context(lifecycle, false, ExecTermination::Exited { exit_code: 1 });

        assert_eq!(exec_terminal_log_severity(context), None);
    }
}

#[test]
fn exec_terminal_log_severity_warns_for_notable_slow_supervised_result() {
    let clean_slow = clean_terminal_log_context(
        ExecTerminalLogLifecycle::Supervised,
        true,
        ExecTermination::Exited { exit_code: 0 },
    );
    for context in [
        ExecTerminalLogContext {
            stdout_truncated: true,
            ..clean_slow
        },
        ExecTerminalLogContext {
            stderr_truncated: true,
            ..clean_slow
        },
        ExecTerminalLogContext {
            stream_overflowed: true,
            ..clean_slow
        },
        ExecTerminalLogContext {
            actionable_diagnostic: true,
            ..clean_slow
        },
        ExecTerminalLogContext {
            termination: ExecTermination::TimedOut,
            ..clean_slow
        },
    ] {
        assert_eq!(
            exec_terminal_log_severity(context),
            Some(ExecTerminalLogSeverity::Warn)
        );
    }
}

#[test]
fn exec_terminal_log_severity_warns_for_notable_result_metadata() {
    for lifecycle in [
        ExecTerminalLogLifecycle::OneShot,
        ExecTerminalLogLifecycle::Supervised,
    ] {
        let clean =
            clean_terminal_log_context(lifecycle, false, ExecTermination::Exited { exit_code: 0 });
        for context in [
            ExecTerminalLogContext {
                stdout_truncated: true,
                ..clean
            },
            ExecTerminalLogContext {
                stderr_truncated: true,
                ..clean
            },
            ExecTerminalLogContext {
                stream_overflowed: true,
                ..clean
            },
            ExecTerminalLogContext {
                actionable_diagnostic: true,
                ..clean
            },
        ] {
            assert_eq!(
                exec_terminal_log_severity(context),
                Some(ExecTerminalLogSeverity::Warn)
            );
        }
    }
}

#[test]
fn exec_terminal_log_severity_demotes_expected_host_cancel() {
    for lifecycle in [
        ExecTerminalLogLifecycle::OneShot,
        ExecTerminalLogLifecycle::Supervised,
    ] {
        let context = ExecTerminalLogContext {
            host_cancel_requested: true,
            ..clean_terminal_log_context(lifecycle, false, ExecTermination::Cancelled)
        };

        assert_eq!(
            exec_terminal_log_severity(context),
            Some(ExecTerminalLogSeverity::Info)
        );
    }
}

#[test]
fn exec_terminal_log_severity_warns_for_expected_host_cancel_with_metadata() {
    let clean_cancel = ExecTerminalLogContext {
        host_cancel_requested: true,
        ..clean_terminal_log_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            ExecTermination::Cancelled,
        )
    };
    for context in [
        ExecTerminalLogContext {
            stdout_truncated: true,
            ..clean_cancel
        },
        ExecTerminalLogContext {
            stderr_truncated: true,
            ..clean_cancel
        },
        ExecTerminalLogContext {
            stream_overflowed: true,
            ..clean_cancel
        },
        ExecTerminalLogContext {
            actionable_diagnostic: true,
            ..clean_cancel
        },
        ExecTerminalLogContext {
            evidence_malformed: true,
            ..clean_cancel
        },
    ] {
        assert_eq!(
            exec_terminal_log_severity(context),
            Some(ExecTerminalLogSeverity::Warn)
        );
    }
}

#[test]
fn exec_operation_diagnostic_does_not_warn_for_capture_candidate_metadata() {
    let candidate = oom_evidence_diagnostic(false);
    for exit_code in [0, 1, 124] {
        let result = guest_control_proto::DecodedExecResult {
            termination: ExecTermination::Exited { exit_code },
            diagnostic: candidate.as_str(),
            ..clean_terminal_result()
        };

        assert!(
            capture_terminal_log_events_with_context(
                ExecTerminalLogLifecycle::Supervised,
                false,
                &result,
                false,
                false,
            )
            .is_empty(),
            "metadata-only terminal result must not be logged; exit_code={exit_code}"
        );
    }
}

#[test]
fn exec_operation_diagnostic_reports_metadata_counts_without_the_payload() {
    let diagnostic = oom_evidence_diagnostic(true);
    let result = guest_control_proto::DecodedExecResult {
        diagnostic: diagnostic.as_str(),
        ..clean_terminal_result()
    };
    let events = capture_terminal_log_events_with_context(
        ExecTerminalLogLifecycle::Supervised,
        false,
        &result,
        false,
        false,
    );

    assert_eq!(events.len(), 1, "captured events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::WARN);
    assert_terminal_log_field(event, "terminal_reason", "oom_evidence");
    assert_terminal_log_field(event, "termination", "Exited { exit_code: 0 }");
    assert_terminal_log_field(event, "diagnostic_present", "false");
    assert_terminal_log_field(event, "oom_evidence", "true");
    assert_terminal_log_field(event, "oom_evidence_proof", "true");
    assert_terminal_log_field(event, "oom_evidence_malformed", "false");
    assert_terminal_log_field(event, "oom_incidents", "1");
    assert_terminal_log_field(event, "oom_kernel_events", "1");
    assert_terminal_log_field(event, "oom_dropped_incidents", "0");
    assert!(
        !event
            .fields
            .values()
            .any(|value| value.contains("OKOU_OOM_EVIDENCE_V1") || value.contains("victim_comm")),
        "metadata payload must never be logged; event={event:#?}"
    );
}

#[test]
fn exec_operation_diagnostic_preserves_a_real_diagnostic_carried_beside_metadata() {
    let diagnostic = format!(
        "Failed to wait: no child processes\n{}",
        oom_evidence_diagnostic(false)
    );
    let result = guest_control_proto::DecodedExecResult {
        termination: ExecTermination::WaitFailed,
        diagnostic: diagnostic.as_str(),
        ..clean_terminal_result()
    };
    let events = capture_terminal_log_events_with_context(
        ExecTerminalLogLifecycle::Supervised,
        false,
        &result,
        false,
        false,
    );

    assert_eq!(events.len(), 1, "captured events: {events:#?}");
    assert_eq!(events[0].level, Level::WARN);
    assert_terminal_log_field(&events[0], "terminal_reason", "notable");
    assert_terminal_log_field(&events[0], "diagnostic_present", "true");
    assert_terminal_log_field(&events[0], "oom_evidence", "true");
}

#[test]
fn exec_operation_diagnostic_warns_for_a_broken_metadata_envelope() {
    for diagnostic in [
        format!("{}not json", guest_contracts::oom_evidence::EVIDENCE_PREFIX),
        format!(
            "{}{}",
            guest_contracts::oom_evidence::EVIDENCE_PREFIX,
            "x".repeat(guest_contracts::oom_evidence::MAX_EVIDENCE_BYTES + 1)
        ),
    ] {
        let result = guest_control_proto::DecodedExecResult {
            diagnostic: diagnostic.as_str(),
            ..clean_terminal_result()
        };
        let events = capture_terminal_log_events_with_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            &result,
            false,
            false,
        );

        assert_eq!(events.len(), 1, "captured events: {events:#?}");
        assert_eq!(events[0].level, Level::WARN);
        assert_terminal_log_field(&events[0], "terminal_reason", "notable");
        assert_terminal_log_field(&events[0], "oom_evidence_malformed", "true");
        assert_terminal_log_field(&events[0], "oom_evidence", "false");
        // A broken envelope is never promoted into a user-facing diagnostic.
        assert_terminal_log_field(&events[0], "diagnostic_present", "false");
    }
}

#[test]
fn exec_terminal_log_severity_keeps_expected_host_cancel_with_capture_candidate() {
    let context = ExecTerminalLogContext {
        host_cancel_requested: true,
        ..clean_terminal_log_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            ExecTermination::Cancelled,
        )
    };

    // Bounded metadata rides the diagnostic transport; it must not turn a
    // host-requested cancellation into an actionable warning.
    assert_eq!(
        exec_terminal_log_severity(context),
        Some(ExecTerminalLogSeverity::Info)
    );
}

#[test]
fn exec_terminal_log_severity_keeps_expected_timeout_with_capture_candidate() {
    let context = ExecTerminalLogContext {
        timeout_is_expected: true,
        ..clean_terminal_log_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            ExecTermination::TimedOut,
        )
    };

    assert_eq!(
        exec_terminal_log_severity(context),
        Some(ExecTerminalLogSeverity::Info)
    );
}

#[test]
fn exec_terminal_log_severity_ignores_a_capture_candidate_on_an_ordinary_exit() {
    for (lifecycle, slow, expected) in [
        (ExecTerminalLogLifecycle::Supervised, false, None),
        (ExecTerminalLogLifecycle::OneShot, false, None),
        (
            ExecTerminalLogLifecycle::Supervised,
            true,
            Some(ExecTerminalLogSeverity::Info),
        ),
        (
            ExecTerminalLogLifecycle::OneShot,
            true,
            Some(ExecTerminalLogSeverity::Warn),
        ),
    ] {
        for exit_code in [0, 1, 124] {
            let context =
                clean_terminal_log_context(lifecycle, slow, ExecTermination::Exited { exit_code });

            assert_eq!(
                exec_terminal_log_severity(context),
                expected,
                "candidate metadata must classify exactly like no metadata; \
                 lifecycle={lifecycle:?} slow={slow} exit_code={exit_code}"
            );
        }
    }
}

#[test]
fn exec_terminal_log_decision_reports_proven_oom_on_an_ordinary_exit() {
    for exit_code in [0, 1] {
        let context = ExecTerminalLogContext {
            evidence_has_proof: true,
            ..clean_terminal_log_context(
                ExecTerminalLogLifecycle::Supervised,
                false,
                ExecTermination::Exited { exit_code },
            )
        };
        let decision = exec_terminal_log_decision(context).unwrap();

        assert_eq!(decision.severity, ExecTerminalLogSeverity::Warn);
        assert_eq!(decision.reason, ExecTerminalLogReason::OomEvidence);
    }
}

#[test]
fn exec_terminal_log_decision_prefers_a_real_failure_over_proven_oom() {
    let context = ExecTerminalLogContext {
        evidence_has_proof: true,
        actionable_diagnostic: true,
        ..clean_terminal_log_context(
            ExecTerminalLogLifecycle::Supervised,
            false,
            ExecTermination::WaitFailed,
        )
    };
    let decision = exec_terminal_log_decision(context).unwrap();

    assert_eq!(decision.severity, ExecTerminalLogSeverity::Warn);
    assert_eq!(decision.reason, ExecTerminalLogReason::Notable);
}

#[test]
fn exec_terminal_log_severity_warns_for_host_cancel_with_failure_terminations() {
    for termination in [
        ExecTermination::TimedOut,
        ExecTermination::StartFailed,
        ExecTermination::WaitFailed,
    ] {
        let context = ExecTerminalLogContext {
            host_cancel_requested: true,
            ..clean_terminal_log_context(ExecTerminalLogLifecycle::Supervised, false, termination)
        };

        assert_eq!(
            exec_terminal_log_severity(context),
            Some(ExecTerminalLogSeverity::Warn)
        );
    }
}

#[test]
fn exec_terminal_log_severity_warns_for_non_exit_terminations() {
    for lifecycle in [
        ExecTerminalLogLifecycle::OneShot,
        ExecTerminalLogLifecycle::Supervised,
    ] {
        for termination in [
            ExecTermination::TimedOut,
            ExecTermination::Cancelled,
            ExecTermination::StartFailed,
            ExecTermination::WaitFailed,
        ] {
            let context = clean_terminal_log_context(lifecycle, false, termination);

            assert_eq!(
                exec_terminal_log_severity(context),
                Some(ExecTerminalLogSeverity::Warn)
            );
        }
    }
}

#[test]
fn exec_operation_label_log_truncates_at_utf8_boundary() {
    let exact = "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES);
    assert_eq!(exec_operation_label_log(&exact), exact);

    let over_ascii = format!("{}b", "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES));
    assert_eq!(
        exec_operation_label_log(&over_ascii),
        format!(
            "{}...",
            "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES)
        )
    );

    let boundary = format!(
        "{}\u{00e9}tail",
        "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES - 2)
    );
    assert_eq!(
        exec_operation_label_log(&boundary),
        format!(
            "{}\u{00e9}...",
            "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES - 2)
        )
    );

    let crossing = format!(
        "{}\u{00e9}tail",
        "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES - 1)
    );
    assert_eq!(
        exec_operation_label_log(&crossing),
        format!(
            "{}...",
            "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES - 1)
        )
    );
}

#[test]
fn exec_operation_diagnostic_keeps_only_truncated_label_log() {
    let label = format!(
        "{}secret-tail",
        "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES)
    );
    let mut diagnostic = ExecOperationDiagnostic::new(
        7,
        &label,
        guest_control_proto::ExecProcessRole::Workload,
        false,
        false,
    );
    diagnostic.registered_at =
        Instant::now() - EXEC_OPERATION_STAGE_SLOW_THRESHOLD - Duration::from_millis(1);

    assert_eq!(
        diagnostic.label_log,
        format!(
            "{}...",
            "a".repeat(EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES)
        )
    );
    assert!(!diagnostic.label_log.contains("secret-tail"));
    assert_eq!(diagnostic.frame("start").label_log, diagnostic.label_log);
    assert_eq!(diagnostic.snapshot().label_log, diagnostic.label_log);
    assert_eq!(diagnostic.process_class, "contained_workload");
    assert_eq!(diagnostic.operation_kind, "exec");
    assert_eq!(
        diagnostic.mark_first_output().unwrap().label_log,
        diagnostic.label_log
    );
}

#[test]
fn exec_operation_diagnostic_derives_agent_class_and_operation_kind() {
    let diagnostic = ExecOperationDiagnostic::new(
        8,
        "agent",
        guest_control_proto::ExecProcessRole::Agent,
        true,
        false,
    );

    assert_eq!(diagnostic.process_class, "controlled_agent");
    assert_eq!(diagnostic.operation_kind, "start_agent_process");
    let frame = diagnostic.frame("start");
    assert_eq!(frame.process_class, "controlled_agent");
    assert_eq!(frame.operation_kind, "start_agent_process");
    let snapshot = diagnostic.snapshot();
    assert_eq!(snapshot.process_class, "controlled_agent");
    assert_eq!(snapshot.operation_kind, "start_agent_process");
}

#[test]
fn exec_operation_diagnostic_marks_only_first_slow_output() {
    let mut diagnostic = ExecOperationDiagnostic {
        seq: 9,
        timeout_is_expected: false,
        label_log: "slow-first-output".to_string(),
        registered_at: Instant::now()
            - EXEC_OPERATION_STAGE_SLOW_THRESHOLD
            - Duration::from_millis(1),
        first_output_at: None,
        process_class: "contained_workload",
        operation_kind: "exec",
    };

    let snapshot = diagnostic.mark_first_output().unwrap();
    assert_eq!(snapshot.seq, 9);
    assert_eq!(snapshot.label_log, "slow-first-output");
    assert!(snapshot.elapsed_ms >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD.as_millis());
    assert!(diagnostic.mark_first_output().is_none());
}

#[test]
fn exec_operation_close_snapshot_limits_logged_operations() {
    let active_count = EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT + 3;
    let mut operations = Operations::new();
    for seq in 0..active_count {
        operations.insert(
            RouteId::from_raw(seq as u64),
            exec_operation_for_snapshot(seq as u32, &format!("operation-{seq}")),
        );
    }

    let snapshot = operations.close_snapshot();
    assert_eq!(snapshot.active_count, active_count);
    assert_eq!(
        snapshot.operations.len(),
        EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT
    );
    assert_eq!(
        snapshot.active_count - snapshot.operations.len(),
        active_count - EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT
    );
    for operation in snapshot.operations {
        assert!(operations.contains_seq(operation.seq));
        assert!(operation.label_log.starts_with("operation-"));
    }
}

#[test]
fn contained_tool_oom_log_retains_evidence_and_independent_failures() {
    use guest_contracts::oom_evidence::{EVIDENCE_PREFIX, OomEvidence};
    let evidence: OomEvidence = serde_json::from_str(include_str!(
        "../../../guest-contracts/tests/fixtures/contained-tool-oom.json"
    ))
    .unwrap();
    let diagnostic =
        ExecOperationDiagnostic::new(7, "guest-agent", ExecProcessRole::Agent, true, false);
    let metadata = format!(
        "{EVIDENCE_PREFIX}{}",
        serde_json::to_string(&evidence).unwrap()
    );
    for (termination, overflow, residual, expected) in [
        (
            ExecTermination::Exited { exit_code: 0 },
            false,
            "",
            Level::INFO,
        ),
        (
            ExecTermination::Exited { exit_code: 1 },
            false,
            "",
            Level::WARN,
        ),
        (
            ExecTermination::Exited { exit_code: 124 },
            false,
            "",
            Level::WARN,
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            true,
            "",
            Level::WARN,
        ),
        (
            ExecTermination::Exited { exit_code: 0 },
            false,
            "disk failure\n",
            Level::WARN,
        ),
        (ExecTermination::TimedOut, false, "", Level::WARN),
        (ExecTermination::Cancelled, false, "", Level::WARN),
        (ExecTermination::StartFailed, false, "", Level::WARN),
        (ExecTermination::WaitFailed, false, "", Level::WARN),
    ] {
        let transported = format!("{residual}{metadata}");
        let result = guest_control_proto::DecodedExecResult {
            termination,
            diagnostic: &transported,
            ..clean_terminal_result()
        };
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            diagnostic.log_terminal(
                ExecTerminalLogLifecycle::Supervised,
                &result,
                overflow,
                true,
            );
        });
        let events = captured.entries();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].level, expected,
            "termination={termination:?}, overflow={overflow}, residual={residual}"
        );
        assert_terminal_log_field(&events[0], "oom_classification", "contained_tool_oom");
        assert_terminal_log_field(&events[0], "oom_incidents", "1");
        assert_terminal_log_field(&events[0], "oom_kernel_events", "1");
        assert!(events[0].fields["operation_id"].contains(&evidence.operation_id));
        assert_eq!(
            result.diagnostic, transported,
            "logging must not consume retained evidence"
        );
    }
    for (seq, role, evidence) in [
        (8, ExecProcessRole::Agent, evidence.clone()),
        (7, ExecProcessRole::Workload, evidence.clone()),
        (
            7,
            ExecProcessRole::Agent,
            OomEvidence {
                runtime_progress_at: None,
                ..evidence
            },
        ),
    ] {
        let diagnostic = ExecOperationDiagnostic::new(seq, "guest-agent", role, true, false);
        let transported = format!(
            "{EVIDENCE_PREFIX}{}",
            serde_json::to_string(&evidence).unwrap()
        );
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, || {
            diagnostic.log_terminal(
                ExecTerminalLogLifecycle::Supervised,
                &guest_control_proto::DecodedExecResult {
                    diagnostic: &transported,
                    ..clean_terminal_result()
                },
                false,
                false,
            );
        });
        assert_eq!(
            captured.entries()[0].level,
            Level::WARN,
            "stale route, wrong role, or exit zero without progress"
        );
    }
}
