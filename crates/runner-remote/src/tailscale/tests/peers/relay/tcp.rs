//! Production relay dialing inside its retained native owner, over real TCP.

use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    pin::Pin,
    task::Poll,
    time::Duration,
};

use runner_types::ids::RunId;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
};
use ts_derp::{IpUsage, ServerConnInfo, TlsValidationConfig};

use super::super::{bounded, inside};
use crate::tailscale::{
    Failure, Key, Work,
    evidence::{Role, Stage, Status, Trace},
    regional_relay::{Dial, Verified},
    resolver::Resolver,
    tests::fixture::Cache,
};

fn address(ipv6: bool, port: u16) -> SocketAddr {
    SocketAddr::new(
        if ipv6 {
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        } else {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        },
        port,
    )
}

fn reserve(ipv6: bool, port: u16) -> TcpSocket {
    let socket = if ipv6 {
        TcpSocket::new_v6().unwrap()
    } else {
        TcpSocket::new_v4().unwrap()
    };
    socket.bind(address(ipv6, port)).unwrap();
    socket
}

fn pair(ipv6: bool) -> (TcpSocket, TcpSocket) {
    // An ephemeral port on one loopback family can already be occupied on the
    // other. Reserve both before publishing the fixture's shared DERP port.
    for _ in 0..16 {
        let first = reserve(ipv6, 0);
        let other = if ipv6 {
            TcpSocket::new_v4().unwrap()
        } else {
            TcpSocket::new_v6().unwrap()
        };
        match other.bind(address(!ipv6, first.local_addr().unwrap().port())) {
            Ok(()) => return (first, other),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => panic!("could not reserve the other loopback family: {error}"),
        }
    }
    panic!("could not reserve a shared loopback port");
}

fn server(port: u16, ipv4: bool, ipv6: bool) -> ServerConnInfo {
    ServerConnInfo {
        hostname: "localhost".into(),
        ipv4: if ipv4 {
            IpUsage::FixedAddr(Ipv4Addr::LOCALHOST)
        } else {
            IpUsage::Disable
        },
        ipv6: if ipv6 {
            IpUsage::FixedAddr(Ipv6Addr::LOCALHOST)
        } else {
            IpUsage::Disable
        },
        tls_validation_config: TlsValidationConfig::CommonName {
            common_name: "localhost".into(),
        },
        https_port: port,
        stun_port: None,
        stun_only: false,
        supports_port_80: false,
    }
}

fn selected(trace: &Trace, endpoint: SocketAddr, status: Status) {
    let snapshot = trace.snapshot().unwrap();
    assert_eq!(snapshot.endpoints.len(), 1);
    assert_eq!(snapshot.endpoints[0].role, Role::Relay);
    assert_eq!(snapshot.endpoints[0].address, endpoint);
    assert!(
        snapshot
            .steps
            .iter()
            .any(|step| step.stage == Stage::RelayTcp && step.status == status)
    );
}

async fn exchange(mut client: TcpStream, listener: &TcpListener) {
    assert!(client.nodelay().unwrap());
    let (mut peer, _) = bounded(listener.accept()).await.unwrap();
    client.write_all(b"relay-request").await.unwrap();
    let mut request = [0; 13];
    bounded(peer.read_exact(&mut request)).await.unwrap();
    assert_eq!(&request, b"relay-request");
    peer.write_all(b"relay-response").await.unwrap();
    let mut response = [0; 14];
    bounded(client.read_exact(&mut response)).await.unwrap();
    assert_eq!(&response, b"relay-response");
    drop(client);
    assert_eq!(bounded(peer.read(&mut [0])).await.unwrap(), 0);
}

async fn single_family_refusal(ipv6: bool, dns: bool) {
    inside(move |control| async move {
        control.ready();
        // Keep the refused port reserved rather than releasing a listener's port.
        let refused = reserve(ipv6, 0);
        let endpoint = refused.local_addr().unwrap();
        let mut server = server(endpoint.port(), !ipv6, ipv6);
        if dns {
            if ipv6 {
                server.ipv6 = IpUsage::UseDns;
            } else {
                server.ipv4 = IpUsage::UseDns;
            }
        }
        let trace = Trace::new(true);
        let dial = Verified(Resolver::new());
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            trace.clone().scope(dial.tcp(&server)),
        )
        .await
        .expect("a refused enabled family must finish before the regional deadline");
        assert!(matches!(result, Err(Failure::DomainFailed)));
        selected(&trace, endpoint, Status::Failed);
    })
    .await;
}

