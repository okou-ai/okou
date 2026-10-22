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
use runner_rpc_proto::stream::{Frame, Reader, Writer};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf},
    net::{TcpStream, UnixStream},
    sync::{Semaphore, mpsc},
};
use tokio_util::sync::CancellationToken;

use super::{
    super::{VncRuntime, network::Network},
    peer::{PLAIN_PASSWORD, PLAIN_USERNAME, Peer},
};
use crate::guest_rpc::{Run as RpcRun, Runtime};
use crate::test_fixtures::http::{HttpClientConfig, http_client};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_types::ids::RunId;
use runner_types::types::ExecutionContext;
use sandbox::Sandbox;
use sandbox_mock::MockSandbox;

pub(super) const CONNECTION: &str = "9f0128ce-dd11-4234-b1ac-a0c33353a112";
const TOKEN: &str = "vm0_official_vnc-test";
pub(crate) const CREATED_AT: &str = "2026-09-01T00:00:00.123456Z";

pub(super) fn resolved_response(body: &str) -> Vec<u8> {
    let mut response = crate::test_fixtures::raw_http::json_response("200 OK", body);
    let end = response.iter().position(|byte| *byte == b'\n').unwrap() + 1;
    response.splice(
        end..end,
        format!("X-VNC-Connection-Created-At: {CREATED_AT}\r\n").bytes(),
    );
    response
}

fn supported_profiles() -> Value {
    crate::test_fixtures::vnc::supported_profiles(false)
}

fn optional_kerberos_request(
    expected: Value,
) -> impl Fn(&httpmock::HttpMockRequest) -> bool + Send + Sync + 'static {
    crate::test_fixtures::vnc::optional_kerberos_request(expected, false)
}

pub(super) async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .unwrap()
}

pub(crate) struct TestNetwork {
    pub(super) target: Mutex<SocketAddr>,
    pub(crate) answers: Mutex<Vec<SocketAddr>>,
    pub(crate) attempts: Mutex<Vec<SocketAddr>>,
    pub(crate) queries: Mutex<Vec<(String, u16)>>,
    pub(super) resolve_gate: Mutex<Option<Arc<Semaphore>>>,
}

#[async_trait]
impl Network for TestNetwork {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        self.queries.lock().unwrap().push((host.to_owned(), port));
        let gate = self.resolve_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        Ok(self.answers.lock().unwrap().clone())
    }

    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream> {
        self.attempts.lock().unwrap().push(address);
        let target = *self.target.lock().unwrap();
        TcpStream::connect(target).await
    }
}

struct Stream<S> {
    stream: S,
    fail_output: bool,
    cancel_after_data: Option<CancellationToken>,
    header: Vec<u8>,
    remaining: usize,
    data: bool,
}

impl<S> Stream<S> {
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
impl<S: AsyncRead + AsyncWrite + Unpin + Send> sandbox::GuestRpcStream for Stream<S> {}
impl<S: AsyncRead + Unpin> AsyncRead for Stream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for Stream<S> {
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

pub(crate) struct TestRun {
    pub(crate) id: RunId,
    pub(super) cancel: CancellationToken,
    pub(super) lifecycle: CancellationToken,
    incoming: mpsc::Sender<sandbox::AcceptedGuestRpc>,
    rpc: Arc<Runtime>,
    dispatcher: Option<RpcRun>,
}

impl TestRun {
    pub(crate) fn native(&self) -> Arc<crate::native::Run> {
        self.dispatcher.as_ref().unwrap().native()
    }

    pub(super) fn new(runtime: &Arc<VncRuntime>) -> Self {
        Self::with_id(runtime, RunId::new_v4())
    }

    pub(super) fn with_id(runtime: &Arc<VncRuntime>, id: RunId) -> Self {
        Self::with_rpc(
            Arc::new(Runtime::new(None, Some(Arc::clone(runtime)), None)),
            id,
        )
    }

