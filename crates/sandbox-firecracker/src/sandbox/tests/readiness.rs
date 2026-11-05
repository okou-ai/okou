use super::*;
use guest_control_proto::{
    ExecCapturedOutput, FileWriteStage, FileWriteStatus, GuestDnsReadinessTermination,
    MSG_FILE_WRITE_STATUS, MSG_FILE_WRITE_STATUS_RESULT, MSG_GUEST_DNS_READINESS,
    MSG_GUEST_DNS_READINESS_RESULT, MSG_HOME_DRIVE_MOUNT, MSG_HOME_DRIVE_MOUNT_RESULT,
};

#[derive(Default)]
struct ReadinessObserver {
    stages: Vec<(SandboxStartStage, bool)>,
    attempts: Vec<sandbox::SandboxDnsReadinessAttempt>,
}

impl SandboxStartObserver for ReadinessObserver {
    fn record_stage(&mut self, stage: SandboxStartStage, _: Duration, success: bool) {
        self.stages.push((stage, success));
    }

    fn record_dns_readiness_attempt(&mut self, attempt: sandbox::SandboxDnsReadinessAttempt) {
        self.attempts.push(attempt);
    }
}

async fn readiness_peer() -> (Arc<GuestControlClient>, UnixStream) {
    let sandbox = test_sandbox_with_state(SandboxState::Created);
    let peer = attach_mock_shutdown_guest(&sandbox).await;
    let guest = sandbox.guest.lock().await.as_ref().unwrap().clone();
    (guest, peer)
}

async fn reply(peer: &mut UnixStream, request: &RawMessage, success: bool) {
    let (kind, payload) = match request.msg_type {
        MSG_HOME_DRIVE_MOUNT => (
            MSG_HOME_DRIVE_MOUNT_RESULT,
            guest_control_proto::encode_home_drive_mount_result(
                guest_control_proto::ExecTermination::Exited {
                    exit_code: if success { 0 } else { 64 },
                },
                1,
                ExecCapturedOutput::Captured {
                    bytes: b"",
                    truncated: false,
                },
                ExecCapturedOutput::Captured {
                    bytes: b"",
                    truncated: false,
                },
                "",
            )
            .unwrap(),
        ),
        MSG_GUEST_DNS_READINESS => (
            MSG_GUEST_DNS_READINESS_RESULT,
            guest_control_proto::encode_guest_dns_readiness_result(
                if success {
                    GuestDnsReadinessTermination::Exited { exit_code: 0 }
                } else {
                    GuestDnsReadinessTermination::StartFailed
                },
                1,
                b"192.0.2.1 STREAM vm0-readiness.invalid\n",
                false,
                "",
            )
            .unwrap(),
        ),
        kind => panic!("unexpected readiness operation {kind}"),
    };
    peer.write_all(&guest_control_proto::encode(kind, request.seq, &payload).unwrap())
        .await
        .unwrap();
}

