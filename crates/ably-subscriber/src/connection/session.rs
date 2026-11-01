//! Session bookkeeping for the realtime event loop.
//!
//! `EventLoopState` drives this module while it owns the WebSocket transport.
//! The state here is private implementation detail, but it determines
//! externally visible subscription events and reconnect behavior.

use std::time::Duration;

use tokio::time::Instant;

use super::state::{
    ChannelLifecycleState, ConnState, ConnectionLifecycleState, RealtimeStateMachine,
    checked_deadline_after, checked_deadline_from, retry_delay,
};
use crate::protocol::{AttachMode, ProtocolMessage};
use crate::types::TokenDetails;

/// Mutable session state owned by the realtime event loop.
///
/// `ConnState` stores transport metadata such as connection keys, channel
/// serials, TTLs, and token renewal deadlines. `RealtimeStateMachine` stores
/// the current connection and channel lifecycle phases. `SessionState` owns the
/// timers, counters, and pending event markers that coordinate those two state
/// models with event-loop behavior.
pub(crate) struct SessionState {
    conn_state: ConnState,
    lifecycle: RealtimeStateMachine,
    /// Consecutive token renewal failures. Successful renewal and committed
    /// connected reconnects reset this counter; reaching the configured max
    /// marks the lifecycle failed.
    token_renewal_failures: u32,
    /// Next suspended-channel reattach attempt. It is scheduled from a
    /// suspended channel while the connection can send events, then cleared
    /// when consumed, superseded by a new attach, reset by reconnect/suspended
    /// retry, or dropped by explicit channel/connection failure cleanup.
    channel_retry_at: Option<Instant>,
    /// Backoff counter used when scheduling suspended-channel retries. It
    /// resets after a successful channel attach, and reconnect commits reset it
    /// before scheduling any suspended retry on the new transport.
    channel_retry_count: u32,
    /// Optional deadline tracked for a started channel attach operation. This
    /// is separate from `channel_retry_at`: operation deadlines time out active
    /// attaches, while retry deadlines start the next attach attempt.
    /// Reconnect, suspended retry, and explicit channel/connection failure
    /// cleanup clear stale attach deadlines.
    channel_operation_deadline: Option<Instant>,
    /// A reconnect can restore the transport while channel attach is still
    /// suspended. In that case `Event::Connected` is held for a later `ATTACHED`
    /// message unless channel failure or suspended cleanup clears the pending
    /// marker.
    connected_event_pending: bool,
    /// Whether automatic channel attaches should be encoded as non-clean
    /// attaches with ATTACH_RESUME. This is independent of channel_serial:
    /// suspended retry clears the serial but still continues the same
    /// subscription attachment.
    attach_resume: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TokenRenewalFailure {
    Retry { failures: u32 },
    Fatal { failures: u32 },
}

impl SessionState {
    pub(crate) fn connected(conn_state: ConnState) -> Self {
        Self {
            conn_state,
            lifecycle: RealtimeStateMachine::connected(),
            token_renewal_failures: 0,
            channel_retry_at: None,
            channel_retry_count: 0,
            channel_operation_deadline: None,
            connected_event_pending: false,
            attach_resume: true,
        }
    }

    pub(super) fn channel_operation_deadline(&self) -> Option<Instant> {
        self.channel_operation_deadline
    }

    pub(super) fn channel_retry_at(&self) -> Option<Instant> {
        self.channel_retry_at
    }

    pub(super) fn token_renewal_at(&self) -> Option<Instant> {
        self.conn_state.token_renewal_at
    }

    pub(super) fn max_idle_interval(&self) -> Option<Duration> {
        self.conn_state.max_idle_interval
    }

    pub(super) fn channel_state(&self) -> ChannelLifecycleState {
        self.lifecycle.channel
    }

    pub(super) fn connection_is_suspended(&self) -> bool {
        self.lifecycle.connection == ConnectionLifecycleState::Suspended
    }

    pub(super) fn channel_serial(&self) -> Option<&str> {
        self.conn_state.channel_serial.as_deref()
    }

    pub(super) fn attach_mode(&self) -> AttachMode {
        if self.attach_resume {
            AttachMode::Resume
        } else {
            AttachMode::Clean
        }
    }

    pub(super) fn token(&self) -> &str {
        &self.conn_state.token.token
    }

    pub(super) fn connection_key(&self) -> Option<&str> {
        self.conn_state.connection_key.as_deref()
    }

    pub(super) fn connection_id(&self) -> Option<&str> {
        self.conn_state.connection_id.as_deref()
    }

    pub(super) fn server_id(&self) -> Option<&str> {
        self.conn_state.server_id.as_deref()
    }

