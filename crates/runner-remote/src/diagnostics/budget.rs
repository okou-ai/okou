//! Retain an incident's useful finite summary when completed detail exceeds budget.

use super::{Report, trace::Progress};
use crate::tailscale::evidence::{Snapshot, Stage, Status};

impl Report {
    pub(super) fn compact(&mut self, minimal: bool) {
        self.truncated = true;
        if let Some(node) = &mut self.native_layers {
            compact_native(node, minimal);
            node.endpoints.retain(|endpoint| {
                matches!(
                    endpoint.role,
                    crate::tailscale::evidence::Role::Relay
                        | crate::tailscale::evidence::Role::PrivateTcp
                )
            });
        }
        if let Some(connection) = &mut self.native_connection {
            compact_native(connection, minimal);
        }
        if minimal {
            if let Some(ssh) = &mut self.ssh {
                ssh.stages
                    .retain(|step| !matches!(step.status, Progress::Passed | Progress::Reused));
            }
            if let Some(vnc) = &mut self.vnc {
                vnc.steps.retain(|step| {
                    use crate::vnc::evidence::Stage as V;
                    !matches!(
                        step.status,
                        Progress::Passed | Progress::Reused | Progress::NotReached
                    ) || matches!(
                        step.stage,
                        V::Authentication
                            | V::Initialization
                            | V::KdcTransport
                            | V::KdcExchange
                            | V::Retirement
                    )
                });
                for carrier in [&mut vnc.rfb_carrier, &mut vnc.kdc_carrier]
                    .into_iter()
                    .flatten()
                {
                    if let Some(access) = &mut carrier.access {
                        access.stages.retain(|step| {
                            !matches!(step.status, Progress::Passed | Progress::Reused)
                        });
                    }
                }
            }
        }
    }
}

fn compact_native(snapshot: &mut Snapshot, minimal: bool) {
    let last_passed = snapshot
        .steps
        .iter()
        .rposition(|step| step.status == Status::Passed);
    let first_failure = snapshot
        .steps
        .iter()
        .position(|step| step.status == Status::Failed);
    let last_pending = snapshot
        .steps
        .iter()
        .rposition(|step| matches!(step.status, Status::Pending | Status::Unknown));
    let mut index = 0;
    snapshot.steps.retain(|step| {
        // Guidance must still know that a relay established despite a losing
        // address-family branch, and where this exact TCP connection ended.
        let keep = matches!(step.stage, Stage::RelayProtocol | Stage::PrivateTcp)
            || if minimal {
                [last_passed, first_failure, last_pending].contains(&Some(index))
            } else {
                step.status != Status::Passed || Some(index) == last_passed
            };
        index += 1;
        keep
    });
    if let Some(relay) = &mut snapshot.relay {
        compact_native(relay, minimal);
    }
    for dial in &mut snapshot.dial {
        compact_native(dial, minimal);
    }
}
