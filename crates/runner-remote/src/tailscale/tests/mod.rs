//! SDK IO through the common assignment owner and real consumer authority.

mod control_key;
mod derp;
mod fixture;
mod history;
mod map_reader;
mod peers;
pub(super) mod provisioning;
mod registration;
pub(super) mod relay_projection;
pub(super) mod startup;

use super::{Control, Failure, Key, Work};
use crate::ssh::FailureReason;
use crate::tailscale::tests::fixture::Cache;
use fixture::{Blocking, Http, SocketClosure, bounded};
use http_body_util::{BodyExt, Limited};
use runner_types::ids::RunId;
use std::{
    io::{Read, Write},
    net::SocketAddr,
    os::fd::AsRawFd,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::AsyncReadExt;
use ts_http_util::{Client, EmptyBody, Request};

type Fd = Arc<Mutex<Option<(i32, PathBuf)>>>;

fn key(generation: i64) -> Key {
    Key {
        configuration: uuid::Uuid::new_v4(),
        generation,
    }
}

fn http_work(
    address: SocketAddr,
    blocking: Option<SocketAddr>,
    fd: Fd,
) -> (Work, tokio::sync::oneshot::Receiver<Vec<u8>>) {
    http_work_with_reset(address, blocking, fd, false)
}

fn http_work_with_reset(
    address: SocketAddr,
    blocking: Option<SocketAddr>,
    fd: Fd,
    reset_on_close: bool,
) -> (Work, tokio::sync::oneshot::Receiver<Vec<u8>>) {
    let (body, received) = tokio::sync::oneshot::channel();
    let work = Box::new(move |control: Control| {
        Box::pin(async move {
            let socket = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            if reset_on_close {
                // Exercise abortive native IO retirement without changing the owner.
                socket
                    .set_zero_linger()
                    .map_err(|_| Failure::DomainFailed)?;
            }
            let socket = socket.into_std().map_err(|_| Failure::DomainFailed)?;
            if let Some(address) = blocking {
                let retained = socket.try_clone().map_err(|_| Failure::DomainFailed)?;
                let number = retained.as_raw_fd();
                let inode = std::fs::read_link(format!("/proc/self/fd/{number}"))
                    .map_err(|_| Failure::DomainFailed)?;
                *fd.lock().unwrap() = Some((number, inode));
                tokio::task::spawn_blocking(move || {
                    let mut gate =
                        std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5))
                            .unwrap();
                    gate.set_read_timeout(Some(Duration::from_secs(20)))
                        .unwrap();
                    gate.set_write_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut released = [0];
                    gate.read_exact(&mut released).unwrap();
                    assert_eq!(released, [1]);
                    assert!(
                        crate::tailscale::in_domain(),
                        "blocking descendants have the production diagnostic scope"
                    );
                    drop(retained);
                    gate.write_all(b"joined").unwrap();
                });
            }
            let socket =
                tokio::net::TcpStream::from_std(socket).map_err(|_| Failure::DomainFailed)?;
            let client = ts_http_util::http2::connect::<EmptyBody>(socket)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            control.ready();
            let response = client
                .send(
                    Request::builder()
                        .uri(format!(
                            "http://{address}/native-registration-qualification"
                        ))
                        .body(EmptyBody::new())
                        .map_err(|_| Failure::DomainFailed)?,
                )
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let bytes = Limited::new(response.into_body(), 1024 * 1024)
                .collect()
                .await
                .map_err(|_| Failure::DomainFailed)?
                .to_bytes()
                .to_vec();
            let _ = body.send(bytes);
            control.cancelled().cancelled().await;
            drop(client);
            Ok(())
        }) as std::pin::Pin<Box<dyn Future<Output = Result<(), Failure>>>>
    });
    (work, received)
}

