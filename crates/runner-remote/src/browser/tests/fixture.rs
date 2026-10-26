//! External API/TLS/CDP peers and the real assignment-bound Guest entry.

use super::super::*;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use httpmock::MockServer;
use rustls::{ClientConfig, RootCertStore, ServerConfig, pki_types::PrivatePkcs8KeyDer};
use sandbox::{AcceptedGuestRpc, GuestRpcAcceptor, GuestRpcStream};
use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::{TcpListener, TcpStream, UnixStream},
    sync::Mutex as AsyncMutex,
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};
use tokio_util::sync::CancellationToken;

pub(super) const HOST: &str = "fixture.browser-use.com";
pub(super) const OWNED: &str = "page-owned";
pub(super) const FOREIGN: &str = "page-foreign";

#[derive(Default)]
pub(super) struct State {
    pub moved: AtomicBool,
    pub navigated: AtomicBool,
    pub move_on_tree: AtomicBool,
    pub move_on_metadata: AtomicBool,
    pub move_after_window_check: AtomicBool,
    pub window_checks: AtomicUsize,
    pub malformed_window: AtomicBool,
    pub pause_auto_attach: AtomicBool,
    pub child_tree_pending: AtomicBool,
    pub child_tree_entered: tokio::sync::Notify,
    pub child_tree_release: tokio::sync::Notify,
    pub drop_input_ack: AtomicBool,
    pub inserted: Mutex<String>,
    pub methods: Mutex<Vec<String>>,
    pub connections: AtomicUsize,
    pub closed: tokio::sync::Notify,
}

struct ActiveConnection(Arc<State>);
impl Drop for ActiveConnection {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::SeqCst);
        self.0.closed.notify_waiters();
    }
}

pub(super) struct Peer {
    pub address: SocketAddr,
    pub tls: Arc<ClientConfig>,
    pub server: Arc<ServerConfig>,
    pub state: Arc<State>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}

pub(super) struct Network {
    pub address: SocketAddr,
}
#[async_trait]
impl crate::destination::Network for Network {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        assert_eq!(host, HOST);
        Ok(vec![SocketAddr::from(([8, 8, 8, 8], port))])
    }
    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream> {
        TcpStream::connect(SocketAddr::new(self.address.ip(), address.port())).await
    }
}

pub(super) struct GatedResolver {
    network: Network,
    used: AtomicBool,
    pub entered: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
    pub finished: tokio::sync::Notify,
}

impl GatedResolver {
    pub fn new(address: SocketAddr) -> Self {
        Self {
            network: Network { address },
            used: AtomicBool::new(false),
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            finished: tokio::sync::Notify::new(),
        }
    }
}

#[async_trait]
impl crate::destination::Network for GatedResolver {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        if !self.used.swap(true, Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
            let result = crate::destination::Network::resolve(&self.network, host, port).await;
            self.finished.notify_one();
            return result;
        }
        crate::destination::Network::resolve(&self.network, host, port).await
    }
    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream> {
        crate::destination::Network::connect(&self.network, address).await
    }
}

