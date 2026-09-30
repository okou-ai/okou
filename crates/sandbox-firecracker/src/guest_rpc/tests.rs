use super::*;

use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseReader, ResponseWriter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::timeout;

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    host: Arc<GuestControlClient>,
    _guest_peer: UnixStream,
    endpoint: Option<GuestRpcEndpoint>,
    state: Arc<AtomicU8>,
    guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    coordinator: ParkCoordinator,
    runtime_cancel: CancellationToken,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let control = dir.path().join("control");
        let control_string = control.to_str().unwrap().to_owned();
        let mut connection = Box::pin(GuestControlClient::wait_for_connection(
            &control_string,
            Duration::from_secs(5),
        ));
        // Poll the real listener to its accept boundary before connecting.
        assert!(futures_util::poll!(connection.as_mut()).is_pending());
        let mut peer = UnixStream::connect(format!(
            "{}_{}",
            control.display(),
            guest_control_proto::VSOCK_PORT
        ))
        .await
        .unwrap();
        peer.write_all(
            &guest_control_proto::encode(guest_control_proto::MSG_READY, 0, &[]).unwrap(),
        )
        .await
        .unwrap();
        let handshake = async {
            let mut decoder = guest_control_proto::Decoder::new();
            let mut buffer = [0; 1024];
            loop {
                let n = peer.read(&mut buffer).await.unwrap();
                assert_ne!(n, 0);
                for message in decoder.decode(buffer.get(..n).unwrap()).unwrap() {
                    if message.msg_type == guest_control_proto::MSG_PING {
                        peer.write_all(
                            &guest_control_proto::encode(
                                guest_control_proto::MSG_PONG,
                                message.seq,
                                &[],
                            )
                            .unwrap(),
                        )
                        .await
                        .unwrap();
                        return;
                    }
                }
            }
        };
        let (host, ()) = tokio::join!(connection, handshake);
        let host = Arc::new(host.unwrap());
        let guest = Arc::new(tokio::sync::Mutex::new(Some(Arc::clone(&host))));
        let coordinator = ParkCoordinator::new();
        coordinator.bind_run_control("run-a").unwrap();
        let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
        let mut fixture = Self {
            path: dir.path().join("runner-rpc-client.sock"),
            _dir: dir,
            host,
            _guest_peer: peer,
            endpoint: None,
            state,
            guest,
            coordinator,
            runtime_cancel: CancellationToken::new(),
        };
        fixture.bind();
        fixture
    }

    fn context(&self) -> GuestRpcContext {
        GuestRpcContext {
            sandbox_id: "sandbox-a".into(),
            state: Arc::clone(&self.state),
            guest: Arc::clone(&self.guest),
            coordinator: self.coordinator.clone(),
        }
    }

    fn bind(&mut self) {
        self.endpoint = Some(
            GuestRpcEndpoint::bind(
                self.path.clone(),
                self.context(),
                self.runtime_cancel.clone(),
            )
            .unwrap(),
        );
    }

    fn acceptor(&self, run: &str) -> Arc<dyn GuestRpcAcceptor> {
        self.endpoint.as_ref().unwrap().acceptor(run)
    }
}

