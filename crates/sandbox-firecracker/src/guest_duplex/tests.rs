use super::*;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::AtomicU8;

use guest_control_client::GuestControlClient;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

use crate::park_coordinator::ParkCoordinator;

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    host: Arc<GuestControlClient>,
    _control_peer: UnixStream,
    endpoint: Option<Endpoint>,
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
        let mut connection = Box::pin(GuestControlClient::wait_for_connection(
            control.to_str().unwrap(),
            Duration::from_secs(5),
        ));
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
                for message in decoder.decode(&buffer[..n]).unwrap() {
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
        let mut fixture = Self {
            path: dir.path().join("private-duplex.sock"),
            _dir: dir,
            host,
            _control_peer: peer,
            endpoint: None,
            state: Arc::new(AtomicU8::new(SandboxState::Running as u8)),
            guest,
            coordinator,
            runtime_cancel: CancellationToken::new(),
        };
        fixture.bind();
        fixture
    }
    fn context(&self) -> GuestEndpointContext {
        GuestEndpointContext {
            sandbox_id: "sandbox-a".into(),
            state: Arc::clone(&self.state),
            guest: Arc::clone(&self.guest),
            coordinator: self.coordinator.clone(),
        }
    }
    fn bind(&mut self) {
        self.endpoint = Some(
            Endpoint::bind(
                self.path.clone(),
                self.context(),
                self.runtime_cancel.clone(),
            )
            .unwrap(),
        );
    }
    fn acceptor(&self, run: &str) -> Arc<dyn GuestDuplexAcceptor> {
        self.endpoint.as_ref().unwrap().acceptor(run)
    }
    async fn connect(&self) -> UnixStream {
        let mut stream = UnixStream::connect(&self.path).await.unwrap();
        let mut ready = [0];
        stream.read_exact(&mut ready).await.unwrap();
        assert_eq!(ready, [READY]);
        stream
    }
}

