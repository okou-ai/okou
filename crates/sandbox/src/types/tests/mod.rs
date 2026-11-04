use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

fn guest_agent_start_timing() -> GuestAgentStartTiming {
    let ready_at = Instant::now();
    GuestAgentStartTiming {
        shell_started_at: ready_at,
        ready_at,
        containment_create: Duration::ZERO,
        placement_broker_setup: Duration::ZERO,
        shell_spawn: Duration::ZERO,
        bootstrap_ready_wait: Duration::ZERO,
    }
}

#[test]
fn timeout_ms_normal() {
    let req = ExecRequest {
        cmd: "echo hi",
        timeout: Duration::from_millis(5000),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };
    assert_eq!(req.timeout_ms(), 5000);
}

#[test]
fn timeout_ms_zero() {
    let req = ExecRequest {
        cmd: "true",
        timeout: Duration::ZERO,
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };
    assert_eq!(req.timeout_ms(), 0);
}

#[test]
fn timeout_ms_rounds_nonzero_submillisecond_up() {
    let req = ExecRequest {
        cmd: "true",
        timeout: Duration::from_nanos(1),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };
    assert_eq!(req.timeout_ms(), 1);
}

#[test]
fn start_process_timeout_ms_rounds_nonzero_submillisecond_up() {
    let req = StartProcessRequest {
        timeout_is_expected: false,
        cmd: "true",
        start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
        timeout: Duration::from_nanos(1),
        env: &[],
        sudo: false,
        output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
    };
    assert_eq!(req.timeout_ms(), 1);
}

#[test]
fn start_agent_process_timeout_rounds_nonzero_submillisecond_up() {
    let req = StartAgentProcessRequest {
        timeout: Duration::from_nanos(1),
        env: &[],
        output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
    };
    assert_eq!(req.timeout_ms(), 1);
}

#[test]
fn copy_file_timeout_ms_rounds_nonzero_submillisecond_up() {
    let options = CopyFileOptions {
        max_bytes: 1024,
        timeout: Duration::from_nanos(1),
        missing_ok: false,
    };
    assert_eq!(options.timeout_ms(), 1);
}

#[test]
fn timeout_ms_saturates_at_u32_max() {
    let req = ExecRequest {
        cmd: "sleep infinity",
        timeout: Duration::from_secs(u64::MAX / 1000),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };
    assert_eq!(req.timeout_ms(), u32::MAX);
}

#[test]
fn timeout_ms_exact_u32_max() {
    let req = ExecRequest {
        cmd: "cmd",
        timeout: Duration::from_millis(u32::MAX as u64),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };
    assert_eq!(req.timeout_ms(), u32::MAX);
}

#[test]
fn process_output_mode_stream_uses_bounded_defaults() {
    assert_eq!(
        ProcessOutputMode::stream(),
        ProcessOutputMode::Stream {
            stream_limit_bytes: ProcessOutputMode::DEFAULT_STREAM_LIMIT_BYTES,
            chunk_limit_bytes: 64 * 1024,
            queue_capacity: ProcessOutputMode::DEFAULT_QUEUE_CAPACITY,
            stderr_capture_limit_bytes: None,
        }
    );
}

#[test]
fn process_output_mode_stream_with_stderr_capture_uses_bounded_defaults() {
    assert_eq!(
        ProcessOutputMode::stream_with_stderr_capture(4096),
        ProcessOutputMode::Stream {
            stream_limit_bytes: ProcessOutputMode::DEFAULT_STREAM_LIMIT_BYTES,
            chunk_limit_bytes: 64 * 1024,
            queue_capacity: ProcessOutputMode::DEFAULT_QUEUE_CAPACITY,
            stderr_capture_limit_bytes: Some(4096),
        }
    );
}

