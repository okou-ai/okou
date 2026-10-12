//! Fixed control HTTP through actual Cache-owned production IO; TLS/Noise is a
//! separate gate. All endpoint responses and keys are synthetic loopback data.

use super::{
    fixture::{Http, bounded},
    registration::Measured,
};
use crate::{
    ssh::cache::Cache,
    tailscale::{Control, Failure, Key, Work, control_key},
};
use runner_types::ids::RunId;
use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use ts_keys::MachinePublicKey;

fn body(key: MachinePublicKey) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"publicKey": key.to_string()})).unwrap()
}

fn work(
    address: std::net::SocketAddr,
    bytes: Arc<AtomicUsize>,
) -> (Work, tokio::sync::oneshot::Receiver<MachinePublicKey>) {
    let (sent, received) = tokio::sync::oneshot::channel();
    let work: Work = Box::new(move |control: Control| {
        Box::pin(async move {
            let socket = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let key = control_key::fetch(Measured { socket, bytes }).await?;
            let _ = sent.send(key);
            control.ready();
            control.cancelled().cancelled().await;
            Ok(())
        })
    });
    (work, received)
}

fn configuration() -> Key {
    Key {
        configuration: uuid::Uuid::new_v4(),
        generation: 1,
    }
}

#[tokio::test]
async fn valid_key_fetch_uses_fixed_request_and_closes_its_owned_http_driver() {
    let expected = MachinePublicKey::random();
    let http = Http::key(body(expected), 200).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let (work, received) = work(http.address, Arc::new(AtomicUsize::new(0)));
    let node = access.native_node(configuration(), work).unwrap();
    http.requested().await;
    http.reply();
    bounded(node.ready()).await.unwrap();
    assert_eq!(bounded(received).await.unwrap(), expected);
    // The one-shot key operation releases actual IO while the node is still
    // alive; node retirement is not used to conceal a retained key driver.
    http.finish_closed().await;
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
}

#[tokio::test]
async fn oversized_valid_key_body_stops_at_raw_limit_before_collection() {
    let mut oversized = vec![b' '; 2 * 1024 * 1024];
    oversized.extend(body(MachinePublicKey::random()));
    let http = Http::key(oversized, 200).await;
    let bytes = Arc::new(AtomicUsize::new(0));
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let (work, _) = work(http.address, Arc::clone(&bytes));
    let node = access.native_node(configuration(), work).unwrap();
    http.requested().await;
    http.reply();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    assert_eq!(bytes.load(Ordering::Acquire), 1024 * 1024);
    bounded(run.shutdown_native()).await.unwrap();
    http.finish_closed().await;
}

#[tokio::test]
async fn missing_invalid_zero_key_and_non_success_status_fail_closed() {
    for (status, response) in [
        (200, b"{}".to_vec()),
        (200, b"{\"publicKey\":\"invalid\"}".to_vec()),
        (200, body(MachinePublicKey::from_bytes([0; 32]))),
        (200, b"not-json SYNTHETIC-KEY-BODY-CANARY".to_vec()),
        (302, body(MachinePublicKey::random())),
        (403, body(MachinePublicKey::random())),
    ] {
        let http = Http::key(response, status).await;
        let cache = Cache::new();
        let run = cache.register(RunId::new_v4());
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let (work, _) = work(http.address, Arc::new(AtomicUsize::new(0)));
        let node = access.native_node(configuration(), work).unwrap();
        http.requested().await;
        http.reply();
        assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        http.finish_closed().await;
    }
}

#[tokio::test]
async fn cancelling_pending_key_response_physically_closes_the_owned_driver() {
    let http = Http::key(body(MachinePublicKey::random()), 200).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let (work, _) = work(http.address, Arc::new(AtomicUsize::new(0)));
    let node = access.native_node(configuration(), work).unwrap();
    http.requested().await;
    run.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    http.finish_closed().await;
}

#[tokio::test]
async fn rejected_caller_io_cannot_be_bypassed_by_the_key_operation() {
    let polled = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    let io = Denied {
        polled: Arc::clone(&polled),
        dropped: Arc::clone(&dropped),
    };
    let (sent, received) = tokio::sync::oneshot::channel();
    let work: Work = Box::new(move |_| {
        Box::pin(async move {
            let result = control_key::fetch(io).await.map(|_| ());
            let _ = sent.send(result);
            result
        })
    });
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), work).unwrap();
    assert_eq!(bounded(received).await.unwrap(), Err(Failure::DomainFailed));
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    assert!(polled.load(Ordering::Acquire) > 0);
    assert!(dropped.load(Ordering::Acquire));
}

struct Denied {
    polled: Arc<AtomicUsize>,
    dropped: Arc<AtomicBool>,
}

impl Drop for Denied {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::Release);
    }
}
impl AsyncRead for Denied {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.polled.fetch_add(1, Ordering::AcqRel);
        Poll::Ready(Err(io::Error::other("synthetic denied caller IO")))
    }
}
impl AsyncWrite for Denied {
    fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, _: &[u8]) -> Poll<io::Result<usize>> {
        self.polled.fetch_add(1, Ordering::AcqRel);
        Poll::Ready(Err(io::Error::other("synthetic denied caller IO")))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Err(io::Error::other("synthetic denied caller IO")))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
