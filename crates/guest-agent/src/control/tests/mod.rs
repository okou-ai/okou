use super::*;

const CONTROL_TEST_READ_TIMEOUT: Duration = Duration::from_secs(3);

fn active_input_payload(sequence: u64) -> Vec<u8> {
    let event_id = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("vm0:control-test:active-input:{sequence}").as_bytes(),
    );
    guest_contracts::active_input::encode_active_input(&event_id.to_string(), "hello")
        .expect("active-input control payload should serialize")
}

fn accept_control_stream_and_read_hello(listener: &std::os::unix::net::UnixListener) -> UnixStream {
    let mut stream = process_control_ipc::accept_with_timeout(listener, Duration::from_secs(1))
        .expect("control task should connect");
    stream
        .set_read_timeout(Some(CONTROL_TEST_READ_TIMEOUT))
        .expect("control test stream should set read timeout");
    process_control_ipc::read_hello(&mut stream).expect("control task should send hello");
    stream
}

#[test]
fn control_task_accepts_request_until_shutdown() {
    let nonce = *b"0123456789abcdef";
    let endpoint = process_control_ipc::endpoint_name(42, &nonce);
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let shutdown = CancellationToken::new();
    let worker_shutdown = shutdown.clone();
    let stream_slot = Arc::new(Mutex::new(None));
    let active_runtime =
        crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
    let active_input = active_runtime.controller();
    let worker = thread::spawn({
        let endpoint = endpoint.clone();
        move || {
            run_inner(
                &endpoint,
                worker_shutdown,
                stream_slot,
                active_input,
                CancellationToken::new(),
            )
        }
    });

    let mut stream = accept_control_stream_and_read_hello(&listener);
    process_control_ipc::write_request(
        &mut stream,
        &process_control_ipc::ControlRequest {
            message_id: "msg-1".to_owned(),
            payload: active_input_payload(0),
        },
    )
    .unwrap();
    let response =
        process_control_ipc::read_response(&mut stream).expect("control task should send response");
    assert_eq!(response.message_id, "msg-1");
    assert_eq!(
        response.status,
        process_control_ipc::ControlResponseStatus::Accepted
    );

    shutdown.cancel();
    drop(stream);
    worker.join().unwrap().unwrap();
}

