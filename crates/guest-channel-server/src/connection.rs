use std::{
    collections::{HashMap, HashSet},
    io::{self, Write},
    panic::AssertUnwindSafe,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use api_contracts::generated::{
    constants::sandbox_channel as limits, types::sandbox_channel::MessageResponseError,
};
use futures_util::FutureExt;
use guest_contracts::sandbox_channel::{self as contract, Message, ResultPayload, Role};
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot},
    task::JoinSet,
    time::{Instant, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;

use crate::{
    Categories, ChannelError, Echo, Error, EventError, Notice, Operation, Params, Service,
};

const REQUEST_WAIT: Duration = Duration::from_millis(limits::REQUEST_TIMEOUT_MS as u64);
const HELLO_WAIT: Duration = Duration::from_millis(limits::HELLO_TIMEOUT_MS as u64);
const WRITE_WAIT: Duration = Duration::from_millis(limits::WRITE_TIMEOUT_MS as u64);

struct Pending {
    operation: Operation,
    result: oneshot::Sender<Result<ResultPayload, Error>>,
}
#[derive(Default)]
struct State {
    remote: Option<Categories>,
    pending: HashMap<String, Pending>,
    incoming: HashSet<String>,
}
struct Packet {
    bytes: Vec<u8>,
    deadline: Instant,
    pending_id: Option<String>,
    _frame: OwnedSemaphorePermit,
    _bytes: OwnedSemaphorePermit,
}
struct Inner {
    local: Categories,
    state: Mutex<State>,
    closed: CancellationToken,
    queue: mpsc::Sender<Packet>,
    frames: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    work: Arc<Semaphore>,
    service: Arc<dyn Service>,
    observer_live: AtomicBool,
}

/// An epoch-bound handle for reverse RPC and one-way notices.
/// Captured handles never reconnect and reject work after their owner closes.
#[derive(Clone)]
pub struct Peer(Arc<Inner>);

impl Peer {
    /// Observe the exact connection's cancellation during service work.
    pub fn cancellation(&self) -> CancellationToken {
        self.0.closed.clone()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        match self.0.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                // Preserve the actual records for cleanup, but revoke the
                // poisoned epoch before any further producer can write.
                self.0.closed.cancel();
                poisoned.into_inner()
            }
        }
    }

    fn id(&self) -> Result<String, Error> {
        let mut bytes = [0; 16];
        if getrandom::fill(&mut bytes).is_err() {
            self.close();
            return Err(Error::Unavailable);
        }
        Ok(uuid::Builder::from_random_bytes(bytes)
            .into_uuid()
            .to_string())
    }

    fn close(&self) {
        self.0.closed.cancel();
        self.state().pending.clear();
    }

    fn write(&self, message: &Message, pending_id: Option<String>) -> Result<(), Error> {
        if self.0.closed.is_cancelled() {
            return Err(Error::Unavailable);
        }
        let bytes = encode(message)?;
        // Permits account for the active write as well as queued frames. They
        // stay with physical IO, not just its queue receiver.
        let frame = Arc::clone(&self.0.frames)
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let byte_count = u32::try_from(bytes.len()).map_err(|_| Error::Unavailable)?;
        let byte_permit = Arc::clone(&self.0.bytes)
            .try_acquire_many_owned(byte_count)
            .map_err(|_| Error::Busy)?;
        self.0
            .queue
            .try_send(Packet {
                bytes,
                deadline: Instant::now() + WRITE_WAIT,
                pending_id,
                _frame: frame,
                _bytes: byte_permit,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                mpsc::error::TrySendError::Closed(_) => Error::Unavailable,
            })
    }

    fn response(
        &self,
        request_id: String,
        outcome: Result<Value, MessageResponseError>,
    ) -> Result<(), Error> {
        let (result, error) = match outcome {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        self.write(
            &Message::Response {
                schema_version: i64::from(limits::SCHEMA_VERSION),
                id: self.id()?,
                request_id,
                result,
                error,
            },
            None,
        )
    }

    /// Call a captured current operation in the Guest-to-external direction.
    /// Parameters/results use the shared validators. Dropping the future removes
    /// its pending registration and suppresses an unsent queued request.
    pub async fn request(
        &self,
        category: &str,
        version: u64,
        name: &str,
        params: Value,
    ) -> Result<ResultPayload, Error> {
        if self.0.closed.is_cancelled() {
            return Err(Error::Unavailable);
        }
        let operation = {
            let state = self.state();
            let remote = state.remote.as_ref().ok_or(Error::Unavailable)?;
            contract::operation_contract(
                category,
                version,
                name,
                Role::Guest,
                &self.0.local,
                remote,
            )?
        };
        let params = match contract::decode_params(operation, params)? {
            Params::Echo(value) => serde_json::to_value(value),
            Params::FsList(value) => serde_json::to_value(value),
            Params::FsListClose(value) => serde_json::to_value(value),
        }
        .map_err(|_| Error::Unavailable)?;
        let id = self.id()?;
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.state();
            if state.pending.len() >= limits::MAX_PENDING as usize {
                return Err(Error::Busy);
            }
            if state.pending.contains_key(&id) {
                drop(state);
                self.close();
                return Err(Error::Unavailable);
            }
            state.pending.insert(
                id.clone(),
                Pending {
                    operation,
                    result: sender,
                },
            );
        }
        let _pending = PendingGuard {
            peer: self.clone(),
            id: id.clone(),
        };
        let deadline = Instant::now() + REQUEST_WAIT;
        self.write(
            &Message::Request {
                schema_version: i64::from(limits::SCHEMA_VERSION),
                id: id.clone(),
                category: category.to_owned(),
                category_version: version,
                operation: name.to_owned(),
                params,
            },
            Some(id),
        )?;
        tokio::select! {
            _ = self.0.closed.cancelled() => Err(Error::Unavailable),
            result = timeout_at(deadline, receiver) => match result {
                Err(_) => Err(Error::TimedOut),
                Ok(Err(_)) => Err(Error::Unavailable),
                Ok(Ok(result)) => result,
            }
        }
    }

    /// Perform the either-direction typed diagnostics echo.
    pub async fn echo(&self, echo: Echo) -> Result<Echo, Error> {
        let params = serde_json::to_value(echo).map_err(|_| Error::Unavailable)?;
        match self
            .request(
                "diagnostics",
                u64::from(limits::diagnostics::VERSION),
                "echo",
                params,
            )
            .await?
        {
            ResultPayload::Echo(echo) => Ok(echo),
            _ => Err(ChannelError::InvalidRequest.into()),
        }
    }

    /// Emit one validated notice without a response, ACK or replay promise.
    pub fn notice(&self, notice: Notice) -> Result<(), Error> {
        if self.0.closed.is_cancelled() {
            return Err(Error::Unavailable);
        }
        let data = serde_json::to_value(notice).map_err(|_| Error::Unavailable)?;
        {
            let state = self.state();
            let remote = state.remote.as_ref().ok_or(Error::Unavailable)?;
            contract::decode_notice(
                "diagnostics",
                u64::from(limits::diagnostics::VERSION),
                "notice",
                data.clone(),
                &self.0.local,
                remote,
            )?;
        }
        self.write(
            &Message::Event {
                schema_version: i64::from(limits::SCHEMA_VERSION),
                id: self.id()?,
                category: "diagnostics".to_owned(),
                category_version: u64::from(limits::diagnostics::VERSION),
                event: "notice".to_owned(),
                data,
            },
            None,
        )
    }

    fn event_error(&self, category: String, event: String, error: Error) {
        if self.0.closed.is_cancelled() || !self.0.observer_live.load(Ordering::Acquire) {
            return;
        }
        if std::panic::catch_unwind(AssertUnwindSafe(|| {
            self.0.service.event_error(EventError {
                category,
                event,
                error,
            });
        }))
        .is_err()
        {
            self.0.observer_live.store(false, Ordering::Release);
        }
    }
}