    pub(super) fn reassign(&self) -> Self {
        Self::with_rpc(Arc::clone(&self.rpc), self.id)
    }

    fn with_rpc(rpc: Arc<Runtime>, id: RunId) -> Self {
        let cancel = CancellationToken::new();
        let (incoming, receiver) = mpsc::channel(16);
        let dispatcher = rpc.start(
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
            rpc,
            dispatcher: Some(dispatcher),
        }
    }

    pub(super) async fn open(&self) -> DuplexStream {
        self.open_stream(false).await
    }

    pub(super) async fn open_stream(&self, cancel_after_data: bool) -> DuplexStream {
        self.open_options(cancel_after_data, false, 64 * 1024).await
    }

    pub(super) async fn open_failing_output(&self) -> DuplexStream {
        self.open_options(false, true, 64 * 1024).await
    }

    pub(super) async fn open_sized(&self, capacity: usize) -> DuplexStream {
        self.open_options(false, false, capacity).await
    }

    pub(super) async fn accept_socket(&self, host: UnixStream) {
        self.incoming
            .send(sandbox::AcceptedGuestRpc {
                sandbox_id: "vnc-assigned-sandbox".into(),
                stream: Box::new(Stream {
                    stream: host,
                    fail_output: false,
                    cancel_after_data: None,
                    header: Vec::with_capacity(4),
                    remaining: 0,
                    data: false,
                }),
                cancelled: self.lifecycle.clone(),
            })
            .await
            .unwrap();
    }

