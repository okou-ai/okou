use super::*;
use ::sandbox::DEFAULT_PROCESS_START_TIMEOUT;
use std::sync::Arc;

#[tokio::test]
async fn agent_start_preserves_provider_handle_without_consuming_it_for_other_starts() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_agent_process_handle(::sandbox::GuestProcessHandle::new(
        42,
        None,
        Some(::sandbox::GuestProcessControlHandle::new_with_outcome(
            |message_id, payload, _| {
                Box::pin(async move {
                    assert_eq!(payload, b"provider payload");
                    ProcessControlOutcome::Delivered(::sandbox::ProcessControlAck { message_id })
                })
            },
        )),
        ::sandbox::GuestProcessWaiter::new(|_| {
            Box::pin(async { Ok(::sandbox::ProcessExit::new(42, 7, Vec::new(), Vec::new())) })
        }),
    ));
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let ordinary = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "ordinary helper",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    assert_eq!(ordinary.guest_pid, 1);
    sandbox
        .wait_process(ordinary, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(
        sandbox
            .start_agent_process(&StartAgentProcessRequest {
                timeout: Duration::from_secs(5),
                env: &[("INVALID=KEY", "value")],
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            })
            .await
            .is_err()
    );
    let agent = sandbox
        .start_agent_process(&StartAgentProcessRequest {
            timeout: Duration::from_secs(5),
            env: &[],
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    let (process, control) = agent.into_parts();
    assert_eq!(process.guest_pid, 42);
    let outcome = control
        .control_outcome("message", b"provider payload", Duration::from_secs(1))
        .await;
    let ProcessControlOutcome::Delivered(ack) = outcome else {
        panic!("expected delivered process-control outcome, got {outcome:?}");
    };
    assert_eq!(ack.message_id, "message");
    let exit = sandbox
        .wait_process(process, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(exit.guest_pid, 42);
    assert_eq!(
        exit.termination,
        ::sandbox::ExecTermination::Exited { exit_code: 7 }
    );
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
}

#[tokio::test]
async fn overrides_record_start_process_output_modes_in_order() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let buffered = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    assert!(!buffered.has_stdout_receiver());

    let streamed = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::stream(),
        })
        .await
        .unwrap();
    assert!(streamed.has_stdout_receiver());

    assert_eq!(
        overrides.start_process_calls(),
        vec![
            StartProcessCall {
                timeout_is_expected: false,
                cmd: "agent".to_string(),
                timeout: Duration::from_secs(5),
                start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
                env: Vec::new(),
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            },
            StartProcessCall {
                timeout_is_expected: false,
                cmd: "agent".to_string(),
                timeout: Duration::from_secs(5),
                start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
                env: Vec::new(),
                sudo: false,
                output: ProcessOutputMode::stream(),
            },
        ]
    );
}

#[tokio::test]
async fn start_process_emits_queued_stdout_chunks() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial".to_vec(),
        truncated: true,
    }]);
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let mut handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::stream(),
        })
        .await
        .unwrap();
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let chunk = stdout_rx.recv().await.unwrap();

    assert_eq!(chunk.bytes, b"partial");
    assert!(chunk.truncated);
    assert!(stdout_rx.recv().await.is_none());
}

#[tokio::test]
async fn process_stream_capacity_overflow_retains_one_chunk_and_marks_exit() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![
        ProcessOutputChunk {
            bytes: b"first".to_vec(),
            truncated: false,
        },
        ProcessOutputChunk {
            bytes: b"second".to_vec(),
            truncated: false,
        },
    ]);
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let mut handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 16,
                queue_capacity: 1,
                stderr_capture_limit_bytes: None,
            },
        })
        .await
        .unwrap();
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let exit = sandbox
        .wait_process(handle, Duration::from_secs(5))
        .await
        .unwrap();

    assert!(exit.stream_overflowed);
    assert_eq!(stdout_rx.recv().await.unwrap().bytes, b"first");
    assert!(stdout_rx.recv().await.is_none());
}