    pub(super) fn can_resume(&self) -> bool {
        self.conn_state.can_resume()
    }

    // Channel attach tracks separate timers: an operation deadline may be set
    // when ATTACH starts, and a retry deadline is scheduled if that attach is
    // suspended by timeout or DETACHED response.
    pub(super) fn begin_channel_attach(&mut self, realtime_request_timeout: Duration) -> bool {
        self.lifecycle.request_channel_attaching();
        if self.lifecycle.channel != ChannelLifecycleState::Attaching
            || !self.lifecycle.connection.send_events()
        {
            return false;
        }

        self.channel_retry_at = None;
        self.channel_operation_deadline = checked_deadline_after(realtime_request_timeout);
        true
    }

    pub(super) fn clear_elapsed_channel_operation_deadline(
        &mut self,
        now: Instant,
        channel_retry_timeout: Duration,
    ) -> Option<bool> {
        if self
            .channel_operation_deadline
            .is_none_or(|deadline| deadline > now)
        {
            return None;
        }

        self.channel_operation_deadline = None;
        if self.lifecycle.channel == ChannelLifecycleState::Attaching {
            self.enter_channel_suspended(channel_retry_timeout);
            return Some(true);
        }
        Some(false)
    }

    pub(super) fn clear_elapsed_channel_retry(&mut self, now: Instant) -> Option<bool> {
        if self.channel_retry_at.is_none_or(|deadline| deadline > now) {
            return None;
        }

        self.channel_retry_at = None;
        Some(self.lifecycle.channel == ChannelLifecycleState::Suspended)
    }

    pub(super) fn enter_channel_suspended(&mut self, channel_retry_timeout: Duration) {
        self.conn_state.channel_serial = None;
        self.lifecycle.notify_channel_suspended();
        self.schedule_channel_retry(channel_retry_timeout);
    }

    // A successful attach resolves pending channel work and restarts retry
    // backoff from zero for the next suspension.
    pub(super) fn mark_channel_attached(&mut self) {
        self.lifecycle.notify_channel_attached();
        self.attach_resume = true;
        self.channel_retry_at = None;
        self.channel_retry_count = 0;
        self.channel_operation_deadline = None;
    }

    pub(super) fn enter_channel_failed(&mut self) {
        self.conn_state.channel_serial = None;
        self.attach_resume = false;
        self.lifecycle.notify_channel_failed();
        self.channel_retry_at = None;
        self.channel_operation_deadline = None;
        self.connected_event_pending = false;
    }

    pub(super) fn record_channel_serial(&mut self, channel_serial: String) {
        self.conn_state.channel_serial = Some(channel_serial);
    }

    pub(super) fn mark_connection_disconnected(&mut self, now: Instant) {
        self.conn_state.disconnected_at = Some(now);
        self.lifecycle.notify_disconnected();
    }

    pub(super) fn notify_protocol_disconnected(&mut self) {
        self.lifecycle.notify_disconnected();
    }

    pub(super) fn suspend_deadline(&self) -> Option<Instant> {
        if self.lifecycle.connection == ConnectionLifecycleState::Suspended
            || self.conn_state.connection_key.is_none()
        {
            return None;
        }
        self.conn_state.disconnected_at.and_then(|disconnected_at| {
            checked_deadline_from(disconnected_at, self.conn_state.connection_state_ttl)
        })
    }

    pub(super) fn should_enter_suspended_retry(&self) -> bool {
        self.lifecycle.connection != ConnectionLifecycleState::Suspended
            && self.conn_state.disconnected_at.is_some()
            && !self.conn_state.can_resume()
    }

    // Suspended retry means the session can no longer resume the previous
    // connection, either because the resumable window expired or because no
    // resume key is available. Clear resume metadata, channel serial, pending
    // channel deadlines, and deferred connected emission before future attempts
    // use a fresh connection.
    pub(super) fn enter_suspended_retry_state(&mut self) {
        self.conn_state.clear_resume_state();
        self.lifecycle.notify_suspended();
        self.conn_state.channel_serial = None;
        self.channel_retry_at = None;
        self.channel_operation_deadline = None;
        self.connected_event_pending = false;
    }

    pub(super) fn request_closing(&mut self) {
        self.attach_resume = false;
        self.lifecycle.request_closing();
    }

    pub(super) fn mark_closed(&mut self) {
        self.attach_resume = false;
        self.lifecycle.notify_closed();
    }

    pub(super) fn enter_connection_failed(&mut self) {
        self.lifecycle.notify_failed();
        self.conn_state.channel_serial = None;
        self.attach_resume = false;
        self.channel_retry_at = None;
        self.channel_operation_deadline = None;
    }

