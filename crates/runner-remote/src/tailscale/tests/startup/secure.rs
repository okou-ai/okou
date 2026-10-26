//! A controlled external TLS authority exercises the shared complete startup.
//! The production connector continues using the SDK's unchanged WebPKI roots.

use super::fixture::{ACCEPTED, DERIVED, NoiseService, accept_tls};
use crate::{
    tailscale::tests::fixture::Cache,
    tailscale::{
        Failure, Key, Work,
        registration::{Registration, Tls},
        tests::fixture::bounded,
    },
};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::Full;
use hyper::{Response, service::service_fn};
use hyper_util::rt::TokioIo;
use runner_types::ids::RunId;
use std::{
    convert::Infallible,
    os::fd::{AsRawFd, RawFd},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::instrument::WithSubscriber;

const MAP: &[u8] = br#"{"Node":{"ID":1,"StableID":"local","Name":"native.synthetic.ts.net.","Key":"MATCH-REQUEST","Addresses":["100.64.0.1/32","fd7a:115c:a1e0::1/128"]},"Peers":[]}"#;

#[derive(Clone)]
struct FixtureTls(Arc<rustls::ClientConfig>);

impl Tls for FixtureTls {
    async fn connect<Io>(
        &self,
        name: ts_tls_util::ServerName<'static>,
        io: Io,
    ) -> std::io::Result<ts_tls_util::TlsStream<Io>>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        assert_eq!(
            name,
            ts_tls_util::ServerName::try_from("controlplane.tailscale.com").unwrap()
        );
        tokio_rustls::TlsConnector::from(Arc::clone(&self.0))
            .connect(name, io)
            .await
    }
}

pub(in crate::tailscale::tests) enum KeyReply {
    Valid,
    Missing,
    Oversized,
}

struct SocketIdentity {
    fd: RawFd,
    identity: PathBuf,
}

impl SocketIdentity {
    fn record(socket: &impl AsRawFd) -> Self {
        let fd = socket.as_raw_fd();
        Self {
            fd,
            identity: std::fs::read_link(format!("/proc/self/fd/{fd}"))
                .expect("record control socket identity"),
        }
    }

    fn is_open(&self) -> bool {
        let current = match std::fs::read_link(format!("/proc/self/fd/{}", self.fd)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            result => result.expect("inspect control socket identity"),
        };
        current == self.identity
    }

    fn assert_open(&self) {
        assert!(self.is_open(), "original control socket must remain open");
    }

    fn assert_closed(&self) {
        assert!(!self.is_open(), "original control socket must be closed");
    }
}

pub(in crate::tailscale::tests) struct Service {
    key_address: std::net::SocketAddr,
    key_requested: Arc<tokio::sync::Notify>,
    pub(in crate::tailscale::tests) key_response: CancellationToken,
    key_stopped: CancellationToken,
    key_task: tokio::task::JoinHandle<()>,
    noise: NoiseService,
    tls: FixtureTls,
    control_socket: Arc<Mutex<Option<SocketIdentity>>>,
}

#[derive(Clone)]
pub(crate) struct Sockets {
    key: std::net::SocketAddr,
    control: std::net::SocketAddr,
    expected: Arc<Mutex<Option<ts_keys::MachinePublicKey>>>,
    auth: Arc<Mutex<String>>,
    control_socket: Arc<Mutex<Option<SocketIdentity>>>,
    tls: FixtureTls,
}

impl crate::tailscale::producer::ControlSockets for Sockets {
    type Io = tokio::net::TcpStream;
    async fn connect(&self, keys: &ts_keys::NodeState) -> Result<(Self::Io, Self::Io), Failure> {
        *self.expected.lock().unwrap() = Some(keys.machine_keys.public);
        *self.auth.lock().unwrap() = "tskey-auth-synthetic-one-use".into();
        let key = tokio::net::TcpStream::connect(self.key)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let control = tokio::net::TcpStream::connect(self.control)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        *self.control_socket.lock().unwrap() = Some(SocketIdentity::record(&control));
        Ok((key, control))
    }
    fn tls(&self) -> impl Tls {
        self.tls.clone()
    }
}

