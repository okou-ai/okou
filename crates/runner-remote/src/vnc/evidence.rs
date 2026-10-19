//! Owned finite facts. Snapshots retain no session, credential, IO or capacity.

use serde::Serialize;
use std::net::SocketAddr;
use tokio::time::Instant;
use uuid::Uuid;

use super::{Failure, authority::Transport};
use crate::diagnostics::{Operation, trace::Progress};

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Stage {
    Admission,
    Credential,
    Destination,
    Transport,
    Authentication,
    Initialization,
    AuthorityRecheck,
    SessionAdmission,
    KdcTransport,
    KdcExchange,
    Capture,
    Input,
    Status,
    Retirement,
}

#[derive(Clone, Serialize)]
pub(crate) struct Step {
    pub(crate) stage: Stage,
    pub(crate) status: Progress,
    /// Local observed time; authentication includes its nested KDC work.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) elapsed_ms: Option<u64>,
    #[serde(skip)]
    started: Option<Instant>,
}

impl Step {
    fn freeze(&mut self) {
        if let Some(started) = self.started.take() {
            let elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            self.elapsed_ms = Some(self.elapsed_ms.unwrap_or(0).saturating_add(elapsed));
        }
    }

    fn set(&mut self, status: Progress) {
        if status == Progress::NotReached {
            self.started = None;
            self.elapsed_ms = None;
        } else if status == Progress::Running {
            if self.status != Progress::Running {
                // Independent KDC stages can run several times in one setup.
                self.started = Some(Instant::now());
            }
        } else {
            self.freeze();
        }
        self.status = status;
    }
}

#[derive(Clone, Copy)]
pub(super) enum Role {
    Rfb,
    Kdc,
}

/// A finite receipt for one independently authorized native carrier.
#[derive(Clone, Serialize)]
pub(crate) struct Carrier {
    pub(crate) configuration_id: Uuid,
    pub(crate) generation: i64,
    pub(crate) attempt_id: Uuid,
    pub(crate) resource_id: Option<Uuid>,
    pub(crate) connection_id: Option<Uuid>,
    pub(crate) status: Progress,
    pub(crate) node_setup: Option<Progress>,
    pub(crate) origin_tls: Option<Progress>,
    pub(crate) access: Option<crate::diagnostics::trace::Snapshot>,
}

#[derive(Clone, Serialize)]
pub(crate) struct Snapshot {
    pub(crate) route: &'static str,
    pub(crate) kdc_route: Option<&'static str>,
    pub(crate) rfb_carrier: Option<Box<Carrier>>,
    pub(crate) kdc_carrier: Option<Box<Carrier>>,
    pub(crate) address: Option<SocketAddr>,
    pub(crate) kdc_address: Option<SocketAddr>,
    pub(crate) profile: Option<&'static str>,
    pub(crate) rfb_error_code: Option<&'static str>,
    pub(crate) authentication_stage: Option<&'static str>,
    pub(crate) dh_check: Option<&'static str>,
    pub(crate) dh_generator: Option<u16>,
    pub(crate) dh_key_bytes: Option<u16>,
    pub(crate) first_failure: Option<Failure>,
    pub(crate) first_failure_at: Option<chrono::DateTime<chrono::Utc>>,
    pub(crate) steps: Vec<Step>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            route: "not observed",
            kdc_route: None,
            rfb_carrier: None,
            kdc_carrier: None,
            address: None,
            kdc_address: None,
            profile: None,
            rfb_error_code: None,
            authentication_stage: None,
            dh_check: None,
            dh_generator: None,
            dh_key_bytes: None,
            first_failure: None,
            first_failure_at: None,
            steps: [
                Stage::Admission,
                Stage::Credential,
                Stage::Destination,
                Stage::Transport,
                Stage::Authentication,
                Stage::Initialization,
                Stage::AuthorityRecheck,
                Stage::SessionAdmission,
                Stage::KdcTransport,
                Stage::KdcExchange,
                Stage::Capture,
                Stage::Input,
                Stage::Status,
                Stage::Retirement,
            ]
            .into_iter()
            .map(|stage| Step {
                stage,
                status: Progress::NotReached,
                elapsed_ms: None,
                started: None,
            })
            .collect(),
        }
    }
}

pub(super) fn route(transport: Transport) -> &'static str {
    match transport {
        Transport::Direct => "direct",
        Transport::Ssh { .. } => "ssh",
        Transport::Cloudflare { .. } => "cloudflare_access",
        Transport::Tailscale { .. } => "tailscale",
    }
}