#[tokio::test]
async fn repeated_fake_handler_requests_hold_the_real_park_reservation() {
    let fixture = Fixture::new().await;
    assert_eq!(
        std::fs::metadata(&fixture.path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    for _ in 0..3 {
        let peer = UnixStream::connect(&fixture.path).await.unwrap();
        let accepted = fixture.acceptor("run-a").accept().await.unwrap();
        assert_eq!(accepted.sandbox_id, "sandbox-a");
        assert_eq!(
            fixture.host.try_fence_normal_operations().err(),
            Some(guest_control_client::NormalOperationFenceRejection::Busy)
        );
        let mut writer = ResponseWriter::new(accepted.stream);
        writer
            .send(&Response::error(
                ErrorCode::Unavailable,
                Delivery::NotDispatched,
            ))
            .await
            .unwrap();
        let mut reader = ResponseReader::new(peer);
        assert!(matches!(
            reader.next().await.unwrap(),
            Some(Response::Error { .. })
        ));
        assert!(reader.next().await.unwrap().is_none());
        // Terminal I/O alone must not release the handler's reservation.
        assert_eq!(
            fixture.host.try_fence_normal_operations().err(),
            Some(guest_control_client::NormalOperationFenceRejection::Busy)
        );
        drop(writer);
        drop(fixture.host.try_fence_normal_operations().unwrap());
    }
}

#[tokio::test]
async fn rpc_request_remains_byte_for_byte_on_its_dedicated_port() {
    assert_ne!(
        guest_contracts::private_duplex::VSOCK_PORT,
        runner_rpc_proto::VSOCK_PORT
    );
    let fixture = Fixture::new().await;
    let mut peer = UnixStream::connect(&fixture.path).await.unwrap();
    let body = br#"{"version":1,"method":"run.usage","params":{}}"#;
    peer.write_all(&(body.len() as u32).to_be_bytes())
        .await
        .unwrap();
    peer.write_all(body).await.unwrap();
    let mut accepted = fixture.acceptor("run-a").accept().await.unwrap();
    let parsed = runner_rpc_proto::read_request(&mut accepted.stream)
        .await
        .unwrap();
    assert_eq!(parsed.method, "run.usage");
    assert_eq!(parsed.params.get(), "{}");
    assert!(fixture.host.try_fence_normal_operations().is_err());
}

#[tokio::test]
async fn stale_assignment_park_first_and_existing_tracker_fence_fail_closed() {
    let fixture = Fixture::new().await;
    assert!(fixture.acceptor("run-other").accept().await.is_err());
    let attempt = fixture.coordinator.begin_prepare_park().unwrap();
    assert!(fixture.acceptor("run-a").accept().await.is_err());
    fixture.coordinator.abort_prepare_park(&attempt).unwrap();
    let _fence = fixture.host.try_fence_normal_operations().unwrap();
    let _peer = UnixStream::connect(&fixture.path).await.unwrap();
    assert!(fixture.acceptor("run-a").accept().await.is_err());
}

#[tokio::test]
async fn admission_rechecks_assignment_after_waiting_for_the_live_guest() {
    let fixture = Fixture::new().await;
    let locked_guest = fixture.guest.lock().await;
    let _peer = UnixStream::connect(&fixture.path).await.unwrap();
    let acceptor = fixture.acceptor("run-a");
    let mut accept = Box::pin(acceptor.accept());
    assert!(futures_util::poll!(accept.as_mut()).is_pending());
    let _attempt = fixture.coordinator.begin_prepare_park().unwrap();
    drop(locked_guest);
    assert!(accept.await.is_err());
    drop(fixture.host.try_fence_normal_operations().unwrap());
}

#[tokio::test]
async fn close_cancels_pending_accept_and_old_handles_cannot_follow_reassignment() {
    let mut fixture = Fixture::new().await;
    let old = fixture.acceptor("run-a");
    let mut pending = Box::pin(old.accept());
    assert!(futures_util::poll!(pending.as_mut()).is_pending());
    let attempt = fixture.coordinator.begin_prepare_park().unwrap();
    let fence = fixture.host.try_fence_normal_operations().unwrap();
    fixture
        .coordinator
        .complete_prepare_park(
            &attempt,
            crate::park_coordinator::PrepareParkEvidence::AgentQuiesced,
        )
        .unwrap();
    fixture.coordinator.mark_parked(&attempt).unwrap();
    drop(fixture.endpoint.take());
    assert!(!fixture.path.exists());
    assert!(
        timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .is_err()
    );
    assert!(UnixStream::connect(&fixture.path).await.is_err());
    fixture.coordinator.bind_run_control("run-b").unwrap();
    fixture.bind();
    fixture.coordinator.reopen_after_unpark().unwrap();
    drop(fence);
    assert!(old.accept().await.is_err());
    let _peer = UnixStream::connect(&fixture.path).await.unwrap();
    drop(fixture.acceptor("run-b").accept().await.unwrap());
    drop(old);
    assert!(fixture.path.exists());
}

#[tokio::test]
async fn termination_cancels_inflight_io_and_pending_accept_without_waiting_for_external_work() {
    let fixture = Fixture::new().await;
    let _peer = UnixStream::connect(&fixture.path).await.unwrap();
    let mut accepted = fixture.acceptor("run-a").accept().await.unwrap();
    let acceptor = fixture.acceptor("run-a");
    let mut pending = Box::pin(acceptor.accept());
    assert!(futures_util::poll!(pending.as_mut()).is_pending());
    let mut byte = [0];
    let mut read = Box::pin(accepted.stream.read(&mut byte));
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    fixture.coordinator.begin_terminate(Some("run-a"));
    assert!(
        timeout(Duration::from_secs(1), accepted.cancelled.cancelled())
            .await
            .is_ok()
    );
    assert!(
        timeout(Duration::from_secs(1), read)
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .is_err()
    );
}

#[tokio::test]
async fn runtime_exit_unlinks_socket_and_bind_failure_preserves_the_other_owner() {
    let fixture = Fixture::new().await;
    assert!(
        GuestRpcEndpoint::bind(
            fixture.path.clone(),
            fixture.context(),
            CancellationToken::new()
        )
        .is_err()
    );
    assert!(fixture.path.exists());
    let _peer = UnixStream::connect(&fixture.path).await.unwrap();
    let accepted = fixture.acceptor("run-a").accept().await.unwrap();
    fixture.runtime_cancel.cancel();
    timeout(Duration::from_secs(1), accepted.cancelled.cancelled())
        .await
        .unwrap();
    assert!(!fixture.path.exists());
    assert!(fixture.acceptor("run-a").accept().await.is_err());
}
