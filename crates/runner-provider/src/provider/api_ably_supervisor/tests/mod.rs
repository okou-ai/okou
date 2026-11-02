use super::*;
use crate::provider::{RunnerPreference, RunnerPreferenceTier};
use tracing::Level;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

mod finalizing_source;
mod reuse_polling;

fn make_message(name: Option<&str>, data: serde_json::Value) -> ably_subscriber::Message {
    ably_subscriber::Message {
        name: name.map(String::from),
        data,
        id: None,
        client_id: None,
        timestamp: None,
    }
}

fn poll_reason(due: Option<PollDue>) -> Option<PollReason> {
    due.map(PollDue::reason)
}

fn direct_candidate_inbox() -> Arc<DirectCandidateInbox> {
    direct_candidate_inbox_with_capacity(4)
}

fn direct_candidate_inbox_with_capacity(capacity: usize) -> Arc<DirectCandidateInbox> {
    direct_candidate_inbox_with_stale_after(
        capacity,
        crate::provider::api_direct_candidates::DIRECT_CANDIDATE_STALE_AFTER,
    )
}

fn direct_candidate_inbox_with_stale_after(
    capacity: usize,
    stale_after: Duration,
) -> Arc<DirectCandidateInbox> {
    DirectCandidateInbox::new(capacity, stale_after)
}

async fn pop_direct_candidate(inbox: &DirectCandidateInbox) -> DirectJobCandidate {
    inbox.try_pop().await.expect("direct candidate")
}

async fn assert_no_direct_candidate(inbox: &DirectCandidateInbox) {
    assert!(inbox.try_pop().await.is_none());
}

fn default_profiles() -> Vec<String> {
    vec![crate::profile::DEFAULT_PROFILE.to_string()]
}

#[tokio::test(start_paused = true)]
async fn wait_for_poll_due_consumes_stateful_immediate_wakeup() {
    let wakeups = PollWakeups::new(true);

    let reason = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;

    assert_eq!(poll_reason(reason), Some(PollReason::Immediate));
    let snapshot = wakeups.snapshot();
    assert!(snapshot.ably_connected);
    assert!(!snapshot.poll_now);
}

#[tokio::test(start_paused = true)]
async fn wakeup_poll_failure_schedules_short_retry() {
    let wakeups = PollWakeups::new(true);
    let reason = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();

    wakeups.record_poll_result(reason, PollOutcome::Failure, Duration::from_secs(5));
    let snapshot = wakeups.snapshot();
    assert!(snapshot.wakeup_retry_at.is_some());

    tokio::time::sleep(Duration::from_secs(5)).await;
    let reason = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    assert_eq!(poll_reason(reason), Some(PollReason::WakeupRetry));
}

