use super::*;
use tracing::{Level, instrument::WithSubscriber};
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

mod blocked_cancellation;

fn make_message(name: Option<&str>, data: serde_json::Value) -> ably_subscriber::Message {
    ably_subscriber::Message {
        name: name.map(String::from),
        data,
        id: None,
        client_id: None,
        timestamp: None,
    }
}

#[tokio::test]
async fn ably_connected_wakes_every_active_input_reader_once() {
    let notifications = ActiveInputNotifications::new();
    let mut first = notifications.subscribe(RunId::new_v4());
    let mut second = notifications.subscribe(RunId::new_v4());

    let mut disconnect = AblyDisconnectState::disconnected("transport lost".to_string());

    handle_ably_connected(&mut disconnect, &notifications);

    assert!(disconnect.is_connected());
    for subscription in [&mut first, &mut second] {
        tokio::time::timeout(Duration::from_secs(5), subscription.wait())
            .await
            .expect("reconnect wakes every active run");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), subscription.wait())
                .await
                .is_err(),
            "one reconnect wakes each run once"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn disconnect_state_preserves_one_shot_escalation_window() {
    let captured = CapturedEvents::default();
    let dispatch = tracing::Dispatch::new(tracing_subscriber::registry().with(captured.clone()));
    let mut state = AblyDisconnectState::disconnected("connecting".to_string());
    state.mark_connected();

    state.record_disconnected("first disconnect".to_string());
    let first_deadline = state.error_deadline().unwrap();
    tokio::time::advance(Duration::from_secs(20)).await;
    state.record_disconnected("second disconnect event".to_string());

    assert!(!state.is_connected());
    assert_eq!(state.error_deadline(), Some(first_deadline));
    tokio::time::advance(Duration::from_secs(40)).await;
    tracing::dispatcher::with_default(&dispatch, || state.log_persistent_disconnect());
    assert!(state.error_deadline().is_none());

    state.record_disconnected("third disconnect event".to_string());
    assert!(state.error_deadline().is_none());
    tokio::time::advance(ABLY_DISCONNECT_ERROR_AFTER).await;
    tracing::dispatcher::with_default(&dispatch, || state.log_persistent_disconnect());
    assert_eq!(captured.entries().len(), 1);

    state.mark_connected();
    assert!(state.is_connected());
    assert!(state.error_deadline().is_none());
    state.record_disconnected("new window".to_string());
    assert_eq!(
        state.error_deadline(),
        Some(tokio::time::Instant::now() + ABLY_DISCONNECT_ERROR_AFTER)
    );
    tokio::time::advance(ABLY_DISCONNECT_ERROR_AFTER).await;
    tracing::dispatcher::with_default(&dispatch, || state.log_persistent_disconnect());
    assert!(state.error_deadline().is_none());

    let events = captured.entries();
    assert_eq!(events.len(), 2);
    for (event, reason) in events.iter().zip(["second disconnect event", "new window"]) {
        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("ably disconnected for too long, reconnecting control subscription")
        );
        assert_eq!(event.fields.get("reason").map(String::as_str), Some(reason));
        assert_eq!(
            event.fields.get("disconnected_secs").map(String::as_str),
            Some("60")
        );
    }
}

#[tokio::test(start_paused = true)]
async fn quick_reconnect_clears_error_deadline_but_persistent_disconnect_reaches_it() {
    let mut state = AblyDisconnectState::disconnected("connecting".to_string());
    let deadline = state.error_deadline().unwrap();

    tokio::time::advance(ABLY_BACKOFF_INITIAL).await;
    assert!(tokio::time::Instant::now() < deadline);
    state.mark_connected();
    assert!(state.error_deadline().is_none());

    state.record_disconnected("new disconnect".to_string());
    let deadline = state.error_deadline().unwrap();
    tokio::time::advance(ABLY_DISCONNECT_ERROR_AFTER - Duration::from_millis(1)).await;
    assert!(tokio::time::Instant::now() < deadline);
    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(tokio::time::Instant::now() >= deadline);
}

#[tokio::test]
async fn cooperative_cancel_notification_uses_cooperative_signal() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let token = registration.token();
    let signals = registration.handle().signals();

    let msg = make_message(
        Some("cancel"),
        serde_json::json!({ "runId": run_id, "mode": "cooperative" }),
    );

    handle_ably_message(&msg, &tokens).await;

    assert!(token.is_cancelled());
    assert!(signals.cooperative_user().is_cancelled());
    assert!(!signals.hard().is_cancelled());
}

#[tokio::test]
async fn hard_cancel_notification_uses_hard_signal() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();

    let msg = make_message(
        Some("cancel"),
        serde_json::json!({ "runId": run_id, "mode": "hard" }),
    );

    handle_ably_message(&msg, &tokens).await;

    assert!(signals.any().is_cancelled());
    assert!(signals.hard().is_cancelled());
    assert!(!signals.cooperative_user().is_cancelled());
}

