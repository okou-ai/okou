use super::{Run, Runtime};
use async_trait::async_trait;
use runner_rpc_proto::ResponseReader;
use sandbox::{AcceptedGuestRpc, GuestRpcAcceptor, GuestRpcStream};
use serde_json::{Value, json};
use std::{
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf},
    sync::{Mutex, mpsc},
};
use tokio_util::sync::CancellationToken;

struct Stream(DuplexStream);
impl GuestRpcStream for Stream {}
impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}
impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

struct Acceptor(Mutex<mpsc::Receiver<AcceptedGuestRpc>>);
#[async_trait]
impl GuestRpcAcceptor for Acceptor {
    async fn accept(&self) -> io::Result<AcceptedGuestRpc> {
        self.0
            .lock()
            .await
            .recv()
            .await
            .ok_or_else(|| io::Error::other("test input closed"))
    }
}

struct Harness {
    run: Option<Run>,
    incoming: mpsc::Sender<AcceptedGuestRpc>,
    cancelled: CancellationToken,
    lifecycle: CancellationToken,
}

impl Harness {
    fn new() -> Self {
        let (incoming, receiver) = mpsc::channel(16);
        let cancelled = CancellationToken::new();
        let run = Runtime {
            ssh: None,
            vnc: None,
        }
        .start(
            Arc::new(Acceptor(Mutex::new(receiver))),
            "assigned-sandbox".into(),
            crate::ids::RunId::new_v4(),
            &cancelled,
        );
        Self {
            run: Some(run),
            incoming,
            cancelled,
            lifecycle: CancellationToken::new(),
        }
    }

    async fn open(&self, sandbox: &str) -> DuplexStream {
        let (guest, host) = tokio::io::duplex(64 * 1024);
        self.incoming
            .send(AcceptedGuestRpc {
                sandbox_id: sandbox.into(),
                stream: Box::new(Stream(host)),
                cancelled: self.lifecycle.clone(),
            })
            .await
            .unwrap();
        guest
    }

    async fn shutdown(mut self) {
        if let Some(run) = self.run.take() {
            run.shutdown().await;
        }
    }
}

async fn frames(guest: DuplexStream) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut reader = ResponseReader::new(guest);
        let mut frames = Vec::new();
        while let Some(frame) = reader.next().await.unwrap() {
            frames.push(serde_json::to_value(frame).unwrap());
        }
        frames
    })
    .await
    .unwrap()
}

async fn send(guest: &mut DuplexStream, request: &[u8]) {
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request).await.unwrap();
    // Deliberately do not half-close: Firecracker does not forward guest EOF.
}

fn error(code: &str) -> Vec<Value> {
    vec![json!({"type":"error","code":code,"delivery":"not_dispatched"})]
}

async fn closed(mut guest: DuplexStream) {
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), guest.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert!(bytes.is_empty());
}

#[tokio::test]
async fn dispatch_without_consumers_rejects_known_unavailable_and_unknown_methods() {
    let h = Harness::new();
    for (method, code) in [
        ("ssh.exec", "unavailable"),
        ("ssh.session.list", "unavailable"),
        ("ssh.file.upload", "unavailable"),
        ("ssh.file.download", "unavailable"),
        ("vnc.session.start", "unavailable"),
        ("vnc.session.list", "unavailable"),
        ("vnc.session.status", "unavailable"),
        ("vnc.session.close", "unavailable"),
        ("vnc.capture", "unavailable"),
        ("vnc.input", "unavailable"),
        ("vnc.session.reconnect", "unknown_method"),
        ("vnc.capture.extra", "unknown_method"),
        ("unrelated.query", "unknown_method"),
    ] {
        let mut guest = h.open("assigned-sandbox").await;
        send(
            &mut guest,
            json!({"version":1,"method":method,"params":{}})
                .to_string()
                .as_bytes(),
        )
        .await;
        assert_eq!(frames(guest).await, error(code));
    }
    h.shutdown().await;
}