impl Service {
    pub(crate) fn test_services(
        &self,
        api: crate::tailscale::tests::provisioning::fixture::Secure,
        relay: crate::tailscale::tests::provisioning::regional_fixture::Relay,
    ) -> crate::tailscale::TestServices {
        self.noise
            .streaming_map
            .store(true, std::sync::atomic::Ordering::Release);
        crate::tailscale::TestServices {
            api,
            relay,
            control: Sockets {
                key: self.key_address,
                control: self.noise.address,
                expected: Arc::clone(&self.noise.expected_client),
                auth: Arc::clone(&self.noise.expected_auth),
                control_socket: Arc::clone(&self.control_socket),
                tls: self.tls.clone(),
            },
        }
    }
    pub(in crate::tailscale::tests) async fn update_map(&self, value: serde_json::Value) {
        let body = serde_json::to_vec(&value).unwrap();
        let mut bytes = u32::try_from(body.len()).unwrap().to_le_bytes().to_vec();
        bytes.extend_from_slice(&body);
        bounded(self.noise.map_updates.send(bytes)).await.unwrap();
    }

    pub(in crate::tailscale::tests) async fn new(
        body: Vec<u8>,
        map: Vec<u8>,
        key: KeyReply,
        pause_noise: bool,
    ) -> Self {
        let cert =
            rcgen::generate_simple_self_signed(vec!["controlplane.tailscale.com".into()]).unwrap();
        let crypto = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let tls = rustls::ServerConfig::builder_with_provider(Arc::clone(&crypto))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.cert.der().clone()],
                rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der())
                    .into(),
            )
            .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert.cert.der().clone()).unwrap();
        let client = rustls::ClientConfig::builder_with_provider(crypto)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let tls = Arc::new(tls);
        let noise = NoiseService::secure(body, Some(map), pause_noise, Arc::clone(&tls)).await;
        let body = match key {
            KeyReply::Missing => b"{}".to_vec(),
            KeyReply::Valid | KeyReply::Oversized => {
                let mut body = serde_json::to_vec(&serde_json::json!({
                    "publicKey": noise.public_key().to_string(),
                }))
                .unwrap();
                if matches!(key, KeyReply::Oversized) {
                    body.resize(2 * 1024 * 1024, b' ');
                }
                body
            }
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let key_address = listener.local_addr().unwrap();
        let key_requested = Arc::new(tokio::sync::Notify::new());
        let seen = Arc::clone(&key_requested);
        let key_response = CancellationToken::new();
        let gate = key_response.clone();
        let key_stopped = CancellationToken::new();
        let stopping = key_stopped.clone();
        let key_task = tokio::spawn(
            async move {
                let stream = match accept_tls(&listener, tls, &stopping).await {
                    Some(stream) => stream,
                    None => return,
                };
                let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    assert_eq!(request.method(), "GET");
                    assert_eq!(request.uri().path(), "/key");
                    assert_eq!(
                        request.uri().query().unwrap(),
                        format!("v={}", ts_capabilityversion::CapabilityVersion::CURRENT)
                    );
                    assert_eq!(request.headers()["host"], "controlplane.tailscale.com");
                    let seen = Arc::clone(&seen);
                    let gate = gate.clone();
                    let body = body.clone();
                    async move {
                        seen.notify_one();
                        gate.cancelled().await;
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(body))))
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            }
            .with_subscriber(tracing::Dispatch::none()),
        );
        Self {
            key_address,
            key_requested,
            key_response,
            key_stopped,
            key_task,
            noise,
            tls: FixtureTls(Arc::new(client)),
            control_socket: Arc::new(Mutex::new(None)),
        }
    }

    fn work(&self) -> Work {
        let key_address = self.key_address;
        let control_address = self.noise.address;
        let expected = Arc::clone(&self.noise.expected_client);
        let control_socket = Arc::clone(&self.control_socket);
        let tls = self.tls.clone();
        Box::new(move |control| {
            Box::pin(async move {
                let registration = Registration::new();
                *expected.lock().unwrap() = Some(registration.keys().machine_keys.public);
                let key_io = tokio::net::TcpStream::connect(key_address)
                    .await
                    .map_err(|_| Failure::DomainFailed)?;
                let control_io = tokio::net::TcpStream::connect(control_address)
                    .await
                    .map_err(|_| Failure::DomainFailed)?;
                *control_socket.lock().unwrap() = Some(SocketIdentity::record(&control_io));
                let client = registration
                    .connect_using(key_io, control_io, DERIVED, &tls)
                    .await?;
                let maps = registration.maps(&client).await?;
                tokio::pin!(maps);
                let update = maps.next().await.ok_or(Failure::DomainFailed)?;
                let local = update.node.ok_or(Failure::DomainFailed)?;
                assert_eq!(local.node_key, registration.keys().node_keys.public);
                assert_eq!(local.hostname, "native");
                assert_eq!(local.tailnet.as_deref(), Some("synthetic.ts.net"));
                assert_eq!(local.tailnet_address.ipv4.addr().octets(), [100, 64, 0, 1]);
                assert_eq!(
                    local.tailnet_address.ipv6.addr().to_string(),
                    "fd7a:115c:a1e0::1"
                );
                control.ready();
                control.cancelled().cancelled().await;
                Ok(())
            })
        })
    }

    fn root_work(
        &self,
        relay: &crate::tailscale::tests::derp::fixture::Server,
        gate: Arc<crate::tailscale::tests::derp::fixture::WriteGate>,
        descriptors: Arc<Mutex<Vec<i32>>>,
        trusted_fixture: bool,
    ) -> Work {
        use crate::tailscale::{node_root::Root, tests::peers::shared_derp::single_connector};
        let key_address = self.key_address;
        let control_address = self.noise.address;
        let relay_address = relay.address;
        let relay_tls = relay.tls.clone();
        let expected = Arc::clone(&self.noise.expected_client);
        let control_socket = Arc::clone(&self.control_socket);
        let tls = self.tls.clone();
        Box::new(move |control| {
            // Complete root and fresh identity exist before either startup dial.
            let registration = Registration::new();
            let (root, client) = Root::new(control.cancelled());
            *expected.lock().unwrap() = Some(registration.keys().machine_keys.public);
            Box::pin(async move {
                let _client_lease = client;
                let key_io = tokio::net::TcpStream::connect(key_address)
                    .await
                    .map_err(|_| Failure::DomainFailed)?;
                let control_io = tokio::net::TcpStream::connect(control_address)
                    .await
                    .map_err(|_| Failure::DomainFailed)?;
                *control_socket.lock().unwrap() = Some(SocketIdentity::record(&control_io));
                let connector = move |keys, cancelled| {
                    single_connector(keys, cancelled, relay_address, relay_tls, gate, descriptors)
                };
                if trusted_fixture {
                    root.start_using(
                        registration,
                        (key_io, control_io),
                        DERIVED,
                        &tls,
                        connector,
                        &control,
                    )
                    .await
                } else {
                    root.start(
                        registration,
                        key_io,
                        control_io,
                        DERIVED,
                        connector,
                        &control,
                    )
                    .await
                }
            })
        })
    }

    pub(in crate::tailscale::tests) fn provisioned_root_factory<D, R>(
        &self,
        dial: D,
        relay: R,
    ) -> impl FnOnce(crate::tailscale::Configuration, Arc<crate::tailscale::Journal>) -> Work
    where
        D: crate::tailscale::provisioning_io::Dial + Send,
        R: crate::tailscale::regional_relay::Dial + Send,
    {
        let sockets = Sockets {
            key: self.key_address,
            control: self.noise.address,
            expected: Arc::clone(&self.noise.expected_client),
            auth: Arc::clone(&self.noise.expected_auth),
            control_socket: Arc::clone(&self.control_socket),
            tls: self.tls.clone(),
        };
        self.noise
            .streaming_map
            .store(true, std::sync::atomic::Ordering::Release);
        move |configuration, journal| {
            crate::tailscale::producer::work_using(configuration, journal, dial, sockets, relay)
        }
    }

    pub(in crate::tailscale::tests) fn announced_home(&self) -> Vec<u32> {
        self.noise.announced_home.lock().unwrap().clone()
    }

    pub(in crate::tailscale::tests) fn set_home_status(&self, status: hyper::StatusCode) {
        *self.noise.home_status.lock().unwrap() = status;
    }

    pub(in crate::tailscale::tests) fn logout_count(&self) -> usize {
        self.noise.logout.requests.lock().unwrap().len()
    }

    pub(in crate::tailscale::tests) fn set_logout_reply(
        &self,
        status: hyper::StatusCode,
        body: Vec<u8>,
    ) {
        *self.noise.logout.status.lock().unwrap() = status;
        *self.noise.logout.body.lock().unwrap() = body;
    }

    pub(in crate::tailscale::tests) fn pause_logout(&self) {
        self.noise
            .logout
            .blocked
            .store(true, std::sync::atomic::Ordering::Release);
    }

    pub(in crate::tailscale::tests) async fn logout_requested(&self) {
        bounded(self.noise.logout.requested.notified()).await;
    }

    pub(in crate::tailscale::tests) fn assert_control_open(&self) {
        self.control_socket
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .assert_open();
    }

    pub(in crate::tailscale::tests) async fn registration_requested(&self) {
        bounded(self.noise.requested.notified()).await;
    }

    pub(in crate::tailscale::tests) fn allow_registration(&self) {
        self.noise.response.cancel();
    }

    pub(in crate::tailscale::tests) async fn map_requested(&self) {
        bounded(self.noise.map_requested.notified()).await;
    }

    pub(in crate::tailscale::tests) fn allow_all(&self) {
        self.key_response.cancel();
        self.noise.response.cancel();
        self.noise.map_response.cancel();
    }

    pub(in crate::tailscale::tests) async fn abandon_tls_connections(&self) {
        for address in [self.key_address, self.noise.address] {
            let mut socket = bounded(tokio::net::TcpStream::connect(address))
                .await
                .unwrap();
            bounded(socket.shutdown()).await.unwrap();
            // Observe server-side retirement before the genuine startup connects.
            assert_eq!(bounded(socket.read(&mut [0])).await.unwrap(), 0);
        }
    }

    pub(in crate::tailscale::tests) fn assert_control_closed(&self) {
        self.control_socket
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .assert_closed();
    }

    pub(in crate::tailscale::tests) async fn finish(self) {
        self.allow_all();
        self.noise.logout.response.cancel();
        self.noise.handshake_continue.cancel();
        // A failed key request can retire the native control socket before TLS
        // starts. Explicit fixture shutdown releases listeners still awaiting it.
        self.key_stopped.cancel();
        self.noise.stopped.cancel();
        bounded(self.key_task).await.unwrap();
        bounded(self.noise.task).await.unwrap();
    }

    pub(in crate::tailscale::tests) async fn finish_unused(self) {
        assert!(self.control_socket.lock().unwrap().is_none());
        self.key_task.abort();
        self.noise.task.abort();
        assert!(matches!(self.key_task.await, Err(error) if error.is_cancelled()));
        assert!(matches!(self.noise.task.await, Err(error) if error.is_cancelled()));
    }
}

