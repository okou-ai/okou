//! Actual public SDK startup components under the retained native owner.

mod fixture;
pub(crate) mod secure;

use self::fixture::{ACCEPTED, DERIVED, NoiseService};
use super::fixture::bounded;
use crate::{
    ssh::cache::Cache,
    tailscale::{Failure, Key, Work, registration::Registration},
};
use runner_types::ids::RunId;
use std::{
    os::fd::AsRawFd,
    sync::{Arc, Mutex},
};

#[tokio::test]
async fn official_noise_map_request_uses_registered_identity_and_bounded_sdk_model() {
    let map = br#"{"Node":{"ID":1,"StableID":"local","Name":"native.synthetic.ts.net.","Key":"MATCH-REQUEST","Addresses":["100.64.0.1/32","fd7a:115c:a1e0::1/128"]},"Peers":[]}"#.to_vec();
    let service = NoiseService::with_map(ACCEPTED.to_vec(), false, Some(map)).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_node(configuration(), service.map_work(true))
        .unwrap();
    bounded(service.requested.notified()).await;
    service.response.cancel();
    bounded(service.map_requested.notified()).await;
    service.map_response.cancel();
    bounded(node.ready()).await.unwrap();
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(service.task).await.unwrap();
}

#[tokio::test]
async fn oversized_map_after_noise_registration_cannot_adopt_a_native_node() {
    let service = NoiseService::with_map(
        ACCEPTED.to_vec(),
        false,
        Some(u32::MAX.to_le_bytes().to_vec()),
    )
    .await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_node(configuration(), service.map_work(false))
        .unwrap();
    bounded(service.requested.notified()).await;
    service.response.cancel();
    bounded(service.map_requested.notified()).await;
    service.map_response.cancel();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(service.task).await.unwrap();
}

#[tokio::test]
async fn cancellation_during_map_headers_drops_authenticated_noise_driver() {
    let service = NoiseService::with_map(ACCEPTED.to_vec(), false, Some(b"{}".to_vec())).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_node(configuration(), service.map_work(false))
        .unwrap();
    bounded(service.requested.notified()).await;
    service.response.cancel();
    bounded(service.map_requested.notified()).await;
    run.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    // An unreturned server response is still blocked when the actual owned
    // client runtime/driver has physically disappeared.
    assert!(!service.map_response.is_cancelled());
    service.map_response.cancel();
    bounded(service.task).await.unwrap();
}

#[tokio::test]
async fn official_noise_upgrade_authenticates_identity_and_carries_typed_registration() {
    let service = NoiseService::new(ACCEPTED.to_vec(), false).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), service.work()).unwrap();
    bounded(service.requested.notified()).await;
    service.response.cancel();
    bounded(node.ready()).await.unwrap();
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(service.task).await.unwrap();
}

#[tokio::test]
async fn corrupted_official_noise_response_cannot_adopt_a_native_node() {
    let service = NoiseService::new(ACCEPTED.to_vec(), true).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), service.work()).unwrap();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(service.task).await.unwrap();
}

#[tokio::test]
async fn cancellation_during_noise_handshake_closes_upgraded_io_before_registration() {
    use futures_util::FutureExt;
    let service = NoiseService::paused().await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), service.work()).unwrap();
    bounded(service.handshake_started.notified()).await;
    run.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    assert!(service.requested.notified().now_or_never().is_none());
    service.handshake_continue.cancel();
    bounded(service.task).await.unwrap();
}

#[tokio::test]
async fn authenticated_noise_registration_still_rejects_each_provider_failure_flag() {
    for body in [
        br#"{"MachineAuthorized":true,"Error":"SYNTHETIC-PRIVATE-ERROR"}"#.as_slice(),
        br#"{"MachineAuthorized":true,"NodeKeyExpired":true}"#,
        br#"{"MachineAuthorized":false}"#,
        br#"{"MachineAuthorized":true,"AuthURL":"https://synthetic.invalid/PRIVATE-CANARY"}"#,
    ] {
        let service = NoiseService::new(body.to_vec(), false).await;
        let cache = Cache::new();
        let run = cache.register(RunId::new_v4());
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let node = access.native_node(configuration(), service.work()).unwrap();
        bounded(service.requested.notified()).await;
        service.response.cancel();
        assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        bounded(service.task).await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_during_fixed_name_tls_handshake_closes_the_owned_socket() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let observed = Arc::clone(&started);
    let service = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut acceptor = rustls::server::Acceptor::default();
        let mut bytes = [0; 16 * 1024];
        loop {
            let count = socket.read(&mut bytes).await.unwrap();
            assert!(count > 0);
            let mut input = std::io::Cursor::new(&bytes[..count]);
            assert_eq!(acceptor.read_tls(&mut input).unwrap(), count);
            if let Some(accepted) = acceptor.accept().unwrap() {
                assert_eq!(
                    accepted.client_hello().server_name(),
                    Some("controlplane.tailscale.com")
                );
                break;
            }
        }
        observed.notify_one();
        // No server handshake response. Only actual client destruction can
        // release this socket while TLS startup remains pending.
        match socket.read(&mut bytes).await {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            result => panic!("pending TLS socket did not close: {result:?}"),
        }
    });
    let work: Work = Box::new(move |_| {
        Box::pin(async move {
            let profile = Registration::new();
            let key_io = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let (control_io, _peer) = tokio::io::duplex(64);
            profile
                .connect(key_io, control_io, DERIVED)
                .await
                .map(|_| ())
        })
    });
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), work).unwrap();
    bounded(started.notified()).await;
    run.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(service).await.unwrap();
}