#[tokio::test(start_paused = true)]
async fn successful_immediate_poll_retires_pending_wakeup_retry() {
    let slow_interval = Duration::from_secs(30);
    let fast_interval = Duration::from_secs(5);

    for outcome in [PollOutcome::JobFound, PollOutcome::Empty] {
        let wakeups = PollWakeups::new(true);
        let cancel = CancellationToken::new();
        let initial = wakeups
            .wait_for_poll_due(&cancel, slow_interval, fast_interval)
            .await
            .unwrap();
        assert_eq!(initial.reason(), PollReason::Immediate);
        wakeups.record_poll_result(initial, PollOutcome::Failure, fast_interval);

        wakeups.request_immediate_poll();
        let due = wakeups
            .wait_for_poll_due(&cancel, slow_interval, fast_interval)
            .await
            .unwrap();
        assert_eq!(due.reason(), PollReason::Immediate);
        wakeups.record_poll_result(due, outcome, fast_interval);

        if outcome == PollOutcome::JobFound {
            let backlog = wakeups
                .wait_for_poll_due(&cancel, slow_interval, fast_interval)
                .await
                .unwrap();
            assert_eq!(backlog.reason(), PollReason::Immediate);
        }

        let started = tokio::time::Instant::now();
        let next = wakeups
            .wait_for_poll_due(&cancel, slow_interval, fast_interval)
            .await
            .unwrap();
        assert_eq!(next.reason(), PollReason::Slow, "{outcome:?}");
        assert_eq!(started.elapsed(), slow_interval, "{outcome:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn regular_poll_failure_does_not_schedule_wakeup_retry() {
    let wakeups = PollWakeups::new(false);
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

    tokio::time::sleep(Duration::from_secs(5)).await;
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(due.reason(), PollReason::Fast);

    wakeups.record_poll_result(due, PollOutcome::Failure, Duration::from_secs(5));
    assert!(wakeups.snapshot().wakeup_retry_at.is_none());
}

#[tokio::test]
async fn ably_connected_wakes_every_active_input_reader_once() {
    let notifications = ActiveInputNotifications::new();
    let mut first = notifications.subscribe(RunId::new_v4());
    let mut second = notifications.subscribe(RunId::new_v4());
    let wakeups = PollWakeups::new(false);
    let mut disconnect = AblyDisconnectState::disconnected("transport lost".to_string());

    handle_ably_connected(&mut disconnect, &wakeups, &notifications);

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
async fn disconnected_state_uses_fast_poll_interval() {
    let wakeups = Arc::new(PollWakeups::new(false));
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

    let wakeups_for_wait = Arc::clone(&wakeups);
    let cancel = CancellationToken::new();
    let wait = tokio::spawn(async move {
        wakeups_for_wait
            .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
            .await
    });
    tokio::time::sleep(Duration::from_secs(5)).await;

    assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Fast));
}

#[tokio::test(start_paused = true)]
async fn connected_state_uses_slow_poll_interval() {
    let wakeups = Arc::new(PollWakeups::new(true));
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

    let wakeups_for_wait = Arc::clone(&wakeups);
    let cancel = CancellationToken::new();
    let wait = tokio::spawn(async move {
        wakeups_for_wait
            .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
            .await
    });
    tokio::time::sleep(Duration::from_secs(30)).await;

    assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Slow));
}

#[tokio::test(start_paused = true)]
async fn pending_connected_wait_switches_to_fast_after_disconnect() {
    let wakeups = Arc::new(PollWakeups::new(true));
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

    let wakeups_for_wait = Arc::clone(&wakeups);
    let cancel = CancellationToken::new();
    let wait = tokio::spawn(async move {
        wakeups_for_wait
            .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
            .await
    });
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(!wait.is_finished());

    wakeups.mark_ably_disconnected();
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(!wait.is_finished());
    tokio::time::sleep(Duration::from_secs(1)).await;

    assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Fast));
}

#[tokio::test(start_paused = true)]
async fn pending_disconnected_wait_switches_to_slow_after_connect() {
    let wakeups = Arc::new(PollWakeups::new(false));
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

    let wakeups_for_wait = Arc::clone(&wakeups);
    let cancel = CancellationToken::new();
    let wait = tokio::spawn(async move {
        wakeups_for_wait
            .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
            .await
    });
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(!wait.is_finished());

    wakeups.mark_ably_connected();
    tokio::time::sleep(Duration::from_secs(29)).await;
    assert!(!wait.is_finished());
    tokio::time::sleep(Duration::from_secs(1)).await;

    assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Slow));
}

#[tokio::test]
async fn job_found_rearms_immediate_poll_for_backlog_drain() {
    let wakeups = PollWakeups::new(true);
    let reason = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();

    wakeups.record_poll_result(reason, PollOutcome::JobFound, Duration::from_secs(5));

    assert!(wakeups.snapshot().poll_now);
    let reason = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    assert_eq!(poll_reason(reason), Some(PollReason::Immediate));
}