#[tokio::test]
async fn start_agent_process_returns_mandatory_control_handle() {
    let runtime = MockSandboxRuntime::new();
    let factory = runtime.create_factory(test_factory_config()).await.unwrap();
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let without_control = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    assert!(without_control.control_handle().is_none());

    let with_control = sandbox
        .start_agent_process(&StartAgentProcessRequest {
            timeout: Duration::from_secs(5),
            env: &[],
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    let (_process, control) = with_control.into_parts();
    let outcome = control
        .control_outcome("msg-1", b"payload", Duration::from_secs(5))
        .await;
    let ProcessControlOutcome::Delivered(ack) = outcome else {
        panic!("expected delivered process-control outcome, got {outcome:?}");
    };
    assert_eq!(ack.message_id, "msg-1");
}

#[tokio::test]
async fn start_agent_process_fails_when_control_is_unavailable() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_process_control_supported(false);
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));

    let error = match sandbox
        .start_agent_process(&StartAgentProcessRequest {
            timeout: Duration::from_secs(5),
            env: &[],
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
    {
        Ok(_) => panic!("Agent start unexpectedly succeeded without control"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        SandboxError::Operation {
            operation: SandboxOperation::StartAgentProcess,
            reason: SandboxOperationReason::Other,
            ..
        }
    ));
    assert!(overrides.start_process_calls().is_empty());
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
}

#[tokio::test]
async fn process_control_calls_are_recorded_when_overrides_are_enabled() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let handle = sandbox
        .start_agent_process(&StartAgentProcessRequest {
            timeout: Duration::from_secs(5),
            env: &[],
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    let (_process, control) = handle.into_parts();

    let outcome = control
        .control_outcome("msg-1", b"payload", Duration::from_millis(250))
        .await;
    assert!(matches!(
        outcome,
        ProcessControlOutcome::Delivered(ack) if ack.message_id == "msg-1"
    ));

    assert_eq!(
        overrides.process_control_calls(),
        vec![ProcessControlCall {
            message_id: "msg-1".to_string(),
            payload: b"payload".to_vec(),
            timeout: Duration::from_millis(250),
        }]
    );
}

#[tokio::test]
async fn queued_process_control_errors_are_consumed_fifo() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_process_control_error("first control failed");
    overrides.push_process_control_error("second control failed");
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let handle = sandbox
        .start_agent_process(&StartAgentProcessRequest {
            timeout: Duration::from_secs(5),
            env: &[],
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    let (_process, control) = handle.into_parts();

    let outcome = control
        .control_outcome("msg-1", b"payload-1", Duration::from_secs(1))
        .await;
    let first_error = match outcome {
        ProcessControlOutcome::Failed {
            kind,
            write_state,
            error,
        } => {
            assert_eq!(kind, ProcessControlFailureKind::Operation);
            assert_eq!(write_state, ProcessControlWriteState::PossiblyWritten);
            error
        }
        other => panic!("expected failed process-control outcome, got {other:?}"),
    };
    let outcome = control
        .control_outcome("msg-2", b"payload-2", Duration::from_secs(1))
        .await;
    let second_error = match outcome {
        ProcessControlOutcome::Failed {
            kind,
            write_state,
            error,
        } => {
            assert_eq!(kind, ProcessControlFailureKind::Operation);
            assert_eq!(write_state, ProcessControlWriteState::PossiblyWritten);
            error
        }
        other => panic!("expected failed process-control outcome, got {other:?}"),
    };
    let outcome = control
        .control_outcome("msg-3", b"payload-3", Duration::from_secs(1))
        .await;
    let ProcessControlOutcome::Delivered(ack) = outcome else {
        panic!("expected delivered process-control outcome, got {outcome:?}");
    };

    assert!(first_error.to_string().contains("first control failed"));
    assert!(second_error.to_string().contains("second control failed"));
    assert_eq!(ack.message_id, "msg-3");
    assert_eq!(overrides.process_control_calls().len(), 3);
}

#[tokio::test]
async fn queued_structured_process_control_outcomes_are_preserved() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_process_control_outcome(ProcessControlOutcome::GuestStatus {
        status: ProcessControlGuestStatus::QueueFull,
        diagnostic: "guest queue is full".to_string(),
    });
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let handle = sandbox
        .start_agent_process(&StartAgentProcessRequest {
            timeout: Duration::from_secs(5),
            env: &[],
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    let (_process, control) = handle.into_parts();

    let outcome = control
        .control_outcome("msg-1", b"payload", Duration::from_secs(1))
        .await;

    assert!(matches!(
        outcome,
        ProcessControlOutcome::GuestStatus {
            status: ProcessControlGuestStatus::QueueFull,
            diagnostic,
        } if diagnostic == "guest queue is full"
    ));
}

#[tokio::test]
async fn structured_process_control_distinguishes_timeout_write_state() {
    for write_state in [
        ProcessControlWriteState::NotWritten,
        ProcessControlWriteState::PossiblyWritten,
    ] {
        let control =
            GuestProcessControlHandle::new_with_outcome(move |_message_id, _payload, _timeout| {
                Box::pin(async move {
                    ProcessControlOutcome::Failed {
                        kind: ProcessControlFailureKind::Operation,
                        write_state,
                        error: std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "process control timed out",
                        ),
                    }
                })
            });

        let outcome = control
            .control_outcome("msg", b"payload", Duration::from_secs(1))
            .await;
        match outcome {
            ProcessControlOutcome::Failed {
                kind,
                write_state: actual_write_state,
                error,
            } => {
                assert_eq!(kind, ProcessControlFailureKind::Operation);
                assert_eq!(actual_write_state, write_state);
                assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
                assert_eq!(error.to_string(), "process control timed out");
            }
            other => panic!("expected failed process-control outcome, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn start_process_validates_stream_configuration() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));

    for (output, expected_message) in [
        (
            ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 0,
                queue_capacity: 1,
                stderr_capture_limit_bytes: None,
            },
            "process stream chunk limit must be positive",
        ),
        (
            ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 16,
                queue_capacity: 0,
                stderr_capture_limit_bytes: None,
            },
            "process stream queue capacity must be positive",
        ),
        (
            ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 16,
                queue_capacity: ProcessOutputMode::MAX_QUEUE_CAPACITY + 1,
                stderr_capture_limit_bytes: None,
            },
            "process stream queue capacity must be at most 8192",
        ),
    ] {
        let error = match sandbox
            .start_process(&StartProcessRequest {
                timeout_is_expected: false,
                cmd: "agent",
                start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output,
            })
            .await
        {
            Ok(_) => panic!("invalid stream configuration should be rejected"),
            Err(error) => error,
        };
        assert_operation_error(
            error,
            SandboxOperation::StartProcess,
            SandboxOperationReason::Other,
            expected_message,
        );
    }
    assert!(overrides.start_process_calls().is_empty());

    let output = ProcessOutputMode::Stream {
        stream_limit_bytes: 0,
        chunk_limit_bytes: 16,
        queue_capacity: ProcessOutputMode::MAX_QUEUE_CAPACITY,
        stderr_capture_limit_bytes: None,
    };
    let handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output,
        })
        .await
        .unwrap();

    assert!(handle.has_stdout_receiver());
    let calls = overrides.start_process_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls.first().unwrap().output, output);
}

