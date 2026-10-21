use super::*;

const SLOW: Duration = Duration::from_secs(30);
const FAST: Duration = Duration::from_secs(5);
const REUSE: Duration = Duration::from_millis(500);

async fn ready() -> PollWakeups {
    let wakeups = PollWakeups::new(true);
    let initial = wakeups
        .wait_for_poll_due(&CancellationToken::new(), SLOW, FAST)
        .await
        .unwrap();
    wakeups.record_poll_result(initial, PollOutcome::Empty, FAST);
    wakeups
}

#[tokio::test(start_paused = true)]
async fn reuse_deadline_survives_connection_changes_and_wait_cancellation() {
    let wakeups = ready().await;
    let cancel = CancellationToken::new();
    wakeups.update_reuse_polling((1, 1), Some(REUSE));
    for sequence in 2..=6 {
        let wait = wakeups.wait_for_poll_due(&cancel, SLOW, FAST);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        tokio::time::advance(Duration::from_millis(100)).await;
        if sequence == 3 {
            wakeups.mark_ably_disconnected();
        } else {
            wakeups.mark_ably_connected();
        }
        wakeups.update_reuse_polling((1, sequence), Some(REUSE));
    }
    let due = wakeups
        .wait_for_poll_due(&cancel, SLOW, FAST)
        .await
        .unwrap();
    assert_eq!(due.reason(), PollReason::Fast);
    wakeups.record_poll_result(due, PollOutcome::Empty, FAST);
    let next = wakeups.wait_for_poll_due(&cancel, SLOW, FAST);
    tokio::pin!(next);
    assert!(futures_util::poll!(&mut next).is_pending());
    tokio::time::advance(REUSE).await;
    assert_eq!(next.await.unwrap().reason(), PollReason::Fast);
}

#[tokio::test(start_paused = true)]
async fn withdrawn_inventory_cannot_be_restored_by_an_older_heartbeat() {
    let wakeups = ready().await;
    let cancel = CancellationToken::new();
    wakeups.update_reuse_polling((2, 1), Some(REUSE));
    let wait = wakeups.wait_for_poll_due(&cancel, SLOW, FAST);
    tokio::pin!(wait);
    assert!(futures_util::poll!(&mut wait).is_pending());
    wakeups.update_reuse_polling((2, 2), None);
    wakeups.update_reuse_polling((2, 1), Some(REUSE));
    wakeups.update_reuse_polling((1, 100), Some(REUSE));
    tokio::time::advance(REUSE).await;
    assert!(futures_util::poll!(&mut wait).is_pending());
    tokio::time::advance(SLOW).await;
    assert_eq!(wait.await.unwrap().reason(), PollReason::Slow);
}

#[tokio::test(start_paused = true)]
async fn reuse_reconciliation_keeps_explicit_admission_deferrals() {
    let wakeups = ready().await;
    let cancel = CancellationToken::new();
    wakeups.update_reuse_polling((1, 1), Some(REUSE));
    wakeups.request_deferred_poll_after(Duration::from_secs(2));
    let wait = wakeups.wait_for_poll_due(&cancel, SLOW, FAST);
    tokio::pin!(wait);
    assert!(futures_util::poll!(&mut wait).is_pending());
    tokio::time::advance(REUSE).await;
    assert!(futures_util::poll!(&mut wait).is_pending());
    tokio::time::advance(Duration::from_millis(1500)).await;
    let due = wait.await.unwrap();
    assert_eq!(due.reason(), PollReason::Deferred);
    wakeups.record_poll_result(due, PollOutcome::Empty, FAST);
    let next = wakeups
        .wait_for_poll_due(&cancel, SLOW, FAST)
        .await
        .unwrap();
    assert_eq!(next.reason(), PollReason::Fast);
}

#[tokio::test(start_paused = true)]
async fn failed_reuse_poll_backs_off_even_as_inventory_is_refreshed() {
    let wakeups = ready().await;
    let cancel = CancellationToken::new();
    wakeups.update_reuse_polling((1, 1), Some(REUSE));
    let due = wakeups
        .wait_for_poll_due(&cancel, SLOW, FAST)
        .await
        .unwrap();
    wakeups.record_poll_result(due, PollOutcome::Failure, FAST);
    let next = wakeups.wait_for_poll_due(&cancel, SLOW, FAST);
    tokio::pin!(next);
    assert!(futures_util::poll!(&mut next).is_pending());
    tokio::time::advance(FAST - Duration::from_millis(1)).await;
    wakeups.update_reuse_polling((1, 2), Some(REUSE));
    assert!(futures_util::poll!(&mut next).is_pending());
    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(next.await.unwrap().reason(), PollReason::Fast);
}

#[tokio::test(start_paused = true)]
async fn shutdown_cancels_reuse_wait() {
    let wakeups = ready().await;
    let cancel = CancellationToken::new();
    wakeups.update_reuse_polling((1, 1), Some(REUSE));
    let next = wakeups.wait_for_poll_due(&cancel, SLOW, FAST);
    tokio::pin!(next);
    assert!(futures_util::poll!(&mut next).is_pending());
    cancel.cancel();
    assert!(next.await.is_none());
}
