use std::time::Duration;

use tokio::time::Instant;

use crate::protocol::ProtocolMessage;
use crate::types::{TimingConfig, TokenDetails};

pub(crate) struct ConnState {
    pub(super) connection_id: Option<String>,
    pub(super) server_id: Option<String>,
    pub(super) connection_key: Option<String>,
    pub(super) channel_serial: Option<String>,
    pub(super) connection_state_ttl: Duration,
    pub(super) max_idle_interval: Option<Duration>,
    pub(super) disconnected_at: Option<Instant>,
    pub(super) token: TokenDetails,
    pub(super) token_renewal_at: Option<Instant>,
}

impl ConnState {
    pub(super) fn from_connected(
        msg: &ProtocolMessage,
        token: TokenDetails,
        timing: &TimingConfig,
    ) -> Self {
        let mut state = ConnState {
            server_id: None,
            connection_id: None,
            connection_key: None,
            channel_serial: None,
            connection_state_ttl: timing.default_connection_state_ttl,
            max_idle_interval: Some(timing.default_max_idle_interval),
            disconnected_at: None,
            token_renewal_at: Self::compute_renewal_at(&token, timing.token_renewal_margin),
            token,
        };
        state.update_from_connected(msg);
        state
    }

    pub(super) fn update_from_connected(&mut self, msg: &ProtocolMessage) {
        self.connection_id = msg.connection_id.clone();
        self.server_id = msg
            .connection_details
            .as_ref()
            .and_then(|details| details.server_id.clone());
        if let Some(ref key) = msg.connection_key {
            self.connection_key = Some(key.clone());
        }

        if let Some(ref details) = msg.connection_details {
            if let Some(ref key) = details.connection_key {
                self.connection_key = Some(key.clone());
            }
            if let Some(ttl) = details.connection_state_ttl
                && let Some(ttl) = positive_external_millis(ttl)
            {
                self.connection_state_ttl = ttl;
            }
            self.max_idle_interval = details.max_idle_interval.and_then(positive_external_millis);
        }
    }

    pub(super) fn compute_renewal_at(token: &TokenDetails, margin: Duration) -> Option<Instant> {
        let now_ms = unix_now_ms();
        let remaining_ms = token.expires.saturating_sub(now_ms);
        if remaining_ms <= 0 {
            return Some(Instant::now());
        }

        let remaining = Duration::from_millis(u64::try_from(remaining_ms).ok()?);
        let effective_margin = margin.min(remaining / 2);
        let renew_in = remaining - effective_margin;
        checked_deadline_after(renew_in)
    }

    /// Resume is allowed while the Ably connection state is still retained and
    /// we have a connection key. This mirrors ably-js' suspend timer: once a
    /// connection has been detected as disconnected, the resumable window is
    /// `connection_state_ttl`.
    pub(super) fn can_resume(&self) -> bool {
        if let Some(disconnected_at) = self.disconnected_at {
            disconnected_at.elapsed() < self.connection_state_ttl && self.connection_key.is_some()
        } else {
            false
        }
    }

    pub(super) fn clear_resume_state(&mut self) {
        self.connection_id = None;
        self.server_id = None;
        self.connection_key = None;
        self.channel_serial = None;
    }
}

pub(super) fn unix_now_ms() -> i64 {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(now_ms).unwrap_or(i64::MAX)
}

fn positive_external_millis(value: i64) -> Option<Duration> {
    if value <= 0 {
        return None;
    }
    Some(Duration::from_millis(value as u64))
}

pub(super) fn checked_deadline_after(duration: Duration) -> Option<Instant> {
    Instant::now().checked_add(duration)
}

pub(super) fn checked_deadline_from(start: Instant, duration: Duration) -> Option<Instant> {
    start.checked_add(duration)
}

pub(super) fn idle_deadline(
    last_inbound_activity_at: Instant,
    max_idle_interval: Option<Duration>,
    heartbeat_margin: Duration,
) -> Option<(Instant, Duration)> {
    let idle_timeout = max_idle_interval?.checked_add(heartbeat_margin)?;
    let deadline = checked_deadline_from(last_inbound_activity_at, idle_timeout)?;
    Some((deadline, idle_timeout))
}

pub(super) fn reconnect_spacing_delay(
    last_attempt: Option<Instant>,
    min_interval: Duration,
) -> Duration {
    last_attempt.map_or(Duration::ZERO, |attempt| {
        min_interval.saturating_sub(attempt.elapsed())
    })
}