#[tokio::test]
async fn legacy_cancel_notification_defaults_to_hard_signal() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();

    let msg = make_message(Some("cancel"), serde_json::json!({ "runId": run_id }));

    handle_ably_message(&msg, &tokens).await;

    assert!(signals.any().is_cancelled());
    assert!(signals.hard().is_cancelled());
    assert!(!signals.cooperative_user().is_cancelled());
}

#[tokio::test]
async fn unknown_cancel_notification_mode_defaults_to_hard_signal() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();

    let msg = make_message(
        Some("cancel"),
        serde_json::json!({ "runId": run_id, "mode": "future-mode" }),
    );

    handle_ably_message(&msg, &tokens).await;

    assert!(signals.any().is_cancelled());
    assert!(signals.hard().is_cancelled());
    assert!(!signals.cooperative_user().is_cancelled());
}

#[tokio::test]
async fn supervisor_shutdown_awaits_task_termination() {
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let supervisor = AblySupervisor::spawn_test_task(|shutdown| async move {
        shutdown.cancelled().await;
        let _ = done_tx.send(());
    });

    supervisor.shutdown().await;

    tokio::time::timeout(Duration::from_secs(1), done_rx)
        .await
        .expect("supervisor shutdown should await task termination")
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn supervisor_shutdown_reports_panicked_task_once_after_cancelled_waiter() {
    let captured = CapturedEvents::default();
    async {
        let supervisor = AblySupervisor::spawn_test_task(|shutdown| async move {
            shutdown.cancelled().await;
            panic!("expected supervisor panic");
        });

        // Neither poll yields to the signalled worker on this runtime.
        let mut first = Box::pin(supervisor.shutdown());
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        let mut concurrent = Box::pin(supervisor.shutdown());
        assert!(futures_util::poll!(concurrent.as_mut()).is_pending());
        drop(first);
        assert!(futures_util::poll!(concurrent.as_mut()).is_pending());

        tokio::time::timeout(Duration::from_secs(1), concurrent)
            .await
            .expect("remaining shutdown should join the panicked worker");
        supervisor.shutdown().await;
    }
    .with_subscriber(tracing_subscriber::registry().with(captured.clone()))
    .await;

    let events = captured.entries();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].level, Level::WARN);
    assert_eq!(
        events[0].fields.get("message").map(String::as_str),
        Some("ably supervisor task failed during shutdown")
    );
    assert!(events[0].fields["error"].contains("expected supervisor panic"));
}

#[tokio::test]
async fn supervisor_drop_cancels_task() {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let supervisor = AblySupervisor::spawn_test_task(|shutdown| async move {
        let _ = started_tx.send(());
        shutdown.cancelled().await;
        let _ = done_tx.send(());
    });
    started_rx.await.expect("supervisor test task should start");

    drop(supervisor);

    tokio::time::timeout(Duration::from_secs(1), done_rx)
        .await
        .expect("dropping supervisor should cancel the task")
        .unwrap();
}

#[test]
fn parse_connector_runtime_sync_notification_reads_target() {
    let msg = make_message(
        Some("connector-runtime-sync"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000003",
            "target": {
                "kind": "custom",
                "customConnectorId": "550e8400-e29b-41d4-a716-446655440000"
            }
        }),
    );

    let notification = parse_connector_runtime_sync_notification(&msg)
        .expect("connector runtime notification should parse");

    assert_eq!(
        notification.run_id.to_string(),
        "00000000-0000-0000-0000-000000000003"
    );
    assert_eq!(
        notification.target,
        ConnectorRuntimeTarget::Custom {
            custom_connector_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
        }
    );
}

#[test]
fn parse_connector_runtime_sync_notification_rejects_malformed_target() {
    for data in [
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000003"
        }),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000003",
            "target": { "kind": "custom" }
        }),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000003",
            "target": { "kind": "unknown", "connectorSlug": "slack" }
        }),
    ] {
        let msg = make_message(Some("connector-runtime-sync"), data);
        assert!(parse_connector_runtime_sync_notification(&msg).is_none());
    }
}

#[test]
fn parse_active_input_notification_reads_run_id() {
    let msg = make_message(
        Some("active-input"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000004"
        }),
    );

    assert_eq!(
        parse_active_input_notification(&msg)
            .expect("active-input notification should parse")
            .to_string(),
        "00000000-0000-0000-0000-000000000004"
    );
}

#[test]
fn parse_cancel_notification_valid() {
    let msg = make_message(
        Some("cancel"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000002",
            "mode": "cooperative"
        }),
    );
    let notification = parse_cancel_notification(&msg).unwrap();
    assert_eq!(
        notification.run_id.to_string(),
        "00000000-0000-0000-0000-000000000002"
    );
    assert_eq!(notification.mode, RunCancellationMode::Cooperative);
}
