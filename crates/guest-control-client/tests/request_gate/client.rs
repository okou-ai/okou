use std::pin::Pin;

use guest_control_client::test_support::request_gate::{RequestKind, ResponseDisposition};
use guest_control_client::{
    ExecCaptureRequest, NormalOperationFenceRejection, SupervisedExecControl, SupervisedExecRequest,
};
use guest_control_proto::{
    ExecCapturedOutput, ExecLifecyclePolicy, ExecOutputPolicy, ExecOutputStream, ExecProcessRole,
    ExecTermination, ExecTimeoutPolicy, GuestStateRestoreTimezone, MSG_ERROR, MSG_EXEC_OUTPUT,
    MSG_EXEC_RESULT, MSG_EXEC_START, MSG_EXEC_STARTED, MSG_GUEST_STATE_RESTORE,
    MSG_GUEST_STATE_RESTORE_RESULT, MSG_OPERATIONS_QUIESCED, MSG_QUIESCE_OPERATIONS,
};

use super::support::*;

#[tokio::test]
async fn cancelled_restore_keeps_original_transport_and_not_parkable_policy() {
    let (client, mut peer, mut controls, mut exchange, mut connection) = setup().await.unwrap();
    controls.arm(RequestKind::GuestStateRestore).unwrap();
    let mut operation = Box::pin(restore(&client));
    let captured = capture(&mut controls, operation.as_mut()).await.unwrap();
    assert_eq!(captured.message_type(), MSG_GUEST_STATE_RESTORE);
    let mut expected = Vec::new();
    guest_control_proto::encode_guest_state_restore_request_frame_into(
        &mut expected,
        captured.sequence(),
        1_000,
        1_778_000_000,
        123_000_000,
        &ENTROPY,
        GuestStateRestoreTimezone::Required("UTC"),
    )
    .unwrap();
    assert_eq!(captured.raw(), expected);
    assert!(controls.arm(RequestKind::Quiesce).is_err());
    pending_once(operation.as_mut()).await;
    status_roundtrip(&client, &mut peer).await.unwrap();
    controls.dispatch.send(()).unwrap();
    assert_eq!(peer.next().await.unwrap().raw, captured.raw());
    let raw = peer
        .send(
            MSG_GUEST_STATE_RESTORE_RESULT,
            captured.sequence(),
            &restore_result().unwrap(),
        )
        .await
        .unwrap();
    let response = bounded(&mut controls.response).await.unwrap().unwrap();
    assert_eq!(response.raw(), raw);
    pending_once(operation.as_mut()).await;
    for _ in 0..2 {
        let mut join = Box::pin(exchange.join());
        pending_once(join.as_mut()).await;
        let mut connection_join = Box::pin(connection.join());
        pending_once(connection_join.as_mut()).await;
    }
    status_roundtrip(&client, &mut peer).await.unwrap();
    drop(operation);
    assert!(matches!(
        client.try_fence_normal_operations(),
        Err(NormalOperationFenceRejection::NotParkable)
    ));
    controls
        .delivery
        .send(ResponseDisposition::Deliver)
        .unwrap();
    let joined = bounded(exchange.join()).await.unwrap().unwrap();
    assert_eq!(joined.request, captured);
    assert_eq!(joined.response, response);
    status_roundtrip(&client, &mut peer).await.unwrap();
    assert!(matches!(
        client.try_fence_normal_operations(),
        Err(NormalOperationFenceRejection::NotParkable)
    ));
    assert!(restore(&client).await.is_err());
    finish(client, peer, connection).await.unwrap();
}