#[tokio::test(start_paused = true)]
async fn deferred_poll_extends_until_latest_deadline() {
    let wakeups = Arc::new(PollWakeups::new(true));
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;

    wakeups.request_deferred_poll_after(Duration::from_secs(2));
    let first_deadline = wakeups
        .snapshot()
        .deferred_poll_at
        .expect("first defer deadline");
    tokio::time::sleep(Duration::from_secs(1)).await;
    wakeups.request_deferred_poll_after(Duration::from_secs(2));
    let extended_deadline = wakeups
        .snapshot()
        .deferred_poll_at
        .expect("extended defer deadline");

    assert!(extended_deadline > first_deadline);
    let wakeups_for_wait = Arc::clone(&wakeups);
    let cancel = CancellationToken::new();
    let wait = tokio::spawn(async move {
        wakeups_for_wait
            .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
            .await
    });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        !wait.is_finished(),
        "new deferred poll request should extend the defer window"
    );

    tokio::time::sleep_until(extended_deadline).await;
    assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
}

#[tokio::test]
async fn deferred_poll_until_preserves_absolute_deadline() {
    let wakeups = PollWakeups::new(true);
    let deadline = StdInstant::now() + Duration::from_secs(2);

    wakeups.request_deferred_poll_until(deadline);

    assert_eq!(wakeups.snapshot().deferred_poll_at, Some(deadline.into()));
}

#[tokio::test(start_paused = true)]
async fn deferred_poll_revalidates_extended_deadline() {
    let wakeups = PollWakeups::new(true);
    let now = tokio::time::Instant::now();
    wakeups.request_deferred_poll_after(Duration::from_secs(2));
    let scheduled = PollWakeups::next_scheduled(
        &wakeups.lock_inner(),
        now,
        Duration::from_secs(30),
        Duration::from_secs(5),
    );

    tokio::time::advance(Duration::from_secs(1)).await;
    wakeups.request_deferred_poll_after(Duration::from_secs(2));
    wakeups.request_deferred_poll_after(Duration::ZERO);

    // The earlier timer can win a race with the extension notification.
    tokio::time::sleep_until(scheduled.at).await;
    assert!(wakeups.consume_scheduled(scheduled).is_none());

    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    assert_eq!(poll_reason(due), Some(PollReason::Deferred));
    assert_eq!(tokio::time::Instant::now(), now + Duration::from_secs(3));
    assert!(!wakeups.snapshot().poll_now);
}

#[tokio::test(start_paused = true)]
async fn deferred_poll_extension_is_bounded() {
    let wakeups = PollWakeups::new(true);
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;

    wakeups.request_deferred_poll_after(Duration::from_secs(2));
    let cap = wakeups.snapshot().deferred_poll_cap_at.expect("defer cap");
    for _ in 0..9 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        wakeups.request_deferred_poll_after(Duration::from_secs(2));
    }

    let snapshot = wakeups.snapshot();
    assert_eq!(snapshot.deferred_poll_at, Some(cap));
    assert_eq!(snapshot.deferred_poll_cap_at, Some(cap));
    tokio::time::sleep_until(cap).await;
    let reason = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    assert_eq!(poll_reason(reason), Some(PollReason::Deferred));
}

#[tokio::test(start_paused = true)]
async fn deferred_poll_cap_resets_after_deadline() {
    let wakeups = PollWakeups::new(true);
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;

    wakeups.request_deferred_poll_after(Duration::from_secs(2));
    let initial_cap = wakeups
        .snapshot()
        .deferred_poll_cap_at
        .expect("initial defer cap");
    for _ in 0..9 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        wakeups.request_deferred_poll_after(Duration::from_secs(2));
    }

    tokio::time::sleep_until(initial_cap).await;
    let reason = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    assert_eq!(poll_reason(reason), Some(PollReason::Deferred));
    let snapshot = wakeups.snapshot();
    assert!(snapshot.deferred_poll_at.is_none());
    assert!(snapshot.deferred_poll_cap_at.is_none());

    wakeups.request_deferred_poll_after(Duration::from_secs(2));
    let snapshot = wakeups.snapshot();
    let next_deadline = snapshot
        .deferred_poll_at
        .expect("next defer deadline should be scheduled");
    let next_cap = snapshot
        .deferred_poll_cap_at
        .expect("next defer cap should be scheduled");
    assert!(next_deadline > initial_cap);
    assert!(next_cap > next_deadline);
}

