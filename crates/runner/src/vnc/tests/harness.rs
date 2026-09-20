use std::{
    future::Future,
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use async_trait::async_trait;
use httpmock::{Mock, MockServer};
use runner_rpc_proto::stream::{Frame, Reader};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf},
    net::TcpStream,
    sync::{Semaphore, mpsc},
};
use tokio_util::sync::CancellationToken;

use super::{
    super::{VncRuntime, network::Network},
    peer::Peer,
};
use crate::{
    guest_rpc::{Run as RpcRun, Runtime},
    http::{HttpClient, HttpClientConfig},
    ids::RunId,
    runner_process_identity::RunnerProcessIdentity,
};

pub(super) const CONNECTION: &str = "9f0128ce-dd11-4234-b1ac-a0c33353a112";
const TOKEN: &str = "vm0_official_vnc-test";

pub(super) async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .unwrap()
}

pub(super) struct TestNetwork {
    target: SocketAddr,
    pub(super) answers: Mutex<Vec<SocketAddr>>,
    pub(super) attempts: Mutex<Vec<SocketAddr>>,
    pub(super) resolve_gate: Mutex<Option<Arc<Semaphore>>>,
}

#[async_trait]
impl Network for TestNetwork {
    async fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<SocketAddr>> {
        let gate = self.resolve_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        Ok(self.answers.lock().unwrap().clone())
    }

    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream> {
        self.attempts.lock().unwrap().push(address);
        TcpStream::connect(self.target).await
    }
}

struct Stream {
    stream: DuplexStream,
    fail_output: bool,
    cancel_after_data: Option<CancellationToken>,
    header: Vec<u8>,
    remaining: usize,
    data: bool,
}

impl Stream {
    fn observe(&mut self, mut bytes: &[u8]) {
        if self.cancel_after_data.is_none() {
            return;
        }
        while !bytes.is_empty() {
            if self.remaining == 0 {
                let count = (4 - self.header.len()).min(bytes.len());
                self.header.extend_from_slice(&bytes[..count]);
                bytes = &bytes[count..];
                if self.header.len() < 4 {
                    continue;
                }
                self.remaining = u32::from_be_bytes(self.header[..].try_into().unwrap()) as usize;
                self.data = false;
            } else {
                if self.header.len() == 4 {
                    self.data = bytes[0] == 0;
                    self.header.clear();
                }
                let count = self.remaining.min(bytes.len());
                self.remaining -= count;
                bytes = &bytes[count..];
            }
        }
    }
}
impl sandbox::GuestRpcStream for Stream {}
impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}
impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.fail_output {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        let result = Pin::new(&mut this.stream).poll_write(cx, bytes);
        if let Poll::Ready(Ok(count)) = result {
            this.observe(&bytes[..count]);
        }
        result
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.stream).poll_flush(cx);
        if matches!(result, Poll::Ready(Ok(())))
            && this.remaining == 0
            && this.data
            && let Some(cancel) = this.cancel_after_data.take()
        {
            cancel.cancel();
        }
        result
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
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
            .ok_or_else(|| io::Error::other("closed test acceptor"))
    }
}

pub(super) struct TestRun {
    pub(super) id: RunId,
    pub(super) cancel: CancellationToken,
    pub(super) lifecycle: CancellationToken,
    incoming: mpsc::Sender<sandbox::AcceptedGuestRpc>,
    dispatcher: Option<RpcRun>,
}

impl TestRun {
    pub(super) fn new(runtime: &Arc<VncRuntime>) -> Self {
        let id = RunId::new_v4();
        let cancel = CancellationToken::new();
        let (incoming, receiver) = mpsc::channel(16);
        let dispatcher = Runtime {
            ssh: None,
            vnc: Some(Arc::clone(runtime)),
            usage: None,
        }
        .start(
            Arc::new(Acceptor(tokio::sync::Mutex::new(receiver))),
            "vnc-assigned-sandbox".into(),
            id,
            &cancel,
        );
        Self {
            id,
            cancel,
            lifecycle: CancellationToken::new(),
            incoming,
            dispatcher: Some(dispatcher),
        }
    }

    pub(super) async fn open(&self) -> DuplexStream {
        self.open_stream(false).await
    }

    pub(super) async fn open_stream(&self, cancel_after_data: bool) -> DuplexStream {
        self.open_options(cancel_after_data, false).await
    }

    pub(super) async fn open_failing_output(&self) -> DuplexStream {
        self.open_options(false, true).await
    }

    async fn open_options(&self, cancel_after_data: bool, fail_output: bool) -> DuplexStream {
        let (guest, host) = tokio::io::duplex(64 * 1024);
        self.incoming
            .send(sandbox::AcceptedGuestRpc {
                sandbox_id: "vnc-assigned-sandbox".into(),
                stream: Box::new(Stream {
                    stream: host,
                    fail_output,
                    cancel_after_data: cancel_after_data.then(|| self.cancel.clone()),
                    header: Vec::with_capacity(4),
                    remaining: 0,
                    data: false,
                }),
                cancelled: self.lifecycle.clone(),
            })
            .await
            .unwrap();
        guest
    }

    pub(super) async fn request(&self, method: &str, params: Value) -> Reply {
        self.raw(
            json!({"version":1,"method":method,"remaining_ms":60000,"params":params}).to_string(),
        )
        .await
    }

    pub(super) async fn raw(&self, request: String) -> Reply {
        let mut guest = self.open().await;
        send(&mut guest, &request).await;
        read(guest).await
    }

    pub(super) async fn shutdown(&mut self) {
        if let Some(dispatcher) = self.dispatcher.take() {
            bounded(dispatcher.shutdown()).await;
        }
    }
}

