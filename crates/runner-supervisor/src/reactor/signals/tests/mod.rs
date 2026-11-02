use std::sync::Arc;
use std::time::Duration;

use super::*;
use runner_types::ids::RunId;

#[tokio::test]
async fn hard_cancellation_dispatch_does_not_serialize_transfer_gate_waits() {
    let blocked_run_id = RunId::new_v4();
    let ready_run_id = RunId::new_v4();
    let blocked = runner_provider::RunCancellationHandle::new();
    let ready = runner_provider::RunCancellationHandle::new();
    let transfer_guard = blocked.transfer_guard().await;
    let ready_token = ready.token();
    let blocked_token = blocked.token();
    let dispatch = tokio::spawn(dispatch_hard_cancellations(vec![
        (blocked_run_id, blocked),
        (ready_run_id, ready),
    ]));

    tokio::time::timeout(Duration::from_secs(1), ready_token.cancelled())
        .await
        .expect("an unrelated transfer gate must not delay hard cancellation");
    assert!(!blocked_token.is_cancelled());

    drop(transfer_guard);
    dispatch.await.unwrap();
    assert!(blocked_token.is_cancelled());
}

#[tokio::test]
async fn recv_handler_task_clears_completed_task() {
    let mut handler_task = Some(SignalHandlerTask::new(tokio::spawn(async {})));

    recv_handler_task(&mut handler_task)
        .await
        .expect("completed handler task");

    assert!(handler_task.is_none());
}

#[tokio::test]
async fn recv_handler_task_reports_cancelled_task() {
    let task = tokio::spawn(std::future::pending::<()>());
    task.abort();
    let mut handler_task = Some(SignalHandlerTask::new(task));

    let result = recv_handler_task(&mut handler_task)
        .await
        .expect_err("cancelled handler task should be reported");

    assert!(result.contains("cancelled"));
    assert!(handler_task.is_none());
}

#[tokio::test]
async fn dropping_handler_task_aborts_task() {
    struct NotifyOnDrop(Arc<tokio::sync::Notify>);

    impl Drop for NotifyOnDrop {
        fn drop(&mut self) {
            self.0.notify_one();
        }
    }

    let started = Arc::new(tokio::sync::Notify::new());
    let dropped = Arc::new(tokio::sync::Notify::new());
    let task = {
        let started = Arc::clone(&started);
        let dropped = Arc::clone(&dropped);
        tokio::spawn(async move {
            let _guard = NotifyOnDrop(dropped);
            started.notify_one();
            std::future::pending::<()>().await;
        })
    };
    let handler_task = SignalHandlerTask::new(task);
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("signal handler test task should start");

    drop(handler_task);

    tokio::time::timeout(Duration::from_secs(2), dropped.notified())
        .await
        .expect("dropping signal handler task should abort the task");
}

/// `handle_stopping_signal` idempotency: a repeat invocation takes the
/// "already Stopping" guard and returns without re-entering the registry's
/// hard-stop barrier or re-cancelling `cancel`.
#[tokio::test]
async fn stopping_signal_repeat_is_idempotent() {
    use crate::idle_pool::ParkingState;

    let gate = ParkingGate::new_open();
    let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
    let lifecycle = LifecycleController::new(tx, gate.clone());
    let cancel = CancellationToken::new();
    let tokens = RunCancellationRegistry::new();

    // First call: transitions, cancels main cancel.
    handle_stopping_signal("SIGTERM", &cancel, &tokens, &lifecycle).await;
    assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
    assert_eq!(gate.state(), ParkingState::Closed);
    assert!(cancel.is_cancelled());

    // A registration after the first hard-stop barrier is cancelled by
    // registration itself; repeat-signal handling need not rescan it.
    let registration = tokens.register(RunId::new_v4()).await.unwrap();
    assert!(registration.token().is_cancelled());

    // Repeat call: must early-return on the already-Stopping guard.
    handle_stopping_signal("SIGTERM", &cancel, &tokens, &lifecycle).await;
    assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
    assert_eq!(gate.state(), ParkingState::Closed);
    assert!(cancel.is_cancelled());
}