#[tokio::test]
async fn registration_close_joins_an_actually_pending_sdk_constructor() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fd: Fd = Arc::new(Mutex::new(None));
    let descriptor = Arc::clone(&fd);
    let (pending, observed) = tokio::sync::oneshot::channel();
    let work: Work = Box::new(move |_control| {
        Box::pin(async move {
            let socket = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            *descriptor.lock().unwrap() = Some((
                socket.as_raw_fd(),
                std::fs::read_link(format!("/proc/self/fd/{}", socket.as_raw_fd())).unwrap(),
            ));
            let keys = ts_keys::NodeKeyPair::random();
            let mut handshake = Box::pin(ts_derp::Client::handshake(socket, &keys));
            let mut pending = Some(pending);
            let client = std::future::poll_fn(|cx| {
                let result = handshake.as_mut().poll(cx);
                if result.is_pending()
                    && let Some(pending) = pending.take()
                {
                    let _ = pending.send(());
                }
                result
            })
            .await
            .map_err(|_| Failure::DomainFailed)?;
            drop(client);
            Ok(())
        })
    });
    let cache = Cache::new();
    let registration = cache.register(RunId::new_v4());
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(key(1), work).unwrap();
    let (mut socket, _) = bounded(listener.accept()).await.unwrap();
    bounded(observed).await.unwrap();
    let descriptor = fd.lock().unwrap().clone().unwrap();
    registration.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(registration.shutdown_native()).await.unwrap();
    assert_eq!(bounded(socket.read(&mut [0])).await.unwrap(), 0);
    assert_ne!(
        std::fs::read_link(format!("/proc/self/fd/{}", descriptor.0)).ok(),
        Some(descriptor.1)
    );
    assert_eq!(access.check(), Err(FailureReason::Cancelled));
}

#[tokio::test]
async fn replacement_and_stale_close_cannot_adopt_or_cancel_the_winning_registration() {
    replacement_and_stale_close(false).await;
}

#[tokio::test]
async fn replacement_and_stale_close_preserve_the_winning_response_when_sockets_reset() {
    replacement_and_stale_close(true).await;
}

async fn replacement_and_stale_close(reset_on_close: bool) {
    let cache = Cache::new();
    let run = RunId::new_v4();
    let old = cache.register(run);
    let a = Http::new(vec![7; 1024]).await.named("old registration");
    let (work, old_body) =
        http_work_with_reset(a.address, None, Arc::new(Mutex::new(None)), reset_on_close);
    let old_access = old.lookup(uuid::Uuid::new_v4()).unwrap();
    let old_node = old_access.native_node(key(1), work).unwrap();
    a.requested().await;
    let winning = cache.register(run);
    let b_bytes: Vec<_> = (0..65536).map(|index| (index % 251) as u8).collect();
    let b = Http::new(b_bytes.clone())
        .await
        .named("winning registration");
    let (work, body) =
        http_work_with_reset(b.address, None, Arc::new(Mutex::new(None)), reset_on_close);
    let access = winning.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(key(1), work).unwrap();
    b.requested().await;
    old.close();
    assert_eq!(access.check(), Ok(()));
    assert_eq!(bounded(old_node.ready()).await, Err(Failure::Cancelled));
    bounded(old.shutdown_native()).await.unwrap();
    assert!(bounded(old_body).await.is_err());
    b.reply();
    assert_eq!(bounded(body).await.unwrap(), b_bytes);
    assert_eq!(bounded(node.ready()).await, Ok(()));
    winning.close();
    bounded(winning.shutdown_native()).await.unwrap();
    // Joined cancellation closes the socket; a graceful TCP FIN is not required.
    let old_closure = a.finish_closed().await;
    let winning_closure = b.finish_closed().await;
    if reset_on_close {
        assert_eq!(old_closure, SocketClosure::Reset, "old registration");
        assert_eq!(
            winning_closure,
            SocketClosure::Reset,
            "winning registration"
        );
    }
}

#[tokio::test]
async fn one_configuration_is_deduplicated_only_inside_its_exact_registration() {
    let cache = Cache::new();
    let registration = cache.register(RunId::new_v4());
    let a = Http::new(vec![8; 4096]).await;
    let native_key = key(4);
    let (first, body) = http_work(a.address, None, Arc::new(Mutex::new(None)));
    let one = registration
        .lookup(uuid::Uuid::new_v4())
        .unwrap()
        .native_node(native_key, first)
        .unwrap();
    a.requested().await;
    let (unused, _unused_body) = http_work(a.address, None, Arc::new(Mutex::new(None)));
    let two = registration
        .lookup(uuid::Uuid::new_v4())
        .unwrap()
        .native_node(native_key, unused)
        .unwrap();
    drop(one);
    a.reply();
    assert_eq!(bounded(body).await.unwrap(), vec![8; 4096]);
    assert_eq!(bounded(two.ready()).await, Ok(()));
    drop(two);
    bounded(registration.shutdown_native()).await.unwrap();
    a.finish().await;
}

