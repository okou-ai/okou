//! Independent TLS/WSS peer and server-local TLS-to-loopback origin wrapper.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rustls::{ClientConfig, RootCertStore, ServerConfig, pki_types::PrivatePkcs8KeyDer};
use std::{
    net::SocketAddr,
    sync::{
        Arc,
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
};

pub(crate) const HOST: &str = "access.example.test";
pub(crate) const ORIGIN: &str = "mac.example.test";

struct Upgrade;
impl Callback for Upgrade {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        assert_eq!(request.headers()["host"], HOST);
        assert_eq!(request.headers()["cf-access-client-id"], "private-client");
        assert_eq!(
            request.headers()["cf-access-client-secret"],
            "private-secret"
        );
        assert_eq!(request.uri().path(), "/");
        Ok(response)
    }
}

pub(crate) struct Gateway {
    pub(crate) address: SocketAddr,
    pub(crate) tls: Arc<ClientConfig>,
    pub(crate) ca: String,
    pub(crate) applications: Arc<AtomicUsize>,
    pub(crate) upgraded: Arc<tokio::sync::Notify>,
    pub(crate) received: Arc<tokio::sync::Notify>,
    pub(crate) origin_gate: Arc<tokio::sync::Semaphore>,
    task: JoinHandle<()>,
}

fn certificate(name: &str, expired: bool) -> (Arc<ServerConfig>, Arc<ClientConfig>, String) {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::new(vec![name.to_owned()]).unwrap();
    if expired {
        params.not_before = rcgen::date_time_ymd(2010, 1, 1);
        params.not_after = rcgen::date_time_ymd(2011, 1, 1);
    }
    let cert = params.self_signed(&key).unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let server = ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
        )
        .unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(cert.der().clone()).unwrap();
    let client = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let ca = format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        base64::engine::general_purpose::STANDARD.encode(cert.der())
    );
    (Arc::new(server), Arc::new(client), ca)
}

impl Gateway {
    pub(crate) async fn new(
        target: SocketAddr,
        origin: bool,
        expired: bool,
        gateway_name: &str,
    ) -> Self {
        assert!(
            target.ip().is_loopback(),
            "origin wrapper forwards only to its local VNC socket"
        );
        let (server, tls, _) = certificate(gateway_name, false);
        let (inner, _, ca) = certificate(ORIGIN, expired);
        let inner = origin.then(|| TlsAcceptor::from(inner));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let acceptor = TlsAcceptor::from(server);
        let applications = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&applications);
        let upgraded = Arc::new(tokio::sync::Notify::new());
        let announced = Arc::clone(&upgraded);
        let received = Arc::new(tokio::sync::Notify::new());
        let receipt = Arc::clone(&received);
        let origin_gate = Arc::new(tokio::sync::Semaphore::new(1));
        let gate = Arc::clone(&origin_gate);
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    socket = listener.accept() => {
                        let (socket, _) = socket.unwrap();
                        let acceptor = acceptor.clone();
                        let inner = inner.clone();
                        let observed = Arc::clone(&observed);
                        let announced = Arc::clone(&announced);
                        let receipt = Arc::clone(&receipt);
                        let gate = Arc::clone(&gate);
                        tasks.spawn(async move {
                            let Ok(tls) = acceptor.accept(socket).await else { return; };
                            let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tls, Upgrade).await else { return; };
                            announced.notify_one();
                            let (mut bridge, bytes) = tokio::io::duplex(64 * 1024);
                            let pump = async {
                                let mut buffer = [0; 8192];
                                loop {
                                    tokio::select! {
                                        message = ws.next() => match message {
                                            Some(Ok(Message::Binary(bytes))) => {
                                                receipt.notify_one();
                                                if bridge.write_all(&bytes).await.is_err() { break; }
                                            },
                                            Some(Ok(Message::Ping(_))) => { if ws.flush().await.is_err() { break; } },
                                            _ => break,
                                        },
                                        read = bridge.read(&mut buffer) => {
                                            let Ok(count) = read else { break; };
                                            if count == 0 { break; }
                                            if ws.send(Message::Binary(buffer[..count].to_vec().into())).await.is_err() { break; }
                                        }
                                    }
                                }
                            };
                            let application = async {
                                let mut stream: Box<dyn crate::cloudflare::ByteIo> = match inner {
                                    Some(inner) => {
                                        let accepted = {
                                            let _permit = gate.acquire().await.unwrap();
                                            inner.accept(bytes).await
                                        };
                                        match accepted { Ok(tls) => Box::new(tls), Err(_) => return }
                                    },
                                    None => Box::new(bytes),
                                };
                                observed.fetch_add(1, Ordering::SeqCst);
                                let mut vnc = TcpStream::connect(target).await.unwrap();
                                let _ = tokio::io::copy_bidirectional(&mut stream, &mut vnc).await;
                            };
                            tokio::select! { _ = pump => {}, _ = application => {} }
                        });
                    }
                    result = tasks.join_next(), if !tasks.is_empty() => { result.unwrap().unwrap(); }
                }
            }
        });
        Self {
            address,
            tls,
            ca,
            applications,
            upgraded,
            received,
            origin_gate,
            task,
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}
