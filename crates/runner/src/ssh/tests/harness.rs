use async_trait::async_trait;
mod process;
use httpmock::{Mock, MockServer};
use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey, PublicKey},
    server,
};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    io,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, mpsc},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

use super::super::{SshRun, SshRuntime, network::Network};
use crate::{
    http::{HttpClient, HttpClientConfig},
    ids::RunId,
    runner_process_identity::RunnerProcessIdentity,
};

pub(super) const CONNECTION: &str = "9f0128ce-dd11-4234-b1ac-a0c33353a112";
pub(super) const TOKEN: &str = "vm0_official_test-only";

#[derive(Clone)]
pub(super) enum Reply {
    Exit {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
        fragment: usize,
        code: Option<u32>,
        signal: Option<russh::Sig>,
    },
    Reject,
    Disconnect,
    Hold,
    Process,
    BlockedInput,
}
impl Default for Reply {
    fn default() -> Self {
        Self::Exit {
            stdout: b"hello\0\xff".to_vec(),
            stderr: b"warning\n".to_vec(),
            fragment: 16384,
            code: Some(7),
            signal: None,
        }
    }
}

#[derive(Default)]
pub(super) struct Observed {
    pub(super) auth: AtomicUsize,
    pub(super) commands: Mutex<Vec<Vec<u8>>>,
    pub(super) attempts: Mutex<Vec<SocketAddr>>,
    pub(super) queries: Mutex<Vec<(String, u16)>>,
    pub(super) resolved: AtomicUsize,
    pub(super) reservations: AtomicUsize,
    pub(super) ptys: AtomicUsize,
    pub(super) signals: AtomicUsize,
    pub(super) closed: AtomicUsize,
    pub(super) reject_reused_channels: AtomicBool,
    pub(super) input: Mutex<Vec<u8>>,
}

pub(super) struct TestNetwork {
    pub(super) target: Mutex<SocketAddr>,
    pub(super) answers: Mutex<Vec<SocketAddr>>,
    pub(super) observed: Arc<Observed>,
    pub(super) resolve_gate: Mutex<Option<Arc<Semaphore>>>,
}
#[async_trait]
impl Network for TestNetwork {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        self.observed
            .queries
            .lock()
            .unwrap()
            .push((host.to_owned(), port));
        let gate = self.resolve_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            let _permit = gate.acquire().await.unwrap();
        }
        let answers = self.answers.lock().unwrap().clone();
        self.observed.resolved.fetch_add(1, Ordering::SeqCst);
        Ok(answers)
    }
    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream> {
        self.observed.attempts.lock().unwrap().push(address);
        let target = *self.target.lock().unwrap();
        TcpStream::connect(target).await
    }
}

struct Acceptor(tokio::sync::Mutex<mpsc::Receiver<sandbox::AcceptedGuestRpc>>);
#[async_trait]
impl sandbox::GuestRpcAcceptor for Acceptor {
    async fn accept(&self) -> io::Result<sandbox::AcceptedGuestRpc> {
        self.0
            .lock()
            .await
            .recv()
            .await
            .ok_or_else(|| io::Error::other("test acceptor closed"))
    }
}

struct ReservedStream {
    stream: DuplexStream,
    observed: Arc<Observed>,
    _reservation: guest_control_client::ExternalOperationReservation,
}
impl Drop for ReservedStream {
    fn drop(&mut self) {
        self.observed.reservations.fetch_sub(1, Ordering::SeqCst);
    }
}
impl sandbox::GuestRpcStream for ReservedStream {}
impl tokio::io::AsyncRead for ReservedStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}
impl tokio::io::AsyncWrite for ReservedStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().stream).poll_write(cx, bytes)
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

pub(super) struct Harness {
    pub(super) api: MockServer,
    pub(super) runtime: Arc<SshRuntime>,
    pub(super) network: Arc<TestNetwork>,
    pub(super) observed: Arc<Observed>,
    pub(super) key: PrivateKey,
    pub(super) host_key: PrivateKey,
    pub(super) run: RunId,
    pub(super) identity: RunnerProcessIdentity,
    pub(super) cancel: CancellationToken,
    pub(super) lifecycle: CancellationToken,
    pub(super) control: guest_control_client::GuestControlClient,
    _control_peer: tokio::net::UnixStream,
    dispatcher: Option<SshRun>,
    incoming: mpsc::Sender<sandbox::AcceptedGuestRpc>,
    peer: JoinHandle<()>,
}