#[tokio::test(start_paused = true)]
async fn deferred_poll_blocks_pending_immediate_until_deadline() {
    let wakeups = Arc::new(PollWakeups::new(true));
    let initial = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(initial, PollOutcome::JobFound, Duration::from_secs(5));
    assert!(wakeups.snapshot().poll_now);

    wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));

    let wakeups_for_wait = Arc::clone(&wakeups);
    let cancel = CancellationToken::new();
    let wait = tokio::spawn(async move {
        wakeups_for_wait
            .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !wait.is_finished(),
        "pending immediate must not bypass deferred poll window"
    );

    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
    assert!(!wakeups.snapshot().poll_now);
}

#[tokio::test(start_paused = true)]
async fn deferred_poll_blocks_wakeup_retry_until_deadline() {
    let wakeups = Arc::new(PollWakeups::new(true));
    let initial = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(initial, PollOutcome::Failure, Duration::from_secs(1));
    wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));

    tokio::time::sleep(Duration::from_secs(1)).await;
    let wakeups_for_wait = Arc::clone(&wakeups);
    let cancel = CancellationToken::new();
    let wait = tokio::spawn(async move {
        wakeups_for_wait
            .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !wait.is_finished(),
        "wakeup retry must not bypass deferred poll window"
    );

    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
}

#[tokio::test(start_paused = true)]
async fn empty_poll_keeps_deferred_wakeup_created_after_poll_started() {
    let wakeups = PollWakeups::new(true);
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();

    let deferred_at = tokio::time::Instant::now() + Duration::from_secs(2);
    wakeups.request_deferred_poll_at(deferred_at);
    wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

    assert_eq!(wakeups.snapshot().deferred_poll_at, Some(deferred_at));
}

#[tokio::test(start_paused = true)]
async fn job_found_defers_return_when_deferred_poll_arrived_after_poll_started() {
    let wakeups = PollWakeups::new(true);
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();

    wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));
    let record = wakeups.record_poll_result(due, PollOutcome::JobFound, Duration::from_secs(5));

    assert!(record.defer_job_return());
    assert!(wakeups.snapshot().deferred_poll_at.is_some());
}

#[tokio::test(start_paused = true)]
async fn job_found_returns_when_deferred_poll_was_the_poll_reason() {
    let wakeups = PollWakeups::new(true);
    let initial = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(initial, PollOutcome::Empty, Duration::from_secs(5));
    wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));
    tokio::time::sleep(Duration::from_secs(2)).await;
    let due = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();

    let record = wakeups.record_poll_result(due, PollOutcome::JobFound, Duration::from_secs(5));

    assert!(!record.defer_job_return());
}