#[tokio::test]
async fn lost_controllers_forward_real_restore_before_and_after_dispatch() {
    for release_dispatch in [false, true] {
        let (client, mut peer, mut controls, mut exchange, connection) = setup().await.unwrap();
        controls.arm(RequestKind::GuestStateRestore).unwrap();
        let mut operation = Box::pin(restore(&client));
        let captured = capture(&mut controls, operation.as_mut()).await.unwrap();
        if release_dispatch {
            controls.dispatch.send(()).unwrap();
        } else {
            drop(controls.dispatch);
        }
        assert_eq!(peer.next().await.unwrap().raw, captured.raw());
        drop(controls.delivery);
        peer.send(
            MSG_GUEST_STATE_RESTORE_RESULT,
            captured.sequence(),
            &restore_result().unwrap(),
        )
        .await
        .unwrap();
        let actual = bounded(operation).await.unwrap().unwrap();
        assert_eq!(actual.termination, ExecTermination::Exited { exit_code: 0 });
        assert_eq!(actual.stderr, b"original diagnostic");
        assert_eq!(
            bounded(exchange.join()).await.unwrap().unwrap().request,
            captured
        );
        let fence = client.try_fence_normal_operations().unwrap();
        drop(fence);
        finish(client, peer, connection).await.unwrap();
    }
}

#[tokio::test]
async fn quiesce_holds_only_its_actual_sequence_and_preserves_error_terminal() {
    for busy in [false, true] {
        let (client, mut peer, mut controls, mut exchange, connection) = setup().await.unwrap();
        controls.arm(RequestKind::Quiesce).unwrap();
        let mut operation = Box::pin(client.quiesce_operations(DEADLINE));
        let captured = capture(&mut controls, operation.as_mut()).await.unwrap();
        assert_eq!(captured.message_type(), MSG_QUIESCE_OPERATIONS);
        status_roundtrip(&client, &mut peer).await.unwrap();
        controls.dispatch.send(()).unwrap();
        assert_eq!(peer.next().await.unwrap().raw, captured.raw());
        peer.send(MSG_OPERATIONS_QUIESCED, captured.sequence() + 17, &[])
            .await
            .unwrap();
        status_roundtrip(&client, &mut peer).await.unwrap();
        pending_once(Pin::new(&mut controls.response)).await;
        let (kind, payload) = if busy {
            (
                MSG_ERROR,
                guest_control_proto::encode_error("operations busy"),
            )
        } else {
            (MSG_OPERATIONS_QUIESCED, Vec::new())
        };
        let raw = peer
            .send(kind, captured.sequence(), &payload)
            .await
            .unwrap();
        assert_eq!(
            bounded(&mut controls.response)
                .await
                .unwrap()
                .unwrap()
                .raw(),
            raw
        );
        pending_once(operation.as_mut()).await;
        status_roundtrip(&client, &mut peer).await.unwrap();
        controls
            .delivery
            .send(ResponseDisposition::Deliver)
            .unwrap();
        let result = bounded(operation).await.unwrap();
        if busy {
            assert!(result.unwrap_err().to_string().contains("operations busy"));
        } else {
            result.unwrap();
        }
        assert_eq!(
            bounded(exchange.join())
                .await
                .unwrap()
                .unwrap()
                .response
                .message_type(),
            kind
        );
        finish(client, peer, connection).await.unwrap();
    }
}

#[tokio::test]
async fn final_capture_exec_retains_real_result_and_original_normal_fence() {
    let (client, mut peer, mut controls, mut exchange, connection) = setup().await.unwrap();
    controls.arm(RequestKind::Exec).unwrap();
    let mut operation = Box::pin(
        client.exec_operation_capture_with_fence(ExecCaptureRequest {
            timeout_ms: 1_000,
            command: "true",
            env: &[],
            sudo: false,
            label: "original-final-preparation",
            stdout_limit_bytes: 1024,
            stderr_limit_bytes: 1024,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: DEADLINE,
        }),
    );
    let captured = capture(&mut controls, operation.as_mut()).await.unwrap();
    assert_eq!(captured.message_type(), MSG_EXEC_START);
    status_roundtrip(&client, &mut peer).await.unwrap();
    controls.dispatch.send(()).unwrap();
    let forwarded = peer.next().await.unwrap();
    assert_eq!(forwarded.raw, captured.raw());
    assert_eq!(
        guest_control_proto::decode_exec_start(&forwarded.message.payload)
            .unwrap()
            .lifecycle,
        ExecLifecyclePolicy::OneShot
    );
    let stdout = ExecCapturedOutput::Captured {
        bytes: b"complete original result",
        truncated: false,
    };
    let stderr = ExecCapturedOutput::Captured {
        bytes: b"",
        truncated: false,
    };
    peer.send(
        MSG_EXEC_RESULT,
        captured.sequence(),
        &guest_control_proto::encode_exec_result(
            ExecTermination::Exited { exit_code: 0 },
            3,
            stdout,
            stderr,
            "",
        )
        .unwrap(),
    )
    .await
    .unwrap();
    bounded(&mut controls.response).await.unwrap().unwrap();
    pending_once(operation.as_mut()).await;
    status_roundtrip(&client, &mut peer).await.unwrap();
    controls
        .delivery
        .send(ResponseDisposition::Deliver)
        .unwrap();
    let (result, fence) = bounded(operation).await.unwrap().unwrap();
    assert_eq!(
        result.stdout,
        guest_control_client::ExecOwnedCapturedOutput::Captured {
            bytes: b"complete original result".to_vec(),
            truncated: false,
        }
    );
    bounded(exchange.join()).await.unwrap().unwrap();
    assert!(matches!(
        client.try_fence_normal_operations(),
        Err(NormalOperationFenceRejection::AlreadyFenced)
    ));
    drop(fence);
    drop(client.try_fence_normal_operations().unwrap());
    finish(client, peer, connection).await.unwrap();
}