pub(super) struct AdditionalRun {
    sandbox: String,
    control: guest_control_client::GuestControlClient,
    _control_peer: tokio::net::UnixStream,
    observed: Arc<Observed>,
    lifecycle: CancellationToken,
    incoming: mpsc::Sender<sandbox::AcceptedGuestRpc>,
    dispatcher: SshRun,
}

impl AdditionalRun {
    pub(super) async fn new(runtime: &Arc<SshRuntime>, sandbox: &str) -> Self {
        let (control, control_peer) = control_connection().await;
        let (incoming, receiver) = mpsc::channel(32);
        let dispatcher = runtime.start(
            Arc::new(Acceptor(tokio::sync::Mutex::new(receiver))),
            sandbox.into(),
            RunId::new_v4(),
            &CancellationToken::new(),
        );
        Self {
            sandbox: sandbox.into(),
            control,
            _control_peer: control_peer,
            observed: Arc::new(Observed::default()),
            lifecycle: CancellationToken::new(),
            incoming,
            dispatcher,
        }
    }

    pub(super) async fn open(&self) -> DuplexStream {
        open_rpc(
            &self.incoming,
            &self.sandbox,
            &self.control,
            &self.observed,
            &self.lifecycle,
        )
        .await
    }

    pub(super) async fn shutdown(self) {
        self.dispatcher.shutdown().await;
    }
}

