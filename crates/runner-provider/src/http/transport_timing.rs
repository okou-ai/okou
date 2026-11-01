//! Passive observations of the existing reqwest transport, scoped to one claim.
//!
//! DNS uses the same system GAI service as reqwest's default. Connector timing
//! includes DNS/TCP/TLS/proxy establishment, not separate socket/TLS timers.
//! Hyper can race setup against pool checkout: connector activity does not
//! identify the connection that served a request or a physical socket write.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use futures_util::future::{BoxFuture, FutureExt as _};
use hyper_util::client::legacy::connect::dns::{GaiResolver, Name as HyperName};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use runner_types::ids::RunId;
use tower_layer::Layer;
use tower_service::Service;
use tracing::{Dispatch, info};

use super::{PreparedApiRequest, ProviderResult, Response};
use crate::error::ApiRequestContext;

tokio::task_local! {
    static CURRENT: Observer;
}

// This limits diagnostic records only, never transport attempts or retries.
const MAX_PHASE_RECORDS: u32 = 4;

#[derive(Clone)]
struct Observer(Arc<Observation>);

struct Observation {
    state: Mutex<State>,
    started: Instant,
    run_id: RunId,
    context: ApiRequestContext,
    dispatch: Dispatch,
}

#[derive(Default)]
struct State {
    frozen: bool,
    dns: Phase,
    connect: Phase,
}

/// Saturating, fixed-size counts include unfinished attempts at request end.
#[derive(Clone, Copy, Default)]
struct Phase {
    started: u32,
    succeeded: u32,
    failed: u32,
    dropped: u32,
    active: u32,
    terminal_ms: u64,
}

impl Phase {
    fn terminal_duration_ms(self) -> Option<u64> {
        (self.succeeded > 0 || self.failed > 0 || self.dropped > 0).then_some(self.terminal_ms)
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Dns,
    Connect,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dns => "dns",
            Self::Connect => "connect",
        }
    }
}

impl State {
    fn phase(&mut self, kind: Kind) -> &mut Phase {
        match kind {
            Kind::Dns => &mut self.dns,
            Kind::Connect => &mut self.connect,
        }
    }
}

impl Observer {
    fn new(started: Instant, run_id: RunId, context: ApiRequestContext) -> Self {
        Self(Arc::new(Observation {
            state: Mutex::new(State::default()),
            started,
            run_id,
            context,
            dispatch: tracing::dispatcher::get_default(Clone::clone),
        }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    async fn scope<F: Future>(&self, future: F) -> F::Output {
        CURRENT.scope(self.clone(), future).await
    }

    fn start(&self, kind: Kind) -> Option<PhaseGuard> {
        let started = Instant::now();
        let mut state = self.state();
        if state.frozen {
            return None;
        }
        let phase = state.phase(kind);
        phase.started = phase.started.saturating_add(1);
        phase.active = phase.active.saturating_add(1);
        let index = phase.started;
        // Serialize synchronous records with freeze; nothing awaits or starts
        // background logging while holding this short per-request lock.
        self.record_phase(kind, index, "started", None);
        Some(PhaseGuard {
            observer: self.clone(),
            kind,
            index,
            started,
            finished: false,
        })
    }

    fn finish(&self, kind: Kind, index: u32, success: Option<bool>, elapsed: Duration) {
        let mut state = self.state();
        if state.frozen {
            return;
        }
        let phase = state.phase(kind);
        phase.active = phase.active.saturating_sub(1);
        let (count, outcome) = match success {
            Some(true) => (&mut phase.succeeded, "succeeded"),
            Some(false) => (&mut phase.failed, "failed"),
            None => (&mut phase.dropped, "dropped"),
        };
        *count = count.saturating_add(1);
        phase.terminal_ms = phase.terminal_ms.saturating_add(millis(elapsed));
        self.record_phase(kind, index, outcome, Some(millis(elapsed)));
    }

    fn record_phase(&self, kind: Kind, index: u32, outcome: &'static str, elapsed_ms: Option<u64>) {
        if index > MAX_PHASE_RECORDS {
            return;
        }
        tracing::dispatcher::with_default(&self.0.dispatch, || {
            info!(
                run_id = %self.0.run_id,
                client_request_id = %self.0.context.client_request_id,
                client_session_id = %self.0.context.client_session_id,
                client_version = %self.0.context.client_version,
                phase = kind.as_str(), attempt = index, outcome,
                execution_elapsed_ms = millis(self.0.started.elapsed()),
                phase_elapsed_ms = elapsed_ms,
                "claim transport phase"
            )
        });
    }
}

struct PhaseGuard {
    observer: Observer,
    kind: Kind,
    index: u32,
    started: Instant,
    finished: bool,
}

impl PhaseGuard {
    fn finish(mut self, success: bool) {
        self.observer
            .finish(self.kind, self.index, Some(success), self.started.elapsed());
        self.finished = true;
    }
}

impl Drop for PhaseGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.observer
                .finish(self.kind, self.index, None, self.started.elapsed());
        }
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

pub(super) struct TimedResolver<R = GaiResolver>(R);

impl Default for TimedResolver {
    fn default() -> Self {
        Self(GaiResolver::new())
    }
}

impl<R> Resolve for TimedResolver<R>
where
    R: Service<HyperName, Error = std::io::Error> + Clone + Send + Sync + 'static,
    R::Future: Send,
    R::Response: Iterator<Item = SocketAddr> + Send + 'static,
{
    fn resolve(&self, name: Name) -> Resolving {
        // reqwest's Name wraps the same Hyper name. This retains the default
        // system lookup, address ordering, errors and blocking-work lifetime.
        let name = name.as_str().parse::<HyperName>();
        let mut resolver = self.0.clone();
        let guard = CURRENT
            .try_with(|observer| observer.start(Kind::Dns))
            .ok()
            .flatten();
        Box::pin(async move {
            let result = match name {
                Ok(name) => resolver
                    .call(name)
                    .await
                    .map(|addrs| Box::new(addrs) as Addrs)
                    .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>),
                Err(error) => Err(Box::new(error) as Box<dyn std::error::Error + Send + Sync>),
            };
            if let Some(guard) = guard {
                guard.finish(result.is_ok());
            }
            result
        })
    }
}

#[derive(Clone, Copy)]
pub(super) struct ConnectionTimingLayer;

impl<S> Layer<S> for ConnectionTimingLayer {
    type Service = ConnectionTimingService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        ConnectionTimingService(inner)
    }
}

