use std::{io, sync::Arc, time::Duration};

use guest_contracts::agent_instructions::InstructionOperation;
use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, MSG_GUEST_AGENT_INSTRUCTIONS,
    MSG_GUEST_AGENT_INSTRUCTIONS_RESULT,
};
use sandbox::AgentInstructionsRequest;
use tokio::sync::oneshot;

use crate::operation_tracker::NormalOperationReadiness;
use crate::tests::support::{
    MockGuest, host_from_stream, make_pair, normal_operation_readiness, pending_request_count,
};

fn request() -> AgentInstructionsRequest<'static> {
    AgentInstructionsRequest {
        operation: InstructionOperation::Check,
        metadata: b"{}",
        run_id: "run",
        runtime_dir: "/run/instructions",
        timeout: Duration::from_secs(3),
    }
}

#[tokio::test]
async fn instruction_result_validation_settles_each_terminal_operation() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        for case in 0..4 {
            let request = guest.expect_message(MSG_GUEST_AGENT_INSTRUCTIONS).await;
            let decoded =
                guest_control_proto::decode_guest_agent_instructions_request(&request.payload)
                    .unwrap();
            assert_eq!(decoded.operation, InstructionOperation::Check);
            assert_eq!(decoded.input.run_id, "run");
            assert_eq!(decoded.input.runtime_dir, "/run/instructions");
            assert_eq!(decoded.input.timeout_ms, 3000);
            assert_eq!(decoded.input.manifest_json, b"{}");
            let bytes = if case == 1 {
                vec![0; 65537]
            } else {
                b"out".to_vec()
            };
            let stdout = if case == 2 {
                ExecCapturedOutput::Discarded
            } else {
                ExecCapturedOutput::Captured {
                    bytes: &bytes,
                    truncated: true,
                }
            };
            let payload = if case == 3 {
                vec![255]
            } else {
                guest_control_proto::encode_exec_result(
                    ExecTermination::Exited { exit_code: 23 },
                    7,
                    stdout,
                    ExecCapturedOutput::Captured {
                        bytes: b"failure",
                        truncated: false,
                    },
                    "helper error",
                )
                .unwrap()
            };
            guest
                .send_response(MSG_GUEST_AGENT_INSTRUCTIONS_RESULT, request.seq, &payload)
                .await;
        }
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();
    for case in 0..4 {
        let result = host
            .guest_agent_instructions(&request(), Duration::from_secs(5))
            .await;
        if case == 0 {
            let result = result.unwrap();
            assert_eq!(
                result.termination,
                ExecTermination::Exited { exit_code: 23 }
            );
            assert_eq!(result.stdout, b"out");
            assert!(result.stdout_truncated);
            assert_eq!(result.stderr, b"failure");
            assert_eq!(result.diagnostic, "helper error");
            assert!(result.resources.is_none());
        } else {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
        assert_eq!(pending_request_count(&host), 0);
        assert_eq!(
            normal_operation_readiness(&host),
            NormalOperationReadiness::Idle
        );
    }
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn dropping_transmitted_instruction_request_prevents_parking() {
    let (host_stream, guest_stream) = make_pair();
    let (sent_tx, sent_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        guest.expect_message(MSG_GUEST_AGENT_INSTRUCTIONS).await;
        sent_tx.send(()).unwrap();
        release_rx.await.unwrap();
    });
    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let request_host = Arc::clone(&host);
    let pending = tokio::spawn(async move {
        request_host
            .guest_agent_instructions(&request(), Duration::from_secs(5))
            .await
    });
    sent_rx.await.unwrap();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}