#[test]
fn exec_termination_deserializes_valid_shapes() {
    for (value, expected) in [
        (
            serde_json::json!({
                "kind": "exited",
                "exit_code": 0,
            }),
            ExecTermination::Exited { exit_code: 0 },
        ),
        (
            serde_json::json!({
                "kind": "exited",
                "exit_code": -1,
            }),
            ExecTermination::Exited { exit_code: -1 },
        ),
        (
            serde_json::json!({
                "kind": "exited",
                "exit_code": i32::MIN,
            }),
            ExecTermination::Exited {
                exit_code: i32::MIN,
            },
        ),
        (
            serde_json::json!({
                "kind": "exited",
                "exit_code": i32::MAX,
            }),
            ExecTermination::Exited {
                exit_code: i32::MAX,
            },
        ),
        (
            serde_json::json!({
                "kind": "timed_out",
            }),
            ExecTermination::TimedOut,
        ),
        (
            serde_json::json!({
                "kind": "cancelled",
            }),
            ExecTermination::Cancelled,
        ),
        (
            serde_json::json!({
                "kind": "start_failed",
            }),
            ExecTermination::StartFailed,
        ),
        (
            serde_json::json!({
                "kind": "wait_failed",
            }),
            ExecTermination::WaitFailed,
        ),
    ] {
        let decoded = serde_json::from_value::<ExecTermination>(value).unwrap();
        assert_eq!(decoded, expected);
    }
}