pub(super) fn retry_delay(initial_timeout: Duration, retry_attempt: u32) -> Duration {
    // Mirrors ably-js Utils.getRetryTime(): base * min((attempt + 2) / 3, 2)
    // with jitter in [0.8, 1.0). Use wall-clock subsecond nanos as a cheap
    // process-local jitter source; cryptographic randomness is unnecessary.
    let backoff_num = retry_attempt.saturating_add(2).min(6) as u128;
    let base_ms = initial_timeout.as_millis();
    let upper_ms = base_ms.saturating_mul(backoff_num) / 3;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u128;
    let jitter_per_mille = 800 + (nanos % 200);
    let jittered_ms = upper_ms.saturating_mul(jitter_per_mille) / 1000;
    Duration::from_millis(u64::try_from(jittered_ms).unwrap_or(u64::MAX))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ConnectionLifecycleState {
    Connecting,
    Connected,
    Disconnected,
    Suspended,
    Closing,
    Closed,
    Failed,
}

impl ConnectionLifecycleState {
    pub(super) fn send_events(self) -> bool {
        matches!(self, Self::Connected)
    }

    fn queue_events(self) -> bool {
        matches!(self, Self::Connecting | Self::Disconnected)
    }

    fn terminal(self) -> bool {
        matches!(self, Self::Closed | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChannelLifecycleState {
    Attaching,
    Attached,
    Detached,
    Suspended,
    Failed,
}

#[derive(Debug, Clone)]
pub(crate) struct RealtimeStateMachine {
    pub(super) connection: ConnectionLifecycleState,
    pub(super) channel: ChannelLifecycleState,
}

impl RealtimeStateMachine {
    pub(crate) fn connected() -> Self {
        Self {
            connection: ConnectionLifecycleState::Connected,
            channel: ChannelLifecycleState::Attached,
        }
    }

    pub(super) fn request_connecting(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Connecting);
        // Our reconnect attempt performs transport activation and channel attach
        // in one async step. Mark the channel as attaching before that step so
        // the lifecycle still mirrors ably-js' attached -> attaching -> attached
        // transition for every new transport.
        if matches!(
            self.channel,
            ChannelLifecycleState::Attached | ChannelLifecycleState::Suspended
        ) {
            self.transition_channel(ChannelLifecycleState::Attaching);
        }
    }

    pub(super) fn notify_transport_connected(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Connected);
        self.on_transport_active();
    }

    pub(super) fn notify_connected(&mut self) {
        self.notify_transport_connected();
        self.notify_channel_attached();
    }

    pub(super) fn notify_disconnected(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Disconnected);
    }

    pub(super) fn notify_suspended(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Suspended);
        self.notify_channel_suspended();
    }

    pub(super) fn request_closing(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Closing);
        self.notify_channel_detached();
    }

    pub(super) fn notify_closed(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Closed);
        self.notify_channel_detached();
    }

    pub(super) fn notify_failed(&mut self) {
        self.transition_connection(ConnectionLifecycleState::Failed);
        self.notify_channel_failed();
    }

    pub(super) fn request_channel_attaching(&mut self) {
        if self.connection.send_events() {
            self.transition_channel(ChannelLifecycleState::Attaching);
        }
    }

    pub(super) fn notify_channel_attached(&mut self) {
        self.transition_channel(ChannelLifecycleState::Attached);
    }

    fn notify_channel_detached(&mut self) {
        self.transition_channel(ChannelLifecycleState::Detached);
    }

    pub(super) fn notify_channel_suspended(&mut self) {
        self.transition_channel(ChannelLifecycleState::Suspended);
    }

    pub(super) fn notify_channel_failed(&mut self) {
        self.transition_channel(ChannelLifecycleState::Failed);
    }

    fn on_transport_active(&mut self) {
        // Matches ably-js Channels.onTransportActive(): when a new transport
        // becomes active, any attached/suspended channel must re-attach on that
        // transport rather than assuming server-side channel state survived.
        match self.channel {
            ChannelLifecycleState::Attaching => {}
            ChannelLifecycleState::Suspended | ChannelLifecycleState::Attached => {
                self.request_channel_attaching();
            }
            ChannelLifecycleState::Detached | ChannelLifecycleState::Failed => {}
        }
    }

    fn transition_connection(&mut self, next: ConnectionLifecycleState) {
        if self.connection.terminal() || self.connection == next {
            return;
        }
        tracing::info!(
            previous = ?self.connection,
            current = ?next,
            queue_events = next.queue_events(),
            send_events = next.send_events(),
            "Ably connection state transition",
        );
        self.connection = next;
    }

    fn transition_channel(&mut self, next: ChannelLifecycleState) {
        if self.channel == next {
            return;
        }
        tracing::info!(
            previous = ?self.channel,
            current = ?next,
            "Ably channel state transition",
        );
        self.channel = next;
    }
}

#[cfg(test)]
mod tests;