    async fn open_options(
        &self,
        cancel_after_data: bool,
        fail_output: bool,
        capacity: usize,
    ) -> DuplexStream {
        let (guest, host) = tokio::io::duplex(capacity);
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

    pub(crate) async fn request(&self, method: &str, params: Value) -> Reply {
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

    pub(crate) async fn shutdown(&mut self) {
        self.shutdown_result().await.unwrap();
    }

    pub(crate) async fn shutdown_result(&mut self) -> Result<(), crate::guest_rpc::CleanupError> {
        if let Some(dispatcher) = self.dispatcher.take() {
            bounded(dispatcher.shutdown()).await
        } else {
            Ok(())
        }
    }

    pub(crate) async fn enable_diagnostics(&mut self, runtime: &Arc<VncRuntime>) {
        self.enable_diagnostics_token(runtime, "diagnostic-vnc-agent")
            .await;
    }

    pub(crate) async fn enable_checks(&mut self, runtime: &Arc<VncRuntime>, capabilities: &[&str]) {
        self.enable_diagnostics_token(
            runtime,
            &crate::test_fixtures::check_token(self.id, capabilities),
        )
        .await;
    }

    async fn enable_diagnostics_token(&mut self, runtime: &Arc<VncRuntime>, token: &str) {
        let context =
            crate::test_fixtures::execution_context::diagnostic_context_for_test(self.id, token);
        self.install_context(runtime, &context).await;
    }

    pub(crate) async fn install_context(
        &mut self,
        runtime: &Arc<VncRuntime>,
        context: &ExecutionContext,
    ) {
        self.shutdown().await;
        let (incoming, receiver) = mpsc::channel(16);
        self.incoming = incoming;
        let mut sandbox = MockSandbox::new("vnc-assigned-sandbox")
            .with_guest_rpc(Arc::new(Acceptor(tokio::sync::Mutex::new(receiver))));
        sandbox.bind_run_control(&self.id.to_string()).unwrap();
        self.rpc = Arc::new(Runtime::new(None, Some(Arc::clone(runtime)), None));
        self.dispatcher = Some(self.rpc.install(&sandbox, context, &self.cancel).unwrap());
    }

    pub(crate) async fn passive(&self, method: &str, params: Value) -> Value {
        self.diagnostic_rpc(method, params, None).await
    }

    pub(crate) async fn active_check(&self, params: Value) -> Value {
        self.active_check_budget(params, 60000).await
    }

    pub(super) async fn active_check_budget(&self, params: Value, remaining_ms: u64) -> Value {
        self.diagnostic_rpc("vnc.check", params, Some(remaining_ms))
            .await
    }

    async fn diagnostic_rpc(
        &self,
        method: &str,
        params: Value,
        remaining_ms: Option<u64>,
    ) -> Value {
        let mut guest = self.open().await;
        let mut request = json!({"version":1,"method":method,"params":params});
        if let Some(remaining_ms) = remaining_ms {
            request["remaining_ms"] = json!(remaining_ms);
        }
        let request = request.to_string();
        guest.write_u32(request.len() as u32).await.unwrap();
        guest.write_all(request.as_bytes()).await.unwrap();
        let mut reader = runner_rpc_proto::ResponseReader::new(guest);
        let frame = bounded(reader.next()).await.unwrap().unwrap();
        assert!(bounded(reader.next()).await.unwrap().is_none());
        serde_json::to_value(frame).unwrap()["data"].clone()
    }
}

pub(super) async fn send(guest: &mut DuplexStream, request: &str) {
    guest
        .write_u32(request.len().try_into().unwrap())
        .await
        .unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    Writer::input(&mut *guest).send(&Frame::End).await.unwrap();
    // No half-close: production Firecracker does not forward this as host EOF.
}

#[derive(Default)]
pub(crate) struct Reply {
    pub(super) controls: Vec<Value>,
    pub(crate) bytes: Vec<u8>,
    pub(super) ended: bool,
}

impl Reply {
    pub(crate) fn result(&self) -> &Value {
        let terminal = self.controls.last().expect("terminal response");
        assert_eq!(terminal["type"], "result", "{terminal}");
        &terminal["data"]
    }

    pub(crate) fn session(&self) -> String {
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

pub(crate) struct Harness {
    pub(crate) api: MockServer,
    pub(crate) runtime: Arc<VncRuntime>,
    pub(crate) network: Arc<TestNetwork>,
    pub(crate) peer: Peer,
    pub(crate) run: TestRun,
    identity: RunnerProcessIdentity,
}

impl Harness {
    pub(crate) async fn new() -> Self {
        Self::with_authority(Peer::new().await, None).await
    }

    pub(super) async fn new_plain() -> Self {
        Self::with_authority(Peer::plain().await, None).await
    }

    pub(crate) async fn with_authority(peer: Peer, api_url: Option<String>) -> Self {
        let api = MockServer::start_async().await;
        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 27).unwrap();
        let http = http_client(HttpClientConfig {
            api_url: api_url.unwrap_or_else(|| api.base_url()),
            vercel_bypass: None,
            client_session_id: "vnc-dispatch-test".into(),
        });
        let mut runtime = VncRuntime::official(http, TOKEN, identity)
            .unwrap()
            .unwrap();
        let network = Arc::new(TestNetwork {
            target: Mutex::new(peer.address),
            answers: Mutex::new(vec!["93.184.216.34:5900".parse().unwrap()]),
            attempts: Mutex::new(Vec::new()),
            queries: Mutex::new(Vec::new()),
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
                .is_true(optional_kerberos_request(json!({"connectionId":connection,"runnerIdentity":{"runnerId":self.identity.runner_id(),"heartbeatGeneration":27},"supportedProfiles":supported_profiles()})));
            then.status(200).header("X-VNC-Connection-Created-At", CREATED_AT).json_body(json!({"outcome":"resolved_transport","host":"vnc.example.test","port":5900,"generation":7,
                "serverName":"vnc.example.test","transport":{"type":"direct"},
                "authentication":{"method":"vnc_password","password":" secret "},
                "security":{"type":"x509_vnc","trust":{"mode":"custom_ca","caBundle":self.peer.ca}}}));
        }).await
    }

    pub(super) async fn resolve_plain(&self) -> Mock<'_> {
        self.api.mock_async(|when, then| {
            when.method("POST")
                .path_matches(r"^/api/runners/runs/[^/]+/vnc/resolve$")
                .header("authorization", format!("Bearer {TOKEN}"))
                .is_true(optional_kerberos_request(json!({"connectionId":CONNECTION,"runnerIdentity":{"runnerId":self.identity.runner_id(),"heartbeatGeneration":27},"supportedProfiles":supported_profiles()})));
            then.status(200).header("X-VNC-Connection-Created-At", CREATED_AT).json_body(json!({"outcome":"resolved_transport","host":"vnc.example.test","port":5900,"generation":7,
                "serverName":"vnc.example.test","transport":{"type":"direct"},
                "authentication":{"method":"username_password","username":PLAIN_USERNAME,"password":PLAIN_PASSWORD},
                "security":{"type":"x509_plain","trust":{"mode":"custom_ca","caBundle":self.peer.ca}}}));
        }).await
    }

    pub(crate) async fn resolve_response(&self, response: Value) -> Mock<'_> {
        self.resolve_response_with_created_at(response, Some(CREATED_AT))
            .await
    }

    pub(super) async fn resolve_response_with_created_at(
        &self,
        response: Value,
        created_at: Option<&str>,
    ) -> Mock<'_> {
        self.resolve_response_connection(CONNECTION, response, created_at)
            .await
    }

