//! Content-free observations around the pinned ureq resolver and connector.
//!
//! The connector remains ureq's complete default chain. Its duration includes
//! TCP, TLS, explicit CONNECT, and any resolution performed inside that chain.
//! The unversioned hooks must be audited when upgrading ureq.

use crate::LOG_TAG;
use guest_telemetry::{log_error, log_info};
use serde::Serialize;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use ureq::config::Config;
use ureq::http::Uri;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, DefaultConnector, NextTimeout, Transport,
};

type SharedState = Rc<RefCell<ObservationState>>;

thread_local! {
    static ACTIVE: RefCell<Option<SharedState>> = const { RefCell::new(None) };
}

static NEXT_CALL: AtomicU64 = AtomicU64::new(1);

pub(crate) fn agent(config: Config) -> ureq::Agent {
    ureq::Agent::with_parts(
        config,
        ObservedConnector(DefaultConnector::default()),
        ObservedResolver(DefaultResolver::default()),
    )
}

fn allocate_call_id(counter: &AtomicU64) -> Option<u64> {
    // Exhaustion loses attribution rather than wrapping into another call's ID.
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .ok()
}

fn active() -> Option<SharedState> {
    ACTIVE.with(|current| current.borrow().clone())
}

pub(crate) struct CallObservation {
    state: Option<SharedState>,
    previous: Option<SharedState>,
    started: Instant,
}

impl CallObservation {
    pub(crate) fn start() -> Self {
        let state = Rc::new(RefCell::new(ObservationState {
            call_id: allocate_call_id(&NEXT_CALL),
            ..ObservationState::default()
        }));
        let previous = ACTIVE.with(|current| current.replace(Some(Rc::clone(&state))));
        Self {
            state: Some(state),
            previous,
            started: Instant::now(),
        }
    }

    pub(crate) fn finish(mut self, elapsed: Duration, response_headers: bool) {
        let outcome = if response_headers {
            CallOutcome::ResponseHeaders
        } else {
            CallOutcome::Error
        };
        self.complete(elapsed, outcome);
    }

    fn complete(&mut self, elapsed: Duration, outcome: CallOutcome) {
        let Some(state) = self.state.take() else {
            return;
        };
        // Neither logging nor later response-body access belongs to this scope.
        ACTIVE.with(|current| current.replace(self.previous.take()));
        let summary = state.borrow().summary(elapsed, outcome);
        match serde_json::to_string(&summary) {
            Ok(json) => {
                log_info!(LOG_TAG, "remote_connection_observation {json}");
            }
            Err(_) => {
                log_error!(LOG_TAG, "Failed to serialize remote connection observation");
            }
        }
    }
}

impl Drop for CallObservation {
    fn drop(&mut self) {
        self.complete(self.started.elapsed(), CallOutcome::Interrupted);
    }
}

#[derive(Default)]
struct ObservationState {
    call_id: Option<u64>,
    connector_depth: usize,
    resolve_outside_setup: Phase,
    resolve_inside_setup: Phase,
    connection_setup: Phase,
    used_new: bool,
    used_prior: bool,
    identity_unavailable: bool,
}

impl ObservationState {
    fn phase(&mut self, kind: PhaseKind) -> &mut Phase {
        match kind {
            PhaseKind::ResolveOutside => &mut self.resolve_outside_setup,
            PhaseKind::ResolveInside => &mut self.resolve_inside_setup,
            PhaseKind::ConnectionSetup => &mut self.connection_setup,
        }
    }

    fn summary(&self, elapsed: Duration, call_outcome: CallOutcome) -> Summary {
        let transport_use = if self.identity_unavailable {
            TransportUse::Unavailable
        } else {
            match (self.used_new, self.used_prior) {
                (false, false) => TransportUse::Unobserved,
                (true, false) => TransportUse::NewForCallOnly,
                (false, true) => TransportUse::PriorCallOnly,
                (true, true) => TransportUse::Mixed,
            }
        };
        Summary {
            call_outcome,
            request_to_response_headers_us: micros(elapsed),
            resolve_outside_setup: self.resolve_outside_setup.summary(),
            resolve_inside_setup: self.resolve_inside_setup.summary(),
            connection_setup: self.connection_setup.summary(),
            transport_use,
        }
    }
}

#[derive(Clone, Copy)]
enum PhaseKind {
    ResolveOutside,
    ResolveInside,
    ConnectionSetup,
}

#[derive(Default)]
struct Phase {
    invocations: u64,
    completed: u64,
    errors: u64,
    interrupted: u64,
    duration: Duration,
}

impl Phase {
    fn summary(&self) -> PhaseSummary {
        let status = if self.invocations == 0 {
            PhaseStatus::NotEntered
        } else if self.interrupted > 0 {
            PhaseStatus::Interrupted
        } else if self.errors == 0 {
            PhaseStatus::Completed
        } else if self.completed == 0 {
            PhaseStatus::Failed
        } else {
            PhaseStatus::Mixed
        };
        PhaseSummary {
            status,
            invocations: self.invocations,
            completed: self.completed,
            errors: self.errors,
            interrupted: self.interrupted,
            duration_us: (self.invocations > 0).then(|| micros(self.duration)),
        }
    }
}

