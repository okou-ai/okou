//! Pure, bounded consumer-stage facts. A pending observation is never a pass.

use serde::Serialize;
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Stage {
    Authority,
    Credential,
    Dns,
    DestinationPolicy,
    Tcp,
    AccessTls,
    AccessWebsocket,
    SshProof,
    SshTrust,
    Authentication,
    Operation,
    Forwarding,
}
const STAGES: [Stage; 12] = [
    Stage::Authority,
    Stage::Credential,
    Stage::Dns,
    Stage::DestinationPolicy,
    Stage::Tcp,
    Stage::AccessTls,
    Stage::AccessWebsocket,
    Stage::SshProof,
    Stage::SshTrust,
    Stage::Authentication,
    Stage::Operation,
    Stage::Forwarding,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Progress {
    NotReached,
    Running,
    Passed,
    Failed,
    Unknown,
    Reused,
}
#[derive(Clone, Copy, Default, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Route {
    #[default]
    Unknown,
    Direct,
    CloudflareAccess,
    Tailscale,
}
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Transport {
    #[default]
    Unknown,
    Fresh,
    Reused,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Family {
    Ipv4,
    Ipv6,
}
#[derive(Clone, Serialize)]
pub(super) struct Step {
    pub(super) stage: Stage,
    pub(super) status: Progress,
}
#[derive(Clone, Serialize)]
pub(crate) struct Snapshot {
    pub(crate) access_failure: Option<crate::cloudflare::Failure>,
    pub(super) route: Route,
    pub(super) transport: Transport,
    pub(super) selected_address: Option<IpAddr>,
    pub(super) address_family: Option<Family>,
    pub(super) stages: Vec<Step>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            access_failure: None,
            route: Route::Unknown,
            transport: Transport::Unknown,
            selected_address: None,
            address_family: None,
            stages: STAGES
                .into_iter()
                .map(|stage| Step {
                    stage,
                    status: Progress::NotReached,
                })
                .collect(),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct Trace(Option<Arc<Mutex<Snapshot>>>);
impl Trace {
    pub(crate) fn new(enabled: bool) -> Self {
        Self(enabled.then(|| Arc::new(Mutex::new(Snapshot::default()))))
    }
    fn update(&self, update: impl FnOnce(&mut Snapshot)) {
        if let Some(state) = &self.0 {
            update(&mut state.lock().unwrap_or_else(|p| p.into_inner()));
        }
    }
    pub(crate) fn set(&self, stage: Stage, status: Progress) {
        self.update(|state| {
            if let Some(step) = state.stages.iter_mut().find(|s| s.stage == stage) {
                step.status = status;
            }
        });
    }
    pub(crate) fn finish(&self, stage: Stage, status: Progress) {
        self.update(|state| {
            if let Some(step) = state.stages.iter_mut().find(|s| s.stage == stage)
                && step.status == Progress::Running
            {
                step.status = status;
            }
        });
    }
    pub(crate) fn prepared(&self) {
        self.update(|state| {
            for step in &mut state.stages {
                if matches!(step.stage, Stage::Authority | Stage::Credential)
                    && step.status == Progress::NotReached
                {
                    step.status = Progress::Reused;
                }
            }
        });
    }
    pub(crate) fn access_failure(&self, failure: crate::cloudflare::Failure) {
        self.update(|state| {
            // Preserve the source cause through later carrier/cleanup errors.
            state.access_failure.get_or_insert(failure);
        });
    }
    pub(crate) fn access_cause(&self) -> Option<crate::cloudflare::Failure> {
        self.0
            .as_ref()?
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .access_failure
    }
    pub(crate) fn route(&self, route: Route) {
        self.update(|state| {
            state.route = route;
            state.transport = Transport::Fresh;
        });
    }
    pub(crate) fn selected(&self, address: IpAddr) {
        self.update(|state| {
            state.selected_address = Some(address);
            state.address_family = Some(if address.is_ipv4() {
                Family::Ipv4
            } else {
                Family::Ipv6
            });
        });
    }
    pub(crate) fn snapshot(&self) -> Option<Snapshot> {
        let mut snapshot = self
            .0
            .as_ref()?
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        for step in &mut snapshot.stages {
            if step.status == Progress::Running {
                step.status = Progress::Unknown;
            }
        }
        Some(snapshot)
    }
    pub(crate) fn fork(&self) -> Self {
        Self(self.0.as_ref().map(|state| {
            Arc::new(Mutex::new(
                state.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            ))
        }))
    }
    pub(crate) fn carrier_snapshot(&self) -> Option<Snapshot> {
        let mut snapshot = self.snapshot()?;
        snapshot.stages.retain(|step| {
            matches!(
                step.stage,
                Stage::Dns
                    | Stage::DestinationPolicy
                    | Stage::Tcp
                    | Stage::AccessTls
                    | Stage::AccessWebsocket
            )
        });
        Some(snapshot)
    }
    pub(crate) fn reuse(&self, previous: Option<&Snapshot>) {
        self.update(|state| {
            if let Some(previous) = previous {
                *state = previous.clone();
            }
            state.transport = Transport::Reused;
            for step in &mut state.stages {
                if !matches!(step.stage, Stage::Operation | Stage::Forwarding)
                    && step.status == Progress::Passed
                {
                    step.status = Progress::Reused;
                }
            }
        });
    }
}
impl Snapshot {
    pub(crate) fn has_failure(&self) -> bool {
        self.access_failure.is_some()
            || self
                .stages
                .iter()
                .any(|step| step.status == Progress::Failed)
    }
    pub(crate) fn reused(&mut self) {
        self.transport = Transport::Reused;
        for step in &mut self.stages {
            if step.status == Progress::Passed {
                step.status = Progress::Reused;
            }
        }
    }
    pub(crate) fn failed_at(&self, stage: Stage) -> bool {
        self.stages
            .iter()
            .any(|s| s.stage == stage && matches!(s.status, Progress::Failed | Progress::Unknown))
    }
}
