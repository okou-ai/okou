//! Native verified provider IO. Errors contain no peer diagnostics or URL values.

use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use http_body_util::{BodyExt, Empty};
use hyper_util::rt::TokioIo;
use reqwest::Url;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_rustls::{TlsConnector, client::TlsStream};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;

use super::{Failure, MAX_MESSAGE_BYTES, Result};
use crate::destination::{Network, select_public_address};

pub(super) type Socket = WebSocketStream<TlsStream<TcpStream>>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

pub(super) struct Event {
    pub value: Value,
    _permit: OwnedSemaphorePermit,
}

pub(super) struct Client {
    sink: Arc<AsyncMutex<SplitSink<Socket, Message>>>,
    pending: Pending,
    next: AtomicU64,
    cancel: CancellationToken,
    reader: Option<JoinHandle<()>>,
}

pub(super) fn endpoint(raw: &str, websocket: bool) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| Failure)?;
    let host = url.host_str().ok_or(Failure)?;
    if !(host == "browser-use.com" || host.ends_with(".browser-use.com"))
        || !(url.scheme() == "wss" || !websocket && url.scheme() == "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Failure);
    }
    Ok(url)
}

async fn tls(
    url: &Url,
    network: &dyn Network,
    config: Arc<rustls::ClientConfig>,
) -> Result<TlsStream<TcpStream>> {
    let host = url.host_str().ok_or(Failure)?;
    let port = url.port_or_known_default().ok_or(Failure)?;
    let addresses = network.resolve(host, port).await.map_err(|_| Failure)?;
    let address = select_public_address(&addresses, port).ok_or(Failure)?;
    let tcp = network.connect(address).await.map_err(|_| Failure)?;
    let name = rustls::pki_types::ServerName::try_from(host.to_owned()).map_err(|_| Failure)?;
    TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|_| Failure)
}

async fn discovery(
    url: &Url,
    network: &dyn Network,
    config: Arc<rustls::ClientConfig>,
) -> Result<Url> {
    let mut discovery = url.clone();
    discovery.set_path("/json/version");
    let stream = tls(&discovery, network, config).await?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| Failure)?;
    let read = async {
        let path = format!(
            "{}{}",
            discovery.path(),
            discovery
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default()
        );
        let host = format!(
            "{}:{}",
            discovery.host_str().ok_or(Failure)?,
            discovery.port_or_known_default().ok_or(Failure)?
        );
        let request = hyper::Request::builder()
            .uri(path)
            .header("host", host)
            .header("connection", "close")
            .body(Empty::<bytes::Bytes>::new())
            .map_err(|_| Failure)?;
        let response = sender.send_request(request).await.map_err(|_| Failure)?;
        if response.status() != hyper::StatusCode::OK {
            return Err(Failure);
        }
        let mut body = response.into_body();
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| Failure)?;
            if let Ok(data) = frame.into_data() {
                if data.len() > 64 * 1024 - bytes.len() {
                    return Err(Failure);
                }
                bytes.extend_from_slice(&data);
            }
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| Failure)?;
        endpoint(
            value
                .get("webSocketDebuggerUrl")
                .and_then(Value::as_str)
                .ok_or(Failure)?,
            true,
        )
    };
    tokio::pin!(connection, read);
    // A connection may finish after buffering a complete response but before
    // the body consumer is polled again. Drain that consumer rather than
    // discarding a valid discovery reply on a normal Connection: close.
    tokio::select! { biased; result = &mut read => result, _ = &mut connection => read.await }
}

impl Client {
    pub(super) fn cancelled(&self) -> CancellationToken {
        self.cancel.clone()
    }
    pub(super) async fn connect(
        raw: &str,
        network: &dyn Network,
        config: Arc<rustls::ClientConfig>,
    ) -> Result<Socket> {
        let url = endpoint(raw, false)?;
        let url = if url.scheme() == "https" {
            discovery(&url, network, Arc::clone(&config)).await?
        } else {
            url
        };
        let tls = tls(&url, network, config).await?;
        let options = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        let (socket, _) =
            tokio_tungstenite::client_async_with_config(url.as_str(), tls, Some(options))
                .await
                .map_err(|_| Failure)?;
        Ok(socket)
    }

    pub(super) fn start(
        socket: Socket,
        parent: &CancellationToken,
    ) -> (Self, mpsc::Receiver<Event>) {
        let (sink, mut stream) = socket.split();
        let sink = Arc::new(AsyncMutex::new(sink));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let cancel = parent.child_token();
        let (events, receive) = mpsc::channel(512);
        let budget = Arc::new(Semaphore::new(8 * 1024 * 1024));
        let read_cancel = cancel.clone();
        let read_pending = Arc::clone(&pending);
        let read_sink = Arc::clone(&sink);
        let reader = tokio::spawn(async move {
            loop {
                let message = tokio::select! { biased; () = read_cancel.cancelled() => break, message = stream.next() => message };
                let Some(Ok(message)) = message else {
                    break;
                };
                let bytes = match message {
                    Message::Text(text) => text,
                    Message::Ping(bytes) => {
                        let pong =
                            async { read_sink.lock().await.send(Message::Pong(bytes)).await };
                        if !tokio::time::timeout(Duration::from_secs(1), pong)
                            .await
                            .is_ok_and(|r| r.is_ok())
                        {
                            break;
                        }
                        continue;
                    }
                    Message::Pong(_) => continue,
                    _ => break,
                };
                let Ok(value) = serde_json::from_str::<Value>(&bytes) else {
                    break;
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    let sender = read_pending
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.remove(&id));
                    if let Some(sender) = sender {
                        let _ = sender.send(value);
                    }
                } else {
                    let Ok(permit) = Arc::clone(&budget).try_acquire_many_owned(bytes.len() as u32)
                    else {
                        break;
                    };
                    if events
                        .try_send(Event {
                            value,
                            _permit: permit,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
            read_cancel.cancel();
            if let Ok(mut pending) = read_pending.lock() {
                pending.clear();
            }
        });
        (
            Self {
                sink,
                pending,
                next: AtomicU64::new(1),
                cancel,
                reader: Some(reader),
            },
            receive,
        )
    }

    pub(super) async fn command(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        if self.cancel.is_cancelled() {
            return Err(Failure);
        }
        self.pending.lock().map_err(|_| Failure)?.insert(id, send);
        let guard = PendingGuard {
            pending: Arc::clone(&self.pending),
            id,
        };
        let work = async {
            let mut request = json!({"id":id,"method":method,"params":params});
            if let Some(session) = session {
                request
                    .as_object_mut()
                    .ok_or(Failure)?
                    .insert("sessionId".to_owned(), session.into());
            }
            self.sink
                .lock()
                .await
                .send(Message::Text(request.to_string().into()))
                .await
                .map_err(|_| Failure)?;
            receive.await.map_err(|_| Failure)
        };
        let result = tokio::select! { biased; () = self.cancel.cancelled() => Err(Failure), result = tokio::time::timeout(Duration::from_secs(30), work) => result.map_err(|_| Failure)? };
        drop(guard);
        let value = result?;
        if value.get("error").is_some() {
            return Err(Failure);
        }
        value.get("result").cloned().ok_or(Failure)
    }

    pub(super) async fn shutdown(&mut self) {
        self.cancel.cancel();
        if let Some(reader) = self.reader.take() {
            reader.abort();
            let _ = reader.await;
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(reader) = &self.reader {
            reader.abort();
        }
    }
}

struct PendingGuard {
    pending: Pending,
    id: u64,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}
