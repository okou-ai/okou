//! Public SDK models and bounded HTTP IO inside the actual production Cache root.
//! These are registration boundaries; they do not claim TLS/Noise/OAuth acceptance.

use super::fixture::{Http, bounded};
use crate::{
    ssh::cache::Cache,
    tailscale::{Control, Failure, Key, Work, registration::Registration},
};
use runner_types::ids::RunId;
use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

const DERIVED: &str = "tskey-auth-REGISTER-CANARY-SYNTHETIC";
const ACCEPTED: &[u8] = br#"{"User":{"ID":1},"Login":{"ID":1,"Provider":"synthetic","LoginName":"synthetic"},"NodeKeyExpired":false,"MachineAuthorized":true,"AuthURL":"","Error":""}"#;

fn work(
    address: std::net::SocketAddr,
    bytes: Arc<AtomicUsize>,
) -> (Work, tokio::sync::oneshot::Receiver<(String, String)>) {
    let (sent, keys) = tokio::sync::oneshot::channel();
    let work: Work = Box::new(move |control: Control| {
        Box::pin(async move {
            let profile = Registration::new();
            let public = (
                profile.keys().node_keys.public.to_string(),
                profile.keys().machine_keys.public.to_string(),
            );
            let socket = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let client = profile
                .register(Measured { socket, bytes }, DERIVED)
                .await?;
            let _ = sent.send(public);
            control.ready();
            control.cancelled().cancelled().await;
            drop(client);
            Ok(())
        })
    });
    (work, keys)
}

#[tokio::test]
async fn sdk_registration_explicitly_sends_ephemeral_with_fresh_memory_only_identity() {
    let cache = Cache::new();
    let mut previous: Option<(String, String)> = None;
    for _ in 0..2 {
        let http = Http::with_path(ACCEPTED.to_vec(), "/machine/register").await;
        let run = cache.register(RunId::new_v4());
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let (work, keys) = work(http.address, Arc::new(AtomicUsize::new(0)));
        let node = access
            .native_node(
                Key {
                    configuration: uuid::Uuid::new_v4(),
                    generation: 1,
                },
                work,
            )
            .unwrap();
        http.requested().await;
        let request = http.body();
        assert_eq!(request["Ephemeral"], true);
        assert_eq!(request["Auth"]["AuthKey"], DERIVED);
        assert!(request["Followup"].is_null() || request["Followup"] == "");
        http.reply();
        bounded(node.ready()).await.unwrap();
        let public = bounded(keys).await.unwrap();
        assert_eq!(request["NodeKey"], public.0);
        if let Some(previous) = previous {
            assert_ne!(
                public.0, previous.0,
                "node identity is fresh across exact Run owners"
            );
            assert_ne!(
                public.1, previous.1,
                "machine identity is fresh across exact Run owners"
            );
        }
        previous = Some(public);
        run.close();
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        http.finish().await;
    }
}

#[tokio::test]
async fn oversized_sdk_registration_collection_is_cut_off_and_physically_joined() {
    let http = Http::with_path(vec![b'x'; 128 * 1024], "/machine/register").await;
    let bytes = Arc::new(AtomicUsize::new(0));
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let (work, _) = work(http.address, Arc::clone(&bytes));
    let node = access
        .native_node(
            Key {
                configuration: uuid::Uuid::new_v4(),
                generation: 1,
            },
            work,
        )
        .unwrap();
    http.requested().await;
    http.reply();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    assert_eq!(
        bytes.load(Ordering::Acquire),
        64 * 1024,
        "actual owned HTTP2 IO stops at the pre-success raw read cap"
    );
    bounded(run.shutdown_native()).await.unwrap();
    http.finish_closed().await;
}

#[tokio::test]
async fn cancelling_pending_sdk_registration_drops_its_actual_driver_before_root_release() {
    let http = Http::with_path(ACCEPTED.to_vec(), "/machine/register").await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let (work, _) = work(http.address, Arc::new(AtomicUsize::new(0)));
    let node = access
        .native_node(
            Key {
                configuration: uuid::Uuid::new_v4(),
                generation: 1,
            },
            work,
        )
        .unwrap();
    http.requested().await;
    run.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    http.finish_closed().await;
}

#[tokio::test]
async fn registration_rejects_error_expiry_and_interactive_authorization() {
    for (field, value) in [
        (
            "Error",
            serde_json::json!("SYNTHETIC-PROVIDER-ERROR-CANARY"),
        ),
        ("NodeKeyExpired", serde_json::json!(true)),
        ("MachineAuthorized", serde_json::json!(false)),
        (
            "AuthURL",
            serde_json::json!("https://invalid.example/SECRET-AUTH-URL-CANARY"),
        ),
    ] {
        let mut response: serde_json::Value = serde_json::from_slice(ACCEPTED).unwrap();
        response[field] = value;
        let http = Http::registration(serde_json::to_vec(&response).unwrap(), 200).await;
        let cache = Cache::new();
        let run = cache.register(RunId::new_v4());
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let (work, _) = work(http.address, Arc::new(AtomicUsize::new(0)));
        let node = access
            .native_node(
                Key {
                    configuration: uuid::Uuid::new_v4(),
                    generation: 1,
                },
                work,
            )
            .unwrap();
        http.requested().await;
        http.reply();
        assert_eq!(
            bounded(node.ready()).await,
            Err(Failure::DomainFailed),
            "reject the provider's {field} instead of accepting MachineAuthorized alone"
        );
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        http.finish_closed().await;
    }
}

#[tokio::test]
async fn registration_rejects_redirect_status_and_malformed_response_without_retry() {
    for (status, body) in [
        (302, ACCEPTED.to_vec()),
        (403, ACCEPTED.to_vec()),
        (200, b"{\"MachineAuthorized\":true}".to_vec()),
        (200, b"not-json SYNTHETIC-BODY-CANARY".to_vec()),
    ] {
        let http = Http::registration(body, status).await;
        let cache = Cache::new();
        let run = cache.register(RunId::new_v4());
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let (work, _) = work(http.address, Arc::new(AtomicUsize::new(0)));
        let node = access
            .native_node(
                Key {
                    configuration: uuid::Uuid::new_v4(),
                    generation: 1,
                },
                work,
            )
            .unwrap();
        http.requested().await;
        http.reply();
        assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        http.finish_closed().await;
    }
}

pub(super) struct Measured {
    pub(super) socket: tokio::net::TcpStream,
    pub(super) bytes: Arc<AtomicUsize>,
}

impl AsyncRead for Measured {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = out.filled().len();
        let result = Pin::new(&mut self.socket).poll_read(cx, out);
        self.bytes
            .fetch_add(out.filled().len() - before, Ordering::Release);
        result
    }
}
impl AsyncWrite for Measured {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.socket).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}