#[test]
fn control_socket_assertions_follow_identity_through_descriptor_reuse() {
    use std::{
        fs::File,
        io::Read,
        net::{TcpListener, TcpStream},
        os::fd::OwnedFd,
        panic::catch_unwind,
        sync::mpsc,
        time::Duration,
    };

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (mut peer, _) = listener.accept().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let identity = SocketIdentity::record(&socket);
    identity.assert_open();
    assert!(catch_unwind(|| identity.assert_closed()).is_err());

    let socket = OwnedFd::from(socket);
    let replacement = File::open("/dev/null").unwrap();
    std::thread::scope(|scope| {
        let (replaced, observed) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let worker = scope.spawn(move || {
            let fd = socket.as_raw_fd();
            // SAFETY: both descriptors are owned here. Atomically replacing the
            // still-owned target closes the socket without exposing a free slot
            // that another test could allocate before the replacement is installed.
            assert_eq!(
                unsafe { libc::dup3(replacement.as_raw_fd(), fd, libc::O_CLOEXEC) },
                fd
            );
            replaced.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(5)).unwrap();
        });

        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
        assert_ne!(unsafe { libc::fcntl(identity.fd, libc::F_GETFD) }, -1);
        assert_eq!(
            std::fs::read_link(format!("/proc/self/fd/{}", identity.fd)).unwrap(),
            PathBuf::from("/dev/null")
        );
        identity.assert_closed();
        assert!(catch_unwind(|| identity.assert_open()).is_err());
        release.send(()).unwrap();
        worker.join().unwrap();
    });
    identity.assert_closed();
}

