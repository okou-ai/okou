//! Independent test-owned TLS/WS gateway forwarding to the real SSH test peer.

use futures_util::{SinkExt, StreamExt};
use rustls::{ClientConfig, RootCertStore, ServerConfig, pki_types::PrivatePkcs8KeyDer};
use std::{
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::{
    Message,
    handshake::server::{Callback, ErrorResponse, Request, Response},
    protocol::frame::{
        Frame,
        coding::{Data, OpCode},
    },
};

use super::super::harness::{Harness, Reply};

pub(super) const CLIENT: &str = "client.canary.access";
pub(super) const SECRET: &str = "cfast_test-secret-canary-opaque";

#[derive(Clone)]
pub(super) enum Mode {
    Proxy,
    Fragmented,
    BoundedOrigin,
    Response(String),
    StallTls,
    StallUpgrade,
    Text,
    Oversized,
    OversizedFragmented,
    Extension,
}

#[derive(Default)]
pub(super) struct Observed {
    pub(super) opened: AtomicUsize,
    pub(super) closed: AtomicUsize,
    pub(super) pongs: AtomicUsize,
    pub(super) stalled: AtomicUsize,
    pub(super) requests: Mutex<Vec<(String, String, String)>>,
}

pub(super) struct Gateway {
    pub(super) observed: Arc<Observed>,
    task: JoinHandle<()>,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Connection(Arc<Observed>);
impl Drop for Connection {
    fn drop(&mut self) {
        self.0.closed.fetch_add(1, Ordering::SeqCst);
    }
}

struct Upgrade {
    observed: Arc<Observed>,
    extension: bool,
}

impl Callback for Upgrade {
    fn on_request(
        self,
        request: &Request,
        mut response: Response,
    ) -> Result<Response, ErrorResponse> {
        assert_eq!(request.uri().path(), "/");
        assert!(request.headers().get("cookie").is_none());
        self.observed.requests.lock().unwrap().push((
            request.headers()["host"].to_str().unwrap().to_owned(),
            request.headers()["cf-access-client-id"]
                .to_str()
                .unwrap()
                .to_owned(),
            request.headers()["cf-access-client-secret"]
                .to_str()
                .unwrap()
                .to_owned(),
        ));
        if self.extension {
            response.headers_mut().insert(
                "sec-websocket-extensions",
                "permessage-deflate".parse().unwrap(),
            );
        }
        Ok(response)
    }
}

pub(super) async fn setup(reply: Reply, mode: Mode, cert_host: &str) -> (Harness, Gateway) {
    let cert = rcgen::generate_simple_self_signed(vec![cert_host.to_owned()]).unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let server = ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.cert.der().clone()],
            PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
        )
        .unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(cert.cert.der().clone()).unwrap();
    let client = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let h = Harness::with_tls(reply, Arc::new(client)).await;
    let upstream = *h.network.target.lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    *h.network.target.lock().unwrap() = listener.local_addr().unwrap();
    *h.network.answers.lock().unwrap() = vec!["93.184.216.34:443".parse().unwrap()];
    let observed = Arc::new(Observed::default());
    let state = Arc::clone(&observed);
    let tls = TlsAcceptor::from(Arc::new(server));
    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                socket = listener.accept() => {
                    let (socket, _) = socket.unwrap();
                    state.opened.fetch_add(1, Ordering::SeqCst);
                    let tls = tls.clone();
                    let state = Arc::clone(&state);
                    let mode = mode.clone();
                    connections.spawn(async move {
                        let _connection = Connection(Arc::clone(&state));
                        serve(socket, upstream, tls, mode, state).await;
                    });
                }
                result = connections.join_next(), if !connections.is_empty() => { result.unwrap().unwrap(); }
            }
        }
    });
    (h, Gateway { observed, task })
}