#[tokio::test]
async fn single_family_refusal_ipv4_fixed() {
    single_family_refusal(false, false).await;
}

#[tokio::test]
async fn single_family_refusal_ipv6_fixed() {
    single_family_refusal(true, false).await;
}

#[tokio::test]
async fn single_family_refusal_ipv4_dns() {
    single_family_refusal(false, true).await;
}

#[tokio::test]
async fn single_family_refusal_ipv6_dns() {
    single_family_refusal(true, true).await;
}

async fn success(ipv6: bool, dual: bool) {
    inside(move |control| async move {
        control.ready();
        let (listening, _refused) = if dual {
            let (listening, refused) = pair(ipv6);
            (listening, Some(refused))
        } else {
            (reserve(ipv6, 0), None)
        };
        let listener = listening.listen(8).unwrap();
        let endpoint = listener.local_addr().unwrap();
        let server = server(endpoint.port(), dual || !ipv6, dual || ipv6);
        let trace = Trace::new(true);
        let dial = Verified(Resolver::new());
        let client = bounded(trace.clone().scope(dial.tcp(&server)))
            .await
            .unwrap();
        selected(&trace, endpoint, Status::Passed);
        exchange(client, &listener).await;
    })
    .await;
}

#[tokio::test]
async fn single_family_ipv4_success_retains_its_socket_and_trace() {
    success(false, false).await;
}

#[tokio::test]
async fn single_family_ipv6_success_retains_its_socket_and_trace() {
    success(true, false).await;
}

#[tokio::test]
async fn dual_family_ipv4_success_survives_ipv6_refusal() {
    success(false, true).await;
}

#[tokio::test]
async fn dual_family_ipv6_success_survives_ipv4_refusal() {
    success(true, true).await;
}

#[tokio::test]
async fn dual_family_first_success_keeps_only_the_selected_socket() {
    inside(|control| async move {
        control.ready();
        let (v4, v6) = pair(false);
        let v4 = v4.listen(8).unwrap();
        let v6 = v6.listen(8).unwrap();
        let server = server(v4.local_addr().unwrap().port(), true, true);
        let trace = Trace::new(true);
        let dial = Verified(Resolver::new());
        let client = bounded(trace.clone().scope(dial.tcp(&server)))
            .await
            .unwrap();
        let endpoint = client.peer_addr().unwrap();
        selected(&trace, endpoint, Status::Passed);
        let (winner, loser) = if endpoint.is_ipv6() {
            (v6, v4)
        } else {
            (v4, v6)
        };
        exchange(client, &winner).await;
        // The select may connect both candidates before selecting one. Any
        // accepted losing socket must already have lost its native client IO.
        let losing = std::future::poll_fn(|cx| Poll::Ready(loser.poll_accept(cx))).await;
        if let Poll::Ready(Ok((mut peer, _))) = losing {
            let closed = bounded(peer.read(&mut [0])).await;
            assert!(matches!(closed, Ok(0))
                || matches!(closed, Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset));
        }
    })
    .await;
}

#[tokio::test]
async fn dual_family_both_refusals_finish() {
    inside(|control| async move {
        control.ready();
        let (v4, _v6) = pair(false);
        let port = v4.local_addr().unwrap().port();
        let dial = Verified(Resolver::new());
        assert!(matches!(
            bounded(dial.tcp(&server(port, true, true))).await,
            Err(Failure::DomainFailed)
        ));
    })
    .await;
}

#[tokio::test]
async fn no_enabled_family_finishes_without_tcp_io() {
    inside(|control| async move {
        control.ready();
        let trace = Trace::new(true);
        let dial = Verified(Resolver::new());
        assert!(matches!(
            bounded(trace.clone().scope(dial.tcp(&server(443, false, false)))).await,
            Err(Failure::DomainFailed)
        ));
        assert!(trace.snapshot().unwrap().endpoints.is_empty());
    })
    .await;
}

async fn backlogged(socket: TcpSocket) -> (TcpListener, TcpStream) {
    // Linux retains one established connection for listen(0). Keep it queued
    // so the next real handshake cannot finish until this listener is drained.
    let listener = socket.listen(0).unwrap();
    let queued = bounded(TcpStream::connect(listener.local_addr().unwrap()))
        .await
        .unwrap();
    (listener, queued)
}

