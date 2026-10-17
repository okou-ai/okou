//! Owned finite facts. Snapshots retain no session, credential, IO or capacity.

use serde::Serialize;
use std::net::SocketAddr;

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
}

#[derive(Clone, Serialize)]
pub(crate) struct Snapshot {
    pub(crate) route: &'static str,
    pub(crate) kdc_route: Option<&'static str>,
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
    pub(super) fn begin(&mut self, stage: Stage) {
        for step in &mut self.steps {
            if step.status == Progress::Running {
                step.status = Progress::Passed;
            }
        }
        self.set(stage, Progress::Running);
    }
    pub(super) fn set(&mut self, stage: Stage, status: Progress) {
        if let Some(step) = self.steps.iter_mut().find(|s| s.stage == stage) {
            step.status = status;
        }
    }
    pub(super) fn finish(&mut self, failure: Failure) {
        for step in &mut self.steps {
            if step.status == Progress::Running {
                step.status = if matches!(
                    failure,
                    Failure::Cancelled | Failure::TimedOut | Failure::DeliveryUnknown
                ) {
                    Progress::Unknown
                } else {
                    Progress::Failed
                };
            }
        }
    }
    pub(super) fn operation(&self, operation: Operation, failure: Failure) -> Self {
        let mut snapshot = self.clone();
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
        snapshot.set(stage, Progress::Running);
        snapshot.finish(failure);
        snapshot
    }
}