#[tokio::test]
async fn startup_rejects_untrusted_fixed_name_tls_and_releases_actual_socket() {
    let cert =
        rcgen::generate_simple_self_signed(vec!["controlplane.tailscale.com".into()]).unwrap();
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.cert.der().clone()],
        rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let service = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let result = tokio_rustls::TlsAcceptor::from(Arc::new(tls))
            .accept(socket)
            .await;
        assert!(
            result.is_err(),
            "self-signed control certificate is not trusted"
        );
    });
    let fd = Arc::new(Mutex::new(None));
    let retained = Arc::clone(&fd);
    let work: Work = Box::new(move |_| {
        Box::pin(async move {
            let profile = Registration::new();
            let socket = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let number = socket.as_raw_fd();
            let inode = std::fs::read_link(format!("/proc/self/fd/{number}"))
                .map_err(|_| Failure::DomainFailed)?;
            *retained.lock().unwrap() = Some((number, inode));
            let (control_io, _other) = tokio::io::duplex(64);
            profile
                .connect(socket, control_io, DERIVED)
                .await
                .map(|_| ())
        })
    });
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), work).unwrap();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(service).await.unwrap();
    let (number, inode) = fd.lock().unwrap().take().unwrap();
    assert_ne!(
        std::fs::read_link(format!("/proc/self/fd/{number}")).ok(),
        Some(inode)
    );
}

#[tokio::test]
async fn production_startup_requires_the_private_owned_domain_before_any_io() {
    let profile = Registration::new();
    let (key_io, _key_peer) = tokio::io::duplex(64);
    let (control_io, _control_peer) = tokio::io::duplex(64);
    assert_eq!(
        profile
            .connect(key_io, control_io, DERIVED)
            .await
            .map(|_| ()),
        Err(Failure::DomainFailed)
    );

    use futures_util::FutureExt;
    use tokio::io::AsyncReadExt;
    // Each narrower component also rejects an unowned caller synchronously,
    // before creating a detached SDK HTTP driver or writing a protocol byte.
    let (key_io, mut key_peer) = tokio::io::duplex(64);
    assert_eq!(
        crate::tailscale::control_key::fetch(key_io).now_or_never(),
        Some(Err(Failure::DomainFailed))
    );
    let (io, mut peer) = tokio::io::duplex(64);
    assert_eq!(
        profile
            .register(io, DERIVED)
            .now_or_never()
            .map(|result| result.map(|_| ())),
        Some(Err(Failure::DomainFailed))
    );
    let (io, mut noise_peer) = tokio::io::duplex(64);
    assert_eq!(
        profile
            .noise_register(io, profile.keys().machine_keys.public, DERIVED)
            .now_or_never()
            .map(|result| result.map(|_| ())),
        Some(Err(Failure::DomainFailed))
    );
    let mut byte = [0; 1];
    for peer in [&mut key_peer, &mut peer, &mut noise_peer] {
        assert_eq!(peer.read(&mut byte).now_or_never().unwrap().unwrap(), 0);
    }
}

fn configuration() -> Key {
    Key {
        configuration: uuid::Uuid::new_v4(),
        generation: 1,
    }
}

#[tokio::test]
async fn actual_noise_registration_keeps_private_request_and_failure_body_out_of_parent_tracing() {
    const CANARY: &str = "CONTROL-REGISTRATION-PRIVATE-CANARY-37639";
    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer = Capture(Arc::clone(&bytes));
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let dispatch = tracing::Dispatch::new(subscriber);
    let _parent = tracing::dispatcher::set_default(&dispatch);
    tracing::warn!(target: "hyper", "ordinary parent HTTP event");
    let body = serde_json::to_vec(&serde_json::json!({
        "MachineAuthorized": true,
        "Error": CANARY,
        "AuthURL": format!("https://synthetic.invalid/{CANARY}"),
    }))
    .unwrap();
    // The external service uses its own no-op subscriber. All production
    // SDK descendants remain under the actual Cache-owned private dispatch.
    let service = NoiseService::new(body, false).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), service.work()).unwrap();
    bounded(service.requested.notified()).await;
    service.response.cancel();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(service.task).await.unwrap();
    tracing::warn!(target: "hyper", "ordinary parent HTTP event after cleanup");
    let log = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
    assert!(log.contains("ordinary parent HTTP event"));
    assert!(log.contains("ordinary parent HTTP event after cleanup"));
    assert!(log.contains("native Tailscale startup"));
    assert!(log.contains("noise") && log.contains("registration"));
    assert!(!log.contains(CANARY));
    assert!(!log.contains(DERIVED));
}
