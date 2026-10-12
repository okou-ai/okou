use bytes::Bytes;
use http_body_util::Full;
use http_body_util::{BodyExt, Limited};
use hyper::{Response, server::conn::http2, service::service_fn};
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::{
    convert::Infallible,
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio_util::sync::CancellationToken;

pub(super) async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .unwrap()
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum SocketClosure {
    Eof,
    Reset,
}

pub(super) struct Http {
    pub(super) address: SocketAddr,
    peer: &'static str,
    response: CancellationToken,
    requested: Arc<tokio::sync::Notify>,
    eof: Arc<AtomicBool>,
    reset: Arc<AtomicBool>,
    body: Arc<Mutex<Option<serde_json::Value>>>,
    task: tokio::task::JoinHandle<Result<(), hyper::Error>>,
}

impl Http {
    pub(super) async fn new(body: Vec<u8>) -> Self {
        Self::with_path(body, "/native-registration-qualification").await
    }

    pub(super) async fn with_path(body: Vec<u8>, path: &'static str) -> Self {
        Self::with_response(body, path, 200, false).await
    }

    pub(super) async fn key(body: Vec<u8>, status: u16) -> Self {
        Self::with_response(body, "/key", status, true).await
    }

    pub(super) async fn registration(body: Vec<u8>, status: u16) -> Self {
        Self::with_response(body, "/machine/register", status, false).await
    }

    async fn with_response(body: Vec<u8>, path: &'static str, status: u16, http1: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let response = CancellationToken::new();
        let requested = Arc::new(tokio::sync::Notify::new());
        let eof = Arc::new(AtomicBool::new(false));
        let reset = Arc::new(AtomicBool::new(false));
        let received = Arc::new(Mutex::new(None));
        let gate = response.clone();
        let observed = Arc::clone(&requested);
        let socket_eof = Arc::clone(&eof);
        let socket_reset = Arc::clone(&reset);
        let request_body = Arc::clone(&received);
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                assert_eq!(request.uri().path(), path);
                if path == "/machine/register" {
                    assert_eq!(request.method(), "POST");
                    assert_eq!(
                        request.uri().authority().unwrap().as_str(),
                        "controlplane.tailscale.com"
                    );
                }
                if path == "/key" {
                    assert_eq!(request.method(), "GET");
                    assert_eq!(request.headers()["host"], "controlplane.tailscale.com");
                    assert_eq!(
                        request.uri().query().unwrap(),
                        format!("v={}", ts_capabilityversion::CapabilityVersion::CURRENT)
                    );
                }
                let node_header = request.headers().get("Ts-Lb").cloned();
                let observed = Arc::clone(&observed);
                let received = Arc::clone(&request_body);
                let gate = gate.clone();
                let body = Bytes::from(body.clone());
                async move {
                    let bytes = Limited::new(request.into_body(), 8192)
                        .collect()
                        .await
                        .unwrap()
                        .to_bytes();
                    if !bytes.is_empty() {
                        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                        if path == "/machine/register" {
                            assert_eq!(
                                node_header.unwrap().to_str().unwrap(),
                                parsed["NodeKey"].as_str().unwrap()
                            );
                        }
                        *received.lock().unwrap() = Some(parsed);
                    }
                    observed.notify_one();
                    gate.cancelled().await;
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(status)
                            .body(Full::new(body))
                            .unwrap(),
                    )
                }
            });
            let socket = TokioIo::new(Observed {
                socket,
                eof: socket_eof,
                reset: socket_reset,
            });
            if http1 {
                hyper::server::conn::http1::Builder::new()
                    .serve_connection(socket, service)
                    .await
            } else {
                http2::Builder::new(TokioExecutor::new())
                    .serve_connection(socket, service)
                    .await
            }
        });
        Self {
            address,
            peer: path,
            response,
            requested,
            eof,
            reset,
            body: received,
            task,
        }
    }

    pub(super) async fn requested(&self) {
        bounded(self.requested.notified()).await;
    }
    pub(super) fn named(mut self, peer: &'static str) -> Self {
        self.peer = peer;
        self
    }
    pub(super) fn reply(&self) {
        self.response.cancel();
    }
    pub(super) fn saw_eof(&self) -> bool {
        self.eof.load(Ordering::Acquire)
    }
    pub(super) fn body(&self) -> serde_json::Value {
        self.body.lock().unwrap().clone().unwrap()
    }
    pub(super) async fn finish_closed(self) -> SocketClosure {
        self.response.cancel();
        let server = bounded(self.task).await.unwrap();
        let eof = self.eof.load(Ordering::Acquire);
        let reset = self.reset.load(Ordering::Acquire);
        assert!(
            eof || reset,
            "{} at {}: expected socket EOF/reset; eof={eof}, reset={reset}, server={server:?}",
            self.peer,
            self.address,
        );
        if reset {
            SocketClosure::Reset
        } else {
            SocketClosure::Eof
        }
    }
    pub(super) async fn finish(self) {
        self.response.cancel();
        let server = bounded(self.task).await.unwrap();
        let eof = self.eof.load(Ordering::Acquire);
        let reset = self.reset.load(Ordering::Acquire);
        assert!(
            eof,
            "{} at {}: expected socket EOF; eof={eof}, reset={reset}, server={server:?}",
            self.peer, self.address,
        );
    }
}

struct Observed {
    socket: tokio::net::TcpStream,
    eof: Arc<AtomicBool>,
    reset: Arc<AtomicBool>,
}

impl AsyncRead for Observed {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.socket).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) && before == buf.filled().len() {
            self.eof.store(true, Ordering::Release);
        }
        if matches!(&result, Poll::Ready(Err(error)) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted))
        {
            self.reset.store(true, Ordering::Release);
        }
        result
    }
}
impl AsyncWrite for Observed {
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

pub(super) struct Blocking {
    pub(super) address: SocketAddr,
    listener: Option<tokio::net::TcpListener>,
    socket: Option<tokio::net::TcpStream>,
}
impl Blocking {
    pub(super) async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        Self {
            address: listener.local_addr().unwrap(),
            listener: Some(listener),
            socket: None,
        }
    }
    pub(super) async fn accepted(&mut self) {
        self.socket = Some(
            bounded(self.listener.take().unwrap().accept())
                .await
                .unwrap()
                .0,
        );
    }
    pub(super) async fn release(&mut self) {
        let socket = self.socket.as_mut().unwrap();
        bounded(socket.write_all(&[1])).await.unwrap();
        let mut receipt = [0; 6];
        bounded(socket.read_exact(&mut receipt)).await.unwrap();
        assert_eq!(&receipt, b"joined");
        let mut byte = [0];
        assert_eq!(bounded(socket.read(&mut byte)).await.unwrap(), 0);
    }
}
