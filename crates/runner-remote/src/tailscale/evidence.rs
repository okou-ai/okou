//! Finite application facts; no SDK object, IO, credential or physical lease.

use crate::diagnostics::trace::Timing;
use serde::Serialize;

mod facts;
mod path;
#[cfg(test)]
mod tests;
pub(crate) use facts::PeerStatus;
use facts::{Controls, Gone, Peer};
pub(super) use path::Flow;
pub(crate) use path::Progress;
pub(super) use path::WireKind;
use std::{
    collections::VecDeque,
    future::Future,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

tokio::task_local! { static CURRENT: Trace; }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Stage {
    Provisioning,
    ProviderDns,
    ProviderTcp,
    ProviderTls,
    ProviderRequest,
    KeyDns,
    KeyTcp,
    KeyTls,
    ControlKey,
    ControlDns,
    ControlTcp,
    ControlTls,
    Noise,
    Http2,
    Registration,
    MapRequest,
    MapRead,
    MapAuthority,
    MapHeader,
    MapBody,
    MapValidation,
    MapDecode,
    DerpMap,
    LocalNode,
    Peers,
    HomeAnnouncement,
    RelayAttempt,
    RelayDial,
    RelayDns,
    RelayTcp,
    RelayTls,
    RelayUpgrade,
    RelayProtocol,
    RelayRead,
    RelayWrite,
    PeerSelection,
    PrivateTcp,
    PrivateStream,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Running,
    Pending,
    Passed,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Detail {
    NotExposed,
    Io,
    EndOfStream,
    Truncated,
    Limit,
    Invalid,
    Rejected,
    KeyExpired,
    MachineUnauthorized,
    AuthenticationRequired,
    TimedOut,
    ResetOrClosed,
    InvalidRequest,
    Internal,
    Refused,
    Reset,
    Unreachable,
    Protocol,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Root {
    Startup,
    Work,
    MapStream,
    Relay,
    Readiness,
    DataPlane,
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Role {
    Provider,
    Key,
    #[default]
    Control,
    Relay,
    PrivateTcp,
}

impl Role {
    pub(super) fn network_stages(self) -> (Stage, Stage) {
        match self {
            Self::Provider => (Stage::ProviderDns, Stage::ProviderTcp),
            Self::Key => (Stage::KeyDns, Stage::KeyTcp),
            Self::Control => (Stage::ControlDns, Stage::ControlTcp),
            Self::Relay => (Stage::RelayDns, Stage::RelayTcp),
            Self::PrivateTcp => (Stage::PeerSelection, Stage::PrivateTcp),
        }
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct Step {
    pub(crate) stage: Stage,
    pub(crate) status: Status,
    pub(crate) detail: Detail,
    #[serde(flatten)]
    pub(crate) timing: Timing,
}

#[derive(Clone, Serialize)]
pub(crate) struct Endpoint {
    pub(crate) role: Role,
    pub(crate) address: SocketAddr,
}

#[derive(Clone, Serialize)]
pub(crate) struct Snapshot {
    pub(crate) attempt_id: uuid::Uuid,
    pub(crate) started_at: chrono::DateTime<chrono::Utc>,
    pub(crate) root: Option<Root>,
    pub(crate) region: Option<u32>,
    pub(crate) steps: Vec<Step>,
    pub(crate) endpoints: Vec<Endpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) relay: Option<Box<Snapshot>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) relay_reused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) progress: Option<Progress>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) dial: Vec<Snapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) peer: Option<Peer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) controls: Option<Controls>,
    #[serde(skip)]
    gone: VecDeque<(ts_keys::NodePublicKey, Gone)>,
    #[serde(skip)]
    started: std::time::Instant,
    #[serde(skip)]
    relay_source: Option<(Trace, Option<uuid::Uuid>, ts_keys::NodePublicKey)>,
    #[serde(skip)]
    dial_sources: Vec<Trace>,
    #[serde(skip)]
    sealed: bool,
}

#[derive(Clone, Default)]
pub(crate) struct Trace {
    state: Option<Arc<Mutex<Snapshot>>>,
    role: Role,
}