#[tokio::test]
async fn idle_candidate_does_not_reserve_park_and_only_current_run_activates() {
    let fixture = Fixture::new().await;
    assert_eq!(
        std::fs::metadata(&fixture.path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(fixture.acceptor("other").accept().await.is_err());
    let mut guest = fixture.connect().await;
    drop(fixture.host.try_fence_normal_operations().unwrap());
    let mut accepted = fixture.acceptor("run-a").accept().await.unwrap();
    let mut marker = [0];
    guest.read_exact(&mut marker).await.unwrap();
    assert_eq!(marker, [ACTIVATE]);
    assert_eq!(accepted.sandbox_id, "sandbox-a");
    assert_eq!(
        fixture.host.try_fence_normal_operations().err(),
        Some(guest_control_client::NormalOperationFenceRejection::Busy)
    );
    accepted.stream.write_all(b"to-guest").await.unwrap();
    let mut bytes = [0; 8];
    guest.read_exact(&mut bytes).await.unwrap();
    assert_eq!(&bytes, b"to-guest");
    guest.write_all(b"to-host").await.unwrap();
    accepted.stream.read_exact(&mut bytes[..7]).await.unwrap();
    assert_eq!(&bytes[..7], b"to-host");
    drop(accepted);
    drop(fixture.host.try_fence_normal_operations().unwrap());
}

#[tokio::test]
async fn attach_waiting_on_guest_control_is_bounded_without_activating_socket() {
    let fixture = Fixture::new().await;
    let locked = fixture.guest.lock().await;
    let mut guest = fixture.connect().await;
    let error = fixture.acceptor("run-a").accept().await.err().unwrap();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let mut activation = [0];
    assert_eq!(guest.read(&mut activation).await.unwrap(), 0);
    drop(locked);
    let mut next = fixture.connect().await;
    let accepted = fixture.acceptor("run-a").accept().await.unwrap();
    next.read_exact(&mut activation).await.unwrap();
    assert_eq!(activation, [ACTIVATE]);
    drop(accepted);
}

#[tokio::test]
async fn excess_pending_candidate_rejected_and_park_remains_available() {
    let mut fixture = Fixture::new().await;
    let mut first = fixture.connect().await;
    let mut excess = UnixStream::connect(&fixture.path).await.unwrap();
    let eof = timeout(Duration::from_secs(1), excess.read_u8())
        .await
        .unwrap();
    assert_eq!(eof.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    drop(fixture.host.try_fence_normal_operations().unwrap());
    let attempt = fixture.coordinator.begin_prepare_park().unwrap();
    assert!(fixture.acceptor("run-a").accept().await.is_err());
    // Closing the endpoint at park drops the acknowledged idle candidate.
    drop(fixture.endpoint.take());
    assert_eq!(
        timeout(Duration::from_secs(1), first.read_u8())
            .await
            .unwrap()
            .unwrap_err()
            .kind(),
        io::ErrorKind::UnexpectedEof
    );
    fixture.coordinator.abort_prepare_park(&attempt).unwrap();
}

#[tokio::test]
async fn endpoint_close_drops_idle_even_with_retained_acceptor() {
    let mut fixture = Fixture::new().await;
    let mut guest = fixture.connect().await;
    let old = fixture.acceptor("run-a");
    drop(fixture.endpoint.take());
    assert_eq!(
        timeout(Duration::from_secs(1), guest.read_u8())
            .await
            .unwrap()
            .unwrap_err()
            .kind(),
        io::ErrorKind::UnexpectedEof
    );
    assert!(old.accept().await.is_err());
}

#[tokio::test]
async fn runtime_exit_finishes_idle_drain_with_retained_acceptor() {
    let mut fixture = Fixture::new().await;
    let mut guest = fixture.connect().await;
    let old = fixture.acceptor("run-a");
    fixture.runtime_cancel.cancel();
    timeout(
        Duration::from_secs(1),
        &mut fixture.endpoint.as_mut().unwrap()._drain,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!fixture.path.exists());
    assert_eq!(
        guest.read_u8().await.unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
    assert!(old.accept().await.is_err());
}

#[tokio::test]
async fn duplicate_bind_preserves_original_and_runtime_exit_revokes_active_stream() {
    let fixture = Fixture::new().await;
    assert!(
        Endpoint::bind(
            fixture.path.clone(),
            fixture.context(),
            CancellationToken::new()
        )
        .is_err()
    );
    assert!(fixture.path.exists());
    let mut guest = fixture.connect().await;
    let mut accepted = fixture.acceptor("run-a").accept().await.unwrap();
    guest.read_exact(&mut [0]).await.unwrap();
    let mut byte = [0];
    let mut pending_read = Box::pin(accepted.stream.read(&mut byte));
    assert!(futures_util::poll!(pending_read.as_mut()).is_pending());
    fixture.runtime_cancel.cancel();
    timeout(Duration::from_secs(1), async {
        while fixture.path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(fixture.acceptor("run-a").accept().await.is_err());
    timeout(Duration::from_secs(1), accepted.cancelled.cancelled())
        .await
        .unwrap();
    assert!(
        timeout(Duration::from_secs(1), pending_read)
            .await
            .unwrap()
            .is_err()
    );
}

#[tokio::test]
async fn duplex_close_revokes_only_duplex_not_existing_rpc_work() {
    let mut fixture = Fixture::new().await;
    let rpc_path = fixture._dir.path().join("rpc.sock");
    let rpc = crate::guest_rpc::GuestRpcEndpoint::bind(
        rpc_path.clone(),
        fixture.context(),
        fixture.runtime_cancel.clone(),
    )
    .unwrap();
    let mut rpc_peer = UnixStream::connect(&rpc_path).await.unwrap();
    let mut accepted_rpc = rpc.acceptor("run-a").accept().await.unwrap();
    let mut duplex_peer = fixture.connect().await;
    let accepted_duplex = fixture.acceptor("run-a").accept().await.unwrap();
    duplex_peer.read_exact(&mut [0]).await.unwrap();
    drop(fixture.endpoint.take());
    timeout(
        Duration::from_secs(1),
        accepted_duplex.cancelled.cancelled(),
    )
    .await
    .unwrap();
    assert!(!accepted_rpc.cancelled.is_cancelled());
    accepted_rpc.stream.write_all(b"rpc").await.unwrap();
    let mut bytes = [0; 3];
    rpc_peer.read_exact(&mut bytes).await.unwrap();
    assert_eq!(&bytes, b"rpc");
    drop(accepted_duplex);
    drop(accepted_rpc);
    drop(rpc);
}

#[tokio::test]
async fn rpc_close_revokes_only_rpc_not_existing_duplex_work() {
    let fixture = Fixture::new().await;
    let rpc_path = fixture._dir.path().join("rpc.sock");
    let rpc = crate::guest_rpc::GuestRpcEndpoint::bind(
        rpc_path.clone(),
        fixture.context(),
        fixture.runtime_cancel.clone(),
    )
    .unwrap();
    let _rpc_peer = UnixStream::connect(&rpc_path).await.unwrap();
    let accepted_rpc = rpc.acceptor("run-a").accept().await.unwrap();
    let mut duplex_peer = fixture.connect().await;
    let mut accepted_duplex = fixture.acceptor("run-a").accept().await.unwrap();
    duplex_peer.read_exact(&mut [0]).await.unwrap();
    drop(rpc);
    timeout(Duration::from_secs(1), accepted_rpc.cancelled.cancelled())
        .await
        .unwrap();
    assert!(!accepted_duplex.cancelled.is_cancelled());
    accepted_duplex.stream.write_all(b"duplex").await.unwrap();
    let mut bytes = [0; 6];
    duplex_peer.read_exact(&mut bytes).await.unwrap();
    assert_eq!(&bytes, b"duplex");
}

#[tokio::test]
async fn old_capability_cannot_follow_reused_sandbox_and_cancel_interrupts_io() {
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
    assert!(
        timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .is_err()
    );
    fixture.coordinator.bind_run_control("run-b").unwrap();
    fixture.bind();
    fixture.coordinator.reopen_after_unpark().unwrap();
    drop(fence);
    assert!(old.accept().await.is_err());
    let mut guest = fixture.connect().await;
    let mut accepted = fixture.acceptor("run-b").accept().await.unwrap();
    guest.read_exact(&mut [0]).await.unwrap();
    let mut buffer = [0];
    let mut read = Box::pin(accepted.stream.read(&mut buffer));
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    fixture.coordinator.begin_terminate(Some("run-b"));
    assert!(
        timeout(Duration::from_secs(1), read)
            .await
            .unwrap()
            .is_err()
    );
}