#[tokio::test(start_paused = true)]
async fn empty_poll_clears_deferred_wakeup_seen_by_poll() {
    let wakeups = PollWakeups::new(true);
    let initial = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    wakeups.record_poll_result(initial, PollOutcome::Empty, Duration::from_secs(5));

    wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));
    tokio::time::sleep(Duration::from_secs(2)).await;
    let deferred = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await
        .unwrap();

    wakeups.record_poll_result(deferred, PollOutcome::Empty, Duration::from_secs(5));

    assert!(wakeups.snapshot().deferred_poll_at.is_none());
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
            Some("ably disconnected for too long, continuing fast poll")
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
async fn cooperative_cancel_notification_uses_cooperative_signal_without_discovery() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let token = registration.token();
    let signals = registration.handle().signals();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let msg = make_message(
        Some("cancel"),
        serde_json::json!({ "runId": run_id, "mode": "cooperative" }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert!(token.is_cancelled());
    assert!(signals.cooperative_user().is_cancelled());
    assert!(!signals.hard().is_cancelled());
    assert_no_direct_candidate(&direct_candidates).await;
}

#[tokio::test]
async fn hard_cancel_notification_uses_hard_signal_without_discovery() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let msg = make_message(
        Some("cancel"),
        serde_json::json!({ "runId": run_id, "mode": "hard" }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert!(signals.any().is_cancelled());
    assert!(signals.hard().is_cancelled());
    assert!(!signals.cooperative_user().is_cancelled());
    assert_no_direct_candidate(&direct_candidates).await;
}

#[tokio::test]
async fn legacy_cancel_notification_defaults_to_hard_signal() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let msg = make_message(Some("cancel"), serde_json::json!({ "runId": run_id }));

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert!(signals.any().is_cancelled());
    assert!(signals.hard().is_cancelled());
    assert!(!signals.cooperative_user().is_cancelled());
    assert_no_direct_candidate(&direct_candidates).await;
}

#[tokio::test]
async fn unknown_cancel_notification_mode_defaults_to_hard_signal() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let msg = make_message(
        Some("cancel"),
        serde_json::json!({ "runId": run_id, "mode": "future-mode" }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert!(signals.any().is_cancelled());
    assert!(signals.hard().is_cancelled());
    assert!(!signals.cooperative_user().is_cancelled());
    assert_no_direct_candidate(&direct_candidates).await;
}

#[tokio::test]
async fn queued_cancel_preserves_registration_and_allows_unrelated_notification() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let job_run_id: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();
    let transfer_guard = registration.handle().transfer_guard().await;
    let msg = make_message(
        Some("cancel"),
        serde_json::json!({ "runId": run_id, "mode": "hard" }),
    );
    let mut cancel_deliveries = FuturesUnordered::new();
    assert!(enqueue_cancel_delivery(&msg, &tokens, &mut cancel_deliveries).await);

    assert!(futures_util::poll!(cancel_deliveries.next()).is_pending());
    assert!(registration.unregister().await);
    let replacement = tokens.register(run_id).await.unwrap();

    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let job_msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": job_run_id,
            "profile": "vm0/default"
        }),
    );
    handle_ably_message(&job_msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert_eq!(
        pop_direct_candidate(&direct_candidates).await.run_id(),
        job_run_id
    );
    assert!(!signals.hard().is_cancelled());
    drop(transfer_guard);
    tokio::time::timeout(Duration::from_secs(1), cancel_deliveries.next())
        .await
        .expect("queued cancellation should complete after transfer")
        .expect("queued cancellation delivery");

    assert!(signals.hard().is_cancelled());
    assert!(!replacement.is_cancelled());
}

#[tokio::test]
async fn supervisor_shutdown_drops_transfer_blocked_cancel_after_unrelated_progress() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let job_run_id: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();
    let transfer_guard = registration.handle().transfer_guard().await;
    let direct_candidates = direct_candidate_inbox();
    let task_direct_candidates = Arc::clone(&direct_candidates);
    let task_tokens = tokens.clone();
    let (progress_tx, progress_rx) = tokio::sync::oneshot::channel();
    let supervisor = AblySupervisor::spawn_test_task(move |shutdown| async move {
        let cancel_msg = make_message(
            Some("cancel"),
            serde_json::json!({ "runId": run_id, "mode": "hard" }),
        );
        let mut cancel_deliveries = FuturesUnordered::new();
        assert!(enqueue_cancel_delivery(&cancel_msg, &task_tokens, &mut cancel_deliveries).await);
        assert!(futures_util::poll!(cancel_deliveries.next()).is_pending());

        let wakeups = PollWakeups::new(true);
        let profiles = default_profiles();
        let job_msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": job_run_id,
                "profile": "vm0/default"
            }),
        );
        handle_ably_message(
            &job_msg,
            &profiles,
            &wakeups,
            &task_direct_candidates,
            &task_tokens,
        )
        .await;
        let _ = progress_tx.send(());

        let shutdown_won = tokio::select! {
            () = shutdown.cancelled() => true,
            Some(()) = cancel_deliveries.next() => false,
        };
        assert!(
            shutdown_won,
            "cancellation must remain blocked while the transfer guard is held"
        );
    });

    tokio::time::timeout(Duration::from_secs(1), progress_rx)
        .await
        .expect("unrelated notification should make progress")
        .unwrap();
    assert_eq!(
        pop_direct_candidate(&direct_candidates).await.run_id(),
        job_run_id
    );
    tokio::time::timeout(Duration::from_secs(1), supervisor.shutdown())
        .await
        .expect("supervisor shutdown should drop blocked cancellation delivery");

    assert!(!signals.hard().is_cancelled());
    drop(transfer_guard);
}

