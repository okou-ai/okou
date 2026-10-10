use std::future::{pending, poll_fn, ready};
use std::task::Poll;
use std::time::Duration;

use futures_util::poll;
use runner_storage::{
    OBJECT_DOWNLOAD_BUDGET, OBJECT_DOWNLOAD_RETRY_DELAY, ObjectDownloadBudgetExpired,
    ObjectDownloadRetryBudget,
};
use tokio::sync::oneshot;

#[tokio::test(start_paused = true)]
async fn attempts_preserve_the_callers_ready_success_and_failure() {
    let budget = ObjectDownloadRetryBudget::default();
    assert_eq!(
        budget.run_attempt(ready(Ok::<_, &str>("body"))).await,
        Ok(Ok("body"))
    );
    assert_eq!(
        budget
            .run_attempt(ready(Err::<(), _>("provider failure")))
            .await,
        Ok(Err("provider failure"))
    );
}

#[tokio::test(start_paused = true)]
async fn an_expired_budget_does_not_poll_another_attempt() {
    let budget = ObjectDownloadRetryBudget::default();
    tokio::time::advance(OBJECT_DOWNLOAD_BUDGET).await;
    let attempt = poll_fn(|_| -> Poll<()> {
        panic!("an expired budget must not start another read-only attempt")
    });
    assert_eq!(
        budget.run_attempt(attempt).await,
        Err(ObjectDownloadBudgetExpired)
    );
}

#[tokio::test(start_paused = true)]
async fn an_overdue_ready_result_is_rejected_even_when_it_beats_the_timeout() {
    for result in [Ok("late body"), Err("late provider failure")] {
        let budget = ObjectDownloadRetryBudget::default();
        let (send, receive) = oneshot::channel();
        let attempt = budget.run_attempt(async { receive.await.unwrap() });
        tokio::pin!(attempt);
        // Arm the actual timeout before withholding all further polls. After
        // expiration, the ready inner future wins Tokio's polling order; the
        // shared post-attempt check must still reject both success and failure.
        assert!(poll!(&mut attempt).is_pending());
        tokio::time::advance(OBJECT_DOWNLOAD_BUDGET + Duration::from_secs(1)).await;
        send.send(result).unwrap();
        assert_eq!(attempt.await, Err(ObjectDownloadBudgetExpired));
    }
}

#[tokio::test(start_paused = true)]
async fn a_stalled_attempt_is_interrupted_at_the_total_deadline() {
    let budget = ObjectDownloadRetryBudget::default();
    let attempt = budget.run_attempt(pending::<()>());
    tokio::pin!(attempt);
    assert!(poll!(&mut attempt).is_pending());
    tokio::time::advance(OBJECT_DOWNLOAD_BUDGET).await;
    assert_eq!(attempt.await, Err(ObjectDownloadBudgetExpired));
}

#[tokio::test(start_paused = true)]
async fn retries_progress_through_two_backoffs_then_preserve_exhaustion() {
    let mut budget = ObjectDownloadRetryBudget::default();
    for (failed_attempt, delay) in [
        (1, Duration::from_millis(200)),
        (2, Duration::from_millis(400)),
    ] {
        assert_eq!(
            budget.run_attempt(ready(Err::<(), _>("503"))).await,
            Ok(Err("503"))
        );
        let retry = budget.next_retry(Some(Duration::ZERO)).unwrap();
        assert_eq!(retry.attempt(), failed_attempt);
        assert_eq!(retry.delay(), delay);
        retry.wait().await.unwrap();
    }
    assert_eq!(
        budget.run_attempt(ready(Err::<(), _>("503"))).await,
        Ok(Err("503"))
    );
    assert!(budget.next_retry(Some(Duration::ZERO)).is_none());
}

#[tokio::test(start_paused = true)]
async fn terminal_and_unaffordable_hints_do_not_schedule_a_retry() {
    for retry_after in [None, Some(OBJECT_DOWNLOAD_BUDGET), Some(Duration::MAX)] {
        let mut budget = ObjectDownloadRetryBudget::default();
        assert_eq!(
            budget.run_attempt(ready(Err::<(), _>("429"))).await,
            Ok(Err("429"))
        );
        assert!(budget.next_retry(retry_after).is_none());
    }
}

#[tokio::test(start_paused = true)]
async fn provider_delay_is_a_minimum_and_must_fit_the_remaining_budget() {
    let mut budget = ObjectDownloadRetryBudget::default();
    assert_eq!(
        budget.run_attempt(ready(Err::<(), _>("429"))).await,
        Ok(Err("429"))
    );
    let retry = budget.next_retry(Some(Duration::from_secs(60))).unwrap();
    assert_eq!(retry.delay(), Duration::from_secs(60));
    retry.wait().await.unwrap();
    assert_eq!(
        budget.run_attempt(ready(Err::<(), _>("429"))).await,
        Ok(Err("429"))
    );
    assert!(budget.next_retry(Some(Duration::from_secs(30))).is_none());
}

#[tokio::test(start_paused = true)]
async fn backoff_equal_to_the_remaining_budget_is_not_scheduled() {
    let mut budget = ObjectDownloadRetryBudget::default();
    tokio::time::advance(OBJECT_DOWNLOAD_BUDGET - OBJECT_DOWNLOAD_RETRY_DELAY).await;
    assert_eq!(
        budget.run_attempt(ready(Err::<(), _>("503"))).await,
        Ok(Err("503"))
    );
    assert!(budget.next_retry(Some(Duration::ZERO)).is_none());
}

#[tokio::test(start_paused = true)]
async fn an_overdue_backoff_wakeup_expires_the_original_budget() {
    let mut budget = ObjectDownloadRetryBudget::default();
    assert_eq!(
        budget.run_attempt(ready(Err::<(), _>("429"))).await,
        Ok(Err("429"))
    );
    let wait = budget
        .next_retry(Some(Duration::from_secs(60)))
        .unwrap()
        .wait();
    tokio::pin!(wait);
    assert!(poll!(&mut wait).is_pending());
    tokio::time::advance(OBJECT_DOWNLOAD_BUDGET + Duration::from_secs(1)).await;
    assert_eq!(wait.await, Err(ObjectDownloadBudgetExpired));
}