struct PendingGuard {
    peer: Peer,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.peer.state().pending.remove(&self.id);
    }
}
struct WorkGuard {
    peer: Peer,
    id: Option<String>,
    _permit: OwnedSemaphorePermit,
}
impl Drop for WorkGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            self.peer.state().incoming.remove(id);
        }
    }
}
struct EpochGuard(Peer);
impl Drop for EpochGuard {
    fn drop(&mut self) {
        self.0.close();
    }
}

fn wire_error(error: Error) -> MessageResponseError {
    MessageResponseError {
        code: error.code().to_owned(),
        category: None,
        expected_version: None,
        received_version: None,
    }
}
fn remote_error(error: MessageResponseError) -> Error {
    use ChannelError as C;
    match error.code.as_str() {
        "unsupported_schema" => C::UnsupportedSchema.into(),
        "invalid_request" => C::InvalidRequest.into(),
        "invalid_params" => C::InvalidParams.into(),
        "unsupported_category" => C::UnsupportedCategory.into(),
        "category_version_mismatch" => C::CategoryVersionMismatch.into(),
        "unknown_operation" => C::UnknownOperation.into(),
        "forbidden" => C::Forbidden.into(),
        "limit_exceeded" => C::LimitExceeded.into(),
        "busy" => Error::Busy,
        "outside_home" => Error::OutsideHome,
        "not_found" => Error::NotFound,
        "not_directory" => Error::NotDirectory,
        "link_not_expandable" => Error::LinkNotExpandable,
        "mount_not_expandable" => Error::MountNotExpandable,
        "directory_changed" => Error::DirectoryChanged,
        "cursor_expired" => Error::CursorExpired,
        _ => Error::Unavailable,
    }
}
fn invalid_data() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid sandbox channel")
}