#[tokio::test]
async fn broadcast_supported_job_notification_enqueues_direct_candidate() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "profile": "vm0/default",
            "reuseKey": "thread:chat-thread",
            "runnerPreference": {
                "kind": "preference",
                "runnerIdentity": {
                    "runnerId": "00000000-0000-0000-0000-000000000005",
                    "heartbeatGeneration": 7
                },
                "tier": "predecessorHome",
                "home": {"evidence": "advertised"},
                "predecessorRunId": "33333333-3333-4333-8333-333333333333",
                "expiresAt": "2999-01-01T00:00:00.000Z"
            }
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    let candidate = pop_direct_candidate(&direct_candidates).await;
    assert_eq!(
        candidate.run_id().to_string(),
        "00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(candidate.profile_name(), "vm0/default");
    let candidate = candidate.into_job_candidate();
    assert_eq!(candidate.reuse_key(), Some("thread:chat-thread"));
    let preference = candidate
        .runner_preference()
        .expect("canonical preference should be parsed");
    assert_eq!(
        preference.tier(),
        RunnerPreferenceTier::PredecessorHome(
            crate::provider::ActivePredecessorHomeEvidence::Advertised
        )
    );
    assert_eq!(
        preference.target().predecessor_run_id(),
        Some("33333333-3333-4333-8333-333333333333".parse().unwrap())
    );
    assert!(
        preference.targets(
            runner_host::runner_process_identity::RunnerProcessIdentity::new(
                "00000000-0000-0000-0000-000000000005".parse().unwrap(),
                7,
            )
            .unwrap()
        )
    );
    let telemetry = candidate
        .runner_preference_claim_telemetry()
        .expect("canonical preference telemetry");
    assert!(matches!(
        telemetry.runner_preference,
        RunnerPreference::Preference(
            crate::provider::RunnerPreferenceDecision::PredecessorHome { .. }
        )
    ));
    assert_eq!(
        telemetry.state,
        Some(super::super::RunnerPreferenceClaimState::Active)
    );
    assert_no_direct_candidate(&direct_candidates).await;
    assert!(!wakeups.snapshot().poll_now);
}

#[tokio::test]
async fn malformed_preference_preserves_direct_candidate() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000011",
            "profile": "vm0/default",
            "reuseKey": "thread:malformed-preference",
            "runnerPreference": {
                "kind": "preference",
                "runnerIdentity": {
                    "runnerId": "00000000-0000-0000-0000-000000000005",
                    "heartbeatGeneration": 0
                },
                "tier": "homeCache",
                "expiresAt": "2999-01-01T00:00:00.000Z"
            }
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    let candidate = pop_direct_candidate(&direct_candidates)
        .await
        .into_job_candidate();
    assert_eq!(candidate.reuse_key(), Some("thread:malformed-preference"));
    assert!(candidate.runner_preference().is_none());
    assert!(candidate.runner_preference_claim_telemetry().is_none());
    assert_no_direct_candidate(&direct_candidates).await;
}

