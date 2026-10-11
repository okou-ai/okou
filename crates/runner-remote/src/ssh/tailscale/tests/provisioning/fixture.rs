use std::{
    net::SocketAddr,
    os::fd::AsRawFd,
    sync::{Arc, Mutex},
};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::super::super::{
    Failure,
    control_io::LimitedIo,
    provisioning_io::{Dial, Https},
    registration::Tls,
};
use super::super::fixture::bounded;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Phase {
    OAuth,
    Create,
    Delete,
}

pub(super) struct Request {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) body: Vec<u8>,
}

#[derive(Clone)]
pub(super) struct Loopback(pub(super) SocketAddr);
impl Dial for Loopback {
    type Io = tokio::net::TcpStream;
    async fn connect(&self) -> Result<Self::Io, Failure> {
        assert!(self.0.ip().is_loopback());
        tokio::net::TcpStream::connect(self.0)
            .await
            .map_err(|_| Failure::DomainFailed)
    }
}

#[derive(Clone)]
struct FixtureTls(Arc<rustls::ClientConfig>);

impl Tls for FixtureTls {
    async fn connect<Io>(
        &self,
        name: ts_tls_util::ServerName<'static>,
        io: Io,
    ) -> std::io::Result<ts_tls_util::TlsStream<Io>>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        assert_eq!(
            name,
            ts_tls_util::ServerName::try_from("api.tailscale.com").unwrap()
        );
        tokio_rustls::TlsConnector::from(Arc::clone(&self.0))
            .connect(name, io)
            .await
    }
}

#[derive(Clone)]
pub(in crate::ssh) struct Secure {
    address: SocketAddr,
    tls: FixtureTls,
    descriptors: Arc<Mutex<Vec<(i32, std::path::PathBuf)>>>,
}

impl Dial for Secure {
    type Io = ts_tls_util::TlsStream<LimitedIo<tokio::net::TcpStream>>;

    async fn connect(&self) -> Result<Self::Io, Failure> {
        assert!(self.address.ip().is_loopback());
        let io = tokio::net::TcpStream::connect(self.address)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let fd = io.as_raw_fd();
        let inode =
            std::fs::read_link(format!("/proc/self/fd/{fd}")).map_err(|_| Failure::DomainFailed)?;
        self.descriptors.lock().unwrap().push((fd, inode));
        Https::authenticate(io, &self.tls).await
    }
}

impl Secure {
    pub(super) fn assert_closed(&self, count: usize) {
        let descriptors = self.descriptors.lock().unwrap();
        assert_eq!(descriptors.len(), count);
        for (fd, inode) in &*descriptors {
            assert_ne!(
                std::fs::read_link(format!("/proc/self/fd/{fd}"))
                    .ok()
                    .as_ref(),
                Some(inode)
            );
        }
    }
}