#[tokio::test]
async fn start_process_rejects_invalid_env_key() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test-1", Arc::clone(&overrides));
    let result = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[("1BAD", "x")],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await;
    let err = match result {
        Ok(_) => panic!("invalid env key should be rejected"),
        Err(err) => err,
    };

    assert_operation_error(
        err,
        SandboxOperation::StartProcess,
        SandboxOperationReason::Other,
        "invalid environment variable name",
    );
    assert!(overrides.start_process_calls().is_empty());
}

#[tokio::test]
async fn queued_start_process_errors_are_consumed_fifo() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_error(SandboxError::Operation {
        operation: SandboxOperation::StartProcess,
        reason: SandboxOperationReason::Guest,
        message: "first start failed".into(),
    });
    overrides.push_start_process_error(SandboxError::Operation {
        operation: SandboxOperation::StartProcess,
        reason: SandboxOperationReason::Timeout,
        message: "second start failed".into(),
    });
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let request = StartProcessRequest {
        timeout_is_expected: false,
        cmd: "agent",
        start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
        timeout: Duration::from_secs(5),
        env: &[],
        sudo: false,
        output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
    };

    let first_error = match sandbox.start_process(&request).await {
        Ok(_) => panic!("expected first start to fail"),
        Err(error) => error,
    };
    assert_operation_error(
        first_error,
        SandboxOperation::StartProcess,
        SandboxOperationReason::Guest,
        "first start failed",
    );
    let second_error = match sandbox.start_process(&request).await {
        Ok(_) => panic!("expected second start to fail"),
        Err(error) => error,
    };
    assert_operation_error(
        second_error,
        SandboxOperation::StartProcess,
        SandboxOperationReason::Timeout,
        "second start failed",
    );
    drop(sandbox.start_process(&request).await.unwrap());

    assert_eq!(overrides.start_process_calls().len(), 3);
}