    pub(crate) async fn resolve_response_connection(
        &self,
        connection: &str,
        response: Value,
        created_at: Option<&str>,
    ) -> Mock<'_> {
        self.api.mock_async(|when, then| {
            when.method("POST")
                .path_matches(r"^/api/runners/runs/[^/]+/vnc/resolve$")
                .header("authorization", format!("Bearer {TOKEN}"))
                .is_true(optional_kerberos_request(json!({"connectionId":connection,"runnerIdentity":{"runnerId":self.identity.runner_id(),"heartbeatGeneration":27},"supportedProfiles":supported_profiles()})));
            let then = then.status(200);
            let then = if let Some(created_at) = created_at {
                then.header("X-VNC-Connection-Created-At", created_at)
            } else {
                then
            };
            then.json_body(response);
        }).await
    }

    pub(super) async fn check(&self, outcome: &str, status: u16) -> Mock<'_> {
        self.check_connection(CONNECTION, outcome, status).await
    }

    pub(super) async fn check_connection(
        &self,
        connection: &str,
        outcome: &str,
        status: u16,
    ) -> Mock<'_> {
        self.check_route(connection, json!({"type":"direct"}), outcome, status)
            .await
    }

    pub(crate) async fn check_route(
        &self,
        connection: &str,
        route: Value,
        outcome: &str,
        status: u16,
    ) -> Mock<'_> {
        self.api.mock_async(|when, then| {
            when.method("POST").path_matches(r"^/api/runners/runs/[^/]+/vnc/check$")
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({"connectionId":connection,"runnerIdentity":{"runnerId":self.identity.runner_id(),"heartbeatGeneration":27},"expectedGeneration":7,"expectedTransport":route}));
            then.status(status).json_body(json!({"outcome":outcome}));
        }).await
    }

    pub(crate) async fn check_kerberos_route(
        &self,
        connection: &str,
        rfb: Value,
        kdc: Value,
    ) -> Mock<'_> {
        self.api.mock_async(|when, then| {
            when.method("POST").path_matches(r"^/api/runners/runs/[^/]+/vnc/check$")
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({"connectionId":connection,"runnerIdentity":{"runnerId":self.identity.runner_id(),"heartbeatGeneration":27},
                    "expectedGeneration":7,"expectedTransport":rfb,"expectedCredentialRevision":3,"expectedKdcTransport":kdc}));
            then.status(200).json_body(json!({"outcome":"valid"}));
        }).await
    }

    pub(crate) async fn start(&self, mode: &str) -> Reply {
        self.run
            .request(
                "vnc.session.start",
                json!({"connectionId":CONNECTION,"mode":mode}),
            )
            .await
    }
}
