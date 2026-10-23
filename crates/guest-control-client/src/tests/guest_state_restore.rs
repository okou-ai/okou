use std::io;
use std::time::Duration;

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, GuestStateRestoreTimezone, MSG_GUEST_STATE_RESTORE,
    MSG_GUEST_STATE_RESTORE_RESULT,
};
use tokio::sync::oneshot;

use crate::operation_tracker::NormalOperationReadiness;
use crate::tests::support::{
    MockGuest, host_from_stream, make_pair, normal_operation_readiness, pending_request_count,
    setup_host_and_mock_guest,
};
use crate::{RequestTimeoutError, RequestTimeoutStage};

fn entropy() -> [u8; 256] {
    std::array::from_fn(|index| index as u8)
}

fn success_payload() -> Vec<u8> {
    guest_control_proto::encode_guest_state_restore_result(
        ExecTermination::Exited { exit_code: 0 },
        17,
        ExecCapturedOutput::Captured {
            bytes: b"guest timezone sync failed",
            truncated: true,
        },
        "",
    )
    .unwrap()
}

#[tokio::test]
async fn guest_state_restore_sends_fixed_request_and_decodes_result() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let expected_entropy = entropy();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STATE_RESTORE).await;
        let decoded =
            guest_control_proto::decode_guest_state_restore_request(&request.payload).unwrap();
        assert_eq!(decoded.timeout_ms, 300_000);
        assert_eq!(decoded.unix_seconds, 1_778_000_000);
        assert_eq!(decoded.unix_nanoseconds, 123_000_000);
        assert_eq!(decoded.entropy, expected_entropy);
        assert_eq!(
            decoded.timezone,
            GuestStateRestoreTimezone::Required("Asia/Shanghai")
        );
        guest
            .send_response(
                MSG_GUEST_STATE_RESTORE_RESULT,
                request.seq,
                &success_payload(),
            )
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let result = host
        .guest_state_restore(
            1_778_000_000,
            123_000_000,
            &entropy(),
            GuestStateRestoreTimezone::Required("Asia/Shanghai"),
            300_000,
            Duration::from_secs(1),
        )
        .await
        .unwrap();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.duration_ms, 17);
    assert_eq!(result.stderr, b"guest timezone sync failed");
    assert!(result.stderr_truncated);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_state_restore_rejects_empty_named_timezones_without_sending_request() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let entropy = entropy();
    for timezone in [
        GuestStateRestoreTimezone::BestEffort(""),
        GuestStateRestoreTimezone::Required(""),
    ] {
        let error = host
            .guest_state_restore(1, 0, &entropy, timezone, 1, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    let (result, ()) = tokio::join!(
        host.guest_state_restore(
            1,
            0,
            &entropy,
            GuestStateRestoreTimezone::Required("UTC"),
            1,
            Duration::from_secs(1),
        ),
        async {
            let request = guest.expect_message(MSG_GUEST_STATE_RESTORE).await;
            let decoded =
                guest_control_proto::decode_guest_state_restore_request(&request.payload).unwrap();
            assert_eq!(decoded.timezone, GuestStateRestoreTimezone::Required("UTC"));
            guest
                .send_response(
                    MSG_GUEST_STATE_RESTORE_RESULT,
                    request.seq,
                    &success_payload(),
                )
                .await;
        },
    );
    assert_eq!(
        result.unwrap().termination,
        ExecTermination::Exited { exit_code: 0 }
    );
}

#[tokio::test]
async fn guest_state_restore_surfaces_guest_error_and_malformed_result() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STATE_RESTORE).await;
        guest
            .send_error_response(request.seq, "guest operations are quiescing")
            .await;
        let request = guest.expect_message(MSG_GUEST_STATE_RESTORE).await;
        guest
            .send_response(MSG_GUEST_STATE_RESTORE_RESULT, request.seq, &[0xFF])
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let error = host
        .guest_state_restore(
            1,
            0,
            &entropy(),
            GuestStateRestoreTimezone::None,
            1,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("guest operations are quiescing"));

    let error = host
        .guest_state_restore(
            1,
            0,
            &entropy(),
            GuestStateRestoreTimezone::None,
            1,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_state_restore_timeout_abandons_connection_for_parking() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let entropy = entropy();
    let timeout = Duration::from_millis(20);
    tokio::time::pause();
    let request =
        host.guest_state_restore(1, 0, &entropy, GuestStateRestoreTimezone::None, 1, timeout);
    tokio::pin!(request);
    {
        let receipt = guest.expect_message(MSG_GUEST_STATE_RESTORE);
        tokio::pin!(receipt);
        // A Tokio timeout cannot bound this wait while its clock is frozen.
        let receipt_started = std::time::Instant::now();
        loop {
            tokio::select! {
                biased;
                result = &mut request => {
                    panic!("restore request completed before guest receipt: {result:?}");
                }
                _ = &mut receipt => break,
                // Keep paused time from auto-advancing through real socket I/O.
                () = tokio::task::yield_now() => {
                    assert!(
                        receipt_started.elapsed() < Duration::from_secs(5),
                        "timed out waiting for the guest to receive the restore request"
                    );
                }
            }
        }
    }

    // Leave the request unpolled during the jump, then resume before cleanup.
    tokio::time::advance(timeout + Duration::from_millis(1)).await;
    tokio::time::resume();
    let error = request.await.unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let timeout_error = error
        .get_ref()
        .unwrap()
        .downcast_ref::<RequestTimeoutError>()
        .expect("restore deadline errors must retain their typed timeout stage");
    assert_eq!(
        timeout_error.stage(),
        RequestTimeoutStage::AwaitingTerminalResponse
    );
    assert_eq!(timeout_error.timeout(), timeout);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}