impl Snapshot {
    pub(super) fn failed_carrier(&mut self, resource: Uuid) {
        for carrier in [&mut self.rfb_carrier, &mut self.kdc_carrier]
            .into_iter()
            .flatten()
        {
            if carrier.resource_id == Some(resource) && carrier.status != Progress::NotReached {
                carrier.status = Progress::Failed;
            }
        }
    }
    pub(super) fn carrier(&mut self, role: Role) -> &mut Option<Box<Carrier>> {
        match role {
            Role::Rfb => &mut self.rfb_carrier,
            Role::Kdc => &mut self.kdc_carrier,
        }
    }
    pub(super) fn begin(&mut self, stage: Stage) {
        for step in &mut self.steps {
            if step.status == Progress::Running {
                step.set(Progress::Passed);
            }
        }
        self.set(stage, Progress::Running);
    }
    pub(super) fn set(&mut self, stage: Stage, status: Progress) {
        if let Some(step) = self.steps.iter_mut().find(|s| s.stage == stage) {
            step.set(status);
        }
    }
    pub(crate) fn frozen(mut self) -> Self {
        for step in &mut self.steps {
            step.freeze();
            if step.status == Progress::Running {
                step.status = Progress::Pending;
            }
        }
        self
    }

    pub(super) fn observed(&mut self, stage: Stage, status: Progress, started: Option<Instant>) {
        if let Some(step) = self.steps.iter_mut().find(|s| s.stage == stage) {
            step.elapsed_ms = None;
            step.started = started;
            step.status = Progress::Running;
            step.set(status);
        }
    }
    pub(super) fn finish(&mut self, failure: Failure) {
        for carrier in [&mut self.rfb_carrier, &mut self.kdc_carrier]
            .into_iter()
            .flatten()
        {
            for status in [
                Some(&mut carrier.status),
                carrier.node_setup.as_mut(),
                carrier.origin_tls.as_mut(),
            ]
            .into_iter()
            .flatten()
            {
                if *status == Progress::Running {
                    *status = if matches!(failure, Failure::Cancelled | Failure::TimedOut) {
                        Progress::Unknown
                    } else {
                        Progress::Failed
                    };
                }
            }
        }
        for step in &mut self.steps {
            if step.status == Progress::Running {
                let status = if matches!(
                    failure,
                    Failure::Cancelled | Failure::TimedOut | Failure::DeliveryUnknown
                ) {
                    Progress::Unknown
                } else {
                    Progress::Failed
                };
                step.set(status);
            }
        }
    }
    pub(super) fn operation(
        &self,
        operation: Operation,
        failure: Failure,
        started: Option<Instant>,
    ) -> Self {
        let mut snapshot = self.clone();
        for carrier in [&mut snapshot.rfb_carrier, &mut snapshot.kdc_carrier]
            .into_iter()
            .flatten()
        {
            for status in [
                Some(&mut carrier.status),
                carrier.node_setup.as_mut(),
                carrier.origin_tls.as_mut(),
            ]
            .into_iter()
            .flatten()
            {
                if *status == Progress::Passed {
                    *status = Progress::Reused;
                }
            }
            if let Some(access) = &mut carrier.access {
                access.reused();
            }
        }
        for step in &mut snapshot.steps {
            if step.status == Progress::Passed {
                step.status = Progress::Reused;
            }
        }
        let stage = match operation {
            Operation::Capture => Stage::Capture,
            Operation::Input => Stage::Input,
            Operation::Retirement => Stage::Retirement,
            _ => Stage::Status,
        };
        snapshot.observed(stage, Progress::Running, started);
        snapshot.finish(failure);
        snapshot
    }
    pub(crate) fn native_failure(&self, resource: Uuid) -> Self {
        let mut snapshot = self.operation(Operation::Native, Failure::Network, None);
        // A background source event did not execute a VNC status request.
        snapshot.set(Stage::Status, Progress::NotReached);
        if !self
            .steps
            .iter()
            .any(|step| step.stage == Stage::SessionAdmission && step.status == Progress::Passed)
        {
            // Startup subscriptions captured setup context before dialing. Later
            // authentication progress is published by the owning start operation.
            for step in &mut snapshot.steps {
                if step.status != Progress::Reused {
                    step.status = Progress::Unknown;
                }
            }
        }
        snapshot.failed_carrier(resource);
        snapshot
    }
}