struct BoundedBytes(Vec<u8>);
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > limits::MAX_FRAME_BYTES as usize {
            return Err(invalid_data());
        }
        self.0
            .try_reserve(bytes.len())
            .map_err(|_| io::Error::from(io::ErrorKind::OutOfMemory))?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode(message: &Message) -> Result<Vec<u8>, Error> {
    let mut bytes = BoundedBytes(Vec::new());
    serde_json::to_writer(&mut bytes, message).map_err(|_| Error::Unavailable)?;
    Ok(bytes.0)
}

async fn reader<R: AsyncRead + Unpin>(
    mut read: R,
    sender: mpsc::Sender<Message>,
) -> io::Result<()> {
    loop {
        let mut first = [0];
        if read.read(&mut first).await? == 0 {
            return Ok(());
        }
        let mut remaining = [0; 3];
        read.read_exact(&mut remaining).await?;
        let [first] = first;
        let [second, third, fourth] = remaining;
        let size = u32::from_be_bytes([first, second, third, fourth]) as usize;
        if size > limits::MAX_FRAME_BYTES as usize {
            return Err(invalid_data());
        }
        let mut bytes = vec![0; size];
        read.read_exact(&mut bytes).await?;
        let message = contract::decode_message(&bytes).map_err(|_| invalid_data())?;
        if sender.send(message).await.is_err() {
            return Ok(());
        }
    }
}
async fn writer<W: AsyncWrite + Unpin>(
    mut write: W,
    mut queue: mpsc::Receiver<Packet>,
    peer: Peer,
) -> io::Result<()> {
    while let Some(packet) = queue.recv().await {
        if let Some(id) = &packet.pending_id
            && !peer.state().pending.contains_key(id)
        {
            continue;
        }
        if peer.0.closed.is_cancelled() {
            return Ok(());
        }
        if Instant::now() >= packet.deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let length = u32::try_from(packet.bytes.len())
            .map_err(|_| invalid_data())?
            .to_be_bytes();
        timeout_at(packet.deadline, async {
            write.write_all(&length).await?;
            write.write_all(&packet.bytes).await?;
            write.flush().await
        })
        .await
        .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
    }
    write.shutdown().await
}

