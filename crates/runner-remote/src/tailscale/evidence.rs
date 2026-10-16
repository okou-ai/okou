//! Finite application facts; no SDK object, IO, credential or physical lease.

use serde::Serialize;
use std::{
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
}

#[derive(Clone, Serialize)]
pub(crate) struct Endpoint {
    pub(crate) role: Role,
    pub(crate) address: SocketAddr,
}

#[derive(Clone, Serialize)]
pub(crate) struct Snapshot {
    pub(crate) attempt_id: uuid::Uuid,
    pub(crate) root: Option<Root>,
    pub(crate) region: Option<u32>,
    pub(crate) steps: Vec<Step>,
    pub(crate) endpoints: Vec<Endpoint>,
    #[serde(skip)]
    sealed: bool,
}

#[derive(Clone, Default)]
pub(crate) struct Trace {
    state: Option<Arc<Mutex<Snapshot>>>,
    role: Role,
}

impl Trace {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            state: enabled.then(|| {
                Arc::new(Mutex::new(Snapshot {
                    attempt_id: uuid::Uuid::new_v4(),
                    root: None,
                    region: None,
                    steps: Vec::new(),
                    endpoints: Vec::new(),
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
                if step.status != Status::Failed || status != Status::Failed {
                    *step = Step {
                        stage,
                        status,
                        detail,
                    };
                }
            } else {
                state.steps.push(Step {
                    stage,
                    status,
                    detail,
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
                self.set(step.stage, step.status, step.detail);
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
        let mut state = self
            .state
            .as_ref()?
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        for step in &mut state.steps {
            if step.status == Status::Running {
                step.status = Status::Unknown;
            }
        }
        Some(state)
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
