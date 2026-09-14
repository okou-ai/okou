use std::io;
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::{
    ExecControlStatus, ExecTermination, MSG_ERROR, MSG_EXEC_CONTROL, MSG_EXEC_CONTROL_RESULT,
    MSG_EXEC_START, MSG_OPERATIONS_RESUMED, MSG_RESUME_OPERATIONS,
};
use tokio::io::AsyncWriteExt;

use super::super::super::support::{
    assert_connection_accepts_exec_operation, normal_operation_readiness, operation_count,
    pending_control_count, read_guest_message, send_exec_control_result, send_exec_result,
    set_next_route_id, wait_for_pending_control_count,
};
use super::super::start_capture_operation;
use super::support::{
    StartedControlSupervisedExec, StartedSupervisedExec, assert_no_guest_frame,
    finish_supervised_exec_success, send_guest_error, start_control_supervised_exec_fixture,
    start_supervised_exec_fixture, supervised_request,
};
use crate::operation_tracker::NormalOperationReadiness;

#[tokio::test]
async fn supervised_exec_control_uses_exec_control_messages() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control_owned(
                    "message-1".to_owned(),
                    b"payload".to_vec(),
                    Duration::from_secs(5),
                )
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    assert_eq!(control.msg_type, MSG_EXEC_CONTROL);
    let decoded_control = guest_control_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.target_seq, start_seq);
    assert_eq!(decoded_control.control_nonce, control_nonce);
    assert_eq!(decoded_control.message_id, "message-1");
    assert_eq!(decoded_control.payload, b"payload");

    send_exec_control_result(
        &mut guest,
        control.seq,
        decoded_control.target_seq,
        decoded_control.control_nonce,
        decoded_control.message_id,
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    let ack = control_task.await.unwrap().unwrap();
    assert_eq!(ack.target_seq, start_seq);
    assert_eq!(ack.message_id, "message-1");

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn stale_control_cleanup_does_not_remove_reused_wire_sequence() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
    } = start_control_supervised_exec_fixture("control-route-generation").await;
    let wire_seq = 29;
    set_next_route_id(&host, wire_seq.into());

    let mut first =
        Box::pin(control_handle.control("first-generation", b"first", Duration::from_secs(5)));
    let first_control = tokio::select! {
        result = &mut first => panic!("first control completed before guest response: {result:?}"),
        message = read_guest_message(&mut guest) => message,
    };
    assert_eq!(first_control.msg_type, MSG_EXEC_CONTROL);
    assert_eq!(first_control.seq, wire_seq);
    send_exec_control_result(
        &mut guest,
        first_control.seq,
        start.seq(),
        control_nonce,
        "first-generation",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    wait_for_pending_control_count(&host, 0).await;

    set_next_route_id(&host, (1_u64 << 32) + u64::from(wire_seq));
    let mut second =
        Box::pin(control_handle.control("second-generation", b"second", Duration::from_secs(5)));
    let second_control = tokio::select! {
        result = &mut second => panic!("second control completed before guest response: {result:?}"),
        message = read_guest_message(&mut guest) => message,
    };
    assert_eq!(second_control.msg_type, MSG_EXEC_CONTROL);
    assert_eq!(second_control.seq, first_control.seq);

    drop(first);
    assert_eq!(pending_control_count(&host), 1);
    send_exec_control_result(
        &mut guest,
        second_control.seq,
        start.seq(),
        control_nonce,
        "second-generation",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    assert_eq!(second.await.unwrap().message_id, "second-generation");

    finish_supervised_exec_success(&mut guest, start.seq(), handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn route_wrap_skips_every_live_request_class() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
    } = start_control_supervised_exec_fixture("route-wrap").await;
    assert_eq!(start.seq(), 2);

    set_next_route_id(&host, u64::from(u32::MAX));
    let wrapped_exec = start_capture_operation(&host, "wrapped exec").await;
    let wrapped_start = read_guest_message(&mut guest).await;
    assert_eq!(wrapped_start.msg_type, MSG_EXEC_START);
    assert_eq!(wrapped_start.seq, u32::MAX);

    let control_task = tokio::spawn({
        let control_handle = control_handle.clone();
        async move {
            control_handle
                .control("wrapped-control", b"control", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    assert_eq!(control.msg_type, MSG_EXEC_CONTROL);
    assert_eq!(control.seq, 1);

    let resume_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.resume_operations(Duration::from_secs(5)).await })
    };
    let resume = read_guest_message(&mut guest).await;
    assert_eq!(resume.msg_type, MSG_RESUME_OPERATIONS);
    assert_eq!(resume.seq, 3);

    set_next_route_id(&host, (1_u64 << 32) + u64::from(u32::MAX));
    let next_exec = start_capture_operation(&host, "next generation").await;
    let next_start = read_guest_message(&mut guest).await;
    assert_eq!(next_start.msg_type, MSG_EXEC_START);
    assert_eq!(next_start.seq, 4);

    send_exec_control_result(
        &mut guest,
        control.seq,
        start.seq(),
        control_nonce,
        "wrapped-control",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    let resumed = guest_control_proto::encode(MSG_OPERATIONS_RESUMED, resume.seq, &[]).unwrap();
    guest.write_all(&resumed).await.unwrap();
    assert_eq!(control_task.await.unwrap().unwrap().target_seq, start.seq());
    resume_task.await.unwrap().unwrap();

    send_exec_result(
        &mut guest,
        wrapped_start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    send_exec_result(
        &mut guest,
        next_start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    wrapped_exec.wait(Duration::from_secs(5)).await.unwrap();
    next_exec.wait(Duration::from_secs(5)).await.unwrap();
    finish_supervised_exec_success(&mut guest, start.seq(), handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_rejects_empty_message_id_without_frame() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        ..
    } = start_control_supervised_exec_fixture("control-empty-message-id").await;
    let start_seq = start.seq();

    let err = handle
        .control("", b"payload", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(
        err.to_string().contains("exec_control message_id empty"),
        "unexpected error: {err}",
    );
    assert_no_guest_frame(&mut guest, "invalid control request must not send a frame");

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_sub_millisecond_timeout_rounds_up_to_one_ms() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-sub-ms-timeout").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("sub-ms-timeout", b"payload", Duration::from_nanos(1))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let decoded_control = guest_control_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.target_seq, start_seq);
    assert_eq!(decoded_control.control_nonce, control_nonce);
    assert_eq!(decoded_control.message_id, "sub-ms-timeout");
    assert_eq!(decoded_control.request_timeout_ms, 1);
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

async fn retains_reply_after_guest_budget(timeout: Duration, status: ExecControlStatus) {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
    } = start_control_supervised_exec_fixture("control-reply-allowance").await;
    let start_seq = start.seq();
    let control_task = tokio::spawn(async move {
        control_handle
            .control_owned_with_write_observer(
                "reply".to_owned(),
                b"payload".to_vec(),
                timeout,
                crate::FrameWriteObserver::default(),
            )
            .await
    });
    let control = read_guest_message(&mut guest).await;
    let request = guest_control_proto::decode_exec_control(&control.payload).unwrap();
    let guest_budget = Duration::from_millis(u64::from(request.request_timeout_ms));
    // Model a reply in transit after the Guest's work budget, not an extension
    // of that budget. The response owner must remain alive for this interval.
    tokio::time::sleep(guest_budget + Duration::from_millis(50)).await;
    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "reply",
        status,
        "",
    )
    .await;
    let outcome = control_task.await.unwrap();
    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();

    match status {
        ExecControlStatus::Delivered => assert!(matches!(
            outcome.unwrap(),
            crate::ExecControlOutcome::Delivered(_)
        )),
        _ => assert!(matches!(
            outcome.unwrap(),
            crate::ExecControlOutcome::GuestStatus(result) if result.status == status
        )),
    }
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn supervised_exec_control_retains_guest_deadline_reply() {
    for timeout in [
        Duration::ZERO,
        Duration::from_nanos(1),
        Duration::from_millis(25),
    ] {
        retains_reply_after_guest_budget(timeout, ExecControlStatus::SinkTimeout).await;
    }
}

#[tokio::test]
async fn supervised_exec_control_retains_delivered_reply_in_transit() {
    retains_reply_after_guest_budget(Duration::from_millis(25), ExecControlStatus::Delivered).await;
}

#[tokio::test]
async fn supervised_exec_control_large_timeout_saturates_request_timeout_ms() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-large-timeout").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("large-timeout", b"payload", Duration::MAX)
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let decoded_control = guest_control_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.target_seq, start_seq);
    assert_eq!(decoded_control.control_nonce, control_nonce);
    assert_eq!(decoded_control.message_id, "large-timeout");
    assert_eq!(decoded_control.request_timeout_ms, u32::MAX);

    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "large-timeout",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    let ack = control_task.await.unwrap().unwrap();
    assert_eq!(ack.target_seq, start_seq);
    assert_eq!(ack.message_id, "large-timeout");

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_disabled_returns_unsupported_without_frame() {
    let StartedSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        ..
    } = start_supervised_exec_fixture(supervised_request("control-disabled")).await;
    let start_seq = start.seq();
    assert!(handle.control_handle().is_none());

    let err = handle
        .control("disabled", b"payload", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Unsupported);
    assert_no_guest_frame(&mut guest, "disabled control must not send a frame");

    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn supervised_exec_control_reports_guest_status_and_error() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-status").await;
    let start_seq = start.seq();

    for (status, diagnostic, error_kind, error_message) in [
        (
            ExecControlStatus::QueueFull,
            "queue full",
            io::ErrorKind::WouldBlock,
            "queue full",
        ),
        (
            ExecControlStatus::SinkClosed,
            "",
            io::ErrorKind::BrokenPipe,
            "exec control sink closed",
        ),
    ] {
        let status_task = tokio::spawn({
            let control_handle = control_handle.clone();
            async move {
                control_handle
                    .control("status", b"payload", Duration::from_secs(5))
                    .await
            }
        });
        let status_control = read_guest_message(&mut guest).await;
        send_exec_control_result(
            &mut guest,
            status_control.seq,
            start_seq,
            control_nonce,
            "status",
            status,
            diagnostic,
        )
        .await;
        let err = status_task.await.unwrap().unwrap_err();
        assert_eq!(err.kind(), error_kind);
        assert_eq!(err.to_string(), error_message);
    }

    let error_task = tokio::spawn({
        let control_handle = control_handle.clone();
        async move {
            control_handle
                .control("error", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let error_control = read_guest_message(&mut guest).await;
    send_guest_error(&mut guest, error_control.seq, "guest rejected control").await;
    let err = error_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest rejected control");

    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_guest_error_uses_control_error_fallback() {
    let StartedControlSupervisedExec {
        host: _host,
        mut guest,
        start,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-error-fallback").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("guest-error", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    send_guest_error(&mut guest, control.seq, "guest rejected control").await;

    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest rejected control");

    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn supervised_exec_control_cancelled_before_write_remains_reusable() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-cancelled-before-write").await;
    let start_seq = start.seq();
    let writer_guard = host.shared.writer.lock().await;

    {
        let control = control_handle.control("cancelled", b"payload", Duration::from_secs(5));
        tokio::pin!(control);
        tokio::select! {
            result = &mut control => {
                panic!("control must wait for the held writer lock: {result:?}");
            }
            () = tokio::task::yield_now() => {}
        }
    }

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    drop(writer_guard);
    assert_no_guest_frame(
        &mut guest,
        "control cancelled before write must not send a frame",
    );
    finish_supervised_exec_success(&mut guest, start_seq, handle)
        .await
        .unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn supervised_exec_control_cancelled_after_write_ignores_late_result() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-cancelled-after-write").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn(async move {
        control_handle
            .control("cancelled", b"payload", Duration::from_secs(5))
            .await
    });
    let control = read_guest_message(&mut guest).await;
    control_task.abort();
    assert!(control_task.await.unwrap_err().is_cancelled());
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "cancelled",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_control_timeout_ignores_late_result() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-timeout").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("timeout", b"payload", Duration::ZERO)
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let decoded_control = guest_control_proto::decode_exec_control(&control.payload).unwrap();
    assert_eq!(decoded_control.request_timeout_ms, 0);
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "timeout",
        ExecControlStatus::Delivered,
        "",
    )
    .await;
    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_control_malformed_result_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-malformed-result").await;

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("malformed-result", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    assert_eq!(control.msg_type, MSG_EXEC_CONTROL);
    let frame = guest_control_proto::encode(MSG_EXEC_CONTROL_RESULT, control.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_control_malformed_error_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-malformed-error").await;

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("malformed-error", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    assert_eq!(control.msg_type, MSG_EXEC_CONTROL);
    let frame = guest_control_proto::encode(MSG_ERROR, control.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn supervised_exec_control_nonce_mismatch_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-mismatch").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("nonce-mismatch", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    let mut control_nonce = control_nonce;
    control_nonce[0] ^= 1;
    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "nonce-mismatch",
        ExecControlStatus::Delivered,
        "",
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_control_target_seq_mismatch_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-target-mismatch").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("target-mismatch", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq + 1,
        control_nonce,
        "target-mismatch",
        ExecControlStatus::Delivered,
        "",
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_control_message_id_mismatch_poisons_connection() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        control_nonce,
        ..
    } = start_control_supervised_exec_fixture("control-message-mismatch").await;
    let start_seq = start.seq();

    let control_task = tokio::spawn({
        async move {
            control_handle
                .control("message-mismatch", b"payload", Duration::from_secs(5))
                .await
        }
    });
    let control = read_guest_message(&mut guest).await;
    send_exec_control_result(
        &mut guest,
        control.seq,
        start_seq,
        control_nonce,
        "different-message-id",
        ExecControlStatus::Delivered,
        "",
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = control_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_control_inactive_target_returns_not_found_without_frame() {
    let StartedControlSupervisedExec {
        host,
        mut guest,
        start,
        handle,
        control_handle,
        ..
    } = start_control_supervised_exec_fixture("control-inactive").await;
    let start_seq = start.seq();
    send_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await.unwrap();

    set_next_route_id(&host, (1_u64 << 32) + u64::from(start_seq));
    let replacement = start_capture_operation(&host, "replacement target").await;
    let replacement_start = read_guest_message(&mut guest).await;
    assert_eq!(replacement_start.msg_type, MSG_EXEC_START);
    assert_eq!(replacement_start.seq, start_seq);

    let err = control_handle
        .control("after-exit", b"payload", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
    assert_no_guest_frame(&mut guest, "inactive control must not send a frame");
    assert_eq!(operation_count(&host), 1);
    send_exec_result(
        &mut guest,
        replacement_start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    replacement.wait(Duration::from_secs(5)).await.unwrap();
}