#[tokio::test]
async fn run_invalidation_cancels_owned_io_and_allows_a_fresh_authority_snapshot() {
    run_invalidation(false).await;
}

#[tokio::test]
async fn run_invalidation_preserves_fresh_authority_and_response_when_sockets_reset() {
    run_invalidation(true).await;
}

async fn run_invalidation(reset_on_close: bool) {
    let cache = Cache::new();
    let run = RunId::new_v4();
    let registration = cache.register(run);
    let connection = uuid::Uuid::new_v4();
    let native_key = key(5);
    let a = Http::new(vec![2; 1024]).await.named("invalidated snapshot");
    let (work, original) =
        http_work_with_reset(a.address, None, Arc::new(Mutex::new(None)), reset_on_close);
    let stale = registration.lookup(connection).unwrap();
    let old = stale.native_node(native_key, work).unwrap();
    a.requested().await;
    let retired = old.physical();
    cache.invalidate(run, None);
    assert_eq!(stale.check(), Err(FailureReason::ConfigurationChanged));
    // A raw node is a consumer lease; invalidating SSH cannot cancel another
    // consumer that still owns it. Release this retired consumer explicitly.
    drop(old);
    bounded(retired).await.unwrap();
    assert!(bounded(original).await.is_err());
    let fresh = registration.lookup(connection).unwrap();
    let b = Http::new(vec![4; 4096]).await.named("fresh snapshot");
    let (work, body) =
        http_work_with_reset(b.address, None, Arc::new(Mutex::new(None)), reset_on_close);
    let node = fresh.native_node(native_key, work).unwrap();
    b.requested().await;
    b.reply();
    assert_eq!(bounded(body).await.unwrap(), vec![4; 4096]);
    assert_eq!(fresh.check(), Ok(()));
    registration.close();
    bounded(registration.shutdown_native()).await.unwrap();
    drop(node);
    // Physical retirement may close either socket with EOF or a TCP reset.
    let old_closure = a.finish_closed().await;
    let fresh_closure = b.finish_closed().await;
    if reset_on_close {
        assert_eq!(old_closure, SocketClosure::Reset, "invalidated snapshot");
        assert_eq!(fresh_closure, SocketClosure::Reset, "fresh snapshot");
    }
}

#[tokio::test]
async fn broad_ssh_invalidation_preserves_an_independent_consumers_shared_node_io() {
    let cache = Cache::new();
    let run = RunId::new_v4();
    let registration = cache.register(run);
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let configuration = super::Configuration::new(
        uuid::Uuid::new_v4(),
        1,
        serde_json::from_value(serde_json::json!("synthetic-client")).unwrap(),
        serde_json::from_value(serde_json::json!("synthetic-secret")).unwrap(),
        vec!["tag:vnc".into()],
    )
    .unwrap();
    let native_key = configuration.key();
    let bytes = vec![0xa7; 65537];
    let http = Http::new(bytes.clone()).await;
    let (work, body) = http_work(http.address, None, Arc::new(Mutex::new(None)));
    let ssh_node = access
        .native_configured(configuration, |_, _| work)
        .unwrap();
    http.requested().await;
    let (unused, _) = http_work(http.address, None, Arc::new(Mutex::new(None)));
    let independent = registration
        .native
        .registry
        .acquire(native_key, unused)
        .unwrap();
    independent.start();
    cache.invalidate(run, None);
    assert_eq!(access.check(), Err(FailureReason::ConfigurationChanged));
    drop(ssh_node);
    http.reply();
    assert_eq!(bounded(body).await.unwrap(), bytes);
    assert_eq!(bounded(independent.ready()).await, Ok(()));
    drop(independent);
    registration.close();
    bounded(registration.shutdown_native()).await.unwrap();
    http.finish().await;
}

#[tokio::test]
async fn actual_guest_rpc_shutdown_reports_native_timeout_and_keeps_physical_ownership() {
    actual_guest_rpc_shutdown(false, false, false).await;
}

