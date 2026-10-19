//! Explain observed path progress without promoting local sends to remote proof.

use super::{Report, words};
use crate::tailscale::evidence::{Detail, PeerStatus, Snapshot, Stage, Status};

impl Report {
    pub(super) fn native_summary(&self, text: &mut String) -> Option<()> {
        let Some(connection) = &self.native_connection else {
            return Some(());
        };
        text.push_str("\nNative path summary:");
        if let Some(root) = self.native_layers.as_ref().and_then(|layers| layers.root) {
            text.push_str(&format!(" captured native terminal root {};", words(root)?));
        }
        if connection.relay.as_ref().is_some_and(|relay| {
            relay
                .steps
                .iter()
                .any(|step| step.stage == Stage::RelayProtocol && step.status == Status::Passed)
        }) {
            text.push_str(" selected regional DERP setup passed;");
        }
        if let Some(peer) = &connection.peer {
            text.push_str(&format!(" cached peer map status {};", words(peer.status)?));
        }
        if let Some(tcp) = connection
            .steps
            .iter()
            .find(|s| s.stage == Stage::PrivateTcp)
        {
            text.push_str(&format!(" private TCP {};", words(tcp.status)?));
        }
        if connection
            .progress
            .as_ref()
            .is_some_and(|progress| progress.initiation_without_peer_input())
        {
            text.push_str(" shared-peer initiation output without observed peer input or transport-data output;");
        }
        text.push_str(" map status may be stale; shared headers do not prove authentication or this connection's delivery.\n");
        Some(())
    }

    pub(super) fn native_path(&self, text: &mut String) -> Option<()> {
        let Some(connection) = &self.native_connection else {
            return Some(());
        };
        text.push_str("\nActual path: embedded Tailscale over DERP, then private TCP.\n");
        if let Some(peer) = &connection.peer {
            text.push_str(&format!("- Selected peer control-plane status: {}; map fact sampled locally at {}. This may be stale and does not prove reachability.\n", words(peer.status)?, super::timestamp(peer.sampled_at)));
            text.push_str(&format!("- Target status update last received locally at: {}. Unrelated map updates and cached bindings do not refresh this time; this is not the provider's clock.\n", super::observed(peer.status_received_at.map(super::timestamp))));
            if let Some(at) = peer.control_last_seen {
                text.push_str(&format!("- Peer last seen by control: {}; provider clock, possibly rounded by about 10 minutes.\n", super::timestamp(at)));
            }
            if let Some(at) = peer.local_last_seen_estimate {
                text.push_str(&format!("- Peer offline notification estimated locally at: {}; a separate clock, not a precise remote last-seen deadline.\n", super::timestamp(at)));
            }
        }
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
            controls_text(text, relay)?;
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
            text.push_str("- WireGuard headers do not prove authentication or handshake completion. Transport-data includes keepalives; shared output does not prove this SYN or application payload was delivered.\n");
            if progress.handshake_only_output() {
                text.push_str("- WireGuard initiation was produced without observed transport-data output in this window. Locally produced SYNs may still be awaiting encryption.\n");
            }
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
        if connection.relay.as_ref().is_some_and(|relay| {
            relay
                .controls
                .as_ref()
                .is_some_and(|controls| controls.target_gone.is_some())
        }) {
            return Some(
                "The selected relay recorded PeerGone for this target. Check the target's Tailscale connection and relay association. This notification belongs to that relay incarnation, may predate the operation, and does not establish global offline state or a closed port.",
            );
        }
        if connection
            .peer
            .as_ref()
            .is_some_and(|peer| matches!(peer.status, PeerStatus::Offline))
        {
            return Some(
                "The control map marks the target offline. Check the target's Tailscale client and network first. This cached map hint may be stale; it does not establish device power state or firewall denial. Private TCP was not established, so target service authentication remains unverified.",
            );
        }
        if connection
            .progress
            .as_ref()
            .is_some_and(|progress| progress.initiation_without_peer_input())
        {
            return Some(
                "Shared-peer WireGuard initiation output was observed without peer input or transport-data output. Check the target's Tailscale connection and selected relay path. Local SYNs may still await encryption; silence does not identify the device or network cause.",
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
            "- {label} {}: {}; detail: {}; elapsed {} ms.{}\n",
            words(step.stage)?,
            words(step.status)?,
            words(step.detail)?,
            step.timing.elapsed_ms,
            wait_note(step.stage, step.status, relay),
        ));
    }
    Some(())
}

pub(super) fn wait_note(stage: Stage, status: Status, snapshot: &Snapshot) -> &'static str {
    if matches!(status, Status::Pending | Status::Running) {
        match stage {
            Stage::RelayRead => {
                " Background wait for peer data; DERP controls may be consumed meanwhile."
            }
            Stage::MapHeader
                if snapshot.steps.iter().any(|step| {
                    step.stage == Stage::MapDecode && step.status == Status::Passed
                }) =>
            {
                " Background wait for the next map frame after earlier progress."
            }
            _ => "",
        }
    } else {
        ""
    }
}

fn controls_text(text: &mut String, relay: &Snapshot) -> Option<()> {
    let Some(controls) = &relay.controls else {
        text.push_str("- Selected relay controls: KeepAlive/Ping/target PeerGone not observed.\n");
        return Some(());
    };
    for (name, count) in [
        ("KeepAlive", &controls.keep_alive),
        ("Ping", &controls.ping),
    ] {
        if count.count == 0 {
            text.push_str(&format!("- Shared selected relay {name}: not observed.\n"));
        } else {
            text.push_str(&format!(
                "- Shared selected relay {name}: {}; last {} ms before capture.\n",
                count.count,
                controls.elapsed_ms.saturating_sub(count.last_ms)
            ));
        }
    }
    if let Some(gone) = &controls.target_gone {
        text.push_str(&format!("- Selected peer PeerGone: {}; observed at {}; notification from this relay incarnation, possibly before this operation; not global peer/port state.\n", words(gone.reason)?, super::timestamp(gone.observed_at)));
    } else {
        text.push_str("- Selected peer PeerGone: not observed in retained relay controls.\n");
    }
    if controls.gone_history_omitted {
        text.push_str(
            "- Detail omitted: older PeerGone observations exceeded the bounded relay history.\n",
        );
    }
    text.push_str("- DERP controls show relay activity, not a reply from the target or authenticated tunnel/TCP progress.\n");
    Some(())
}