#[test]
fn control_task_validates_user_cancellation_before_closing_run() {
    let nonce = *b"cancel-repeat-01";
    let endpoint = process_control_ipc::endpoint_name(48, &nonce);
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let shutdown = CancellationToken::new();
    let active_runtime =
        crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
    let active_input = active_runtime.controller();
    let cli_cancellation = CancellationToken::new();
    let handle =
        ControlHandle::spawn_endpoint(endpoint, shutdown, active_input, cli_cancellation.clone())
            .unwrap();

    let mut stream = accept_control_stream_and_read_hello(&listener);
    process_control_ipc::write_request(
        &mut stream,
        &process_control_ipc::ControlRequest {
            message_id: "cancel-invalid".to_string(),
            payload: br#"{"type":"user-cancellation","extra":true}"#.to_vec(),
        },
    )
    .unwrap();
    let response =
        process_control_ipc::read_response(&mut stream).expect("control task should send response");
    assert_eq!(response.message_id, "cancel-invalid");
    assert_eq!(
        response.status,
        process_control_ipc::ControlResponseStatus::Rejected
    );
    assert!(
        response
            .diagnostic
            .starts_with("user cancellation payload is invalid:")
    );
    assert!(
        !cli_cancellation.is_cancelled(),
        "rejected malformed cancellation cancelled the CLI"
    );

    process_control_ipc::write_request(
        &mut stream,
        &process_control_ipc::ControlRequest {
            message_id: "input-after-invalid-cancel".to_string(),
            payload: active_input_payload(0),
        },
    )
    .unwrap();
    let response =
        process_control_ipc::read_response(&mut stream).expect("control task should send response");
    assert_eq!(response.message_id, "input-after-invalid-cancel");
    assert_eq!(
        response.status,
        process_control_ipc::ControlResponseStatus::Accepted,
        "rejected malformed cancellation closed active input"
    );
    assert!(response.diagnostic.is_empty());
    assert!(!cli_cancellation.is_cancelled());

    for (sequence, message_id) in [(1, "cancel-1"), (2, "cancel-2")] {
        process_control_ipc::write_request(
            &mut stream,
            &process_control_ipc::ControlRequest {
                message_id: message_id.to_string(),
                payload: br#"{"type":"user-cancellation"}"#.to_vec(),
            },
        )
        .unwrap();
        let response = process_control_ipc::read_response(&mut stream)
            .expect("control task should send response");
        assert_eq!(response.message_id, message_id);
        assert_eq!(
            response.status,
            process_control_ipc::ControlResponseStatus::Accepted
        );
        assert!(response.diagnostic.is_empty());
        assert!(cli_cancellation.is_cancelled());

        let input_message_id = format!("input-after-{message_id}");
        process_control_ipc::write_request(
            &mut stream,
            &process_control_ipc::ControlRequest {
                message_id: input_message_id.clone(),
                payload: active_input_payload(sequence),
            },
        )
        .unwrap();
        let response = process_control_ipc::read_response(&mut stream)
            .expect("control task should send response");
        assert_eq!(response.message_id, input_message_id);
        assert_eq!(
            response.status,
            process_control_ipc::ControlResponseStatus::Rejected,
            "{message_id} should close active input"
        );
        assert_eq!(
            response.diagnostic,
            guest_contracts::active_input::ACTIVE_INPUT_CLOSED_DIAGNOSTIC
        );
    }

    drop(stream);
    handle.join();
}

#[test]
fn control_task_rejects_invalid_active_input_payload() {
    let nonce = *b"0123456789abcdee";
    let endpoint = process_control_ipc::endpoint_name(46, &nonce);
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let shutdown = CancellationToken::new();
    let worker_shutdown = shutdown.clone();
    let stream_slot = Arc::new(Mutex::new(None));
    let active_runtime =
        crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
    let active_input = active_runtime.controller();
    let worker = thread::spawn({
        let endpoint = endpoint.clone();
        move || {
            run_inner(
                &endpoint,
                worker_shutdown,
                stream_slot,
                active_input,
                CancellationToken::new(),
            )
        }
    });

    let mut stream = accept_control_stream_and_read_hello(&listener);
    process_control_ipc::write_request(
            &mut stream,
            &process_control_ipc::ControlRequest {
                message_id: "bad-1".to_owned(),
                payload: br#"{"type":"other","eventId":"00000000-0000-4000-8000-000000000001","text":"hello"}"#.to_vec(),
            },
        )
        .unwrap();
    let response =
        process_control_ipc::read_response(&mut stream).expect("control task should send response");
    assert_eq!(response.message_id, "bad-1");
    assert_eq!(
        response.status,
        process_control_ipc::ControlResponseStatus::Rejected
    );
    assert_eq!(
        response.diagnostic,
        "active input payload type is unsupported"
    );

    shutdown.cancel();
    drop(stream);
    worker.join().unwrap().unwrap();
}