async fn requests(peer: &mut UnixStream) -> (RawMessage, RawMessage) {
    // Receiving both requests before replying to either proves overlap through
    // the production Guest-control transport, without wall-clock assertions.
    let (first, second) = tokio::time::timeout(Duration::from_secs(5), async {
        let first = read_vsock_message(peer).await;
        let second = read_vsock_message(peer).await;
        (first, second)
    })
    .await
    .unwrap();
    let (home, dns) = if first.msg_type == MSG_HOME_DRIVE_MOUNT {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(home.msg_type, MSG_HOME_DRIVE_MOUNT);
    assert_eq!(dns.msg_type, MSG_GUEST_DNS_READINESS);
    guest_control_proto::decode_home_drive_mount_request(&home.payload).unwrap();
    guest_control_proto::decode_guest_dns_readiness_request(&dns.payload).unwrap();
    (home, dns)
}

async fn wait_for_reply_dispatch(guest: &GuestControlClient, peer: &mut UnixStream) {
    // This control query does not alter normal-operation gates. Its reply comes
    // after the readiness replies on the same stream, so awaiting it proves the
    // client has dispatched those earlier frames before we assert on them.
    let status = FileWriteStatus {
        sequence: 0,
        stage: FileWriteStage::Idle,
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        let respond = async {
            let request = read_vsock_message(peer).await;
            assert_eq!(request.msg_type, MSG_FILE_WRITE_STATUS);
            assert!(request.payload.is_empty());
            peer.write_all(
                &guest_control_proto::encode(
                    MSG_FILE_WRITE_STATUS_RESULT,
                    request.seq,
                    &status.encode_payload(),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        };
        let (received, ()) = tokio::join!(guest.file_write_status(Duration::from_secs(5)), respond);
        assert_eq!(received.unwrap(), status);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn readiness_joins_both_gates_in_either_order_and_preserves_home_failure_precedence() {
    for home_first in [false, true] {
        for (home_ok, dns_ok) in [(true, true), (false, true), (true, false), (false, false)] {
            let (guest, mut peer) = readiness_peer().await;
            let mut observer = ReadinessObserver::default();
            let result = {
                let wait = wait_for_guest_readiness(&guest, true, Some(53), &mut observer);
                tokio::pin!(wait);
                let (home, dns) = tokio::select! {
                    result = &mut wait => panic!("readiness finished before both requests: {result:?}"),
                    requests = requests(&mut peer) => requests,
                };
                let (first, first_ok, second, second_ok) = if home_first {
                    (&home, home_ok, &dns, dns_ok)
                } else {
                    (&dns, dns_ok, &home, home_ok)
                };
                reply(&mut peer, first, first_ok).await;
                wait_for_reply_dispatch(&guest, &mut peer).await;
                assert!(futures_util::poll!(&mut wait).is_pending());
                reply(&mut peer, second, second_ok).await;
                wait.await
            };
            match (home_ok, dns_ok, result) {
                (true, true, Ok(())) => {}
                (false, _, Err(GuestReadinessError::Home(_))) => {}
                (true, false, Err(GuestReadinessError::Dns { port: 53, .. })) => {}
                (_, _, result) => panic!("unexpected readiness result: {result:?}"),
            }
            assert_eq!(
                observer.stages,
                vec![
                    (SandboxStartStage::GuestHomeValidation, home_ok),
                    (SandboxStartStage::GuestDnsReadiness, dns_ok),
                ]
            );
            assert_eq!(observer.attempts.len(), 1);
            assert!(guest.try_fence_normal_operations().is_ok());
        }
    }
}

#[tokio::test]
async fn readiness_only_runs_configured_gates() {
    for (has_home, has_dns) in [(false, false), (true, false), (false, true)] {
        let (guest, mut peer) = readiness_peer().await;
        let mut observer = ReadinessObserver::default();
        let respond = async {
            if has_home || has_dns {
                let request =
                    tokio::time::timeout(Duration::from_secs(5), read_vsock_message(&mut peer))
                        .await
                        .unwrap();
                assert_eq!(
                    request.msg_type,
                    if has_home {
                        MSG_HOME_DRIVE_MOUNT
                    } else {
                        MSG_GUEST_DNS_READINESS
                    }
                );
                reply(&mut peer, &request, true).await;
            }
        };
        let (result, ()) = tokio::join!(
            wait_for_guest_readiness(&guest, has_home, has_dns.then_some(53), &mut observer),
            respond,
        );
        result.unwrap();
        assert_eq!(
            observer.stages,
            if has_home {
                vec![(SandboxStartStage::GuestHomeValidation, true)]
            } else if has_dns {
                vec![(SandboxStartStage::GuestDnsReadiness, true)]
            } else {
                vec![]
            }
        );
    }
}

#[tokio::test]
async fn cancelled_readiness_fences_both_admitted_requests_even_after_late_results() {
    let (guest, mut peer) = readiness_peer().await;
    let mut observer = ReadinessObserver::default();
    let (home, dns) = {
        let wait = wait_for_guest_readiness(&guest, true, Some(53), &mut observer);
        tokio::pin!(wait);
        tokio::select! {
            result = &mut wait => panic!("readiness finished before both requests: {result:?}"),
            requests = requests(&mut peer) => requests,
        }
        // Drop the entire startup wait after both possible-write boundaries.
    };
    reply(&mut peer, &home, true).await;
    reply(&mut peer, &dns, true).await;
    wait_for_reply_dispatch(&guest, &mut peer).await;
    assert!(guest.try_fence_normal_operations().is_err());
    assert!(observer.stages.is_empty());
    assert_eq!(observer.attempts.len(), 1);
    assert_eq!(
        observer.attempts[0].outcome,
        sandbox::SandboxDnsReadinessOutcome::HostCancelled
    );
}

#[tokio::test]
async fn disconnected_guest_cannot_complete_readiness_with_one_successful_gate() {
    for home_first in [false, true] {
        let (guest, mut peer) = readiness_peer().await;
        let mut observer = ReadinessObserver::default();
        let respond = async {
            let (home, dns) = requests(&mut peer).await;
            reply(&mut peer, if home_first { &home } else { &dns }, true).await;
            // EOF represents backend/Guest connection exit while its sibling runs.
            drop(peer);
        };
        let (result, ()) = tokio::join!(
            wait_for_guest_readiness(&guest, true, Some(53), &mut observer),
            respond,
        );
        assert!(result.is_err());
        assert_eq!(
            observer.stages,
            vec![
                (SandboxStartStage::GuestHomeValidation, home_first),
                (SandboxStartStage::GuestDnsReadiness, !home_first),
            ]
        );
    }
}

#[tokio::test]
async fn readiness_retains_existing_request_deadlines_and_discards_unproven_connection() {
    let (guest, mut peer) = readiness_peer().await;
    let mut observer = ReadinessObserver::default();
    {
        let wait = wait_for_guest_readiness(&guest, true, Some(53), &mut observer);
        tokio::pin!(wait);
        let _requests = tokio::select! {
            result = &mut wait => panic!("readiness finished before both requests: {result:?}"),
            requests = requests(&mut peer) => requests,
        };
        // Keep real socket setup and cleanup on running time. Only advance the
        // already armed operation deadlines while the startup wait is unpolled.
        tokio::time::pause();
        tokio::time::advance(HOME_DRIVE_MOUNT_REQUEST_DEADLINE).await;
        tokio::time::resume();
        assert!(matches!(wait.await, Err(GuestReadinessError::Home(_))));
    }
    assert!(guest.try_fence_normal_operations().is_err());
    assert_eq!(
        observer.stages,
        vec![
            (SandboxStartStage::GuestHomeValidation, false),
            (SandboxStartStage::GuestDnsReadiness, false),
        ]
    );
}