#[tokio::test]
async fn start_process_lifecycle_gate_blocks_before_recording_or_cancellation() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_start_process_lifecycle_gate(gate.clone());
    let result_cancel = tokio_util::sync::CancellationToken::new();
    overrides.cancel_after_next_start_process_result(result_cancel.clone());
    let sandbox = Arc::new(MockSandbox::with_overrides("test", Arc::clone(&overrides)));

    let blocked_start = {
        let sandbox = Arc::clone(&sandbox);
        tokio::spawn(async move {
            sandbox
                .start_process(&StartProcessRequest {
                    timeout_is_expected: false,
                    cmd: "blocked-agent",
                    start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
                    timeout: Duration::from_secs(5),
                    env: &[],
                    sudo: false,
                    output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                })
                .await
        })
    };

    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    assert!(overrides.start_process_calls().is_empty());
    assert!(!result_cancel.is_cancelled());

    blocked_start.abort();
    let blocked_start_error = match blocked_start.await {
        Ok(_) => panic!("blocked start task should be cancelled"),
        Err(error) => error,
    };
    assert!(blocked_start_error.is_cancelled());
    overrides.clear_start_process_lifecycle_gate();

    drop(
        sandbox
            .start_process(&StartProcessRequest {
                timeout_is_expected: false,
                cmd: "next-agent",
                start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            })
            .await
            .unwrap(),
    );
    assert!(result_cancel.is_cancelled());
    assert_eq!(overrides.start_process_calls().len(), 1);
}

#[tokio::test]
async fn process_result_cancellations_are_success_only_and_fifo() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let first_start_cancel = tokio_util::sync::CancellationToken::new();
    let second_start_cancel = tokio_util::sync::CancellationToken::new();
    overrides.cancel_after_next_start_process_result(first_start_cancel.clone());
    overrides.cancel_after_next_start_process_result(second_start_cancel.clone());
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));

    let invalid_start = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "invalid-agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[("1BAD", "value")],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await;
    assert!(invalid_start.is_err());
    assert!(!first_start_cancel.is_cancelled());
    assert!(!second_start_cancel.is_cancelled());

    let first_handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "first-agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    assert!(first_start_cancel.is_cancelled());
    assert!(!second_start_cancel.is_cancelled());

    let second_handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "second-agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    assert!(second_start_cancel.is_cancelled());

    let mut invalid_wait_handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "invalid-wait-agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    assert!(invalid_wait_handle.take_waiter().is_some());

    let first_wait_cancel = tokio_util::sync::CancellationToken::new();
    let second_wait_cancel = tokio_util::sync::CancellationToken::new();
    overrides.cancel_after_next_wait_process_result(first_wait_cancel.clone());
    overrides.cancel_after_next_wait_process_result(second_wait_cancel.clone());

    assert!(
        sandbox
            .wait_process(invalid_wait_handle, Duration::from_secs(5))
            .await
            .is_err()
    );
    assert!(!first_wait_cancel.is_cancelled());
    assert!(!second_wait_cancel.is_cancelled());

    sandbox
        .wait_process(first_handle, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(first_wait_cancel.is_cancelled());
    assert!(!second_wait_cancel.is_cancelled());

    sandbox
        .wait_process(second_handle, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(second_wait_cancel.is_cancelled());
    assert_eq!(overrides.start_process_calls().len(), 3);
    assert_eq!(overrides.wait_process_calls().len(), 2);
}

#[tokio::test]
async fn wait_process_rejects_consumed_guest_process_handle() {
    let runtime = MockSandboxRuntime::new();
    let factory = runtime.create_factory(test_factory_config()).await.unwrap();
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let mut handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();

    let consumed = handle.take_waiter();
    assert!(consumed.is_some());
    match sandbox.wait_process(handle, Duration::from_secs(5)).await {
        Ok(_) => panic!("wait_process should reject an already consumed handle"),
        Err(SandboxError::Operation {
            operation,
            reason,
            message,
        }) => {
            assert_eq!(operation, SandboxOperation::WaitProcess);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert!(message.contains("already consumed"));
        }
        Err(other) => panic!("expected wait_process operation error, got {other:?}"),
    }
}

#[tokio::test]
async fn wait_process_returns_queued_process_exit() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let mut exit = ProcessExit::new(77, 0, b"out".to_vec(), b"err".to_vec());
    exit.stream_overflowed = true;
    overrides.push_wait_process_exit(exit);
    let handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();

    let result = sandbox
        .wait_process(handle, Duration::from_secs(5))
        .await
        .unwrap();

    assert_eq!(result.guest_pid, 77);
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(result.stream_overflowed);
}

