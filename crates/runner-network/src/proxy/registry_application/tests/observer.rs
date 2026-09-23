use futures_util::FutureExt;

use super::*;
use crate::proxy::MitmProxy;
use crate::proxy::control::ControlHandle;

const WAIT: Duration = Duration::from_secs(2);

struct Peer {
    directory: tempfile::TempDir,
    listener: UnixListener,
}

impl Peer {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let fd = std::fs::File::open(directory.path()).unwrap();
        let listener =
            UnixListener::bind(format!("/proc/self/fd/{}/control.sock", fd.as_raw_fd())).unwrap();
        Self {
            directory,
            listener,
        }
    }

    fn target(&self, generation: &str) -> ControlTarget {
        ControlTarget {
            directory: self.directory.path().to_path_buf(),
            generation: generation.into(),
        }
    }

    fn publication(&self, bytes: &[u8], generation: &str) -> RegistryPublication {
        RegistryPublication {
            digest: RegistryDigest::of(bytes),
            target: Some(self.target(generation)),
        }
    }

    async fn accept(&self, bytes: &[u8], generation: &str) -> (UnixStream, Value) {
        tokio::time::timeout(WAIT, async {
            let (mut stream, _) = self.listener.accept().await.unwrap();
            let request = request(&mut stream).await;
            assert_eq!(request["method"], "registry.apply");
            assert_eq!(
                request["params"],
                json!({"digest": RegistryDigest::of(bytes)})
            );
            assert_eq!(request["generation"], generation);
            (stream, request)
        })
        .await
        .expect("expected registry observation")
    }
}

async fn complete(mut stream: UnixStream, request: Value, actual: &[u8]) {
    let expected: RegistryDigest =
        serde_json::from_value(request["params"]["digest"].clone()).unwrap();
    let actual = RegistryDigest::of(actual);
    let mut data = receipt(&expected);
    if expected != actual {
        data["state"] = json!("superseded");
        data["snapshot"]["digest"] = json!(actual);
    }
    let response = serde_json::to_vec(&json!({
        "type": "result",
        "requestId": request["requestId"],
        "generation": request["generation"],
        "data": data,
    }))
    .unwrap();
    stream.write_u32(response.len() as u32).await.unwrap();
    stream.write_all(&response).await.unwrap();
    stream.shutdown().await.unwrap();
}

async fn assert_disconnected(stream: &mut UnixStream) {
    assert_eq!(
        tokio::time::timeout(WAIT, stream.read(&mut [0]))
            .await
            .expect("cancelled owner must close its control connection")
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn background_observation_bounds_admission_and_keeps_digest_identity() {
    let peer = Peer::new();
    let control = ControlHandle::default();
    control.set_target(Some(peer.target("first")));
    control.observe_registry(peer.publication(b"active", "first"));
    let (active, _) = peer.accept(b"active", "first").await;

    control.observe_registry(peer.publication(b"queued", "first"));
    control.observe_registry(peer.publication(b"overflow", "first"));
    assert!(peer.listener.accept().now_or_never().is_none());

    // Losing the first reply must not retry it or prevent the queued observation.
    drop(active);
    let (queued, request) = peer.accept(b"queued", "first").await;
    control.observe_registry(peer.publication(b"after-overflow", "first"));
    complete(queued, request, b"after-overflow").await;
    let (last, request) = peer.accept(b"after-overflow", "first").await;
    complete(last, request, b"after-overflow").await;
    control.set_target(None);
}

#[tokio::test]
async fn background_observation_cannot_follow_a_replacement_generation() {
    let peer = Peer::new();
    let control = ControlHandle::default();
    control.set_target(Some(peer.target("first")));
    control.observe_registry(peer.publication(b"active", "first"));
    let (mut active, _) = peer.accept(b"active", "first").await;
    control.observe_registry(peer.publication(b"old-queued", "first"));

    control.set_target(Some(peer.target("replacement")));
    control.observe_registry(peer.publication(b"late-old-publication", "first"));
    assert_disconnected(&mut active).await;
    assert!(peer.listener.accept().now_or_never().is_none());

    control.observe_registry(peer.publication(b"new", "replacement"));
    let (new, request) = peer.accept(b"new", "replacement").await;
    complete(new, request, b"new").await;
    control.set_target(None);
}

#[tokio::test]
async fn background_observation_lifecycle_cancels_with_retained_registry_handles() {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Boundary {
        Stop,
        Kill,
        Restart,
        Drop,
    }
    for boundary in [
        Boundary::Stop,
        Boundary::Kill,
        Boundary::Restart,
        Boundary::Drop,
    ] {
        let peer = Peer::new();
        let (mut proxy, _crashes) = MitmProxy::noop();
        proxy.set_control_directory_for_test(peer.directory.path().to_path_buf());
        let registry = proxy.registry_handle();
        let generation = "test-usage-state-id";
        registry.observe_registration(peer.publication(b"active", generation));
        let (mut active, _) = peer.accept(b"active", generation).await;
        registry.observe_registration(peer.publication(b"queued", generation));

        match boundary {
            Boundary::Stop => proxy.stop().await.unwrap(),
            Boundary::Kill => proxy.kill_now().await.unwrap(),
            Boundary::Restart => drop(proxy.begin_restart()),
            Boundary::Drop => {}
        }
        if boundary != Boundary::Drop {
            // Verify each explicit lifecycle boundary before proxy Drop can mask it.
            assert_disconnected(&mut active).await;
        }
        drop(proxy);
        assert_disconnected(&mut active).await;
        registry.observe_registration(peer.publication(b"late", generation));
        assert!(peer.listener.accept().now_or_never().is_none());
    }
}