impl Harness {
    pub(super) async fn new(reply: Reply) -> Self {
        Self::with_keys(reply, key(Algorithm::Ed25519), key(Algorithm::Ed25519)).await
    }
    pub(super) async fn with_keys(reply: Reply, key: PrivateKey, host_key: PrivateKey) -> Self {
        Self::with_api(reply, key, host_key, None).await
    }
    pub(super) async fn with_api(
        reply: Reply,
        key: PrivateKey,
        host_key: PrivateKey,
        api_url: Option<String>,
    ) -> Self {
        let api = MockServer::start_async().await;
        let (control, control_peer) = control_connection().await;
        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 27).unwrap();
        let run = RunId::new_v4();
        let http = HttpClient::new(HttpClientConfig {
            api_url: api_url.unwrap_or_else(|| api.base_url()),
            vercel_bypass: None,
            client_session_id: "ssh-integration".into(),
        })
        .unwrap();
        let observed = Arc::new(Observed::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = listener.local_addr().unwrap();
        let network = Arc::new(TestNetwork {
            target: Mutex::new(target),
            answers: Mutex::new(vec!["93.184.216.34:22".parse().unwrap()]),
            observed: Arc::clone(&observed),
            resolve_gate: Mutex::new(None),
        });
        let mut runtime = SshRuntime::official(http, TOKEN, identity)
            .unwrap()
            .unwrap();
        Arc::get_mut(&mut runtime).unwrap().network = network.clone();
        let (incoming, receiver) = mpsc::channel(32);
        let cancel = CancellationToken::new();
        let lifecycle = CancellationToken::new();
        let dispatcher = runtime.start(
            Arc::new(Acceptor(tokio::sync::Mutex::new(receiver))),
            "sandbox-authoritative".into(),
            run,
            &cancel,
        );
        let peer_key = key.public_key().clone();
        let config = Arc::new(server::Config {
            keys: vec![host_key.clone()],
            // Use a supported hardware-accelerated cipher so fragmented-output
            // tests measure dispatch and framing, not debug-build ChaCha loops.
            preferred: russh::Preferred {
                cipher: Cow::Borrowed(&[russh::cipher::AES_128_GCM]),
                ..russh::Preferred::default()
            },
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            limits: if matches!(reply, Reply::Process) {
                // Traffic after a quiet period forces another key exchange,
                // including after the initial setup deadline in the long-task test.
                russh::Limits {
                    rekey_time_limit: Duration::from_secs(1),
                    ..russh::Limits::default()
                }
            } else {
                russh::Limits::default()
            },
            window_size: if matches!(reply, Reply::BlockedInput) {
                1
            } else {
                server::Config::default().window_size
            },
            ..server::Config::default()
        });
        let peer_observed = Arc::clone(&observed);
        let peer = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break; };
                        let config = Arc::clone(&config);
                        let handler = Peer { key: peer_key.clone(), observed: Arc::clone(&peer_observed), reply: reply.clone(), output: None, process: None, pty: false, opened: false };
                        sessions.spawn(async move { if let Ok(session) = server::run_stream(config, socket, handler).await { let _ = session.await; } });
                    }
                    _ = sessions.join_next(), if !sessions.is_empty() => (),
                }
            }
        });
        Self {
            api,
            runtime,
            network,
            observed,
            key,
            host_key,
            run,
            identity,
            cancel,
            lifecycle,
            control,
            _control_peer: control_peer,
            dispatcher: Some(dispatcher),
            incoming,
            peer,
        }
    }

    pub(super) fn credential(&self, pinned: bool) -> Value {
        json!({ "outcome": "resolved", "host": "ssh.example.com", "port": 22, "username": "test-user", "generation": 7,
            "learnedHostKey": pinned.then(|| json!({ "algorithm": self.host_key.algorithm().as_str(), "fingerprint": self.host_key.fingerprint(HashAlg::Sha256).to_string() })),
            "privateKey": self.key.to_openssh(russh::keys::ssh_key::LineEnding::LF).unwrap().as_str(), "passphrase": null })
    }

    pub(super) async fn resolve(&self, body: Value) -> Mock<'_> {
        self.api.mock_async(|when, then| {
            when.method("POST").path(format!("/api/runners/runs/{}/ssh/resolve", self.run))
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({"connectionId": CONNECTION, "runnerIdentity": {"runnerId": self.identity.runner_id(), "heartbeatGeneration": self.identity.heartbeat_generation()}}));
            then.status(200).json_body(body);
        }).await
    }

    pub(super) async fn request(&self, params: Value) -> Vec<Value> {
        self.raw(
            json!({"version":1,"method":"ssh.exec","remaining_ms":60000,"params":params})
                .to_string(),
        )
        .await
    }
    pub(super) async fn raw(&self, json: String) -> Vec<Value> {
        request_frames(self.open().await, json).await
    }
    pub(super) async fn open(&self) -> DuplexStream {
        open_rpc(
            &self.incoming,
            "sandbox-authoritative",
            &self.control,
            &self.observed,
            &self.lifecycle,
        )
        .await
    }
    pub(super) async fn shutdown(&mut self) {
        if let Some(dispatcher) = self.dispatcher.take() {
            dispatcher.shutdown().await;
        }
    }

    pub(super) async fn expire_idle(&self) {
        let closed = self.observed.closed.load(Ordering::SeqCst);
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::time::resume();
        super::wait_for(|| self.observed.closed.load(Ordering::SeqCst) > closed).await;
    }

    pub(super) fn take_dispatcher(&mut self) -> SshRun {
        self.dispatcher.take().unwrap()
    }

    pub(super) async fn restart(&mut self, run: RunId) {
        self.shutdown().await;
        self.run = run;
        let (incoming, receiver) = mpsc::channel(32);
        self.incoming = incoming;
        self.dispatcher = Some(self.runtime.start(
            Arc::new(Acceptor(tokio::sync::Mutex::new(receiver))),
            "sandbox-authoritative".into(),
            run,
            &self.cancel,
        ));
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.peer.abort();
    }
}

async fn open_rpc(
    incoming: &mpsc::Sender<sandbox::AcceptedGuestRpc>,
    sandbox: &str,
    control: &guest_control_client::GuestControlClient,
    observed: &Arc<Observed>,
    lifecycle: &CancellationToken,
) -> DuplexStream {
    let (guest, stream) = tokio::io::duplex(64 * 1024);
    observed.reservations.fetch_add(1, Ordering::SeqCst);
    incoming
        .send(sandbox::AcceptedGuestRpc {
            sandbox_id: sandbox.into(),
            stream: Box::new(ReservedStream {
                stream,
                observed: Arc::clone(observed),
                _reservation: control.reserve_external_operation().unwrap(),
            }),
            cancelled: lifecycle.clone(),
        })
        .await
        .unwrap();
    guest
}