#[tokio::test]
async fn wait_process_default_exit_is_unchanged_without_queued_exit() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();

    let result = sandbox
        .wait_process(handle, Duration::from_secs(5))
        .await
        .unwrap();

    assert_eq!(result.guest_pid, 1);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
    assert!(!result.stream_overflowed);
}

#[tokio::test]
async fn wait_process_drops_unclaimed_stdout_receiver_before_waiting() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(MockSandboxOverrides::with_wait_process_gate(Arc::clone(
        &gate,
    )));
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let (stdout_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
    let handle = GuestProcessHandle::new(
        1,
        Some(stdout_rx),
        None,
        GuestProcessWaiter::new(|_timeout| {
            Box::pin(async { Ok(ProcessExit::new(1, 0, Vec::new(), Vec::new())) })
        }),
    );

    let wait =
        tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
    tokio::time::timeout(test_timeout(), stdout_tx.closed())
        .await
        .expect("wait_process should drop an unclaimed stdout receiver before blocking");

    gate.notify_waiters();
    wait.await.unwrap().unwrap();
}

#[tokio::test]
async fn wait_process_lifecycle_gate_blocks_until_released() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();

    let wait =
        tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    assert!(
        !wait.is_finished(),
        "wait_process should block until the lifecycle gate is released",
    );

    gate.release_one();
    let result = wait.await.unwrap().unwrap();
    assert_eq!(result.guest_pid, 1);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
}

#[tokio::test]
async fn wait_process_lifecycle_gate_clear_only_affects_future_waits() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let first_sandbox = MockSandbox::with_overrides("first", Arc::clone(&overrides));
    let first_handle = first_sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();

    let first_wait = tokio::spawn(async move {
        first_sandbox
            .wait_process(first_handle, Duration::from_secs(5))
            .await
    });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

    overrides.clear_wait_process_lifecycle_gate();
    assert!(
        !first_wait.is_finished(),
        "clearing the gate must not release an already-entered wait_process",
    );

    let second_sandbox = MockSandbox::with_overrides("second", overrides);
    let second_handle = second_sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    let second_result = tokio::time::timeout(
        test_timeout(),
        second_sandbox.wait_process(second_handle, Duration::from_secs(5)),
    )
    .await
    .expect("future wait_process calls should bypass a cleared gate")
    .unwrap();
    assert_eq!(
        second_result.termination,
        ExecTermination::Exited { exit_code: 0 }
    );

    gate.release_one();
    let first_result = first_wait.await.unwrap().unwrap();
    assert_eq!(
        first_result.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
}

#[tokio::test]
async fn process_cancel_releases_wait_process_lifecycle_gate() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let mut handle = sandbox
        .start_process(&StartProcessRequest {
            timeout_is_expected: false,
            cmd: "agent",
            start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
        })
        .await
        .unwrap();
    let cancel = handle
        .take_cancel_handle()
        .expect("mock process should expose a cancel handle");

    let wait =
        tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

    cancel.cancel(Duration::from_secs(1)).await.unwrap();
    let result = wait.await.unwrap().unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(overrides.process_cancel_calls().len(), 1);
}