#[test]
fn control_task_reports_queue_full_when_active_input_backlog_is_full() {
    let nonce = *b"1122334455667788";
    let endpoint = process_control_ipc::endpoint_name(47, &nonce);
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let shutdown = CancellationToken::new();
    let worker_shutdown = shutdown.clone();
    let stream_slot = Arc::new(Mutex::new(None));
    let active_runtime =
        crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
    let active_input = active_runtime.controller();
    let worker = thread::spawn({
        let endpoint = endpoint.clone();
        move || {
            run_inner(
                &endpoint,
                worker_shutdown,
                stream_slot,
                active_input,
                CancellationToken::new(),
            )
        }
    });

    let mut stream = accept_control_stream_and_read_hello(&listener);

    let mut accepted_count = 0;
    let mut queue_full_response = None;
    let mut unexpected_status = None;
    for index in 0..32 {
        let message_id = format!("msg-{index}");
        process_control_ipc::write_request(
            &mut stream,
            &process_control_ipc::ControlRequest {
                message_id: message_id.clone(),
                payload: active_input_payload(index),
            },
        )
        .unwrap();

        let response = process_control_ipc::read_response(&mut stream)
            .expect("control task should send response");
        assert_eq!(response.message_id, message_id);
        match response.status {
            process_control_ipc::ControlResponseStatus::Accepted => {
                accepted_count += 1;
            }
            process_control_ipc::ControlResponseStatus::QueueFull => {
                queue_full_response = Some(response);
                break;
            }
            status => {
                unexpected_status = Some(status);
                break;
            }
        }
    }

    shutdown.cancel();
    drop(stream);
    worker.join().unwrap().unwrap();

    if let Some(status) = unexpected_status {
        panic!("unexpected control response status: {status:?}");
    }
    let response = queue_full_response.expect("active input backlog should become full");
    assert!(accepted_count > 0);
    assert_eq!(response.diagnostic, "active input queue is full");
}

#[test]
fn control_handle_join_wakes_idle_reader() {
    let nonce = *b"fedcba9876543210";
    let endpoint = process_control_ipc::endpoint_name(43, &nonce);
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let shutdown = CancellationToken::new();
    let active_runtime =
        crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
    let active_input = active_runtime.controller();
    let handle =
        ControlHandle::spawn_endpoint(endpoint, shutdown, active_input, CancellationToken::new())
            .unwrap();

    let stream = accept_control_stream_and_read_hello(&listener);

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let joiner = thread::spawn(move || {
        handle.join();
        done_tx.send(()).unwrap();
    });

    if let Err(error) = done_rx.recv_timeout(Duration::from_secs(1)) {
        drop(stream);
        joiner.join().unwrap();
        panic!("control handle join should wake idle reader: {error}");
    }
    joiner.join().unwrap();
}

#[test]
fn control_handle_drop_wakes_idle_reader() {
    let nonce = *b"0011223344556677";
    let endpoint = process_control_ipc::endpoint_name(45, &nonce);
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let shutdown = CancellationToken::new();
    let active_runtime =
        crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
    let active_input = active_runtime.controller();
    let handle =
        ControlHandle::spawn_endpoint(endpoint, shutdown, active_input, CancellationToken::new())
            .unwrap();

    let stream = accept_control_stream_and_read_hello(&listener);

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let dropper = thread::spawn(move || {
        drop(handle);
        done_tx.send(()).unwrap();
    });

    if let Err(error) = done_rx.recv_timeout(Duration::from_secs(1)) {
        drop(stream);
        dropper.join().unwrap();
        panic!("control handle drop should wake idle reader: {error}");
    }
    dropper.join().unwrap();
}

#[test]
fn control_task_clears_shutdown_stream_when_reader_exits() {
    let nonce = *b"8899aabbccddeeff";
    let endpoint = process_control_ipc::endpoint_name(44, &nonce);
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let shutdown = CancellationToken::new();
    let stream_slot = Arc::new(Mutex::new(None));
    let worker_slot = Arc::clone(&stream_slot);
    let active_runtime =
        crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
    let active_input = active_runtime.controller();
    let worker = thread::spawn({
        let endpoint = endpoint.clone();
        move || {
            run_inner(
                &endpoint,
                shutdown,
                worker_slot,
                active_input,
                CancellationToken::new(),
            )
        }
    });

    let stream = accept_control_stream_and_read_hello(&listener);
    drop(stream);

    worker.join().unwrap().unwrap();
    assert!(
        stream_slot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none()
    );
}
