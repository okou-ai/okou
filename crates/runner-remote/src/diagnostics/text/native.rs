//! Explain observed path progress without promoting local sends to remote proof.

use super::{Report, words};
use crate::tailscale::evidence::{Detail, Snapshot, Stage, Status};

impl Report {
    pub(super) fn native_path(&self, text: &mut String) -> Option<()> {
        let Some(connection) = &self.native_connection else {
            return Some(());
        };
        text.push_str("\nActual path: embedded Tailscale over DERP, then private TCP.\n");
        if let Some(step) = connection
            .steps
            .iter()
            .find(|step| step.stage == Stage::PrivateTcp)
        {
            text.push_str(&format!(
                "- Private TCP: {} at observation; elapsed {} ms.\n",
                words(step.status)?,
                step.timing.elapsed_ms
            ));
            if step.status == Status::Pending {
                text.push_str("- The operation ended while private TCP establishment was pending; this is a wait location, not a proven remote cause.\n");
            }
        }
        if let Some(relay) = &connection.relay {
            text.push_str(&format!("- Selected relay region: {}; incarnation {}; setup {}; shared regional dependency; evidence began {}. Facts captured with this operation.\n",
                super::observed(relay.region), relay.attempt_id,
                if connection.relay_reused { "already started when selected" } else { "new or replaced" },
                super::timestamp(relay.started_at)));
            relay_text(text, "Selected relay", relay)?;
            for (index, dial) in relay.dial.iter().enumerate() {
                relay_text(
                    text,
                    if index == 0 {
                        "Relay IPv4 dial"
                    } else {
                        "Relay IPv6 dial"
                    },
                    dial,
                )?;
            }
        } else {
            text.push_str("- Selected regional relay progress: not observed. Native node readiness alone does not prove destination-region connectivity.\n");
        }
        if let Some(progress) = &connection.progress {
            text.push_str(&format!("- Traffic observation window: {} ms since first recorded path event. Counts are observations in this window.\n", progress.elapsed_ms));
            for (name, count, shared) in progress.observations() {
                let scope = if shared {
                    "shared peer"
                } else {
                    "this TCP connection"
                };
                if count.count == 0 {
                    text.push_str(&format!("- {scope}: {name}: not observed.\n"));
                } else {
                    text.push_str(&format!(
                        "- {scope}: {name}: {}; last {} ms before capture.\n",
                        count.count,
                        progress.elapsed_ms.saturating_sub(count.last_ms)
                    ));
                }
            }
            text.push_str("- Queue admission and local flush do not prove peer delivery. Peer labels do not prove cryptographic authentication; shared peer traffic can belong to another connection.\n");
        }
        Some(())
    }

    pub(super) fn native_guidance(&self) -> Option<&'static str> {
        let connection = self.native_connection.as_ref()?;
        let tcp = connection
            .steps
            .iter()
            .find(|step| step.stage == Stage::PrivateTcp)?;
        if !matches!(
            tcp.status,
            Status::Pending | Status::Failed | Status::Unknown
        ) {
            return None;
        }
        if tcp.status == Status::Failed
            && connection
                .progress
                .as_ref()
                .is_some_and(|progress| progress.reset_observed())
        {
            return Some(
                "An authenticated TCP RST was observed for this exact connection. Check the target service/port and its admitted peer path; SSH login was not reached. A reset does not identify which service or policy produced it.",
            );
        }
        if let Some(relay) = &connection.relay {
            if relay
                .steps
                .iter()
                .any(|step| step.status == Status::Failed && step.stage == Stage::RelayTls)
            {
                return Some(
                    "Inspect the selected DERP relay certificate/TLS path; node readiness and SSH credentials do not establish relay TLS health.",
                );
            }
            let established = relay
                .steps
                .iter()
                .any(|step| step.stage == Stage::RelayProtocol && step.status == Status::Passed);
            if relay.steps.iter().any(|step| step.status == Status::Failed)
                || (!established
                    && relay
                        .dial
                        .iter()
                        .flat_map(|dial| &dial.steps)
                        .any(|step| step.status == Status::Failed))
            {
                return Some(
                    "Inspect the selected DERP region's failed setup/IO stage and endpoint; another region or prior node readiness cannot establish this path's health.",
                );
            }
        }
        if tcp.detail == Detail::ResetOrClosed {
            return Some(
                "The private netstack reported reset-or-closed. Check the configured target service and admitted peer path; this SDK category alone does not prove a received TCP RST or a closed port.",
            );
        }
        Some(
            "Inspect the selected DERP region and observed queue/flush/peer/TCP progress. Private TCP was not established; silence does not identify an offline device or firewall block. SSH credentials were not tested at this boundary.",
        )
    }
}

fn relay_text(text: &mut String, label: &str, relay: &Snapshot) -> Option<()> {
    if relay.steps.is_empty() {
        text.push_str(&format!("- {label} stages: not observed.\n"));
    }
    for endpoint in &relay.endpoints {
        text.push_str(&format!("- {label} endpoint: {}.\n", endpoint.address));
    }
    for step in &relay.steps {
        text.push_str(&format!(
            "- {label} {}: {}; detail: {}; elapsed {} ms.\n",
            words(step.stage)?,
            words(step.status)?,
            words(step.detail)?,
            step.timing.elapsed_ms
        ));
    }
    Some(())
}