pub(super) fn certificate() -> (Arc<ServerConfig>, Arc<ClientConfig>) {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec![HOST.to_owned()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
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
    (Arc::new(server), Arc::new(client))
}

impl Peer {
    pub async fn new() -> Self {
        Self::start(None).await
    }
    pub async fn relay(endpoint: String) -> Self {
        Self::start(Some(endpoint)).await
    }
    async fn start(relay: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (server, tls) = certificate();
        let accept = TlsAcceptor::from(Arc::clone(&server));
        let state = Arc::new(State::default());
        let peer_state = Arc::clone(&state);
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    () = cancelled.cancelled() => break,
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap(); let accept = accept.clone(); let state = Arc::clone(&peer_state); let relay = relay.clone();
                        tasks.spawn(async move {
                            let tls = accept.accept(stream).await.unwrap();
                            let mut socket = tokio_tungstenite::accept_async(tls).await.unwrap();
                            state.connections.fetch_add(1, Ordering::SeqCst);
                            let _connection = ActiveConnection(Arc::clone(&state));
                            if let Some(endpoint) = relay {
                                let url = reqwest::Url::parse(&endpoint).unwrap();
                                let tcp = TcpStream::connect((url.host_str().unwrap(),url.port_or_known_default().unwrap())).await.unwrap();
                                let upstream = tokio_tungstenite::client_async(endpoint,tcp).await.unwrap().0;
                                let (mut send, mut receive) = socket.split();
                                let (mut upstream_send, mut upstream_receive) = upstream.split();
                                let forward = async { while let Some(Ok(message)) = receive.next().await { if upstream_send.send(message).await.is_err() { break; } } };
                                let backward = async { while let Some(Ok(message)) = upstream_receive.next().await { if send.send(message).await.is_err() { break; } } };
                                tokio::select! { () = forward => {}, () = backward => {} }
                                return;
                            }
                            while let Some(Ok(Message::Text(text))) = socket.next().await {
                                let request: Value = serde_json::from_str(&text).unwrap();
                                let method = request["method"].as_str().unwrap();
                                state.methods.lock().unwrap().push(method.to_owned());
                                if method == "Page.getFrameTree" && state.child_tree_pending.swap(false,Ordering::SeqCst) {
                                    state.child_tree_entered.notify_one();
                                    state.child_tree_release.notified().await;
                                }
                                let result = response(method, &request, &state);
                                if method == "Input.insertText" && state.drop_input_ack.swap(false,Ordering::SeqCst) { break; }
                                let message = json!({"id":request["id"],"result":result});
                                if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                                for event in events(method, &request) {
                                    if socket.send(Message::Text(event.to_string().into())).await.is_err() { break; }
                                }
                            }
                        });
                    }
                }
            }
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        });
        Self {
            address,
            tls,
            server,
            state,
            stop,
            task,
        }
    }
    pub async fn wait_closed(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let closed = self.state.closed.notified();
                if self.state.connections.load(Ordering::SeqCst) == 0 {
                    break;
                }
                closed.await;
            }
        })
        .await
        .unwrap();
    }
    pub async fn shutdown(self) {
        self.stop.cancel();
        self.task.await.unwrap();
    }
}

pub(super) struct HttpsPeer {
    pub address: SocketAddr,
    stop: CancellationToken,
    task: JoinHandle<()>,
}

impl HttpsPeer {
    pub async fn new(peer: &Peer, status: u16, body: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let accept = TlsAcceptor::from(Arc::clone(&peer.server));
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    () = cancelled.cancelled() => break,
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                    incoming = listener.accept() => {
                        let (stream,_) = incoming.unwrap(); let accept = accept.clone(); let body = body.to_string();
                        tasks.spawn(async move {
                            let mut stream = accept.accept(stream).await.unwrap();
                            let mut head = Vec::new(); let mut byte = [0;1];
                            while !head.ends_with(b"\r\n\r\n") {
                                if stream.read_exact(&mut byte).await.is_err() { return; }
                                head.extend_from_slice(&byte); assert!(head.len()<16*1024);
                            }
                            assert!(head.starts_with(b"GET /json/version?token="));
                            let header = format!("HTTP/1.1 {status} Fixture\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
                            if stream.write_all(header.as_bytes()).await.is_err() { return; }
                            for chunk in body.as_bytes().chunks(11) {
                                if stream.write_all(format!("{:x}\r\n",chunk.len()).as_bytes()).await.is_err() { return; }
                                if stream.write_all(chunk).await.is_err() { return; }
                                if stream.write_all(b"\r\n").await.is_err() { return; }
                            }
                            let _ = stream.write_all(b"0\r\n\r\n").await;
                            let _ = stream.shutdown().await;
                        });
                    }
                }
            }
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        });
        Self {
            address,
            stop,
            task,
        }
    }
    pub async fn shutdown(self) {
        self.stop.cancel();
        self.task.await.unwrap();
    }
}