impl Trace {
    pub(super) fn enabled(&self) -> bool {
        self.state.is_some()
    }
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            state: enabled.then(|| {
                Arc::new(Mutex::new(Snapshot {
                    attempt_id: uuid::Uuid::new_v4(),
                    started_at: chrono::Utc::now(),
                    root: None,
                    region: None,
                    steps: Vec::new(),
                    endpoints: Vec::new(),
                    relay: None,
                    relay_reused: false,
                    progress: None,
                    peer: None,
                    controls: None,
                    gone: VecDeque::new(),
                    started: std::time::Instant::now(),
                    relay_source: None,
                    dial: Vec::new(),
                    dial_sources: Vec::new(),
                    sealed: false,
                }))
            }),
            role: Role::default(),
        }
    }
    pub(super) fn current() -> Self {
        CURRENT.try_with(Clone::clone).unwrap_or_default()
    }
    pub(super) fn scope<F: Future>(self, future: F) -> impl Future<Output = F::Output> {
        CURRENT.scope(self, future)
    }
    pub(super) fn sync<T>(&self, work: impl FnOnce() -> T) -> T {
        CURRENT.sync_scope(self.clone(), work)
    }
    pub(super) fn with_role(mut self, role: Role) -> Self {
        self.role = role;
        self
    }
    pub(super) fn role(&self) -> Role {
        self.role
    }
    pub(super) fn fork(&self) -> Self {
        let trace = Self::new(self.state.is_some()).with_role(self.role);
        let region = self
            .state
            .as_ref()
            .and_then(|state| state.lock().unwrap_or_else(|p| p.into_inner()).region);
        if let Some(region) = region {
            trace.region(region);
        }
        trace
    }
    fn update(&self, work: impl FnOnce(&mut Snapshot)) {
        if let Some(state) = &self.state {
            let mut state = state.lock().unwrap_or_else(|p| p.into_inner());
            if !state.sealed {
                work(&mut state);
            }
        }
    }
    pub(super) fn forget(&self, stages: &[Stage]) {
        self.update(|state| state.steps.retain(|step| !stages.contains(&step.stage)));
    }
    pub(super) fn set(&self, stage: Stage, status: Status, detail: Detail) {
        self.update(|state| {
            if let Some(step) = state.steps.iter_mut().find(|s| s.stage == stage) {
                // A generic wrapper must not erase a more precise inner failure.
                if step.status != Status::Failed
                    || status != Status::Failed
                    || step.detail == Detail::NotExposed
                {
                    let mut timing = step.timing.clone();
                    if status == Status::Running && step.status != Status::Running {
                        timing.start();
                    } else if status != Status::Running {
                        timing.freeze();
                    }
                    *step = Step {
                        stage,
                        status,
                        detail,
                        timing,
                    };
                }
            } else {
                let mut timing = Timing::default();
                if status == Status::Running {
                    timing.start();
                }
                state.steps.push(Step {
                    stage,
                    status,
                    detail,
                    timing,
                });
            }
        });
    }
    pub(super) fn root(&self, root: Root) {
        self.update(|s| {
            s.root.get_or_insert(root);
        });
    }
    fn abandon(&self, stage: Stage) {
        self.update(|s| {
            if let Some(step) = s.steps.iter_mut().find(|s| s.stage == stage)
                && step.status == Status::Running
            {
                step.status = Status::Unknown;
                step.timing.freeze();
            }
        });
    }
    pub(super) fn region(&self, region: u32) {
        self.update(|s| s.region = Some(region));
    }
    pub(super) fn endpoint(&self, address: SocketAddr) {
        self.update(|s| {
            if let Some(endpoint) = s.endpoints.iter_mut().find(|e| e.role == self.role) {
                endpoint.address = address;
            } else {
                s.endpoints.push(Endpoint {
                    role: self.role,
                    address,
                });
            }
        });
    }
    pub(super) fn adopt(&self, other: &Self) {
        if let Some(other) = other.snapshot() {
            for step in other.steps {
                self.update(|state| {
                    if let Some(old) = state.steps.iter_mut().find(|old| old.stage == step.stage) {
                        if old.status != Status::Failed
                            || step.status != Status::Failed
                            || old.detail == Detail::NotExposed
                        {
                            *old = step;
                        }
                    } else {
                        state.steps.push(step);
                    }
                });
            }
            for endpoint in other.endpoints {
                self.clone()
                    .with_role(endpoint.role)
                    .endpoint(endpoint.address);
            }
            if let Some(region) = other.region {
                self.region(region);
            }
        }
    }
    pub(super) fn replace(&self, other: &Self) {
        if let Some(mut other) = other.snapshot() {
            other.sealed = false;
            self.update(|state| *state = other);
        }
    }
    pub(crate) fn seal(&self) {
        if let Some(state) = &self.state {
            state.lock().unwrap_or_else(|p| p.into_inner()).sealed = true;
        }
    }
    pub(crate) fn snapshot(&self) -> Option<Snapshot> {
        self.snapshot_for(None)
    }

    fn snapshot_for(&self, peer: Option<ts_keys::NodePublicKey>) -> Option<Snapshot> {
        let mut state = self
            .state
            .as_ref()?
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        for step in &mut state.steps {
            step.timing.freeze();
            if step.status == Status::Running {
                step.status = Status::Pending;
            }
        }
        if let Some((source, previous, key)) = state.relay_source.take() {
            state.relay = source.snapshot_for(Some(key)).map(Box::new);
            state.relay_reused = state
                .relay
                .as_ref()
                .is_some_and(|relay| Some(relay.attempt_id) == previous);
        }
        if let Some(progress) = &mut state.progress {
            progress.freeze();
        }
        if let Some(controls) = &mut state.controls {
            controls.elapsed_ms = state.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            controls.target_gone = state
                .gone
                .iter()
                .rev()
                .find(|(key, _)| Some(*key) == peer)
                .map(|(_, gone)| gone.clone());
        }
        // The raw keys used for correlation never leave the live regional trace.
        state.gone.clear();
        if !state.dial_sources.is_empty() {
            state.dial = std::mem::take(&mut state.dial_sources)
                .into_iter()
                .filter_map(|source| source.snapshot())
                .collect();
        }
        Some(state)
    }

    /// Only regional pure state is linked; no IO or physical owner is retained.
    pub(super) fn relay(&self, source: Self, peer: ts_keys::NodePublicKey) {
        if let (Some(own), Some(other)) = (&self.state, &source.state)
            && !Arc::ptr_eq(own, other)
        {
            // An unchanged map must not turn new setup into reused setup.
            if own
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .relay_source
                .as_ref()
                .is_some_and(|(previous, _, key)| {
                    *key == peer
                        && previous
                            .state
                            .as_ref()
                            .is_some_and(|previous| Arc::ptr_eq(previous, other))
                })
            {
                return;
            }
            let previous = source
                .snapshot()
                .filter(|snapshot| !snapshot.steps.is_empty())
                .map(|snapshot| snapshot.attempt_id);
            self.update(|state| state.relay_source = Some((source, previous, peer)));
        }
    }

    pub(super) fn flow(&self, flow: Flow, count: usize) {
        self.update(|state| {
            state
                .progress
                .get_or_insert_with(Progress::default)
                .record(flow, count)
        });
    }

    pub(super) fn dial_branches(&self, sources: [Self; 2]) {
        self.update(|state| state.dial_sources = sources.into_iter().collect());
    }
    pub(crate) fn id(&self) -> Option<uuid::Uuid> {
        Some(
            self.state
                .as_ref()?
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .attempt_id,
        )
    }
}

pub(super) struct Observation {
    trace: Trace,
    stage: Stage,
    finished: bool,
}
impl Observation {
    pub(super) fn start(stage: Stage) -> Self {
        let trace = Trace::current();
        trace.set(stage, Status::Running, Detail::NotExposed);
        Self {
            trace,
            stage,
            finished: false,
        }
    }
    pub(super) fn finish(mut self, success: bool) {
        self.trace.set(
            self.stage,
            if success {
                Status::Passed
            } else {
                Status::Failed
            },
            Detail::NotExposed,
        );
        self.finished = true;
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        if !self.finished {
            self.trace.abandon(self.stage);
        }
    }
}

pub(super) async fn observe<T, E>(
    stage: Stage,
    work: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let observation = Observation::start(stage);
    let result = work.await;
    observation.finish(result.is_ok());
    result
}

pub(super) fn failed(stage: Stage, detail: Detail) {
    Trace::current().set(stage, Status::Failed, detail);
}

pub(super) fn check<T, E>(stage: Stage, work: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    let observation = Observation::start(stage);
    let result = work();
    observation.finish(result.is_ok());
    result
}
