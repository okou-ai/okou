use std::time::Duration;

use super::ActiveInputNotifications;
use runner_types::ids::RunId;

const WAKE_TIMEOUT: Duration = Duration::from_secs(5);
const NO_WAKE: Duration = Duration::from_millis(20);

#[tokio::test]
async fn run_notification_wakes_only_that_run() {
    let notifications = ActiveInputNotifications::new();
    let target = RunId::new_v4();
    let mut target_subscription = notifications.subscribe(target);
    let mut other_subscription = notifications.subscribe(RunId::new_v4());

    notifications.notify(target);

    tokio::time::timeout(WAKE_TIMEOUT, target_subscription.wait())
        .await
        .expect("the notified run wakes");
    assert!(
        tokio::time::timeout(NO_WAKE, other_subscription.wait())
            .await
            .is_err(),
        "another run's notification must not wake this run"
    );
}

#[tokio::test]
async fn notify_all_wakes_every_run_once() {
    let notifications = ActiveInputNotifications::new();
    let mut subscriptions =
        [RunId::new_v4(), RunId::new_v4()].map(|run_id| notifications.subscribe(run_id));

    notifications.notify_all();

    for subscription in &mut subscriptions {
        tokio::time::timeout(WAKE_TIMEOUT, subscription.wait())
            .await
            .expect("every run wakes");
        assert!(
            tokio::time::timeout(NO_WAKE, subscription.wait())
                .await
                .is_err(),
            "one broadcast wakes each run exactly once"
        );
    }
}

#[tokio::test]
async fn closed_notifications_never_wake() {
    let notifications = ActiveInputNotifications::new();
    let mut subscription = notifications.subscribe(RunId::new_v4());
    drop(notifications);

    assert!(
        tokio::time::timeout(NO_WAKE, subscription.wait())
            .await
            .is_err(),
        "a closed channel must not turn into a read loop"
    );
}