#[tokio::test]
async fn malformed_requests_are_rejected_before_consumer_availability() {
    let h = Harness::new();
    for request in [
        br#"{"version":1,"method":"ssh.exec","params":null}"#.as_slice(),
        br#"{"version":1,"method":"ssh.exec","params":{},"runId":"guest-authority"}"#,
        br#"{"version":1,"method":"ssh.exec","params":{}}{}"#,
        br#"{"version":1,"method":"vnc.session.start","params":null}"#,
        br#"{"version":1,"method":"vnc.capture","params":{},"runId":"guest-authority"}"#,
        br#"{"version":1,"method":"vnc.input","params":{}}{}"#,
    ] {
        let mut guest = h.open("assigned-sandbox").await;
        send(&mut guest, request).await;
        assert_eq!(frames(guest).await, error("invalid_request"));
    }
    h.shutdown().await;
}

#[tokio::test]
async fn wrong_assignment_closes_only_that_stream() {
    let h = Harness::new();
    closed(h.open("other-sandbox").await).await;
    let mut guest = h.open("assigned-sandbox").await;
    send(&mut guest, br#"{"version":1,"method":"query","params":{}}"#).await;
    assert_eq!(frames(guest).await, error("unknown_method"));
    h.shutdown().await;
}

#[tokio::test]
async fn missing_consumer_still_bounds_admission_and_releases_completed_requests() {
    let h = Harness::new();
    let mut pending = Vec::new();
    for _ in 0..8 {
        pending.push(h.open("assigned-sandbox").await);
    }
    // Receiving the ninth rejection also proves the first eight were admitted.
    assert_eq!(
        frames(h.open("assigned-sandbox").await).await,
        error("resource_exhausted")
    );
    let mut guest = pending.pop().unwrap();
    send(
        &mut guest,
        br#"{"version":1,"method":"ssh.exec","params":{}}"#,
    )
    .await;
    assert_eq!(frames(guest).await, error("unavailable"));
    let mut guest = h.open("assigned-sandbox").await;
    send(&mut guest, br#"{"version":1,"method":"query","params":{}}"#).await;
    assert_eq!(frames(guest).await, error("unknown_method"));
    h.shutdown().await;
    for guest in pending {
        closed(guest).await;
    }
}

#[tokio::test]
async fn run_shutdown_drop_and_lifecycle_cancel_close_admitted_partial_requests() {
    enum Stop {
        Shutdown,
        Drop,
        ParentCancel,
        SandboxCancel,
    }
    for stop in [
        Stop::Shutdown,
        Stop::Drop,
        Stop::ParentCancel,
        Stop::SandboxCancel,
    ] {
        let mut h = Harness::new();
        let mut pending = Vec::new();
        for _ in 0..8 {
            let mut guest = h.open("assigned-sandbox").await;
            guest.write_all(&[0, 0]).await.unwrap();
            pending.push(guest);
        }
        assert_eq!(
            frames(h.open("assigned-sandbox").await).await,
            error("resource_exhausted")
        );
        match stop {
            Stop::Shutdown => h.run.take().unwrap().shutdown().await,
            Stop::Drop => drop(h.run.take()),
            Stop::ParentCancel => h.cancelled.cancel(),
            Stop::SandboxCancel => h.lifecycle.cancel(),
        }
        for guest in pending {
            closed(guest).await;
        }
        h.shutdown().await;
    }
}

#[tokio::test]
async fn incomplete_requests_expire_and_release_admission_without_ssh() {
    let h = Harness::new();
    let mut pending = Vec::new();
    for _ in 0..8 {
        let mut guest = h.open("assigned-sandbox").await;
        guest.write_all(&[0, 0]).await.unwrap();
        pending.push(guest);
    }
    assert_eq!(
        frames(h.open("assigned-sandbox").await).await,
        error("resource_exhausted")
    );
    // All setup deadlines exist before advancing the clock; no sleeps are
    // needed to race request admission or parsing.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::time::resume();
    for guest in pending {
        closed(guest).await;
    }
    let mut guest = h.open("assigned-sandbox").await;
    send(&mut guest, br#"{"version":1,"method":"query","params":{}}"#).await;
    assert_eq!(frames(guest).await, error("unknown_method"));
    h.shutdown().await;
}
