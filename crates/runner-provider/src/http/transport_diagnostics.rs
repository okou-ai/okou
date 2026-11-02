//! Best-effort, local INFO evidence. Never add these fields to ProviderError:
//! callers report those errors remotely, whereas this recorder stays on-host.

use std::collections::VecDeque;
use std::error::Error as _;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::future::{BoxFuture, FutureExt as _};
use hyper_util::client::legacy::connect::{Connection, HttpInfo};
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;
use tower_layer::Layer;
use tower_service::Service;
use tracing::{Dispatch, info};

use crate::error::ApiRequestContext;

#[cfg(target_os = "linux")]
mod capture;
#[cfg(test)]
mod tests;

const TARGET: &str = "runner_provider::http::transport_diagnostics";
const HISTORY: Duration = Duration::from_secs(60);
const AFTER_FAILURE: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 128;
const MAX_PACKETS: usize = 2048;
const MAX_BEFORE: usize = 32;
const MAX_AFTER: usize = 32;
// Keep room for a close/reset when queued data arrives after the fault.
const RESERVED_CLOSE_PACKETS: usize = 8;
const MAX_FAULTS: usize = 8;

tokio::task_local! {
    static CURRENT: RequestObservation;
}

#[derive(Clone)]
struct RequestObservation {
    diagnostics: TransportDiagnostics,
    request_id: Arc<str>,
}

#[derive(Clone)]
pub(super) struct TransportDiagnostics(Arc<Owner>);

struct Owner {
    shared: Arc<Shared>,
    faults: mpsc::Sender<Fault>,
    task: Option<JoinHandle<()>>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

struct Shared {
    state: Mutex<State>,
    changed: Notify,
    dispatch: Dispatch,
    dropped_updates: AtomicU64,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    // Diagnostic contention must never become an HTTP admission wait.
    fn try_state(&self) -> Option<MutexGuard<'_, State>> {
        match self.state.try_lock() {
            Ok(state) => Some(state),
            Err(TryLockError::Poisoned(error)) => Some(error.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Tuple {
    local: SocketAddr,
    remote: SocketAddr,
}

impl Tuple {
    fn from_info(info: &HttpInfo) -> Self {
        Self {
            local: info.local_addr(),
            remote: info.remote_addr(),
        }
    }
}

#[derive(Clone)]
struct ObservedConnection {
    tuple: Tuple,
    id: u64,
    registered: Instant,
    registered_unix_ns: u64,
    registered_for: Arc<str>,
    ambiguous: bool,
    responses: u64,
    last_response: Option<Instant>,
    last_payload: Option<Instant>,
}

impl ObservedConnection {
    fn can_attribute(&self, request_id: &str, started: Instant) -> bool {
        // A registration created by another request after this send began
        // cannot identify its generation, including after registry eviction.
        !self.ambiguous
            && (self.registered <= started || self.registered_for.as_ref() == request_id)
    }
}

struct State {
    connections: VecDeque<ObservedConnection>,
    packets: VecDeque<RecordedPacket>,
    revision: u64,
    filter_revision: u64,
    evicted_connections: u64,
    evicted_packets: u64,
    kernel_drops: Option<u64>,
    capture_status: &'static str,
}

impl Default for State {
    fn default() -> Self {
        Self {
            connections: VecDeque::new(),
            packets: VecDeque::new(),
            revision: 0,
            filter_revision: 0,
            evicted_connections: 0,
            evicted_packets: 0,
            kernel_drops: None,
            capture_status: "unavailable",
        }
    }
}

#[derive(Clone, Debug)]
struct Packet {
    source: SocketAddr,
    destination: SocketAddr,
    unix_ns: u64,
    flags: u8,
    sequence: u32,
    acknowledgment: u32,
    window: u16,
    payload_bytes: u32,
}

#[derive(Clone)]
struct RecordedPacket {
    connection_id: u64,
    observed: Instant,
    outbound: bool,
    packet: Packet,
}

impl State {
    fn register(&mut self, tuple: Tuple, registered_for: Arc<str>) {
        // A repeated tuple is not an eternal socket identity. Keep ambiguity
        // explicit rather than attaching an old generation's packets to a fault.
        let previous = self.connections.iter().position(|c| c.tuple == tuple);
        if let Some(index) = previous {
            self.connections.remove(index);
        } else if self.connections.len() == MAX_CONNECTIONS {
            self.connections.pop_front();
            self.evicted_connections = self.evicted_connections.saturating_add(1);
        }
        self.revision = self.revision.saturating_add(1);
        self.connections.push_back(ObservedConnection {
            tuple,
            id: self.revision,
            registered: Instant::now(),
            registered_unix_ns: unix_ns(),
            registered_for,
            ambiguous: previous.is_some(),
            responses: 0,
            last_response: None,
            last_payload: None,
        });
    }

    fn record(&mut self, packet: Packet) -> Option<RecordedPacket> {
        let connection = self.connections.iter_mut().find(|c| {
            (packet.source == c.tuple.local && packet.destination == c.tuple.remote)
                || (packet.source == c.tuple.remote && packet.destination == c.tuple.local)
        })?;
        // Kernel timestamps exclude traffic queued before this registration.
        if connection.ambiguous
            || packet.unix_ns < connection.registered_unix_ns
            || packet.unix_ns > unix_ns()
        {
            return None;
        }
        // Setup finished before registration. A later SYN on the same tuple
        // may belong to another process/guest after port reuse, or be delayed
        // handshake traffic. Neither is safe evidence for this generation.
        if packet.flags & 0x02 != 0 {
            connection.ambiguous = true;
            self.revision = self.revision.saturating_add(1);
            return None;
        }
        let now = Instant::now();
        if packet.payload_bytes > 0 {
            connection.last_payload = Some(now);
        }
        let record = RecordedPacket {
            connection_id: connection.id,
            observed: now,
            outbound: packet.source == connection.tuple.local,
            packet,
        };
        while self
            .packets
            .front()
            .is_some_and(|p| now.duration_since(p.observed) > HISTORY)
        {
            self.packets.pop_front();
        }
        if self.packets.len() == MAX_PACKETS {
            self.packets.pop_front();
            self.evicted_packets = self.evicted_packets.saturating_add(1);
        }
        self.packets.push_back(record.clone());
        Some(record)
    }
}

struct Fault {
    request_id: String,
    connection_id: u64,
    deadline: tokio::time::Instant,
    observed_at: Instant,
}

impl TransportDiagnostics {
    pub(super) fn new() -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: Notify::new(),
            dispatch: tracing::dispatcher::get_default(Clone::clone),
            dropped_updates: AtomicU64::new(0),
        });
        let (faults, receiver) = mpsc::channel(MAX_FAULTS);
        #[cfg(target_os = "linux")]
        let task = capture::start(Arc::clone(&shared), receiver);
        #[cfg(not(target_os = "linux"))]
        let task = {
            drop(receiver);
            info!(target: TARGET, capture_status = "unsupported_platform", "API TCP capture unavailable");
            None
        };
        Self(Arc::new(Owner {
            shared,
            faults,
            task,
        }))
    }