fn response(method: &str, request: &Value, state: &State) -> Value {
    match method {
        "Browser.getVersion" => {
            json!({"protocolVersion":"1.3","product":"Chrome/1","revision":"fixture","userAgent":"fixture","jsVersion":"1"})
        }
        "Target.getTargets" => json!({"targetInfos":[
            {"targetId":OWNED,"type":"page","title":"Owned","url":"https://owned.example/","attached":false,"browserContextId":"private-context"},
            {"targetId":FOREIGN,"type":"page","title":"Foreign","url":"https://foreign.example/","attached":false}
        ]}),
        "Browser.getWindowForTarget" => {
            if state.malformed_window.load(Ordering::SeqCst) {
                return json!({});
            }
            if state.move_after_window_check.load(Ordering::SeqCst)
                && state.window_checks.fetch_add(1, Ordering::SeqCst) == 1
            {
                state.moved.store(true, Ordering::SeqCst);
            }
            json!({"windowId":if request["params"]["targetId"] == OWNED && !state.moved.load(Ordering::SeqCst) { 0 } else { 102 },"bounds":{"left":100}})
        }
        "Target.getTargetInfo" => {
            if state.move_on_metadata.load(Ordering::SeqCst) {
                state.moved.store(true, Ordering::SeqCst);
            }
            json!({"targetInfo":{"targetId":OWNED,"type":"page","title":"Native metadata","url":"https://owned.example/","attached":false}})
        }
        "Target.attachToTarget" => json!({"sessionId":"session-owned"}),
        "Target.setAutoAttach" => {
            state.child_tree_pending.store(
                state.pause_auto_attach.load(Ordering::SeqCst),
                Ordering::SeqCst,
            );
            json!({})
        }
        "Page.getFrameTree" if request["sessionId"] == "session-child" => {
            json!({"frameTree":{"frame":{"id":"frame-child","loaderId":"loader","url":"https://owned.example/child"}}})
        }
        "Page.getFrameTree" => {
            if state.move_on_tree.swap(false, Ordering::SeqCst) {
                state.moved.store(true, Ordering::SeqCst);
            }
            json!({"frameTree":{"frame":{"id":"frame-owned","loaderId":if state.navigated.load(Ordering::SeqCst) { "next-loader" } else { "loader" },"url":"https://owned.example/"},"childFrames":[{"frame":{"id":"frame-child","parentId":"frame-owned","loaderId":"child-loader","url":"https://owned.example/child"}}]}})
        }
        "Page.navigate" => {
            state.navigated.store(true, Ordering::SeqCst);
            json!({"frameId":"frame-owned", "loaderId":"next-loader"})
        }
        "Runtime.evaluate" if request["params"]["expression"] == "object" => {
            json!({"result":{"type":"object","objectId":"object-owned"}})
        }
        "Runtime.evaluate" if request["params"]["expression"] == "inserted" => {
            json!({"result":{"type":"string","value":state.inserted.lock().unwrap().clone()}})
        }
        "Input.insertText" => {
            state
                .inserted
                .lock()
                .unwrap()
                .push_str(request["params"]["text"].as_str().unwrap());
            json!({})
        }
        "Runtime.evaluate" => {
            json!({"result":{"type":"object","value":{"objectId":"forged-object","frameId":"forged-frame"}}})
        }
        "Page.captureScreenshot" => json!({"data":"a".repeat(100_000)}),
        _ => json!({}),
    }
}

fn events(method: &str, request: &Value) -> Vec<Value> {
    match method {
        "Network.enable" => vec![
            json!({"method":"Network.unimplementedGlobalEvent","sessionId":request["sessionId"],"params":{"targetId":FOREIGN}}),
            json!({"method":"Network.responseReceived","sessionId":request["sessionId"],"params":{"frameId":"frame-foreign","requestId":"foreign-request"}}),
            json!({"method":"Network.loadingFinished","sessionId":request["sessionId"],"params":{"requestId":"owned-request","encodedDataLength":10}}),
        ],
        "Runtime.enable" => vec![
            json!({"method":"Runtime.executionContextCreated","sessionId":request["sessionId"],"params":{"context":{"id":100,"uniqueId":"context-owned","auxData":{"frameId":"frame-owned"}}}}),
            json!({"method":"Runtime.executionContextCreated","sessionId":request["sessionId"],"params":{"context":{"id":200,"uniqueId":"context-foreign","auxData":{"frameId":"frame-foreign"}}}}),
        ],
        "Target.setAutoAttach" => {
            assert_eq!(request["sessionId"], "session-owned");
            assert_eq!(
                request["params"]["filter"],
                json!([{"type":"iframe","exclude":false},{"exclude":true}])
            );
            vec![
                json!({"method":"Target.attachedToTarget","sessionId":"session-owned","params":{"sessionId":"session-child","targetInfo":{"targetId":"frame-child","type":"iframe","title":"Child","url":"https://owned.example/child","attached":true},"waitingForDebugger":true}}),
                json!({"method":"Target.attachedToTarget","sessionId":"session-owned","params":{"sessionId":"session-worker","targetInfo":{"targetId":"worker-foreign","type":"worker","title":"Denied","url":"https://foreign.example/worker"},"waitingForDebugger":false}}),
            ]
        }
        _ => Vec::new(),
    }
}