async fn control_connection() -> (
    guest_control_client::GuestControlClient,
    tokio::net::UnixStream,
) {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("control");
    let path = format!("{}_{}", base.display(), guest_control_proto::VSOCK_PORT);
    let host = guest_control_client::GuestControlClient::wait_for_connection(
        base.to_str().unwrap(),
        Duration::from_secs(5),
    );
    let peer = async {
        let mut peer = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match tokio::net::UnixStream::connect(&path).await {
                    Ok(peer) => break peer,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        tokio::time::sleep(Duration::from_millis(1)).await
                    }
                    Err(error) => panic!("control connection failed: {error}"),
                }
            }
        })
        .await
        .unwrap();
        peer.write_all(
            &guest_control_proto::encode(guest_control_proto::MSG_READY, 0, &[]).unwrap(),
        )
        .await
        .unwrap();
        let mut decoder = guest_control_proto::Decoder::new();
        let mut bytes = [0; 1024];
        loop {
            let count = peer.read(&mut bytes).await.unwrap();
            assert_ne!(count, 0);
            if let Some(ping) = decoder
                .decode(&bytes[..count])
                .unwrap()
                .into_iter()
                .find(|message| message.msg_type == guest_control_proto::MSG_PING)
            {
                peer.write_all(
                    &guest_control_proto::encode(guest_control_proto::MSG_PONG, ping.seq, &[])
                        .unwrap(),
                )
                .await
                .unwrap();
                break;
            }
        }
        peer
    };
    let (host, peer) = tokio::join!(biased; host, peer);
    (host.unwrap(), peer)
}

pub(super) fn key(algorithm: Algorithm) -> PrivateKey {
    PrivateKey::random(&mut russh::keys::key::safe_rng(), algorithm).unwrap()
}

pub(super) async fn read_http_request(socket: &mut TcpStream) {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        header.push(socket.read_u8().await.unwrap());
        assert!(header.len() < 8192);
    }
    let header = String::from_utf8(header).unwrap();
    let length: usize = header
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .unwrap()
        .1
        .trim()
        .parse()
        .unwrap();
    assert!(length < 8192);
    socket.read_exact(&mut vec![0; length]).await.unwrap();
}

pub(super) async fn respond(socket: &mut TcpStream, body: Value) -> io::Result<()> {
    let body = body.to_string();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await?;
    socket.shutdown().await
}
pub(super) fn params() -> Value {
    json!({"sshConnectionId":CONNECTION,"command":"printf test-command"})
}
pub(super) async fn request_frames(mut guest: DuplexStream, json: String) -> Vec<Value> {
    guest.write_u32(json.len() as u32).await.unwrap();
    guest.write_all(json.as_bytes()).await.unwrap();
    guest.shutdown().await.unwrap();
    frames(guest).await
}
pub(super) async fn frames(mut guest: DuplexStream) -> Vec<Value> {
    let read = async {
        let mut frames = Vec::new();
        let mut bytes = 0;
        loop {
            let mut header = [0; 4];
            let first = guest.read(&mut header[..1]).await.unwrap();
            if first == 0 {
                break;
            }
            guest.read_exact(&mut header[1..]).await.unwrap();
            let length = u32::from_be_bytes(header) as usize;
            assert!(length <= runner_rpc_proto::MAX_RESPONSE_BYTES);
            bytes += length + 4;
            assert!(bytes <= runner_rpc_proto::MAX_RESPONSE_STREAM_BYTES);
            let mut body = vec![0; length];
            guest.read_exact(&mut body).await.unwrap();
            frames.push(serde_json::from_slice(&body).unwrap());
        }
        frames
    };
    tokio::time::timeout(Duration::from_secs(62), read)
        .await
        .unwrap()
}

pub(super) const PASSWORD: &str = " password-😀-canary \n";
pub(super) const PARTIAL_PASSWORD: &str = "partial-password-canary";

struct Peer {
    key: PublicKey,
    observed: Arc<Observed>,
    reply: Reply,
    output: Option<Outgoing>,
    process: Option<process::Process>,
    pty: bool,
    opened: bool,
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.observed.closed.fetch_add(1, Ordering::SeqCst);
    }
}

struct Outgoing {
    stdout: bytes::Bytes,
    stderr: bytes::Bytes,
    fragment: usize,
    code: Option<u32>,
    signal: Option<russh::Sig>,
}