pub(super) struct Service {
    pub(super) dial: Loopback,
    pub(super) secure: Option<Secure>,
    requests: Arc<Mutex<Vec<Request>>>,
    events: tokio::sync::mpsc::Receiver<Phase>,
    pub(super) oauth: CancellationToken,
    pub(super) create: CancellationToken,
    pub(super) delete: CancellationToken,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl Service {
    pub(super) async fn new(
        paused: Option<Phase>,
        invalid: Option<Vec<u8>>,
        delete_status: u16,
    ) -> Self {
        Self::configured(paused, invalid, delete_status, None).await
    }

    pub(super) async fn secure(paused: Option<Phase>) -> Self {
        Self::secure_with_delete_status(paused, 200).await
    }

    pub(super) async fn secure_with_delete_status(
        paused: Option<Phase>,
        delete_status: u16,
    ) -> Self {
        let cert = rcgen::generate_simple_self_signed(vec!["api.tailscale.com".into()]).unwrap();
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
        Self::configured(
            paused,
            None,
            delete_status,
            Some((Arc::new(server), FixtureTls(Arc::new(client)))),
        )
        .await
    }

    async fn configured(
        paused: Option<Phase>,
        invalid: Option<Vec<u8>>,
        delete_status: u16,
        tls: Option<(Arc<rustls::ServerConfig>, FixtureTls)>,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (send, events) = tokio::sync::mpsc::channel(16);
        let oauth = CancellationToken::new();
        let create = CancellationToken::new();
        let delete = CancellationToken::new();
        for (phase, gate) in [
            (Phase::OAuth, &oauth),
            (Phase::Create, &create),
            (Phase::Delete, &delete),
        ] {
            if paused != Some(phase) {
                gate.cancel();
            }
        }
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let received = Arc::clone(&requests);
        let gates = [oauth.clone(), create.clone(), delete.clone()];
        let secure = tls.as_ref().map(|(_, client)| Secure {
            address,
            tls: client.clone(),
            descriptors: Arc::new(Mutex::new(Vec::new())),
        });
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! { biased;
                    _ = stopped.cancelled() => break,
                    accepted = listener.accept() => {
                        let socket = accepted.unwrap().0;
                        let received = Arc::clone(&received);
                        let send = send.clone();
                        let gates = gates.clone();
                        let invalid = invalid.clone();
                        let tls = tls.as_ref().map(|(server, _)| Arc::clone(server));
                        connections.spawn(async move {
                            let secure = tls.is_some();
                            let socket: Box<dyn Duplex> = match tls {
                                Some(tls) => Box::new(tokio_rustls::TlsAcceptor::from(tls).accept(socket).await.unwrap()),
                                None => Box::new(socket),
                            };
                            serve(socket, received, send, gates, invalid, delete_status, secure).await;
                        });
                    }
                    result = connections.join_next(), if !connections.is_empty() => { result.unwrap().unwrap(); }
                }
            }
            while let Some(result) = connections.join_next().await {
                result.unwrap();
            }
        });
        Self {
            dial: Loopback(address),
            secure,
            requests,
            events,
            oauth,
            create,
            delete,
            stop,
            task,
        }
    }

    pub(super) async fn next(&mut self, expected: Phase) {
        assert!(bounded(self.events.recv()).await == Some(expected));
    }

    pub(super) fn assert_contract(&self, created: usize, deleted: usize) {
        let requests = self.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.path == "/api/v2/oauth/token")
                .count(),
            created
        );
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.method == "POST" && r.path == "/api/v2/tailnet/-/keys")
                .count(),
            created
        );
        assert_eq!(
            requests.iter().filter(|r| r.method == "DELETE").count(),
            deleted
        );
        for request in &*requests {
            match request.path.as_str() {
                "/api/v2/oauth/token" => {
                    assert_eq!(request.method, "POST");
                    assert_eq!(
                        std::str::from_utf8(&request.body).unwrap(),
                        "grant_type=client_credentials&client_id=synthetic-client&client_secret=synthetic-secret&scope=auth_keys&tags=tag%3Assh"
                    );
                }
                "/api/v2/tailnet/-/keys" => {
                    assert_eq!(request.method, "POST");
                    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                    assert_eq!(
                        body,
                        serde_json::json!({"expirySeconds":86400,"capabilities":{"devices":{"create":{"reusable":false,"ephemeral":true,"preauthorized":true,"tags":["tag:ssh"]}}}})
                    );
                }
                _ => {
                    assert_eq!(request.method, "DELETE");
                    assert_eq!(
                        request.path,
                        "/api/v2/tailnet/-/keys/captured%2F%3Fother%23id"
                    );
                    assert!(request.body.is_empty());
                }
            }
        }
    }

    pub(super) async fn finish(self) {
        self.oauth.cancel();
        self.create.cancel();
        self.delete.cancel();
        self.stop.cancel();
        bounded(self.task).await.unwrap();
    }
}

trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<Io: AsyncRead + AsyncWrite + Unpin + Send> Duplex for Io {}

async fn serve(
    mut socket: Box<dyn Duplex>,
    requests: Arc<Mutex<Vec<Request>>>,
    events: tokio::sync::mpsc::Sender<Phase>,
    gates: [CancellationToken; 3],
    invalid: Option<Vec<u8>>,
    delete_status: u16,
    secure: bool,
) {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        assert!(header.len() < 16384);
        let mut byte = [0];
        if bounded(socket.read(&mut byte)).await.unwrap() == 0 {
            return;
        }
        header.push(byte[0]);
    }
    let header = std::str::from_utf8(&header).unwrap();
    let mut lines = header.split("\r\n");
    let mut first = lines.next().unwrap().split_whitespace();
    let method = first.next().unwrap().to_owned();
    let target = first.next().unwrap();
    let path = target
        .strip_prefix("https://api.tailscale.com")
        .unwrap_or(target)
        .to_owned();
    assert_eq!(first.next().unwrap(), "HTTP/1.1");
    let headers: Vec<_> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim()))
        .collect();
    assert_eq!(
        headers.iter().find(|(k, _)| k == "host").unwrap().1,
        "api.tailscale.com"
    );
    let size = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .map_or(0, |(_, v)| v.parse::<usize>().unwrap());
    assert!(size <= 64 * 1024);
    let mut body = vec![0; size];
    bounded(socket.read_exact(&mut body)).await.unwrap();
    let phase = match (method.as_str(), path.as_str()) {
        ("POST", "/api/v2/oauth/token") => Phase::OAuth,
        ("POST", "/api/v2/tailnet/-/keys") => Phase::Create,
        ("DELETE", "/api/v2/tailnet/-/keys/captured%2F%3Fother%23id") => Phase::Delete,
        _ => panic!("unexpected provider operation"),
    };
    if phase != Phase::OAuth {
        assert_eq!(
            headers
                .iter()
                .find(|(k, _)| k == "authorization")
                .unwrap()
                .1,
            "Bearer synthetic-access-token"
        );
    }
    requests
        .lock()
        .unwrap()
        .push(Request { method, path, body });
    // Receiving the complete create is the external provider effect; its reply
    // can be withheld after accepting it to exercise an unknown-ID outcome.
    events.send(phase).await.unwrap();
    let index = match phase {
        Phase::OAuth => 0,
        Phase::Create => 1,
        Phase::Delete => 2,
    };
    gates[index].cancelled().await;
    let body = match phase {
        Phase::OAuth => br#"{"access_token":"synthetic-access-token","token_type":"Bearer","expires_in":3600,"scope":"auth_keys"}"#.to_vec(),
        Phase::Create => invalid.unwrap_or_else(key_response),
        Phase::Delete => Vec::new(),
    };
    let status = if phase == Phase::Delete {
        delete_status
    } else {
        200
    };
    let response = format!(
        "HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    let wrote = socket.write_all(response.as_bytes()).await;
    if wrote.is_ok() {
        let _ = socket.write_all(&body).await;
    }
    // Even failed/cancelled requests must physically close the real client FD.
    let mut byte = [0];
    match bounded(socket.read(&mut byte)).await {
        Ok(0) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ) || (secure && error.kind() == std::io::ErrorKind::UnexpectedEof) => {}
        other => panic!("provider socket did not close: {other:?}"),
    }
}

pub(super) fn key_response() -> Vec<u8> {
    let created = chrono::Utc::now();
    serde_json::to_vec(&serde_json::json!({
        "id":"captured/?other#id", "key":"tskey-auth-synthetic-one-use",
        "created":created.to_rfc3339(), "expires":(created+chrono::Duration::days(1)).to_rfc3339(),
        "capabilities":{"devices":{"create":{"reusable":false,"ephemeral":true,"preauthorized":true,"tags":["tag:ssh"]}}}
    })).unwrap()
}
