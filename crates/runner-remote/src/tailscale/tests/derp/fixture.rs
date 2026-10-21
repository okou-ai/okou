//! Synthetic external DERP service and controlled actual OS IO. SDK source is unchanged.
use crate::tailscale::Failure;
use crypto_box::{
    SalsaBox, SecretKey,
    aead::{Aead, AeadCore, OsRng},
};
use futures_util::StreamExt;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use tokio::sync::oneshot;
use tokio_util::codec::{Encoder, Framed};
use tracing::instrument::WithSubscriber;
use ts_derp::{
    Client,
    frame::{self, RawFrame},
};
use ts_http_util::{Client as _, EmptyBody, Upgraded};
use ts_keys::{DerpServerPublicKey, NodeKeyPair, NodePublicKey};

use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::Notify,
};

mod tests;

struct State {
    remaining: usize,
    pending: bool,
    waker: Option<Waker>,
    destroyed: bool,
    observed_read_bytes: Option<usize>,
    read_pending: bool,
}

pub(in crate::tailscale::tests) struct WriteGate {
    state: Mutex<State>,
    changed: Notify,
}

impl WriteGate {
    pub(in crate::tailscale::tests) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                remaining: usize::MAX,
                pending: false,
                waker: None,
                destroyed: false,
                observed_read_bytes: None,
                read_pending: false,
            }),
            changed: Notify::new(),
        })
    }

    pub(in crate::tailscale::tests) fn pause_after(&self, bytes: usize) {
        let mut state = self.state.lock().unwrap();
        assert!(!state.pending && !state.destroyed);
        state.remaining = bytes;
    }

    pub(in crate::tailscale::tests) async fn pending(&self) {
        loop {
            let changed = self.changed.notified();
            if self.state.lock().unwrap().pending {
                return;
            }
            changed.await;
        }
    }

    pub(super) fn observe_read(&self) {
        let mut state = self.state.lock().unwrap();
        state.observed_read_bytes = Some(0);
        state.read_pending = false;
    }

    pub(super) async fn partial_read_pending(&self, expected: usize) {
        loop {
            let changed = self.changed.notified();
            let complete = {
                let state = self.state.lock().unwrap();
                state.read_pending && state.observed_read_bytes == Some(expected)
            };
            if complete {
                return;
            }
            changed.await;
        }
    }

    pub(in crate::tailscale::tests) async fn destroyed(&self) {
        loop {
            let changed = self.changed.notified();
            if self.state.lock().unwrap().destroyed {
                return;
            }
            changed.await;
        }
    }
}

pub(crate) struct PausedTcp<Io = TcpStream> {
    socket: Io,
    gate: Arc<WriteGate>,
}

impl<Io> PausedTcp<Io> {
    pub(in crate::tailscale::tests) fn new(socket: Io, gate: Arc<WriteGate>) -> Self {
        Self { socket, gate }
    }
}

impl<Io: AsyncRead + Unpin> AsyncRead for PausedTcp<Io> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.socket).poll_read(cx, buf);
        let mut state = self.gate.state.lock().unwrap();
        if let Some(count) = &mut state.observed_read_bytes {
            *count += buf.filled().len() - before;
            state.read_pending = result.is_pending();
            self.gate.changed.notify_waiters();
        }
        result
    }
}

impl<Io: AsyncWrite + Unpin> AsyncWrite for PausedTcp<Io> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        // Keep the nonblocking write and its accounting atomic with pause_after,
        // so an in-flight write cannot consume a newly installed budget.
        let mut state = this.gate.state.lock().unwrap();
        if state.remaining == 0 {
            state.pending = true;
            state.waker = Some(cx.waker().clone());
            this.gate.changed.notify_waiters();
            return Poll::Pending;
        }
        let allowed = state.remaining.min(bytes.len());
        let result = Pin::new(&mut this.socket).poll_write(cx, &bytes[..allowed]);
        if let Poll::Ready(Ok(written)) = result
            && state.remaining != usize::MAX
        {
            state.remaining -= written;
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

impl<Io> Drop for PausedTcp<Io> {
    fn drop(&mut self) {
        // Preserve the original failure and poison; cleanup must not panic again.
        self.gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .destroyed = true;
        self.gate.changed.notify_waiters();
    }
}

async fn upgraded_server(
    listener: TcpListener,
    tls: Option<Arc<rustls::ServerConfig>>,
) -> Upgraded {
    loop {
        let (socket, _) = listener.accept().await.unwrap();
        if let Some(tls) = &tls {
            match tokio_rustls::TlsAcceptor::from(Arc::clone(tls))
                .accept(socket)
                .await
            {
                Ok(socket) => return upgraded_io(socket).await,
                // An abandoned unauthenticated connection must not consume
                // the listener intended for the genuine DERP session.
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => continue,
                Err(error) => panic!("DERP TLS handshake failed: {error:?}"),
            }
        } else {
            return upgraded_io(socket).await;
        }
    }
}

async fn upgraded_io<Io>(socket: Io) -> Upgraded
where
    Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let service = service_fn(move |mut request: hyper::Request<hyper::body::Incoming>| {
        assert_eq!(request.uri().path(), "/derp");
        assert_eq!(request.headers()["upgrade"], "DERP");
        tx.lock()
            .unwrap()
            .take()
            .unwrap()
            .send(hyper::upgrade::on(&mut request))
            .unwrap();
        async {
            Ok::<_, Infallible>(
                hyper::Response::builder()
                    .status(101)
                    .header("connection", "upgrade")
                    .header("upgrade", "DERP")
                    .body(http_body_util::Empty::<bytes::Bytes>::new())
                    .unwrap(),
            )
        }
    });
    let connection = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(socket), service)
        .with_upgrades();
    // Both are required: HTTP driver completion can occur in the same poll as the
    // service sending OnUpgrade. A racing select cannot classify that as failure.
    let (finished, upgrading) = tokio::join!(connection, rx);
    finished.unwrap();
    TokioIo::new(upgrading.unwrap().await.unwrap())
}