fn configuration() -> Key {
    Key {
        configuration: uuid::Uuid::new_v4(),
        generation: 1,
    }
}

#[tokio::test]
async fn authenticated_tls_key_noise_registration_and_map_share_the_owned_startup() {
    let service = Service::new(ACCEPTED.to_vec(), MAP.to_vec(), KeyReply::Valid, false).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), service.work()).unwrap();
    service.allow_all();
    bounded(node.ready()).await.unwrap();
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    service.assert_control_closed();
    service.finish().await;
}

#[tokio::test]
async fn one_retained_root_owns_verified_tls_noise_registration_maps_and_authenticated_derp_until_run_close()
 {
    use crate::tailscale::tests::derp::fixture::{Server, WriteGate};
    let service = Service::new(ACCEPTED.to_vec(), MAP.to_vec(), KeyReply::Valid, false).await;
    service
        .noise
        .streaming_map
        .store(true, std::sync::atomic::Ordering::Release);
    let relay = Server::secure().await;
    let gate = WriteGate::new();
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_node(
            configuration(),
            service.root_work(&relay, Arc::clone(&gate), Arc::clone(&descriptors), true),
        )
        .unwrap();
    service.allow_all();
    bounded(node.ready()).await.unwrap();
    let (mut frames, _) = bounded(relay.task).await.unwrap();
    assert_eq!(descriptors.lock().unwrap().len(), 1);
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    let fd = descriptors.lock().unwrap()[0];
    assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EBADF)
    );
    crate::tailscale::tests::peers::relay::closed(frames.get_mut(), true).await;
    service.assert_control_closed();
    service.finish().await;
}

