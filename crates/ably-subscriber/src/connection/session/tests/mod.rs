use super::*;
use crate::protocol::{AttachMode, ConnectionDetails, action};
use crate::types::{TimingConfig, TokenDetails};

fn test_token() -> TokenDetails {
    TokenDetails {
        token: "token".to_string(),
        expires: i64::MAX,
        issued: 0,
        capability: None,
        client_id: None,
    }
}

fn test_conn_state() -> ConnState {
    let timing = TimingConfig::default();
    ConnState {
        server_id: None,
        connection_id: Some("conn-1".to_string()),
        connection_key: Some("conn-1!key".to_string()),
        channel_serial: Some("serial-0".to_string()),
        connection_state_ttl: timing.default_connection_state_ttl,
        max_idle_interval: Some(timing.default_max_idle_interval),
        disconnected_at: None,
        token: test_token(),
        token_renewal_at: None,
    }
}

#[test]
fn channel_retry_count_saturates_at_max_attempt() {
    let timing = TimingConfig::default();
    let mut state = SessionState::connected(test_conn_state());
    state.lifecycle.notify_channel_suspended();
    state.channel_retry_count = u32::MAX;

    state.schedule_channel_retry(timing.channel_retry_timeout);

    assert_eq!(state.channel_retry_count, u32::MAX);
    assert!(state.channel_retry_at.is_some());
}

#[test]
fn suspended_retry_clears_resume_channel_and_pending_state() {
    let mut state = SessionState::connected(test_conn_state());
    state.connected_event_pending = true;
    state.channel_retry_at = Some(Instant::now());
    state.channel_operation_deadline = Some(Instant::now());

    state.enter_suspended_retry_state();

    assert_eq!(state.connection_id(), None);
    assert_eq!(state.connection_key(), None);
    assert_eq!(state.channel_serial(), None);
    assert_eq!(state.attach_mode(), AttachMode::Resume);
    assert_eq!(state.channel_retry_at(), None);
    assert_eq!(state.channel_operation_deadline(), None);
    assert!(!state.connected_event_pending);
    assert_eq!(
        state.lifecycle.connection,
        ConnectionLifecycleState::Suspended
    );
}

#[test]
fn reconnect_channel_suspended_sets_pending_connected_event() {
    let timing = TimingConfig::default();
    let mut state = SessionState::connected(test_conn_state());
    state.request_connecting();
    let connected = ProtocolMessage {
        action: action::CONNECTED,
        connection_id: Some("conn-2".to_string()),
        connection_key: Some("conn-2!key".to_string()),
        connection_details: Some(ConnectionDetails {
            connection_key: Some("conn-2!key".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    };

    state.commit_reconnect_channel_suspended(
        &connected,
        None,
        timing.token_renewal_margin,
        timing.channel_retry_timeout,
    );

    assert!(state.connected_event_pending);
    assert_eq!(state.channel_serial(), None);
    assert_eq!(state.attach_mode(), AttachMode::Resume);
    assert_eq!(state.connection_id(), Some("conn-2"));
    assert_eq!(state.channel_state(), ChannelLifecycleState::Suspended);
    assert!(state.channel_retry_at().is_some());
}

#[test]
fn terminal_channel_states_clear_attach_resume_intent() {
    let mut closed_state = SessionState::connected(test_conn_state());
    closed_state.request_closing();
    closed_state.mark_closed();

    assert_eq!(closed_state.attach_mode(), AttachMode::Clean);

    let mut channel_failed_state = SessionState::connected(test_conn_state());
    channel_failed_state.enter_channel_failed();

    assert_eq!(channel_failed_state.attach_mode(), AttachMode::Clean);

    let mut connection_failed_state = SessionState::connected(test_conn_state());
    connection_failed_state.enter_connection_failed();

    assert_eq!(connection_failed_state.attach_mode(), AttachMode::Clean);
}

#[test]
fn token_renewal_failure_marks_failed_at_max_attempts() {
    let timing = TimingConfig::default();
    let mut state = SessionState::connected(test_conn_state());

    let result = state.record_failed_token_renewal(1, timing.token_renewal_retry_delay);

    assert!(matches!(result, TokenRenewalFailure::Fatal { failures: 1 }));
    assert_eq!(state.lifecycle.connection, ConnectionLifecycleState::Failed);
    assert_eq!(state.attach_mode(), AttachMode::Clean);
}
