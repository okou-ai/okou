use super::*;
use crate::protocol::{ConnectionDetails, action};

#[test]
fn conn_state_from_connected() {
    let msg = ProtocolMessage {
        action: action::CONNECTED,
        connection_id: Some("conn-1".to_string()),
        connection_key: Some("conn-1!key".to_string()),
        connection_serial: Some(-1),
        connection_details: Some(ConnectionDetails {
            connection_state_ttl: Some(60000),
            max_idle_interval: Some(10000),
            ..Default::default()
        }),
        ..Default::default()
    };
    let token = TokenDetails {
        token: "tok".to_string(),
        expires: i64::MAX,
        issued: 0,
        capability: None,
        client_id: None,
    };
    let timing = TimingConfig::default();
    let state = ConnState::from_connected(&msg, token, &timing);
    assert_eq!(state.connection_id.as_deref(), Some("conn-1"));
    assert_eq!(state.connection_key.as_deref(), Some("conn-1!key"));
    assert_eq!(state.connection_state_ttl, Duration::from_millis(60000));
    assert_eq!(state.max_idle_interval, Some(Duration::from_millis(10000)));
    assert!(state.token_renewal_at.is_some());
}

#[test]
fn conn_state_ignores_non_positive_connection_state_ttl() {
    let timing = TimingConfig::default();
    let token = TokenDetails {
        token: "tok".to_string(),
        expires: unix_now_ms() + 3_600_000,
        issued: 0,
        capability: None,
        client_id: None,
    };

    for ttl in [0, -1] {
        let msg = ProtocolMessage {
            action: action::CONNECTED,
            connection_details: Some(ConnectionDetails {
                connection_state_ttl: Some(ttl),
                max_idle_interval: Some(10000),
                ..Default::default()
            }),
            ..Default::default()
        };

        let state = ConnState::from_connected(&msg, token.clone(), &timing);
        assert_eq!(
            state.connection_state_ttl,
            timing.default_connection_state_ttl
        );
    }
}

#[test]
fn conn_state_keeps_default_connection_state_ttl_when_details_omit_ttl() {
    let timing = TimingConfig::default();
    let token = TokenDetails {
        token: "tok".to_string(),
        expires: unix_now_ms() + 3_600_000,
        issued: 0,
        capability: None,
        client_id: None,
    };
    let msg = ProtocolMessage {
        action: action::CONNECTED,
        connection_details: Some(ConnectionDetails {
            connection_state_ttl: None,
            max_idle_interval: Some(10000),
            ..Default::default()
        }),
        ..Default::default()
    };

    let state = ConnState::from_connected(&msg, token, &timing);
    assert_eq!(
        state.connection_state_ttl,
        timing.default_connection_state_ttl
    );
    assert_eq!(state.max_idle_interval, Some(Duration::from_millis(10000)));
}

#[test]
fn conn_state_disables_idle_timeout_for_missing_or_non_positive_idle_interval() {
    let timing = TimingConfig::default();
    let token = TokenDetails {
        token: "tok".to_string(),
        expires: unix_now_ms() + 3_600_000,
        issued: 0,
        capability: None,
        client_id: None,
    };

    for idle in [None, Some(0), Some(-1)] {
        let msg = ProtocolMessage {
            action: action::CONNECTED,
            connection_details: Some(ConnectionDetails {
                connection_state_ttl: Some(60000),
                max_idle_interval: idle,
                ..Default::default()
            }),
            ..Default::default()
        };

        let state = ConnState::from_connected(&msg, token.clone(), &timing);
        assert_eq!(state.max_idle_interval, None);
    }
}

#[test]
fn idle_deadline_is_disabled_without_max_idle_interval() {
    assert_eq!(
        idle_deadline(Instant::now(), None, Duration::from_secs(10)),
        None
    );
}

#[test]
fn reconnect_spacing_delay_elapsed_exceeds_min_interval_returns_zero() {
    let long_ago = Instant::now() - Duration::from_secs(60);

    assert_eq!(
        reconnect_spacing_delay(Some(long_ago), Duration::from_secs(5)),
        Duration::ZERO
    );
}

#[test]
fn conn_state_uses_default_idle_interval_without_connection_details() {
    let timing = TimingConfig::default();
    let token = TokenDetails {
        token: "tok".to_string(),
        expires: unix_now_ms() + 3_600_000,
        issued: 0,
        capability: None,
        client_id: None,
    };
    let msg = ProtocolMessage {
        action: action::CONNECTED,
        connection_details: None,
        ..Default::default()
    };

    let state = ConnState::from_connected(&msg, token, &timing);
    assert_eq!(
        state.max_idle_interval,
        Some(timing.default_max_idle_interval)
    );
}