struct Stream(UnixStream);
impl GuestRpcStream for Stream {}
impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buffer)
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
struct Acceptor(AsyncMutex<mpsc::Receiver<AcceptedGuestRpc>>);
#[async_trait]
impl GuestRpcAcceptor for Acceptor {
    async fn accept(&self) -> io::Result<AcceptedGuestRpc> {
        self.0
            .lock()
            .await
            .recv()
            .await
            .ok_or_else(|| io::Error::other("fixture closed"))
    }
}

pub(super) struct Harness {
    pub api: MockServer,
    pub run_id: runner_types::ids::RunId,
    pub provider_url: String,
    pub expires: u64,
    pub window: u64,
    pub incoming: mpsc::Sender<AcceptedGuestRpc>,
    pub cancelled: CancellationToken,
    pub sandbox_cancelled: CancellationToken,
    pub run: Option<guest_rpc::Run>,
    pub adapter: JoinHandle<()>,
    pub address: SocketAddr,
    stop: CancellationToken,
    mocks: Vec<usize>,
}

impl Harness {
    pub async fn forged_request(&self, params: Value) -> Vec<Value> {
        let client = self.request(params, self.sandbox_cancelled.clone()).await;
        let mut reader = runner_rpc_proto::ResponseReader::new(client);
        let mut result = Vec::new();
        while let Some(frame) = reader.next().await.unwrap() {
            result.push(serde_json::to_value(frame).unwrap());
        }
        result
    }
    pub async fn request(&self, params: Value, cancelled: CancellationToken) -> UnixStream {
        let (mut client, server) = UnixStream::pair().unwrap();
        self.incoming
            .send(AcceptedGuestRpc {
                sandbox_id: "assigned-browser-guest".into(),
                stream: Box::new(Stream(server)),
                cancelled,
            })
            .await
            .unwrap();
        let request = runner_rpc_proto::parse_request(
            json!({"version":1,"method":"browser.cdp","params":params,"remaining_ms":120_000})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        runner_rpc_proto::write_request(&mut client, &request)
            .await
            .unwrap();
        client
    }
    pub async fn new(peer: &Peer) -> Self {
        Self::for_endpoint(peer.address, Arc::clone(&peer.tls)).await
    }
    pub async fn for_endpoint(address: SocketAddr, tls: Arc<ClientConfig>) -> Self {
        Self::with_network(
            address,
            tls,
            Arc::new(Network { address }),
            Arc::new(Semaphore::new(64)),
        )
        .await
    }
    pub async fn with_network(
        address: SocketAddr,
        tls: Arc<ClientConfig>,
        network: Arc<dyn crate::destination::Network>,
        capacity: Arc<Semaphore>,
    ) -> Self {
        let api = MockServer::start_async().await;
        let run_id = runner_types::ids::RunId::new_v4();
        let token = "vm0_official_fixture";
        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 7).unwrap();
        let http =
            crate::test_fixtures::http::http_client(crate::test_fixtures::http::HttpClientConfig {
                api_url: api.base_url(),
                vercel_bypass: None,
                client_session_id: "browser-fixture".into(),
            });
        let runtime = Arc::new(BrowserRuntime {
            authority: authority::Authority::new(http, token, identity).unwrap(),
            network,
            tls,
            capacity,
        });
        let (incoming, receive) = mpsc::channel(16);
        let cancelled = CancellationToken::new();
        let sandbox_cancelled = CancellationToken::new();
        let run = guest_rpc::Runtime::new(None, None, None)
            .with_browser(Some(runtime))
            .start(
                Arc::new(Acceptor(AsyncMutex::new(receive))),
                "assigned-browser-guest".into(),
                run_id,
                &cancelled,
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = listener.local_addr().unwrap();
        let connector = incoming.clone();
        let lifecycle = sandbox_cancelled.clone();
        let stop = CancellationToken::new();
        let done = stop.clone();
        let adapter = tokio::spawn(async move {
            runner_rpc_client::browser::serve(
                listener,
                move || {
                    let connector = connector.clone();
                    let lifecycle = lifecycle.clone();
                    async move {
                        let (client, server) = UnixStream::pair()?;
                        connector
                            .send(AcceptedGuestRpc {
                                sandbox_id: "assigned-browser-guest".into(),
                                stream: Box::new(Stream(server)),
                                cancelled: lifecycle,
                            })
                            .await
                            .map_err(|_| io::Error::other("fixture ended"))?;
                        Ok(client)
                    }
                },
                async move { done.cancelled().await },
            )
            .await
            .unwrap();
        });
        let mut harness = Self {
            api,
            run_id,
            provider_url: format!(
                "wss://{HOST}:{}/?token=private-provider-canary",
                address.port()
            ),
            expires: authority::now() + 600_000,
            window: 0,
            incoming,
            cancelled,
            sandbox_cancelled,
            run: Some(run),
            adapter,
            address: local,
            stop,
            mocks: Vec::new(),
        };
        harness.set_api(true).await;
        harness
    }

    pub async fn set_api(&mut self, enabled: bool) {
        let old_mocks = std::mem::take(&mut self.mocks);
        let physical = chrono::Utc::now() + chrono::Duration::hours(4);
        let instance = json!({"id":"00000000-0000-0000-0000-000000000001","ownerProfileId":"00000000-0000-0000-0000-000000000002",
            "providerProfileId":"00000000-0000-0000-0000-000000000003","providerSessionId":"00000000-0000-0000-0000-000000000004",
            "status":"active","creationExpiresAt":physical.to_rfc3339(),"timeoutAt":physical.to_rfc3339(),
            "window":{"chatThreadId":"00000000-0000-0000-0000-000000000005","state":"active","expiresAt":self.expires,"primaryWindowId":self.window}});
        let control = if enabled {
            json!({"outcome":"accepted","instance":instance})
        } else {
            json!({"outcome":"unavailable"})
        };
        let connection = if enabled {
            json!({"outcome":"accepted","connection":{"instanceId":instance["id"],"providerSessionId":instance["providerSessionId"],
            "chatThreadId":instance["window"]["chatThreadId"],"primaryWindowId":self.window,"expiresAt":self.expires,"cdpUrl":self.provider_url}})
        } else {
            json!({"outcome":"unavailable"})
        };
        let control_mock = self
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/browser/control", self.run_id))
                    .header("authorization", "Bearer vm0_official_fixture");
                then.status(200).json_body_obj(&control);
            })
            .await;
        let connection_mock = self
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!(
                        "/api/runners/runs/{}/browser/connection",
                        self.run_id
                    ))
                    .header("authorization", "Bearer vm0_official_fixture");
                then.status(200).json_body_obj(&connection);
            })
            .await;
        self.mocks = vec![control_mock.id(), connection_mock.id()];
        // Install replacements before retiring old matchers. A reset would
        // create a 404 gap racing the real Runner's current-authority checks.
        for id in old_mocks {
            httpmock::Mock::new(id, &self.api).delete_async().await;
        }
    }

    pub async fn connect(&self) -> WebSocketStream<TcpStream> {
        let tcp = TcpStream::connect(self.address).await.unwrap();
        tokio_tungstenite::client_async(format!("ws://127.0.0.1:{}", self.address.port()), tcp)
            .await
            .unwrap()
            .0
    }

    pub async fn shutdown(mut self) {
        self.stop.cancel();
        self.adapter.await.unwrap();
        self.run.take().unwrap().shutdown().await.unwrap();
    }
}

pub(super) async fn command(
    socket: &mut WebSocketStream<TcpStream>,
    id: u64,
    method: &str,
    params: Value,
    session: Option<&str>,
) -> Value {
    let mut request = json!({"id":id,"method":method,"params":params});
    if let Some(session) = session {
        request["sessionId"] = session.into();
    }
    socket
        .send(Message::Text(request.to_string().into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let text = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(
                !text.contains("private-provider-canary")
                    && !text.contains("private-context")
                    && !text.contains("page-foreign")
            );
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["id"] == id {
                return value;
            }
        }
    })
    .await
    .unwrap()
}