#[derive(Clone)]
pub(super) struct ConnectionTimingService<S>(S);

impl<S, Request> Service<Request> for ConnectionTimingService<S>
where
    S: Service<Request>,
    S::Future: Send + 'static,
    S::Response: Send + 'static,
    S::Error: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = BoxFuture<'static, Result<S::Response, S::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0.poll_ready(cx)
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let observer = CURRENT.try_with(Clone::clone).ok();
        let guard = observer
            .as_ref()
            .and_then(|observer| observer.start(Kind::Connect));
        let future = self.0.call(request);
        async move {
            // Hyper can move setup to its executor. Carry the original
            // observer with that future, not the task that later polls it.
            let result = if let Some(observer) = observer {
                observer.scope(future).await
            } else {
                future.await
            };
            if let Some(guard) = guard {
                guard.finish(result.is_ok());
            }
            result
        }
        .boxed()
    }
}

struct ClaimObservation {
    observer: Observer,
    outcome: &'static str,
}

impl Drop for ClaimObservation {
    fn drop(&mut self) {
        let (dns, connect) = {
            let mut state = self.observer.state();
            state.frozen = true;
            (state.dns, state.connect)
        };
        // A losing speculative connector can outlive a pool checkout. Freeze
        // active counts here; late work cannot mutate or log this attempt.
        let observation = &self.observer.0;
        tracing::dispatcher::with_default(&observation.dispatch, || {
            info!(
                run_id = %observation.run_id,
                client_request_id = %observation.context.client_request_id,
                client_session_id = %observation.context.client_session_id,
                client_version = %observation.context.client_version,
                outcome = self.outcome,
                execution_to_transport_end_ms = millis(observation.started.elapsed()),
                dns_started = dns.started, dns_succeeded = dns.succeeded,
                dns_failed = dns.failed, dns_dropped = dns.dropped,
                dns_active_at_end = dns.active, dns_terminal_duration_ms = dns.terminal_duration_ms(),
                connect_started = connect.started, connect_succeeded = connect.succeeded,
                connect_failed = connect.failed, connect_dropped = connect.dropped,
                connect_active_at_end = connect.active, connect_terminal_duration_ms = connect.terminal_duration_ms(),
                phase_records_truncated = dns.started > MAX_PHASE_RECORDS || connect.started > MAX_PHASE_RECORDS,
                "claim transport completed"
            )
        });
    }
}

pub(super) async fn send_claim(
    prepared: PreparedApiRequest,
    run_id: RunId,
    execution_started_at: Instant,
) -> ProviderResult<Response> {
    let observer = Observer::new(execution_started_at, run_id, prepared.context().clone());
    // A dropped client future does not establish the server's claim outcome.
    let mut observation = ClaimObservation {
        observer: observer.clone(),
        outcome: "dropped",
    };
    let result = observer.scope(prepared.send()).await;
    observation.outcome = if result.is_ok() {
        "response_headers"
    } else {
        "request_failed"
    };
    result
}

#[cfg(test)]
mod tests;