#[tokio::test]
async fn cancelled_final_capture_retains_original_fence_refusal_after_late_result() {
    for terminal_held in [false, true] {
        let (client, mut peer, mut controls, mut exchange, connection) = setup().await.unwrap();
        controls.arm(RequestKind::Exec).unwrap();
        let request = || ExecCaptureRequest {
            timeout_ms: 1_000,
            command: "true",
            env: &[],
            sudo: false,
            label: "cancelled-final-preparation",
            stdout_limit_bytes: 1024,
            stderr_limit_bytes: 1024,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: DEADLINE,
        };
        let mut operation = Box::pin(client.exec_operation_capture_with_fence(request()));
        let captured = capture(&mut controls, operation.as_mut()).await.unwrap();
        assert!(matches!(
            client.try_fence_normal_operations(),
            Err(NormalOperationFenceRejection::AlreadyFenced)
        ));
        let result = guest_control_proto::encode_exec_result(
            ExecTermination::Exited { exit_code: 0 },
            3,
            ExecCapturedOutput::Captured {
                bytes: b"original final result",
                truncated: false,
            },
            ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: false,
            },
            "",
        )
        .unwrap();
        let mut dispatch = Some(controls.dispatch);
        if terminal_held {
            dispatch.take().unwrap().send(()).unwrap();
            assert_eq!(peer.next().await.unwrap().raw, captured.raw());
            peer.send(MSG_EXEC_RESULT, captured.sequence(), &result)
                .await
                .unwrap();
            bounded(&mut controls.response).await.unwrap().unwrap();
        }
        pending_once(operation.as_mut()).await;
        status_roundtrip(&client, &mut peer).await.unwrap();
        drop(operation);
        assert!(matches!(
            client.try_fence_normal_operations(),
            Err(NormalOperationFenceRejection::NotParkable)
        ));
        if let Some(dispatch) = dispatch {
            dispatch.send(()).unwrap();
            assert_eq!(peer.next().await.unwrap().raw, captured.raw());
            peer.send(MSG_EXEC_RESULT, captured.sequence(), &result)
                .await
                .unwrap();
            bounded(&mut controls.response).await.unwrap().unwrap();
        }
        controls
            .delivery
            .send(ResponseDisposition::Deliver)
            .unwrap();
        let joined = bounded(exchange.join()).await.unwrap().unwrap();
        assert_eq!(joined.request, captured);
        status_roundtrip(&client, &mut peer).await.unwrap();
        assert!(matches!(
            client.try_fence_normal_operations(),
            Err(NormalOperationFenceRejection::NotParkable)
        ));
        assert!(client.exec_operation_capture(request()).await.is_err());
        finish(client, peer, connection).await.unwrap();
    }
}