#[test]
fn exec_termination_deserializes_exited_fields_in_any_order() {
    let decoded =
        serde_json::from_str::<ExecTermination>(r#"{"exit_code":0,"kind":"exited"}"#).unwrap();

    assert_eq!(decoded, ExecTermination::Exited { exit_code: 0 });
}

#[test]
fn exec_termination_rejects_invalid_shapes() {
    for value in [
        serde_json::json!({
            "exit_code": 0,
        }),
        serde_json::json!({
            "kind": "unknown",
            "exit_code": 0,
        }),
        serde_json::json!({
            "kind": "exited",
        }),
        serde_json::json!({
            "kind": "exited",
            "exit_code": null,
        }),
        serde_json::json!({
            "kind": "exited",
            "exit_code": 0,
            "signal": 9,
        }),
    ] {
        assert!(serde_json::from_value::<ExecTermination>(value).is_err());
    }
}

#[test]
fn exec_termination_rejects_out_of_range_exit_code() {
    for value in [
        serde_json::json!({
            "kind": "exited",
            "exit_code": 2_147_483_648_i64,
        }),
        serde_json::json!({
            "kind": "exited",
            "exit_code": -2_147_483_649_i64,
        }),
    ] {
        assert!(serde_json::from_value::<ExecTermination>(value).is_err());
    }
}

#[test]
fn exec_termination_rejects_non_object_shapes() {
    for value in [
        serde_json::Value::Null,
        serde_json::json!("exited"),
        serde_json::json!(0),
        serde_json::json!(["exited"]),
    ] {
        assert!(serde_json::from_value::<ExecTermination>(value).is_err());
    }
}

#[test]
fn exec_termination_rejects_non_exited_exit_code() {
    for kind in ["timed_out", "cancelled", "start_failed", "wait_failed"] {
        for exit_code in [serde_json::json!(124), serde_json::Value::Null] {
            let value = serde_json::json!({
                "kind": kind,
                "exit_code": exit_code,
            });

            assert!(serde_json::from_value::<ExecTermination>(value).is_err());
        }
    }
}

#[test]
fn exec_termination_rejects_non_exited_unknown_fields() {
    for kind in ["timed_out", "cancelled", "start_failed", "wait_failed"] {
        let value = serde_json::json!({
            "kind": kind,
            "signal": 9,
        });

        assert!(serde_json::from_value::<ExecTermination>(value).is_err());
    }
}

#[test]
fn exec_termination_rejects_duplicate_fields() {
    for value in [
        r#"{"kind":"exited","kind":"timed_out","exit_code":0}"#,
        r#"{"kind":"exited","kind":"exited","exit_code":0}"#,
        r#"{"kind":"exited","exit_code":0,"exit_code":1}"#,
        r#"{"kind":"exited","exit_code":0,"exit_code":0}"#,
    ] {
        assert!(serde_json::from_str::<ExecTermination>(value).is_err());
    }
}

#[test]
fn exec_result_new_defaults_to_exited() {
    let result = ExecResult::new(7, b"out".to_vec(), b"err".to_vec());

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
    assert_eq!(result.guest_duration_ms, None);
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(result.diagnostic.is_empty());
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
}

#[test]
fn process_exit_new_defaults_supervised_metadata() {
    let exit = ProcessExit::new(42, 7, b"out".to_vec(), b"err".to_vec());

    assert_eq!(exit.guest_pid, 42);
    assert_eq!(exit.termination, ExecTermination::Exited { exit_code: 7 });
    assert_eq!(exit.guest_duration_ms, None);
    assert_eq!(exit.stdout, b"out");
    assert_eq!(exit.stderr, b"err");
    assert!(!exit.stdout_truncated);
    assert!(!exit.stderr_truncated);
    assert!(exit.diagnostic.is_empty());
    assert!(!exit.stream_overflowed);
}

#[test]
fn guest_process_handle_closes_only_unclaimed_stdout() {
    let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
    let closed = Arc::new(AtomicBool::new(false));
    let close_observed = Arc::clone(&closed);
    let mut handle = GuestProcessHandle::new(
        42,
        Some(stdout_rx),
        None,
        GuestProcessWaiter::new(|_| {
            Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
        }),
    )
    .with_unclaimed_stdout_cleanup(move || {
        close_observed.store(true, Ordering::SeqCst);
    });

    let _claimed_stdout = handle.take_stdout_receiver();
    handle.drop_unclaimed_stdout();

    assert!(!closed.load(Ordering::SeqCst));
}

#[test]
fn guest_agent_process_handle_requires_control() {
    let process = GuestProcessHandle::new(
        42,
        None,
        None,
        GuestProcessWaiter::new(|_| {
            Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
        }),
    );

    let error = match GuestAgentProcessHandle::try_from_process(process, guest_agent_start_timing())
    {
        Ok(_) => panic!("Agent handle unexpectedly accepted missing control"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        crate::SandboxError::Operation {
            operation: crate::SandboxOperation::StartAgentProcess,
            reason: crate::SandboxOperationReason::Other,
            ..
        }
    ));
}

#[tokio::test]
async fn guest_agent_process_handle_transfers_process_and_control() {
    let control = GuestProcessControlHandle::new_with_outcome(|message_id, _, _| {
        Box::pin(async move { ProcessControlOutcome::Delivered(ProcessControlAck { message_id }) })
    });
    let process = GuestProcessHandle::new(
        42,
        None,
        Some(control),
        GuestProcessWaiter::new(|_| {
            Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
        }),
    );

    let agent =
        GuestAgentProcessHandle::try_from_process(process, guest_agent_start_timing()).unwrap();
    let (process, control) = agent.into_parts();
    assert_eq!(process.guest_pid, 42);
    let outcome = control
        .control_outcome("message", b"payload", Duration::from_secs(1))
        .await;
    let ProcessControlOutcome::Delivered(ack) = outcome else {
        panic!("expected delivered process-control outcome, got {outcome:?}");
    };
    assert_eq!(ack.message_id, "message");
}

#[test]
fn guest_process_handle_closes_unclaimed_stdout() {
    let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
    let closed = Arc::new(AtomicBool::new(false));
    let close_observed = Arc::clone(&closed);
    let mut handle = GuestProcessHandle::new(
        42,
        Some(stdout_rx),
        None,
        GuestProcessWaiter::new(|_| {
            Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
        }),
    )
    .with_unclaimed_stdout_cleanup(move || {
        close_observed.store(true, Ordering::SeqCst);
    });

    handle.drop_unclaimed_stdout();

    assert!(closed.load(Ordering::SeqCst));
}

#[test]
fn guest_process_handle_drop_closes_unclaimed_stdout() {
    let (_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
    let closed = Arc::new(AtomicBool::new(false));
    let close_observed = Arc::clone(&closed);
    let handle = GuestProcessHandle::new(
        42,
        Some(stdout_rx),
        None,
        GuestProcessWaiter::new(|_| {
            Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
        }),
    )
    .with_unclaimed_stdout_cleanup(move || {
        close_observed.store(true, Ordering::SeqCst);
    });

    drop(handle);

    assert!(closed.load(Ordering::SeqCst));
}

#[test]
fn guest_process_handle_takes_cancel_handle_once() {
    let mut handle = GuestProcessHandle::new(
        42,
        None,
        None,
        GuestProcessWaiter::new(|_| {
            Box::pin(async { Ok(ProcessExit::new(42, 0, Vec::new(), Vec::new())) })
        }),
    )
    .with_cancel_handle(GuestProcessCancelHandle::new(|_| {
        Box::pin(async { Ok(()) })
    }));

    assert!(handle.take_cancel_handle().is_some());
    assert!(handle.take_cancel_handle().is_none());
}