async fn still_connecting(attempt: Pin<&mut impl Future<Output = Result<TcpStream, Failure>>>) {
    // This bounded negative observation drives both kernel candidates, allowing
    // a real refusal to finish while the other TCP handshake stays backlogged.
    assert!(
        tokio::time::timeout(Duration::from_millis(100), attempt)
            .await
            .is_err(),
        "one refused family must not finish another enabled, pending handshake"
    );
}

async fn pending_family(ipv6: bool, succeeds: bool) {
    inside(move |control| async move {
        control.ready();
        let (socket, _refused) = pair(ipv6);
        let (listener, queued) = backlogged(socket).await;
        let endpoint = listener.local_addr().unwrap();
        let server = server(endpoint.port(), true, true);
        let trace = Trace::new(true);
        let dial = Verified(Resolver::new());
        let mut attempt = Box::pin(trace.clone().scope(dial.tcp(&server)));
        still_connecting(attempt.as_mut()).await;
        if succeeds {
            let (first, _) = bounded(listener.accept()).await.unwrap();
            drop(first);
            drop(queued);
            let client = bounded(attempt).await.unwrap();
            selected(&trace, endpoint, Status::Passed);
            exchange(client, &listener).await;
        } else {
            drop(listener);
            drop(queued);
            assert!(matches!(bounded(attempt).await, Err(Failure::DomainFailed)));
            selected(&trace, endpoint, Status::Failed);
        }
    })
    .await;
}

#[tokio::test]
async fn dual_family_pending_ipv4_can_succeed_after_ipv6_refusal() {
    pending_family(false, true).await;
}

#[tokio::test]
async fn dual_family_pending_ipv6_can_succeed_after_ipv4_refusal() {
    pending_family(true, true).await;
}

#[tokio::test]
async fn dual_family_pending_ipv4_can_fail_after_ipv6_refusal() {
    pending_family(false, false).await;
}

#[tokio::test]
async fn dual_family_pending_ipv6_can_fail_after_ipv4_refusal() {
    pending_family(true, false).await;
}

fn pending_descriptor(ipv6: bool, port: u16) -> (PathBuf, PathBuf) {
    let descriptors = std::fs::read_dir("/proc/self/fd")
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    let table = std::fs::read_to_string(if ipv6 {
        "/proc/net/tcp6"
    } else {
        "/proc/net/tcp"
    })
    .unwrap();
    let remote_port = format!(":{port:04X}");
    table
        .lines()
        .skip(1)
        .find_map(|row| {
            let fields = row.split_whitespace().collect::<Vec<_>>();
            if fields[3] != "02" || !fields[2].ends_with(&remote_port) {
                return None;
            }
            // The network table also contains other processes' sockets. Only
            // this process's actual descriptor can prove native IO retirement.
            let target = PathBuf::from(format!("socket:[{}]", fields[9]));
            descriptors
                .iter()
                .find(|path| std::fs::read_link(path).ok().as_ref() == Some(&target))
                .map(|path| (path.clone(), target))
        })
        .expect("the production dial owns a real SYN_SENT socket")
}

async fn cancel_pending(ipv6: bool) {
    let (socket, _refused) = pair(ipv6);
    let (listener, _queued) = backlogged(socket).await;
    let port = listener.local_addr().unwrap().port();
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let work: Work = Box::new(move |control| {
        Box::pin(async move {
            let server = server(port, true, true);
            let dial = Verified(Resolver::new());
            let mut attempt = Box::pin(dial.tcp(&server));
            still_connecting(attempt.as_mut()).await;
            control.ready();
            attempt.await.map(|_| ())
        })
    });
    let node = run
        .lookup(uuid::Uuid::new_v4())
        .unwrap()
        .native_node(
            Key {
                configuration: uuid::Uuid::new_v4(),
                generation: 1,
            },
            work,
        )
        .unwrap();
    bounded(node.ready()).await.unwrap();
    let (descriptor, target) = pending_descriptor(ipv6, port);
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    assert_ne!(std::fs::read_link(descriptor).ok(), Some(target));
}

#[tokio::test]
async fn native_owner_cancellation_closes_a_pending_ipv4_dial() {
    cancel_pending(false).await;
}

#[tokio::test]
async fn native_owner_cancellation_closes_a_pending_ipv6_dial() {
    cancel_pending(true).await;
}