    pub(super) fn update_from_connected(&mut self, msg: &ProtocolMessage) {
        self.conn_state.update_from_connected(msg);
    }

    pub(super) fn take_connected_event_pending(&mut self) -> bool {
        let pending = self.connected_event_pending;
        self.connected_event_pending = false;
        pending
    }

    // Token renewal failures are consecutive. A successful renewal or
    // committed connected reconnect establishes valid token/transport state and
    // resets the count; reaching max_failures makes the session fail
    // terminally.
    pub(super) fn record_successful_token_renewal(&mut self) {
        self.token_renewal_failures = 0;
    }

    pub(super) fn record_failed_token_renewal(
        &mut self,
        max_failures: u32,
        retry_delay: Duration,
    ) -> TokenRenewalFailure {
        self.token_renewal_failures = self.token_renewal_failures.saturating_add(1);
        let failures = self.token_renewal_failures;

        if failures >= max_failures {
            self.lifecycle.notify_failed();
            self.attach_resume = false;
            return TokenRenewalFailure::Fatal { failures };
        }

        self.conn_state.token_renewal_at = checked_deadline_after(retry_delay);
        TokenRenewalFailure::Retry { failures }
    }

    pub(super) fn commit_token(&mut self, token: TokenDetails, token_renewal_margin: Duration) {
        self.conn_state.token = token;
        self.conn_state.token_renewal_at =
            ConnState::compute_renewal_at(&self.conn_state.token, token_renewal_margin);
    }

    pub(super) fn request_connecting(&mut self) {
        self.lifecycle.request_connecting();
    }

    // Reconnect commit outcomes separate transport recovery from subscription
    // readiness. If the channel reattaches during reconnect, the caller can
    // emit `Event::Connected` immediately. If the transport reconnects but the
    // channel is suspended, hold that event for a later ATTACHED message unless
    // channel failure or suspended cleanup clears the pending marker first.
    pub(super) fn commit_reconnect_attached(
        &mut self,
        connected_msg: &ProtocolMessage,
        channel_serial: Option<String>,
        token: Option<TokenDetails>,
        token_renewal_margin: Duration,
    ) {
        if let Some(serial) = channel_serial {
            self.conn_state.channel_serial = Some(serial);
        }
        self.commit_connected_transport_state(connected_msg, token, token_renewal_margin);
        self.token_renewal_failures = 0;
        self.connected_event_pending = false;
        self.attach_resume = true;
        self.lifecycle.notify_connected();
    }

    pub(super) fn commit_reconnect_channel_suspended(
        &mut self,
        connected_msg: &ProtocolMessage,
        token: Option<TokenDetails>,
        token_renewal_margin: Duration,
        channel_retry_timeout: Duration,
    ) {
        self.conn_state.channel_serial = None;
        self.commit_connected_transport_state(connected_msg, token, token_renewal_margin);
        self.token_renewal_failures = 0;
        self.lifecycle.notify_transport_connected();
        self.enter_channel_suspended(channel_retry_timeout);
        self.connected_event_pending = true;
    }

    pub(super) fn commit_reconnect_closed(&mut self) {
        self.conn_state.channel_serial = None;
        self.attach_resume = false;
        self.lifecycle.notify_closed();
    }

    pub(super) fn mark_reconnect_failed_if_not_suspended(&mut self) {
        if self.lifecycle.connection != ConnectionLifecycleState::Suspended {
            self.lifecycle.notify_disconnected();
        }
    }

    fn schedule_channel_retry(&mut self, channel_retry_timeout: Duration) {
        // A retry supersedes any in-flight attach deadline.
        self.channel_operation_deadline = None;
        if self.lifecycle.channel == ChannelLifecycleState::Suspended
            && self.lifecycle.connection.send_events()
        {
            self.channel_retry_count = self.channel_retry_count.saturating_add(1);
            self.channel_retry_at = checked_deadline_after(retry_delay(
                channel_retry_timeout,
                self.channel_retry_count,
            ));
        } else {
            self.channel_retry_at = None;
        }
    }

    fn commit_connected_transport_state(
        &mut self,
        connected_msg: &ProtocolMessage,
        token: Option<TokenDetails>,
        token_renewal_margin: Duration,
    ) {
        self.conn_state.update_from_connected(connected_msg);
        if let Some(token) = token {
            self.commit_token(token, token_renewal_margin);
        }
        self.conn_state.disconnected_at = None;
        self.channel_retry_at = None;
        self.channel_retry_count = 0;
        self.channel_operation_deadline = None;
    }
}

#[cfg(test)]
mod tests;