#[test]
fn conn_state_handles_huge_external_timing_values_without_panicking() {
    let msg = ProtocolMessage {
        action: action::CONNECTED,
        connection_details: Some(ConnectionDetails {
            connection_state_ttl: Some(i64::MAX),
            max_idle_interval: Some(i64::MAX),
            ..Default::default()
        }),
        ..Default::default()
    };
    let token = TokenDetails {
        token: "tok".to_string(),
        expires: i64::MAX,
        issued: 0,
        capability: None,
        client_id: None,
    };

    let state = ConnState::from_connected(&msg, token, &TimingConfig::default());
    let _ = idle_deadline(
        Instant::now(),
        state.max_idle_interval,
        Duration::from_secs(10),
    );
    let _ = checked_deadline_from(Instant::now(), state.connection_state_ttl);
    let _ = state.token_renewal_at;
}

#[test]
fn retry_delay_saturates_huge_timeout_without_truncating() {
    let delay = retry_delay(Duration::MAX, 1);

    assert_eq!(delay, Duration::from_millis(u64::MAX));
}

#[test]
fn retry_delay_keeps_capped_backoff_at_max_retry_attempt() {
    let delay = retry_delay(Duration::from_millis(300), u32::MAX);

    assert!(delay >= Duration::from_millis(480));
    assert!(delay < Duration::from_millis(600));
}

#[test]
fn expired_token_renewal_is_scheduled_immediately() {
    let token = TokenDetails {
        token: "tok".to_string(),
        expires: 0,
        issued: 0,
        capability: None,
        client_id: None,
    };

    let renewal_at = ConnState::compute_renewal_at(&token, Duration::from_secs(300))
        .expect("expired tokens should still schedule renewal");
    assert!(renewal_at <= Instant::now());
}

#[test]
fn conn_state_can_resume() {
    let mut state = ConnState {
        server_id: None,
        connection_id: Some("c1".to_string()),
        connection_key: Some("c1!key".to_string()),
        channel_serial: None,
        connection_state_ttl: Duration::from_secs(120),
        max_idle_interval: Some(Duration::from_secs(15)),
        disconnected_at: None,
        token: TokenDetails {
            token: "t".to_string(),
            expires: i64::MAX,
            issued: 0,
            capability: None,
            client_id: None,
        },
        token_renewal_at: checked_deadline_after(Duration::from_secs(3600)),
    };

    // No disconnected_at -> cannot resume
    assert!(!state.can_resume());

    // Just disconnected -> can resume
    state.disconnected_at = Some(Instant::now());
    assert!(state.can_resume());

    // Expired connection state TTL -> cannot resume
    state.disconnected_at = Some(Instant::now() - Duration::from_secs(121));
    assert!(!state.can_resume());
    state.disconnected_at = Some(Instant::now());

    // No connection key -> cannot resume
    state.connection_key = None;
    assert!(!state.can_resume());
}

#[test]
fn realtime_state_machine_reattaches_attached_channel_on_new_transport() {
    let mut lifecycle = RealtimeStateMachine::connected();

    lifecycle.notify_disconnected();
    lifecycle.request_connecting();

    assert_eq!(lifecycle.connection, ConnectionLifecycleState::Connecting);
    assert_eq!(lifecycle.channel, ChannelLifecycleState::Attaching);

    lifecycle.notify_connected();

    assert_eq!(lifecycle.connection, ConnectionLifecycleState::Connected);
    assert_eq!(lifecycle.channel, ChannelLifecycleState::Attached);
}

#[test]
fn realtime_state_machine_close_detaches_channel_and_becomes_terminal() {
    let mut lifecycle = RealtimeStateMachine::connected();

    lifecycle.request_closing();
    lifecycle.notify_closed();
    lifecycle.notify_disconnected();

    assert_eq!(lifecycle.connection, ConnectionLifecycleState::Closed);
    assert_eq!(lifecycle.channel, ChannelLifecycleState::Detached);
}

#[test]
fn realtime_state_machine_failure_fails_channel_and_becomes_terminal() {
    let mut lifecycle = RealtimeStateMachine::connected();

    lifecycle.notify_failed();
    lifecycle.request_connecting();

    assert_eq!(lifecycle.connection, ConnectionLifecycleState::Failed);
    assert_eq!(lifecycle.channel, ChannelLifecycleState::Failed);
}