impl Peer {
    fn send_output(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), russh::Error> {
        let Some(output) = &mut self.output else {
            return Ok(());
        };
        // Fill only the granted SSH window, then resume on WINDOW_ADJUST.
        // Direct session writes preserve every one-byte SSH packet without
        // allocating a Vec and scheduling an extra task per fixture byte.
        while !session.has_pending_data(channel) {
            if !output.stdout.is_empty() {
                let count = output.fragment.min(output.stdout.len());
                session.data(channel, output.stdout.split_to(count))?;
            } else if !output.stderr.is_empty() {
                let count = output.fragment.min(output.stderr.len());
                session.extended_data(channel, 1, output.stderr.split_to(count))?;
            } else {
                if let Some(code) = output.code {
                    session.exit_status_request(channel, code)?;
                }
                if let Some(signal) = output.signal.take() {
                    session.exit_signal_request(
                        channel,
                        signal,
                        false,
                        "peer diagnostic must not escape",
                        "en",
                    )?;
                }
                session.eof(channel)?;
                session.close(channel)?;
                self.output = None;
                break;
            }
        }
        Ok(())
    }
}
impl server::Handler for Peer {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.observed.auth.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "test-user" && password == PASSWORD {
            server::Auth::Accept
        } else {
            server::Auth::Reject {
                proceed_with_methods: None,
                partial_success: password == PARTIAL_PASSWORD,
            }
        })
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        self.observed.auth.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "test-user" && key == &self.key {
            server::Auth::Accept
        } else {
            server::Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            }
        })
    }
    async fn channel_open_session(
        &mut self,
        _channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.opened && self.observed.reject_reused_channels.load(Ordering::SeqCst) {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        self.opened = true;
        // A reused transport starts a distinct channel with no inherited process or PTY state.
        self.process = None;
        self.output = None;
        self.pty = false;
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.observed
            .commands
            .lock()
            .unwrap()
            .push(command.to_vec());
        match &self.reply {
            Reply::Process => {
                session.channel_success(channel)?;
                self.process = Some(process::Process::start(
                    Some(command),
                    self.pty,
                    channel,
                    session.handle(),
                ));
            }
            Reply::Reject => {
                session.channel_failure(channel)?;
            }
            Reply::Disconnect => return Err(russh::Error::Disconnect),
            Reply::Hold | Reply::BlockedInput => {
                session.channel_success(channel)?;
            }
            Reply::Exit {
                stdout,
                stderr,
                fragment,
                code,
                signal,
            } => {
                session.channel_success(channel)?;
                self.output = Some(Outgoing {
                    stdout: stdout.clone().into(),
                    stderr: stderr.clone().into(),
                    fragment: *fragment,
                    code: *code,
                    signal: signal.clone(),
                });
                self.send_output(channel, session)?;
            }
        }
        Ok(())
    }

    async fn window_adjusted(
        &mut self,
        channel: ChannelId,
        _new_size: u32,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.send_output(channel, session)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if matches!(self.reply, Reply::Process) {
            session.channel_success(channel)?;
            self.process = Some(process::Process::start(
                None,
                self.pty,
                channel,
                session.handle(),
            ));
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        columns: u32,
        rows: u32,
        _pixels_x: u32,
        _pixels_y: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if matches!(self.reply, Reply::Process) {
            assert_eq!((term, columns, rows), ("xterm-256color", 80, 24));
            self.observed.ptys.fetch_add(1, Ordering::SeqCst);
            self.pty = true;
            session.channel_success(channel)?;
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        bytes: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.observed.input.lock().unwrap().extend_from_slice(bytes);
        if matches!(self.reply, Reply::BlockedInput) {
            // A one-byte receive window remains exhausted. Output is still
            // independent of the client's blocked stdin write.
            session.data(channel, b"output during blocked input".to_vec())?;
        }
        if let Some(process) = &self.process {
            process.input(process::Input::Data(bytes.to_vec()))?;
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        _channel: ChannelId,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if let Some(process) = &self.process {
            process.input(process::Input::Eof)?;
        }
        Ok(())
    }

    async fn signal(
        &mut self,
        _channel: ChannelId,
        signal: russh::Sig,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.observed.signals.fetch_add(1, Ordering::SeqCst);
        if let Some(process) = &self.process {
            process.signal(&signal);
        }
        Ok(())
    }
}
