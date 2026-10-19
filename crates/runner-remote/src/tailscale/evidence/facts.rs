//! Map facts and regional control observations; never tunnel reachability claims.

use chrono::{DateTime, Utc};
use serde::Serialize;
use ts_control::NodeStatus;
use ts_derp::frame::PeerGoneReason;
use ts_keys::NodePublicKey;

use super::{Trace, path::Count};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PeerStatus {
    Unknown,
    Online,
    Offline,
}

#[derive(Clone, Serialize)]
pub(crate) struct Peer {
    pub(crate) status: PeerStatus,
    pub(crate) observed_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) control_last_seen: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) local_last_seen_estimate: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GoneReason {
    Disconnected,
    NotHere,
}

#[derive(Clone, Serialize)]
pub(crate) struct Gone {
    pub(crate) reason: GoneReason,
    pub(crate) observed_at: DateTime<Utc>,
}

#[derive(Clone, Default, Serialize)]
pub(crate) struct Controls {
    pub(crate) keep_alive: Count,
    pub(crate) ping: Count,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_gone: Option<Gone>,
    pub(crate) gone_history_omitted: bool,
    pub(crate) elapsed_ms: u64,
}

impl Trace {
    pub(in crate::tailscale) fn peer_status(&self, status: NodeStatus) {
        self.update(|state| {
            let (status, control_last_seen, local_last_seen_estimate) = match status {
                NodeStatus::Unknown => (PeerStatus::Unknown, None, None),
                NodeStatus::Online => (PeerStatus::Online, None, None),
                NodeStatus::Offline(last) => {
                    (PeerStatus::Offline, last.control, Some(last.estimated))
                }
            };
            state.peer = Some(Peer {
                status,
                observed_at: Utc::now(),
                control_last_seen,
                local_last_seen_estimate,
            });
        });
    }

    pub(in crate::tailscale) fn relay_control(&self, ping: bool) {
        self.update(|state| {
            let elapsed = state.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            let controls = state.controls.get_or_insert_with(Controls::default);
            let count = if ping {
                &mut controls.ping
            } else {
                &mut controls.keep_alive
            };
            count.count = count.count.saturating_add(1);
            count.last_ms = elapsed;
        });
    }

    pub(in crate::tailscale) fn peer_gone(&self, key: NodePublicKey, reason: PeerGoneReason) {
        self.update(|state| {
            let controls = state.controls.get_or_insert_with(Controls::default);
            if state.gone.len() == 64 {
                state.gone.pop_front();
                controls.gone_history_omitted = true;
            }
            state.gone.push_back((
                key,
                Gone {
                    reason: match reason {
                        PeerGoneReason::Disconnected => GoneReason::Disconnected,
                        PeerGoneReason::NotHere => GoneReason::NotHere,
                    },
                    observed_at: Utc::now(),
                },
            ));
        });
    }
}