pub(super) async fn serve<T>(mut stream: T, service: Arc<dyn Service>) -> io::Result<()>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let local = service.categories();
    contract::decode_hello_result(serde_json::json!({"categories": local}))
        .map_err(|_| invalid_data())?;
    let (sender, queue) = mpsc::channel(limits::MAX_QUEUED_FRAMES as usize);
    let peer = Peer(Arc::new(Inner {
        local,
        state: Mutex::new(State::default()),
        closed: CancellationToken::new(),
        queue: sender,
        frames: Arc::new(Semaphore::new(limits::MAX_QUEUED_FRAMES as usize)),
        bytes: Arc::new(Semaphore::new(limits::MAX_QUEUED_BYTES as usize)),
        work: Arc::new(Semaphore::new(limits::MAX_INCOMING as usize)),
        service,
        observer_live: AtomicBool::new(true),
    }));
    let _epoch = EpochGuard(peer.clone());
    // Only a successfully initialized runtime/state may acknowledge activation.
    timeout(
        HELLO_WAIT,
        stream.write_all(&[guest_contracts::private_duplex::ACTIVATED]),
    )
    .await
    .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
    let (read, write) = tokio::io::split(stream);
    let (messages_tx, mut messages) = mpsc::channel(1);
    // JoinSet also aborts owned IO when an outer caller drops this serve future.
    let mut io_tasks = JoinSet::new();
    io_tasks.spawn(reader(read, messages_tx));
    io_tasks.spawn(writer(write, queue, peer.clone()));
    let mut work = JoinSet::new();
    let hello_deadline = Instant::now() + HELLO_WAIT;
    let mut ready = false;
    let result = loop {
        while let Some(result) = work.try_join_next() {
            if result.is_err() {
                peer.close();
            }
        }
        tokio::select! {
            _ = peer.0.closed.cancelled() => break Err(io::Error::other("sandbox channel closed")),
            _ = tokio::time::sleep_until(hello_deadline), if !ready => break Err(io::ErrorKind::TimedOut.into()),
            result = io_tasks.join_next() => break match result {
                Some(Ok(result)) => result,
                _ => Err(io::Error::other("sandbox channel IO failed")),
            },
            result = work.join_next(), if !work.is_empty() => {
                if result.is_some_and(|result| result.is_err()) { peer.close(); }
            },
            message = messages.recv() => {
                let Some(message) = message else {
                    break match io_tasks.join_next().await {
                        Some(Ok(result)) => result,
                        _ => Err(io::Error::other("sandbox channel reader failed")),
                    };
                };
                let routed = route(&peer, message, &mut ready, &mut work);
                if let Err(error) = routed { break Err(error); }
            }
        }
    };
    peer.close();
    work.abort_all();
    while work.join_next().await.is_some() {}
    io_tasks.abort_all();
    while io_tasks.join_next().await.is_some() {}
    result
}

fn route(
    peer: &Peer,
    message: Message,
    ready: &mut bool,
    work: &mut JoinSet<()>,
) -> io::Result<()> {
    match message {
        Message::Hello { id, categories, .. } if !*ready => {
            let result = serde_json::json!({"categories": peer.0.local});
            peer.response(id, Ok(result)).map_err(|_| invalid_data())?;
            peer.state().remote = Some(categories);
            *ready = true;
            // FIFO ordering makes the hello response precede the first event.
            let matching = {
                let state = peer.state();
                state.remote.as_ref().is_some_and(|remote| {
                    contract::category_gate(
                        "diagnostics",
                        u64::from(limits::diagnostics::VERSION),
                        &peer.0.local,
                        remote,
                    )
                    .is_ok()
                })
            };
            if matching {
                peer.notice(Notice {
                    message: "ready".to_owned(),
                })
                .map_err(|_| invalid_data())?;
            }
            Ok(())
        }
        Message::Response {
            request_id,
            result,
            error,
            ..
        } if *ready => {
            let pending = peer.state().pending.remove(&request_id);
            if let Some(pending) = pending {
                let result = match (result, error) {
                    (Some(value), None) => {
                        contract::decode_result(pending.operation, value).map_err(Error::from)
                    }
                    (None, Some(error)) => Err(remote_error(error)),
                    _ => Err(ChannelError::InvalidRequest.into()),
                };
                let _ = pending.result.send(result);
            }
            Ok(())
        }
        Message::Request {
            id,
            category,
            category_version,
            operation,
            params,
            ..
        } if *ready => request(
            peer,
            id,
            category,
            category_version,
            operation,
            params,
            work,
        ),
        Message::Event {
            category,
            category_version,
            event,
            data,
            ..
        } if *ready => {
            event_message(peer, category, category_version, event, data, work);
            Ok(())
        }
        _ => Err(invalid_data()),
    }
}