pub(super) async fn send(guest: &mut DuplexStream, request: &str) {
    guest
        .write_u32(request.len().try_into().unwrap())
        .await
        .unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    // No half-close: production Firecracker does not forward this as host EOF.
}

#[derive(Default)]
pub(super) struct Reply {
    pub(super) controls: Vec<Value>,
    pub(super) bytes: Vec<u8>,
    pub(super) ended: bool,
}

impl Reply {
    pub(super) fn result(&self) -> &Value {
        let terminal = self.controls.last().expect("terminal response");
        assert_eq!(terminal["type"], "result", "{terminal}");
        &terminal["data"]
    }

    pub(super) fn session(&self) -> String {
        assert_eq!(self.result()["outcome"], "started", "{}", self.result());
        self.result()["session"]["sessionId"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

pub(super) async fn read(guest: impl AsyncRead + Unpin) -> Reply {
    bounded(async {
        let mut reader = Reader::responses(guest);
        let mut reply = Reply::default();
        while let Some(frame) = reader.next().await.unwrap() {
            match frame {
                Frame::Control(response) => {
                    reply.controls.push(serde_json::to_value(response).unwrap())
                }
                Frame::Data(bytes) => reply.bytes.extend(bytes),
                Frame::End => reply.ended = true,
            }
        }
        reply
    })
    .await
}

pub(super) struct Harness {
    pub(super) api: MockServer,
    pub(super) runtime: Arc<VncRuntime>,
    pub(super) network: Arc<TestNetwork>,
    pub(super) peer: Peer,
    pub(super) run: TestRun,
    identity: RunnerProcessIdentity,
}

impl Harness {
    pub(super) async fn new() -> Self {
        Self::with_authority(Peer::new().await, None).await
    }

    pub(super) async fn with_authority(peer: Peer, api_url: Option<String>) -> Self {
        let api = MockServer::start_async().await;
        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 27).unwrap();
        let http = HttpClient::new(HttpClientConfig {
            api_url: api_url.unwrap_or_else(|| api.base_url()),
            vercel_bypass: None,
            client_session_id: "vnc-dispatch-test".into(),
        })
        .unwrap();
        let mut runtime = VncRuntime::official(http, TOKEN, identity)
            .unwrap()
            .unwrap();
        let network = Arc::new(TestNetwork {
            target: peer.address,
            answers: Mutex::new(vec!["93.184.216.34:5900".parse().unwrap()]),
            attempts: Mutex::new(Vec::new()),
            resolve_gate: Mutex::new(None),
        });
        Arc::get_mut(&mut runtime).unwrap().network = network.clone();
        let run = TestRun::new(&runtime);
        Self {
            api,
            runtime,
            network,
            peer,
            run,
            identity,
        }
    }

    pub(super) async fn resolve(&self) -> Mock<'_> {
        self.resolve_connection(CONNECTION).await
    }

    pub(super) async fn resolve_connection(&self, connection: &str) -> Mock<'_> {
        self.resolve_path(None, connection).await
    }

    pub(super) async fn resolve_for_run(&self, run: RunId) -> Mock<'_> {
        self.resolve_path(Some(run), CONNECTION).await
    }

    async fn resolve_path(&self, run: Option<RunId>, connection: &str) -> Mock<'_> {
        self.api.mock_async(|when, then| {
            let when = when.method("POST");
            let when = match run { Some(run) => when.path(format!("/api/runners/runs/{run}/vnc/resolve")), None => when.path_matches(r"^/api/runners/runs/[^/]+/vnc/resolve$") };
            when
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({"connectionId":connection,"runnerIdentity":{"runnerId":self.identity.runner_id(),"heartbeatGeneration":27},"supportedProfiles":[{"authMethod":"vnc_password","securityType":"x509_vnc"}]}));
            then.status(200).json_body(json!({"outcome":"resolved","host":"vnc.example.test","port":5900,"generation":7,
                "authentication":{"method":"vnc_password","password":" secret "},
                "security":{"type":"x509_vnc","trust":{"mode":"custom_ca","caBundle":self.peer.ca}}}));
        }).await
    }

    pub(super) async fn check(&self, outcome: &str, status: u16) -> Mock<'_> {
        self.check_delayed(outcome, status, Duration::ZERO).await
    }

    pub(super) async fn check_connection(
        &self,
        connection: &str,
        outcome: &str,
        status: u16,
    ) -> Mock<'_> {
        self.check_connection_delayed(connection, outcome, status, Duration::ZERO)
            .await
    }

    pub(super) async fn check_delayed(
        &self,
        outcome: &str,
        status: u16,
        delay: Duration,
    ) -> Mock<'_> {
        self.check_connection_delayed(CONNECTION, outcome, status, delay)
            .await
    }

    async fn check_connection_delayed(
        &self,
        connection: &str,
        outcome: &str,
        status: u16,
        delay: Duration,
    ) -> Mock<'_> {
        self.api.mock_async(|when, then| {
            when.method("POST").path_matches(r"^/api/runners/runs/[^/]+/vnc/check$")
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({"connectionId":connection,"runnerIdentity":{"runnerId":self.identity.runner_id(),"heartbeatGeneration":27},"expectedGeneration":7}));
            then.status(status).delay(delay).json_body(json!({"outcome":outcome}));
        }).await
    }

    pub(super) async fn start(&self, mode: &str) -> Reply {
        self.run
            .request(
                "vnc.session.start",
                json!({"connectionId":CONNECTION,"mode":mode}),
            )
            .await
    }
}