async fn server_handshake(io: Upgraded) -> (Framed<Upgraded, frame::Codec>, NodePublicKey) {
    let mut frames = Framed::new(io, frame::Codec);
    let secret = SecretKey::generate(&mut OsRng);
    let server_key = frame::ServerKey {
        magic: frame::Magic::MAGIC,
        key: DerpServerPublicKey::from_bytes(*secret.public_key().as_bytes()),
    };
    let mut encoded = bytes::BytesMut::new();
    frame::Codec
        .encode(RawFrame::from_body(&server_key, 0).unwrap(), &mut encoded)
        .unwrap();
    frames.get_mut().write_all(&encoded).await.unwrap();
    let info = frames.next().await.unwrap().unwrap();
    let (client, payload) = info.get().as_type::<frame::ClientInfo>().unwrap();
    let key = client.key;
    let cipher = SalsaBox::new(&key.to_crypto_box(), &secret);
    let decoded = cipher.decrypt(&client.nonce.into(), payload).unwrap();
    let decoded: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(
        decoded["version"].as_u64().unwrap() as usize,
        frame::PROTOCOL_VERSION
    );
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let payload =
        serde_json::to_vec(&serde_json::json!({"version": frame::PROTOCOL_VERSION})).unwrap();
    let encrypted = cipher.encrypt(&nonce, payload.as_slice()).unwrap();
    let server_info = frame::ServerInfo {
        nonce: nonce.into(),
    };
    encoded.clear();
    frame::Codec
        .encode(
            (
                RawFrame::from_body(&server_info, encrypted.len()).unwrap(),
                encrypted.as_slice(),
            ),
            &mut encoded,
        )
        .unwrap();
    frames.get_mut().write_all(&encoded).await.unwrap();
    (frames, key)
}

pub(in crate::tailscale::tests) struct Server {
    pub(in crate::tailscale::tests) address: std::net::SocketAddr,
    pub(in crate::tailscale::tests) task:
        tokio::task::JoinHandle<(Framed<Upgraded, frame::Codec>, NodePublicKey)>,
    pub(in crate::tailscale::tests) tls: Option<Arc<rustls::ClientConfig>>,
}
impl Server {
    pub(in crate::tailscale::tests) async fn new() -> Self {
        Self::configured(None, None).await
    }

    /// Only this external service fixture trusts its synthetic authority.
    /// Actual certificate/name verification stays enabled; SDK roots stay unchanged.
    pub(in crate::tailscale::tests) async fn secure() -> Self {
        let cert =
            rcgen::generate_simple_self_signed(vec!["derp.synthetic.invalid".into()]).unwrap();
        let crypto = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let server = rustls::ServerConfig::builder_with_provider(Arc::clone(&crypto))
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
        Self::configured(Some(Arc::new(server)), Some(Arc::new(client))).await
    }

    async fn configured(
        server: Option<Arc<rustls::ServerConfig>>,
        tls: Option<Arc<rustls::ClientConfig>>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(
            async move {
                let io = upgraded_server(listener, server).await;
                server_handshake(io).await
            }
            .with_subscriber(tracing::Dispatch::none()),
        );
        Self { address, task, tls }
    }
}
pub(super) async fn connect(
    address: std::net::SocketAddr,
    gate: Arc<WriteGate>,
    key: &NodeKeyPair,
) -> Result<Client<Upgraded>, Failure> {
    let socket = TcpStream::connect(address)
        .await
        .map_err(|_| Failure::DomainFailed)?;
    socket
        .set_nodelay(true)
        .map_err(|_| Failure::DomainFailed)?;
    let upgraded = upgrade(address, PausedTcp::new(socket, gate)).await?;
    Client::handshake(upgraded, key)
        .await
        .map_err(|_| Failure::DomainFailed)
}

pub(in crate::tailscale::tests) async fn upgrade<Io>(
    address: std::net::SocketAddr,
    io: Io,
) -> Result<Upgraded, Failure>
where
    Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let http = ts_http_util::http1::connect::<EmptyBody>(io)
        .await
        .map_err(|_| Failure::DomainFailed)?;
    let mut url = ts_control::DEFAULT_CONTROL_SERVER
        .join("derp")
        .map_err(|_| Failure::DomainFailed)?;
    url.set_scheme("http").map_err(|_| Failure::DomainFailed)?;
    url.set_host(Some("127.0.0.1"))
        .map_err(|_| Failure::DomainFailed)?;
    url.set_port(Some(address.port()))
        .map_err(|_| Failure::DomainFailed)?;
    let request =
        ts_http_util::make_upgrade_req(&url, "DERP", None).map_err(|_| Failure::DomainFailed)?;
    let response = http
        .send(request)
        .await
        .map_err(|_| Failure::DomainFailed)?;
    let upgraded = ts_http_util::do_upgrade(response)
        .await
        .map_err(|_| Failure::DomainFailed)?;
    drop(http);
    Ok(upgraded)
}