#[tokio::test]
async fn legitimate_supervised_start_and_streamed_output_pass_before_held_terminal() {
    let (client, mut peer, mut controls, mut exchange, connection) = setup().await.unwrap();
    controls.arm(RequestKind::Exec).unwrap();
    let mut starting = Box::pin(client.start_supervised_exec(SupervisedExecRequest {
        role: ExecProcessRole::Workload,
        timeout: ExecTimeoutPolicy::None,
        timeout_is_expected: false,
        command: "owned-supervised-work",
        env: &[],
        sudo: false,
        label: "supervised-wire-peer",
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 64,
        },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        control: SupervisedExecControl::Disabled,
        stdin_bytes: None,
        stream_queue_capacity: Some(8),
        start_timeout: DEADLINE,
    }));
    let captured = capture(&mut controls, starting.as_mut()).await.unwrap();
    controls.dispatch.send(()).unwrap();
    let forwarded = peer.next().await.unwrap();
    assert_eq!(forwarded.raw, captured.raw());
    assert_eq!(
        guest_control_proto::decode_exec_start(&forwarded.message.payload)
            .unwrap()
            .lifecycle,
        ExecLifecyclePolicy::Supervised
    );
    peer.send(
        MSG_EXEC_STARTED,
        captured.sequence(),
        &guest_control_proto::encode_exec_started(71).unwrap(),
    )
    .await
    .unwrap();
    let mut handle = bounded(starting).await.unwrap().unwrap();
    let mut output = handle.take_stream_receiver().unwrap();
    let chunk = b"original running output";
    peer.send(
        MSG_EXEC_OUTPUT,
        captured.sequence(),
        &guest_control_proto::encode_exec_output(ExecOutputStream::Stdout, 0, chunk, false)
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(bounded(output.recv()).await.unwrap().unwrap().chunk, chunk);
    pending_once(Pin::new(&mut controls.response)).await;
    status_roundtrip(&client, &mut peer).await.unwrap();
    peer.send(
        MSG_EXEC_RESULT,
        captured.sequence(),
        &guest_control_proto::encode_exec_result(
            ExecTermination::Exited { exit_code: 0 },
            3,
            ExecCapturedOutput::Discarded,
            ExecCapturedOutput::Discarded,
            "",
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let terminal = bounded(&mut controls.response).await.unwrap().unwrap();
    let mut waiting = Box::pin(handle.wait(DEADLINE));
    pending_once(waiting.as_mut()).await;
    status_roundtrip(&client, &mut peer).await.unwrap();
    controls
        .delivery
        .send(ResponseDisposition::Deliver)
        .unwrap();
    assert_eq!(
        bounded(waiting).await.unwrap().unwrap().termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert_eq!(
        bounded(exchange.join()).await.unwrap().unwrap().response,
        terminal
    );
    assert!(bounded(output.recv()).await.unwrap().is_none());
    finish(client, peer, connection).await.unwrap();
}

#[tokio::test]
async fn response_relay_unwind_after_real_delivery_is_not_a_positive_join() {
    let (client, mut peer, mut controls, mut exchange, mut connection) = setup().await.unwrap();
    controls.arm(RequestKind::GuestStateRestore).unwrap();
    let mut operation = Box::pin(restore(&client));
    let captured = capture(&mut controls, operation.as_mut()).await.unwrap();
    controls.dispatch.send(()).unwrap();
    peer.next().await.unwrap();
    peer.send(
        MSG_GUEST_STATE_RESTORE_RESULT,
        captured.sequence(),
        &restore_result().unwrap(),
    )
    .await
    .unwrap();
    bounded(&mut controls.response).await.unwrap().unwrap();
    controls
        .delivery
        .send(ResponseDisposition::UnwindAfterDelivery)
        .unwrap();
    assert_eq!(
        bounded(operation).await.unwrap().unwrap().termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert!(bounded(exchange.join()).await.unwrap().is_err());
    let error = bounded(connection.join()).await.unwrap().unwrap_err();
    assert!(
        error
            .get_ref()
            .and_then(|source| source.downcast_ref::<tokio::task::JoinError>())
            .is_some_and(tokio::task::JoinError::is_panic)
    );
    drop(client);
    drop(peer);
}