#[tokio::test]
async fn the_production_root_rejects_an_untrusted_fixed_name_certificate_before_map_or_derp() {
    use crate::tailscale::tests::derp::fixture::{Server, WriteGate};
    let service = Service::new(ACCEPTED.to_vec(), MAP.to_vec(), KeyReply::Valid, false).await;
    let relay = Server::secure().await;
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_node(
            configuration(),
            service.root_work(&relay, WriteGate::new(), Arc::clone(&descriptors), false),
        )
        .unwrap();
    service.allow_all();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    assert!(descriptors.lock().unwrap().is_empty());
    service.assert_control_closed();
    relay.task.abort();
    let Err(error) = bounded(relay.task).await else {
        panic!("unused external DERP fixture ran");
    };
    assert!(error.is_cancelled());
    service.finish().await;
}

#[tokio::test]
async fn authenticated_full_startup_rejects_registration_failure_flags() {
    for body in [
        br#"{"MachineAuthorized":true,"Error":"SYNTHETIC-PRIVATE-ERROR"}"#.as_slice(),
        br#"{"MachineAuthorized":true,"NodeKeyExpired":true}"#,
        br#"{"MachineAuthorized":false}"#,
        br#"{"MachineAuthorized":true,"AuthURL":"https://synthetic.invalid/PRIVATE-CANARY"}"#,
    ] {
        let service = Service::new(body.to_vec(), MAP.to_vec(), KeyReply::Valid, false).await;
        let cache = Cache::new();
        let run = cache.register(RunId::new_v4());
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let node = access.native_node(configuration(), service.work()).unwrap();
        service.allow_all();
        assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        service.assert_control_closed();
        service.finish().await;
    }
}

#[tokio::test]
async fn invalid_or_oversized_tls_key_stops_before_noise_and_closes_both_owned_sockets() {
    use futures_util::FutureExt;
    for key in [KeyReply::Missing, KeyReply::Oversized] {
        let service = Service::new(ACCEPTED.to_vec(), MAP.to_vec(), key, false).await;
        let cache = Cache::new();
        let run = cache.register(RunId::new_v4());
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let node = access.native_node(configuration(), service.work()).unwrap();
        service.allow_all();
        assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        assert!(
            service
                .noise
                .handshake_started
                .notified()
                .now_or_never()
                .is_none()
        );
        service.assert_control_closed();
        service.finish().await;
    }
}

#[tokio::test]
async fn full_startup_cancellation_during_key_response_retires_unstarted_control_tls() {
    let service = Service::new(ACCEPTED.to_vec(), MAP.to_vec(), KeyReply::Valid, false).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), service.work()).unwrap();
    bounded(service.key_requested.notified()).await;
    run.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    assert!(!service.key_response.is_cancelled());
    service.assert_control_closed();
    service.finish().await;
}

#[tokio::test]
async fn full_startup_cancellation_during_noise_physically_closes_authenticated_tls() {
    let service = Service::new(ACCEPTED.to_vec(), MAP.to_vec(), KeyReply::Valid, true).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), service.work()).unwrap();
    service.key_response.cancel();
    bounded(service.noise.handshake_started.notified()).await;
    run.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    service.assert_control_closed();
    service.finish().await;
}

#[tokio::test]
async fn full_startup_cancellation_during_map_physically_closes_authenticated_tls_noise() {
    let service = Service::new(ACCEPTED.to_vec(), MAP.to_vec(), KeyReply::Valid, false).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), service.work()).unwrap();
    service.key_response.cancel();
    service.noise.response.cancel();
    bounded(service.noise.map_requested.notified()).await;
    run.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    assert!(!service.noise.map_response.is_cancelled());
    service.assert_control_closed();
    service.finish().await;
}
