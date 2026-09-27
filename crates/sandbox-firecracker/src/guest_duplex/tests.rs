use super::*;
use std::os::unix::fs::PermissionsExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    fn context(&self) -> ContextData {
        ContextData {
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
}

#[tokio::test]
async fn only_current_assignment_activates_private_guest_stream_and_reserves_park() {
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
    let mut guest = UnixStream::connect(&fixture.path).await.unwrap();
    let mut accepted = fixture.acceptor("run-a").accept().await.unwrap();
    let mut marker = [0];
    guest.read_exact(&mut marker).await.unwrap();
    assert_eq!(marker, [1]);
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
    let mut guest = UnixStream::connect(&fixture.path).await.unwrap();
    let error = fixture.acceptor("run-a").accept().await.err().unwrap();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let mut activation = [0];
    assert_eq!(guest.read(&mut activation).await.unwrap(), 0);
    drop(locked);
    let mut next = UnixStream::connect(&fixture.path).await.unwrap();
    let accepted = fixture.acceptor("run-a").accept().await.unwrap();
    next.read_exact(&mut activation).await.unwrap();
    assert_eq!(activation, [1]);
    drop(accepted);
}

#[tokio::test]
async fn bind_collision_preserves_original_and_runtime_exit_unlinks() {
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
    let mut guest = UnixStream::connect(&fixture.path).await.unwrap();
    let mut accepted = fixture.acceptor("run-a").accept().await.unwrap();
    guest.read_exact(&mut [0]).await.unwrap();
    let mut byte = [0];
    let mut pending_read = Box::pin(accepted.stream.read(&mut byte));
    assert!(futures_util::poll!(pending_read.as_mut()).is_pending());
    fixture.runtime_cancel.cancel();
    tokio::time::timeout(Duration::from_secs(1), async {
        while fixture.path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(fixture.acceptor("run-a").accept().await.is_err());
    assert!(accepted.cancelled.is_cancelled());
    assert!(
        tokio::time::timeout(Duration::from_secs(1), pending_read)
            .await
            .unwrap()
            .is_err()
    );
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
        tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .is_err()
    );
    fixture.coordinator.bind_run_control("run-b").unwrap();
    fixture.bind();
    fixture.coordinator.reopen_after_unpark().unwrap();
    drop(fence);
    assert!(old.accept().await.is_err());
    let mut guest = UnixStream::connect(&fixture.path).await.unwrap();
    let mut accepted = fixture.acceptor("run-b").accept().await.unwrap();
    guest.read_exact(&mut [0]).await.unwrap();
    let mut buffer = [0];
    let mut read = Box::pin(accepted.stream.read(&mut buffer));
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    fixture.coordinator.begin_terminate(Some("run-b"));
    assert!(
        tokio::time::timeout(Duration::from_secs(1), read)
            .await
            .unwrap()
            .is_err()
    );
}