#[tokio::test]
async fn actual_guest_rpc_shutdown_retains_physical_ownership_when_sockets_reset() {
    actual_guest_rpc_shutdown(true, false, false).await;
}

#[tokio::test]
async fn vnc_only_guest_rpc_reports_native_timeout_and_retains_physical_ownership() {
    actual_guest_rpc_shutdown(false, true, false).await;
}

#[tokio::test]
async fn vnc_only_guest_rpc_retains_cleanup_when_sockets_reset() {
    actual_guest_rpc_shutdown(true, true, false).await;
}

#[tokio::test]
async fn cancelled_vnc_only_shutdown_waiter_preserves_native_physical_cleanup() {
    actual_guest_rpc_shutdown(false, true, true).await;
}

async fn actual_guest_rpc_shutdown(reset_on_close: bool, without_ssh: bool, cancel_waiter: bool) {
    use crate::{
        guest_rpc::{CleanupError, Runtime},
        ssh::SshRuntime,
        test_fixtures::http::{HttpClientConfig, http_client},
        vnc::VncRuntime,
    };
    use runner_host::runner_process_identity::RunnerProcessIdentity;
    use tokio_util::sync::CancellationToken;

    struct PendingAcceptor;
    #[async_trait::async_trait]
    impl sandbox::GuestRpcAcceptor for PendingAcceptor {
        async fn accept(&self) -> std::io::Result<sandbox::AcceptedGuestRpc> {
            std::future::pending().await
        }
    }
    let api = httpmock::MockServer::start_async().await;
    let http = http_client(HttpClientConfig {
        api_url: api.base_url(),
        vercel_bypass: None,
        client_session_id: "native-cleanup-qualification".into(),
    });
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let runtime = if without_ssh {
        Runtime::new(
            None,
            VncRuntime::official(http, "vm0_official_test", identity).unwrap(),
            None,
        )
    } else {
        Runtime::new(
            SshRuntime::official(http, "vm0_official_test", identity).unwrap(),
            None,
            None,
        )
    };
    let dispatcher = runtime.start(
        Arc::new(PendingAcceptor),
        "native-qualification-sandbox".into(),
        RunId::new_v4(),
        &CancellationToken::new(),
    );
    let native = dispatcher.native();
    assert_eq!(dispatcher.ssh().is_none(), without_ssh);
    let http = Http::new(vec![1; 1024]).await;
    let mut gate = Blocking::new().await;
    let fd: Fd = Arc::new(Mutex::new(None));
    let (work, body) = http_work_with_reset(
        http.address,
        Some(gate.address),
        Arc::clone(&fd),
        reset_on_close,
    );
    let node = if let Some(ssh) = dispatcher.ssh() {
        crate::ssh::tests::harness::native_registration(&ssh)
            .lookup(uuid::Uuid::new_v4())
            .unwrap()
            .native_node(key(1), work)
            .unwrap()
    } else {
        // A proves that native physical ownership/cleanup needs no SSH consumer;
        // E supplies VNC's admitted native configuration and transport.
        let node = native.registry.acquire(key(1), work).unwrap();
        node.start();
        node
    };
    gate.accepted().await;
    http.requested().await;
    if cancel_waiter {
        let mut shutdown = Box::pin(dispatcher.shutdown());
        std::future::poll_fn(|cx| {
            assert!(shutdown.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        drop(shutdown);
    } else {
        let started = std::time::Instant::now();
        assert_eq!(dispatcher.shutdown().await, Err(CleanupError::Native));
        assert!(started.elapsed() >= Duration::from_secs(5));
    }
    let (number, inode) = fd.lock().unwrap().clone().unwrap();
    assert_eq!(
        std::fs::read_link(format!("/proc/self/fd/{number}")).unwrap(),
        inode
    );
    assert!(bounded(body).await.is_err());
    gate.release().await;
    bounded(node.physical()).await.unwrap();
    // Joined cancellation closes the socket without requiring a graceful FIN.
    let closure = http.finish_closed().await;
    if reset_on_close {
        assert_eq!(closure, SocketClosure::Reset);
    }
    assert_ne!(
        std::fs::read_link(format!("/proc/self/fd/{number}")).ok(),
        Some(inode)
    );
    let expected = if cancel_waiter {
        Ok(())
    } else {
        Err(Failure::CleanupTimedOut)
    };
    assert_eq!(bounded(native.shutdown()).await, expected);
}

#[tokio::test]
async fn five_second_failure_and_cancelled_waiter_retain_real_sdk_fds_and_four_slots() {
    let cache = Cache::new();
    let retiring = cache.register(RunId::new_v4());
    let other = cache.register(RunId::new_v4());
    let mut held = Vec::new();
    for _ in 0..3 {
        let http = Http::new(vec![9; 2048]).await;
        let mut gate = Blocking::new().await;
        let fd: Fd = Arc::new(Mutex::new(None));
        let (work, _body) = http_work(http.address, Some(gate.address), Arc::clone(&fd));
        let node = retiring
            .lookup(uuid::Uuid::new_v4())
            .unwrap()
            .native_node(key(1), work)
            .unwrap();
        gate.accepted().await;
        http.requested().await;
        held.push((node, http, gate, fd));
    }
    let bytes: Vec<_> = (0..65536).map(|index| (index % 239) as u8).collect();
    let b = Http::new(bytes.clone()).await;
    let (work, body) = http_work(b.address, None, Arc::new(Mutex::new(None)));
    let b_node = other
        .lookup(uuid::Uuid::new_v4())
        .unwrap()
        .native_node(key(1), work)
        .unwrap();
    b.requested().await;
    retiring.close();
    let waiter_owner = Arc::clone(&retiring);
    let (polled, poll_observed) = tokio::sync::oneshot::channel();
    let waiter = tokio::spawn(async move {
        let mut shutdown = Box::pin(waiter_owner.shutdown_native());
        let mut polled = Some(polled);
        std::future::poll_fn(|cx| {
            let result = shutdown.as_mut().poll(cx);
            if result.is_pending()
                && let Some(polled) = polled.take()
            {
                let _ = polled.send(());
            }
            result
        })
        .await
    });
    bounded(poll_observed).await.unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    let started = std::time::Instant::now();
    assert_eq!(
        retiring.shutdown_native().await,
        Err(Failure::CleanupTimedOut)
    );
    assert!(started.elapsed() >= Duration::from_secs(5));
    for (_, http, _, fd) in &held {
        let (number, inode) = fd.lock().unwrap().clone().unwrap();
        assert_eq!(
            std::fs::read_link(format!("/proc/self/fd/{number}")).unwrap(),
            inode
        );
        assert!(
            !http.saw_eof(),
            "a started blocking descendant still owns the actual connected socket"
        );
    }
    let next = cache.register(RunId::new_v4());
    let (fifth, _never) = http_work(b.address, None, Arc::new(Mutex::new(None)));
    assert!(matches!(
        next.lookup(uuid::Uuid::new_v4())
            .unwrap()
            .native_node(key(1), fifth),
        Err(FailureReason::ResourceExhausted)
    ));
    b.reply();
    assert_eq!(
        bounded(body).await.unwrap(),
        bytes,
        "the original other Run request is never replayed"
    );
    for (node, http, mut gate, fd) in held {
        gate.release().await;
        let (number, inode) = fd.lock().unwrap().clone().unwrap();
        bounded(node.physical()).await.unwrap();
        drop(node);
        http.finish().await;
        assert_ne!(
            std::fs::read_link(format!("/proc/self/fd/{number}")).ok(),
            Some(inode)
        );
    }
    assert_eq!(
        retiring.shutdown_native().await,
        Err(Failure::CleanupTimedOut)
    );
    // A fresh exact registration can start only after actual physical joins free capacity.
    let c = Http::new(vec![3; 1024]).await;
    let (work, body) = http_work(c.address, None, Arc::new(Mutex::new(None)));
    let c_node = next
        .lookup(uuid::Uuid::new_v4())
        .unwrap()
        .native_node(key(1), work)
        .unwrap();
    c.requested().await;
    c.reply();
    assert_eq!(bounded(body).await.unwrap(), vec![3; 1024]);
    next.close();
    bounded(next.shutdown_native()).await.unwrap();
    other.close();
    bounded(other.shutdown_native()).await.unwrap();
    drop((b_node, c_node));
    b.finish().await;
    c.finish().await;
}