fn request(
    peer: &Peer,
    id: String,
    category: String,
    version: u64,
    operation: String,
    params: Value,
    work: &mut JoinSet<()>,
) -> io::Result<()> {
    if peer.state().incoming.contains(&id) {
        return Err(invalid_data());
    }
    let admitted = (|| {
        let selected = {
            let state = peer.state();
            let remote = state.remote.as_ref().ok_or(Error::Unavailable)?;
            contract::operation_contract(
                &category,
                version,
                &operation,
                Role::External,
                &peer.0.local,
                remote,
            )?
        };
        let params = contract::decode_params(selected, params)?;
        let permit = Arc::clone(&peer.0.work)
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        Ok::<_, Error>((selected, params, permit))
    })();
    let (operation, params, permit) = match admitted {
        Ok(work) => work,
        Err(error) => {
            let mut response = wire_error(error);
            if matches!(
                error,
                Error::Contract(
                    ChannelError::UnsupportedCategory | ChannelError::CategoryVersionMismatch
                )
            ) {
                response.category = Some(category.clone());
            }
            if error == Error::Contract(ChannelError::CategoryVersionMismatch) {
                let state = peer.state();
                if let Some(expected) = peer.0.local.get(&category) {
                    response.expected_version = Some(*expected);
                    response.received_version = Some(if version != *expected {
                        version
                    } else {
                        let Some(received) = state
                            .remote
                            .as_ref()
                            .and_then(|remote| remote.get(&category))
                        else {
                            return Err(invalid_data());
                        };
                        *received
                    });
                }
            }
            return peer.response(id, Err(response)).map_err(|_| invalid_data());
        }
    };
    peer.state().incoming.insert(id.clone());
    let peer = peer.clone();
    let guard = WorkGuard {
        peer: peer.clone(),
        id: Some(id.clone()),
        _permit: permit,
    };
    work.spawn(async move {
        let _guard = guard;
        if peer.0.closed.is_cancelled() {
            return;
        }
        let service = Arc::clone(&peer.0.service);
        let outcome = timeout(
            REQUEST_WAIT,
            AssertUnwindSafe(async { service.request(operation, params, peer.clone()).await })
                .catch_unwind(),
        )
        .await;
        let outcome = match outcome {
            Err(_) => Err(Error::TimedOut),
            Ok(Err(_)) => Err(Error::Unavailable),
            Ok(Ok(result)) => result,
        }
        .and_then(|value| {
            contract::decode_result(operation, value.clone()).map_err(|_| Error::Unavailable)?;
            Ok(value)
        })
        .map_err(wire_error);
        if !peer.0.closed.is_cancelled() && peer.response(id, outcome).is_err() {
            peer.close();
        }
    });
    Ok(())
}

fn event_message(
    peer: &Peer,
    category: String,
    version: u64,
    event: String,
    data: Value,
    work: &mut JoinSet<()>,
) {
    if category != "diagnostics" || event != "notice" {
        return;
    }
    let decoded = {
        let state = peer.state();
        let Some(remote) = &state.remote else {
            return;
        };
        if contract::category_gate(&category, version, &peer.0.local, remote).is_err() {
            return;
        }
        contract::decode_notice(&category, version, &event, data, &peer.0.local, remote)
    };
    let notice = match decoded {
        Ok(notice) => notice,
        Err(error) => {
            peer.event_error(category, event, error.into());
            return;
        }
    };
    let permit = match Arc::clone(&peer.0.work).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            peer.event_error(category, event, Error::Busy);
            return;
        }
    };
    let peer = peer.clone();
    let guard = WorkGuard {
        peer: peer.clone(),
        id: None,
        _permit: permit,
    };
    work.spawn(async move {
        let _guard = guard;
        if peer.0.closed.is_cancelled() {
            return;
        }
        let service = Arc::clone(&peer.0.service);
        let result = timeout(
            REQUEST_WAIT,
            AssertUnwindSafe(async { service.notice(notice, peer.clone()).await }).catch_unwind(),
        )
        .await;
        let error = match result {
            Ok(Ok(Ok(()))) => return,
            Ok(Ok(Err(error))) => error,
            Ok(Err(_)) => Error::Unavailable,
            Err(_) => Error::TimedOut,
        };
        peer.event_error(category, event, error);
    });
}
