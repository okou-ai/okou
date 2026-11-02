use super::*;

fn ownership_transfer_run_id(event: &StartLoopEvent) -> Option<RunId> {
    match event {
        StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id } => Some(*run_id),
        _ => None,
    }
}

#[tokio::test]
async fn start_loop_observer_wait_after_ignores_events_before_cursor() {
    let observer = StartLoopTestObserver::default();
    let first = RunId::new_v4();
    let second = RunId::new_v4();
    let third = RunId::new_v4();

    observer.record(StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id: first });
    let cursor = observer.cursor();
    observer.record(StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id: second });

    let (observed_run_id, cursor) = observer
        .wait_after(
            cursor,
            Duration::from_secs(1),
            "second ownership transfer",
            &mut ownership_transfer_run_id,
        )
        .await;
    assert_eq!(
        observed_run_id, second,
        "wait_after should ignore stale events before the cursor"
    );

    observer.record(StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id: third });
    let (observed_run_id, _) = observer
        .wait_after(
            cursor,
            Duration::from_secs(1),
            "third ownership transfer",
            &mut ownership_transfer_run_id,
        )
        .await;
    assert_eq!(
        observed_run_id, third,
        "next cursor should advance past the matched event"
    );
}

#[tokio::test]
#[should_panic(expected = "start-loop observer cursor")]
async fn start_loop_observer_wait_after_rejects_cursor_past_history() {
    let observer = StartLoopTestObserver::default();

    observer
        .wait_after(
            StartLoopCursor(1),
            Duration::from_secs(1),
            "invalid cursor",
            &mut |_| Some(()),
        )
        .await;
}

#[tokio::test]
async fn start_loop_observer_wait_before_idle_pool_ownership_transfer_observes_existing_event() {
    let observer = StartLoopTestObserver::default();
    let run_id = RunId::new_v4();

    observer.notify_before_idle_pool_ownership_transfer(run_id);
    observer
        .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(1))
        .await;
}

#[tokio::test]
#[should_panic(expected = "runner did not observe idle-pool ownership transfer attempt")]
async fn start_loop_observer_wait_before_idle_pool_ownership_transfer_ignores_other_runs() {
    let observer = StartLoopTestObserver::default();
    let run_id = RunId::new_v4();
    let other_run_id = RunId::new_v4();

    observer.notify_before_idle_pool_ownership_transfer(other_run_id);
    observer
        .wait_before_idle_pool_ownership_transfer(run_id, Duration::ZERO)
        .await;
}