#[tokio::test]
async fn missing_preference_preserves_direct_candidate() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000012",
            "profile": "vm0/default",
            "reuseKey": "thread:missing-preference"
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    let candidate = pop_direct_candidate(&direct_candidates)
        .await
        .into_job_candidate();
    assert_eq!(candidate.reuse_key(), Some("thread:missing-preference"));
    assert!(candidate.runner_preference().is_none());
    assert!(candidate.runner_preference_claim_telemetry().is_none());
    assert_no_direct_candidate(&direct_candidates).await;
}

#[tokio::test]
async fn unsupported_profile_job_notification_is_ignored() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "profile": "vm0/large"
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert_no_direct_candidate(&direct_candidates).await;
    let snapshot = wakeups.snapshot();
    assert!(!snapshot.poll_now);
    assert!(snapshot.deferred_poll_at.is_none());
}

#[tokio::test]
async fn empty_profile_support_job_notification_is_ignored() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = Vec::new();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "profile": "vm0/default"
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert_no_direct_candidate(&direct_candidates).await;
    let snapshot = wakeups.snapshot();
    assert!(!snapshot.poll_now);
    assert!(snapshot.deferred_poll_at.is_none());
}

#[tokio::test]
async fn missing_profile_job_notification_wakes_poll() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001"
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert_no_direct_candidate(&direct_candidates).await;
    assert!(wakeups.snapshot().poll_now);
}

#[tokio::test]
async fn empty_profile_job_notification_wakes_poll() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "profile": ""
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    assert_no_direct_candidate(&direct_candidates).await;
    assert!(wakeups.snapshot().poll_now);
}

#[tokio::test]
async fn full_direct_candidate_queue_wakes_poll_fallback() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox_with_capacity(1);
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "profile": "vm0/default"
        }),
    );
    let overflowing_msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000002",
            "profile": "vm0/default"
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;
    handle_ably_message(
        &overflowing_msg,
        &profiles,
        &wakeups,
        &direct_candidates,
        &tokens,
    )
    .await;

    let candidate = pop_direct_candidate(&direct_candidates).await;
    assert_eq!(candidate.profile_name(), "vm0/default");
    assert!(wakeups.snapshot().poll_now);
}

#[tokio::test]
async fn stale_full_direct_candidate_queue_prunes_before_enqueueing() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let stale_after = Duration::from_secs(60);
    let direct_candidates = direct_candidate_inbox_with_stale_after(1, stale_after);
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let stale_enqueued_at = StdInstant::now() - Duration::from_secs(120);
    let stale_run_id: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
    let _ = direct_candidates
        .push(DirectJobCandidate::new_with_enqueued_at(
            stale_run_id,
            "vm0/default".to_string(),
            stale_enqueued_at,
            stale_enqueued_at,
        ))
        .await;
    let msg = make_message(
        Some("job"),
        serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000002",
            "profile": "vm0/default"
        }),
    );

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    let candidate = pop_direct_candidate(&direct_candidates).await;
    assert_eq!(
        candidate.run_id(),
        "00000000-0000-0000-0000-000000000002"
            .parse::<RunId>()
            .unwrap()
    );
    assert!(!wakeups.snapshot().poll_now);
}

#[tokio::test]
async fn invalid_job_notification_does_not_mutate_wakeup_state() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let direct_candidates = direct_candidate_inbox();
    let profiles = default_profiles();
    let _ = wakeups
        .wait_for_poll_due(
            &CancellationToken::new(),
            Duration::from_secs(30),
            Duration::from_secs(5),
        )
        .await;
    let msg = make_message(Some("job"), serde_json::json!({ "runId": "not-a-uuid" }));

    handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

    let snapshot = wakeups.snapshot();
    assert_no_direct_candidate(&direct_candidates).await;
    assert!(!snapshot.poll_now);
    assert!(snapshot.deferred_poll_at.is_none());
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