async fn serve(
    mut socket: TcpStream,
    upstream: SocketAddr,
    tls: TlsAcceptor,
    mode: Mode,
    observed: Arc<Observed>,
) {
    if matches!(mode, Mode::StallTls) {
        let mut bytes = [0; 4096];
        while socket.read(&mut bytes).await.is_ok_and(|n| n > 0) {
            observed.stalled.store(1, Ordering::SeqCst);
        }
        return;
    }
    let Ok(mut stream) = tls.accept(socket).await else {
        return;
    };
    if let Mode::Response(response) = &mode {
        let mut request = vec![];
        loop {
            let mut byte = [0];
            if stream.read_exact(&mut byte).await.is_err() {
                return;
            }
            request.extend(byte);
            if request.ends_with(b"\r\n\r\n") {
                break;
            }
            assert!(request.len() < 32 * 1024);
        }
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
        return;
    }
    if matches!(mode, Mode::StallUpgrade) {
        let mut bytes = [0; 4096];
        while stream.read(&mut bytes).await.is_ok_and(|n| n > 0) {
            observed.stalled.store(1, Ordering::SeqCst);
        }
        return;
    }
    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(
        stream,
        Upgrade {
            observed: Arc::clone(&observed),
            extension: matches!(mode, Mode::Extension),
        },
    )
    .await
    else {
        return;
    };
    if matches!(mode, Mode::OversizedFragmented) {
        let _ = ws
            .feed(Message::Frame(Frame::message(
                vec![0; 600 * 1024],
                OpCode::Data(Data::Binary),
                false,
            )))
            .await;
        let _ = ws
            .send(Message::Frame(Frame::message(
                vec![0; 600 * 1024],
                OpCode::Data(Data::Continue),
                true,
            )))
            .await;
        while ws.next().await.is_some_and(|result| result.is_ok()) {}
        return;
    }
    if matches!(mode, Mode::Text | Mode::Oversized) {
        let frame = if matches!(mode, Mode::Text) {
            Message::Text("provider-text-canary".into())
        } else {
            Message::Binary(vec![0; 1024 * 1024 + 1].into())
        };
        let _ = ws.send(frame).await;
        while ws.next().await.is_some_and(|result| result.is_ok()) {}
        return;
    }
    let mut upstream = TcpStream::connect(upstream).await.unwrap();
    if ws
        .send(Message::Ping(b"test-ping".to_vec().into()))
        .await
        .is_err()
    {
        return;
    }
    let mut bytes = [0; 8192];
    loop {
        tokio::select! {
            message = ws.next() => match message {
                Some(Ok(Message::Binary(bytes))) => {
                    // cloudflared's origin Conn.Read consumes a whole message but
                    // discards bytes beyond its caller's buffer. Model the observed
                    // 16 KiB read boundary independently of the Runner write limit.
                    let bytes = if matches!(mode, Mode::BoundedOrigin) {
                        &bytes[..bytes.len().min(16 * 1024)]
                    } else {
                        &bytes[..]
                    };
                    if upstream.write_all(bytes).await.is_err() { break; }
                },
                Some(Ok(Message::Pong(bytes))) => { assert_eq!(bytes.as_ref(), b"test-ping"); observed.pongs.fetch_add(1, Ordering::SeqCst); }
                Some(Ok(Message::Ping(_))) => if ws.flush().await.is_err() { break; },
                _ => break,
            },
            read = upstream.read(&mut bytes) => {
                let Ok(n) = read else { break; };
                if n == 0 { let _ = ws.close(None).await; break; }
                if matches!(mode, Mode::Fragmented) {
                    let split = n / 2;
                    if ws.feed(Message::Frame(Frame::message(bytes[..split].to_vec(), OpCode::Data(Data::Binary), false))).await.is_err() { break; }
                    if ws.send(Message::Frame(Frame::message(bytes[split..n].to_vec(), OpCode::Data(Data::Continue), true))).await.is_err() { break; }
                } else if ws.send(Message::Binary(bytes[..n].to_vec().into())).await.is_err() { break; }
            }
        }
    }
}