struct PhaseGuard {
    state: SharedState,
    kind: PhaseKind,
    started: Instant,
    result: Option<bool>,
}

impl PhaseGuard {
    fn start(state: SharedState, kind: PhaseKind) -> Self {
        {
            let mut state = state.borrow_mut();
            let phase = state.phase(kind);
            phase.invocations = phase.invocations.saturating_add(1);
        }
        Self {
            state,
            kind,
            started: Instant::now(),
            result: None,
        }
    }

    fn finish(mut self, success: bool) {
        self.result = Some(success);
    }
}

impl Drop for PhaseGuard {
    fn drop(&mut self) {
        let elapsed = self.started.elapsed();
        let mut state = self.state.borrow_mut();
        let phase = state.phase(self.kind);
        phase.duration = phase.duration.saturating_add(elapsed);
        let count = match self.result {
            Some(true) => &mut phase.completed,
            Some(false) => &mut phase.errors,
            None => &mut phase.interrupted,
        };
        *count = count.saturating_add(1);
    }
}

struct ConnectorScope(SharedState);

impl ConnectorScope {
    fn enter(state: SharedState) -> Self {
        state.borrow_mut().connector_depth += 1;
        Self(state)
    }
}

impl Drop for ConnectorScope {
    fn drop(&mut self) {
        self.0.borrow_mut().connector_depth -= 1;
    }
}

#[derive(Debug)]
struct ObservedResolver<R>(R);

impl<R: Resolver> Resolver for ObservedResolver<R> {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let phase = active().map(|state| {
            let kind = if state.borrow().connector_depth == 0 {
                PhaseKind::ResolveOutside
            } else {
                PhaseKind::ResolveInside
            };
            PhaseGuard::start(state, kind)
        });
        let result = self.0.resolve(uri, config, timeout);
        if let Some(phase) = phase {
            phase.finish(result.is_ok());
        }
        result
    }

    fn empty(&self) -> ResolvedSocketAddrs {
        self.0.empty()
    }
}

#[derive(Debug)]
struct ObservedConnector<C>(C);

impl<C: Connector<Out = Box<dyn Transport>>> Connector for ObservedConnector<C> {
    type Out = Box<dyn Transport>;

    fn connect(
        &self,
        details: &ConnectionDetails,
        chained: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        let Some(state) = active() else {
            return self.0.connect(details, chained);
        };
        let outermost = state.borrow().connector_depth == 0;
        let _scope = ConnectorScope::enter(Rc::clone(&state));
        let phase =
            outermost.then(|| PhaseGuard::start(Rc::clone(&state), PhaseKind::ConnectionSetup));
        // CONNECT can re-enter this connector and the resolver. No state borrow
        // may cross the delegate call.
        let result = self.0.connect(details, chained);
        if let Some(phase) = phase {
            phase.finish(result.is_ok());
        }
        if !outermost {
            return result;
        }
        let creating_call = state.borrow().call_id;
        result.map(|transport| {
            transport.map(|inner| {
                Box::new(ObservedTransport {
                    inner,
                    creating_call,
                }) as Box<dyn Transport>
            })
        })
    }
}

struct ObservedTransport {
    inner: Box<dyn Transport>,
    creating_call: Option<u64>,
}

impl std::fmt::Debug for ObservedTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The delegate's Debug output can contain a peer address.
        formatter.debug_struct("ObservedTransport").finish()
    }
}

impl ObservedTransport {
    fn observe_use(&self) {
        if let Some(state) = active() {
            let mut state = state.borrow_mut();
            match (state.call_id, self.creating_call) {
                (Some(current), Some(creating)) if current == creating => state.used_new = true,
                (Some(_), Some(_)) => state.used_prior = true,
                _ => state.identity_unavailable = true,
            }
        }
    }
}

impl Transport for ObservedTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        if amount > 0 {
            self.observe_use();
        }
        self.inner.transmit_output(amount, timeout)
    }

    // In pinned ureq 3.4.2 every default transport uses the trait's default
    // maybe_await_input: buffered input skips await_input. Retaining that default
    // here avoids attributing buffered-input checks as attempted transport IO.
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.observe_use();
        self.inner.await_input(timeout)
    }

    fn is_open(&mut self) -> bool {
        self.inner.is_open()
    }

    fn is_tls(&self) -> bool {
        self.inner.is_tls()
    }
}

fn micros(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

#[derive(Serialize)]
struct Summary {
    call_outcome: CallOutcome,
    request_to_response_headers_us: u64,
    resolve_outside_setup: PhaseSummary,
    resolve_inside_setup: PhaseSummary,
    connection_setup: PhaseSummary,
    transport_use: TransportUse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CallOutcome {
    ResponseHeaders,
    Error,
    Interrupted,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TransportUse {
    Unobserved,
    NewForCallOnly,
    PriorCallOnly,
    Mixed,
    Unavailable,
}

#[derive(Serialize)]
struct PhaseSummary {
    status: PhaseStatus,
    invocations: u64,
    completed: u64,
    errors: u64,
    interrupted: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_us: Option<u64>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PhaseStatus {
    NotEntered,
    Completed,
    Failed,
    Mixed,
    Interrupted,
}

#[cfg(test)]
mod tests;