    pub(super) async fn scope<F: Future>(&self, request_id: &str, future: F) -> F::Output {
        CURRENT
            .scope(
                RequestObservation {
                    diagnostics: self.clone(),
                    request_id: Arc::from(request_id),
                },
                future,
            )
            .await
    }

    fn connected(&self, info: &HttpInfo, request_id: Arc<str>) {
        if let Some(mut state) = self.0.shared.try_state() {
            state.register(Tuple::from_info(info), request_id);
            drop(state);
            self.0.shared.changed.notify_one();
        } else {
            self.0
                .shared
                .dropped_updates
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(super) fn response(
        &self,
        response: &reqwest::Response,
        request_id: &str,
        started: Instant,
    ) {
        let Some(info) = response.extensions().get::<HttpInfo>() else {
            return;
        };
        if let Some(mut state) = self.0.shared.try_state() {
            if let Some(connection) = state
                .connections
                .iter_mut()
                .find(|c| c.tuple == Tuple::from_info(info))
            {
                if !connection.can_attribute(request_id, started) {
                    self.0
                        .shared
                        .dropped_updates
                        .fetch_add(1, Ordering::Relaxed);
                    return;
                }
                connection.responses = connection.responses.saturating_add(1);
                connection.last_response = Some(Instant::now());
            }
        } else {
            self.0
                .shared
                .dropped_updates
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(super) fn failure(
        &self,
        context: &ApiRequestContext,
        started: Instant,
        error: &reqwest::Error,
    ) {
        let mut source = error.source();
        let mut tuple = None;
        let mut errno = None;
        while let Some(error) = source {
            if let Some(error) = error.downcast_ref::<hyper_util::client::legacy::Error>()
                && let Some(connected) = error.connect_info()
            {
                let mut extras = Default::default();
                connected.get_extras(&mut extras);
                tuple = tuple.or_else(|| extras.get::<HttpInfo>().map(Tuple::from_info));
            }
            if let Some(error) = error.downcast_ref::<std::io::Error>() {
                errno = errno.or(error.raw_os_error());
            }
            source = error.source();
        }
        let observed_at = Instant::now();
        let state = self.0.shared.try_state();
        let connection = state
            .as_ref()
            .and_then(|s| s.connections.iter().find(|c| Some(c.tuple) == tuple))
            .cloned();
        let connection_id = connection.as_ref().map(|c| c.id);
        let ambiguous = connection
            .as_ref()
            .is_some_and(|c| !c.can_attribute(&context.client_request_id, started));
        let capture_status = state.as_ref().map_or("state_busy", |s| s.capture_status);
        let capture_filter_current = state
            .as_ref()
            .is_some_and(|s| s.revision == s.filter_revision);
        let registry_evictions = state.as_ref().map(|s| s.evicted_connections);
        let packet_evictions = state.as_ref().map(|s| s.evicted_packets);
        let kernel_drops = state.as_ref().and_then(|s| s.kernel_drops);
        let fault = connection_id
            .filter(|_| !ambiguous && capture_status == "ready")
            .map(|id| Fault {
                request_id: context.client_request_id.clone(),
                connection_id: id,
                deadline: tokio::time::Instant::now() + AFTER_FAILURE,
                observed_at,
            });
        drop(state);
        let facts = connection.as_ref().filter(|_| !ambiguous);
        info!(
            target: TARGET,
            client_request_id = %context.client_request_id,
            client_session_id = %context.client_session_id,
            client_version = %context.client_version,
            endpoint = context.endpoint_label,
            method = %context.method,
            failure_kind = super::api_failure_kind(error).as_str(),
            failure_cause = super::api_transport_cause(error).as_str(),
            elapsed_ms = millis(started.elapsed()),
            raw_os_error = errno,
            socket_metadata_available = tuple.is_some(),
            local_addr = ?tuple.map(|t| t.local),
            remote_addr = ?tuple.map(|t| t.remote),
            connection_id,
            connection_identity = "tuple_registration_not_kernel_socket_cookie",
            connection_generation_status = if connection_id.is_none() { "unavailable" } else if ambiguous { "ambiguous" } else { "registered" },
            connection_registered_age_ms = facts.map(|c| millis(c.registered.elapsed())),
            responses_observed = facts.map(|c| c.responses),
            last_response_headers_age_ms = facts.and_then(|c| c.last_response.map(|t| millis(t.elapsed()))),
            last_payload_observed_age_ms = facts.and_then(|c| c.last_payload.map(|t| millis(t.elapsed()))),
            capture_status,
            capture_filter_current,
            registry_evictions,
            packet_evictions,
            kernel_drops,
            diagnostic_updates_dropped = self.0.shared.dropped_updates.load(Ordering::Relaxed),
            "API transport failure diagnostics"
        );
        let Some(fault) = fault else {
            return;
        };
        if self.0.faults.try_send(fault).is_err() {
            info!(target: TARGET, client_request_id = %context.client_request_id,
                detail_status = "queue_unavailable", "API TCP evidence omitted");
        }
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn unix_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_nanos()).ok())
        .unwrap_or_default()
}

#[derive(Clone, Copy)]
pub(super) struct ConnectionDiagnosticsLayer;

impl<S> Layer<S> for ConnectionDiagnosticsLayer {
    type Service = ConnectionDiagnosticsService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        ConnectionDiagnosticsService(inner)
    }
}

#[derive(Clone)]
pub(super) struct ConnectionDiagnosticsService<S>(S);

impl<S, Request> Service<Request> for ConnectionDiagnosticsService<S>
where
    S: Service<Request>,
    S::Future: Send + 'static,
    S::Response: Connection + Send + 'static,
    S::Error: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = BoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0.poll_ready(cx)
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let observation = CURRENT.try_with(Clone::clone).ok();
        let future = self.0.call(request);
        async move {
            if let Some(observation) = observation {
                let result = CURRENT.scope(observation.clone(), future).await;
                if let Ok(connection) = &result {
                    let mut extras = Default::default();
                    connection.connected().get_extras(&mut extras);
                    if let Some(info) = extras.get::<HttpInfo>() {
                        observation
                            .diagnostics
                            .connected(info, observation.request_id);
                    }
                }
                result
            } else {
                future.await
            }
        }
        .boxed()
    }
}
