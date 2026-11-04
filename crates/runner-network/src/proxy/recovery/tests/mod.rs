use super::*;

fn unmanaged_child(command: &str, arg: Option<&str>) -> ManagedMitmdump {
    let mut child = tokio::process::Command::new(command);
    if let Some(arg) = arg {
        child.arg(arg);
    }
    ManagedMitmdump::unmanaged(child.spawn().unwrap())
}

async fn panicking_restart() -> Result<ManagedMitmdump, MitmRestartError> {
    panic!("old child cleanup panicked");
}

#[tokio::test(flavor = "current_thread")]
async fn single_flight_drains_duplicate_crashes_and_retries_startup_failure() {
    let (mut mitm, _) = MitmProxy::noop();
    let (tx, mut crash_rx) = mpsc::channel(1);
    let mut recovery = MitmRecovery::new();
    tx.try_send(()).unwrap();
    recovery.restart_at = Some(Instant::now() + Duration::from_secs(60));
    let future_deadline = recovery.retry_deadline();
    recovery.maybe_start(&mut mitm, &mut crash_rx);
    assert_eq!(recovery.retry_deadline(), future_deadline);
    assert!(recovery.task.is_none());
    assert_eq!(crash_rx.try_recv(), Ok(()));

    tx.try_send(()).unwrap();
    recovery.restart_at = Some(Instant::now() - Duration::from_secs(1));
    recovery.maybe_start(&mut mitm, &mut crash_rx);
    assert!(recovery.retry_deadline().is_none());
    assert_eq!(crash_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty));
    let id = recovery.task.as_ref().unwrap().id();
    tx.try_send(()).unwrap();
    recovery.restart_at = Some(Instant::now() - Duration::from_secs(1));
    recovery.maybe_start(&mut mitm, &mut crash_rx);
    assert_eq!(recovery.task.as_ref().unwrap().id(), id);
    assert!(
        recovery.retry_deadline().is_none(),
        "in-flight timer must not spin"
    );
    assert_eq!(crash_rx.try_recv(), Ok(()));
    let failure_handled_at = Instant::now();
    recovery.wait(&mut mitm).await.unwrap();
    assert_eq!(recovery.consecutive_failures, 1);
    assert!(recovery.retry_deadline().unwrap() >= failure_handled_at + BACKOFF_INITIAL);
    assert_eq!(recovery.backoff, BACKOFF_INITIAL * 2);
}

#[tokio::test]
async fn cancelled_wait_retains_in_flight_replacement() {
    let (mut mitm, _) = MitmProxy::noop();
    let mut recovery = MitmRecovery::new();
    let (tx, rx) = tokio::sync::oneshot::channel();
    recovery.task = Some(tokio::spawn(async move {
        rx.await.unwrap();
        Ok(unmanaged_child("true", None))
    }));
    let task_id = recovery.task.as_ref().unwrap().id();
    tokio::select! {
        biased;
        result = recovery.wait(&mut mitm) => panic!("blocked restart unexpectedly completed: {result:?}"),
        () = std::future::ready(()) => {}
    }
    assert_eq!(recovery.task.as_ref().unwrap().id(), task_id);
    tx.send(()).unwrap();
    recovery.wait(&mut mitm).await.unwrap();
    assert!(recovery.task.is_none());
    mitm.stop().await.unwrap();
}

#[tokio::test]
async fn success_resets_backoff_and_adopts_child() {
    let (mut mitm, _) = MitmProxy::noop();
    let dir = tempfile::tempdir().unwrap();
    let mut recovery = MitmRecovery::new();
    recovery.backoff = Duration::from_secs(16);
    recovery.consecutive_failures = 5;
    recovery.task = Some(tokio::spawn(async {
        Ok(unmanaged_child("sleep", Some("60")))
    }));
    let before_crash = Instant::now();
    recovery.on_crash();
    let after_crash = Instant::now();
    assert!(recovery.retry_deadline().is_none());
    recovery.wait(&mut mitm).await.unwrap();
    assert_eq!(recovery.backoff, BACKOFF_INITIAL);
    assert_eq!(recovery.consecutive_failures, 0);
    let retry_at = recovery
        .retry_deadline()
        .expect("a crash during replacement must retain its retry deadline");
    assert!(retry_at >= before_crash + Duration::from_secs(16));
    assert!(retry_at <= after_crash + Duration::from_secs(16));
    mitm.set_control_directory_for_test(dir.path().to_path_buf());
    assert!(
        mitm.usage_flush_target().is_some(),
        "successful recovery must retain a running child"
    );
    mitm.stop().await.unwrap();
    assert!(mitm.usage_flush_target().is_none());
}

#[tokio::test]
async fn startup_failure_schedules_retry_with_backoff() {
    let (mut mitm, _) = MitmProxy::noop();
    let mut recovery = MitmRecovery::new();
    recovery.task = Some(tokio::spawn(async {
        Err(MitmRestartError::Startup(RunnerError::Internal(
            "spawn failed".into(),
        )))
    }));
    recovery.wait(&mut mitm).await.unwrap();
    assert_eq!(recovery.consecutive_failures, 1);
    assert!(recovery.retry_deadline().is_some());
    assert_eq!(recovery.backoff, BACKOFF_INITIAL * 2);
}

#[tokio::test]
async fn backoff_caps_at_max() {
    let (mut mitm, _) = MitmProxy::noop();
    let mut recovery = MitmRecovery::new();
    recovery.backoff = BACKOFF_MAX;
    recovery.consecutive_failures = 10;
    recovery.task = Some(tokio::spawn(async {
        Err(MitmRestartError::Startup(RunnerError::Internal(
            "spawn failed".into(),
        )))
    }));
    recovery.wait(&mut mitm).await.unwrap();
    assert_eq!(recovery.backoff, BACKOFF_MAX);
    assert!(recovery.retry_deadline().is_some());
}

#[tokio::test]
async fn circuit_breaker_stops_after_twenty_failures() {
    let (mut mitm, _) = MitmProxy::noop();
    let mut recovery = MitmRecovery::new();
    recovery.backoff = BACKOFF_MAX;
    recovery.consecutive_failures = 19;
    recovery.restart_at = Some(Instant::now() - Duration::from_secs(1));
    recovery.task = Some(tokio::spawn(async {
        Err(MitmRestartError::Startup(RunnerError::Internal(
            "binary missing".into(),
        )))
    }));
    recovery.wait(&mut mitm).await.unwrap();
    assert_eq!(recovery.consecutive_failures, 20);
    assert!(recovery.retry_deadline().is_none());
    recovery.on_crash();
    assert!(
        recovery.retry_deadline().is_none(),
        "breaker must remain open"
    );
}

#[tokio::test]
async fn shutdown_adopts_in_flight_child() {
    let (mut mitm, _) = MitmProxy::noop();
    let dir = tempfile::tempdir().unwrap();
    let mut recovery = MitmRecovery::new();
    recovery.task = Some(tokio::spawn(async {
        Ok(unmanaged_child("sleep", Some("60")))
    }));
    recovery.finish_before_shutdown(&mut mitm).await.unwrap();
    assert!(recovery.task.is_none());
    mitm.set_control_directory_for_test(dir.path().to_path_buf());
    assert!(mitm.usage_flush_target().is_some());
    mitm.stop().await.unwrap();
}

#[tokio::test]
async fn shutdown_does_not_retry_startup_failure() {
    let (mut mitm, _) = MitmProxy::noop();
    let mut recovery = MitmRecovery::new();
    recovery.task = Some(tokio::spawn(async {
        Err(MitmRestartError::Startup(RunnerError::Internal(
            "spawn failed".into(),
        )))
    }));
    recovery.finish_before_shutdown(&mut mitm).await.unwrap();
    assert!(recovery.task.is_none());
    assert!(recovery.retry_deadline().is_none());
    assert!(mitm.usage_flush_target().is_none());
}

#[tokio::test]
async fn cleanup_failure_and_task_panic_are_fatal() {
    let (mut mitm, mut crash_rx) = MitmProxy::noop();
    let mut recovery = MitmRecovery::new();
    recovery.task = Some(tokio::spawn(async {
        Err(MitmRestartError::Cleanup(RunnerError::Internal(
            "unknown cleanup".into(),
        )))
    }));
    let error = recovery.wait(&mut mitm).await.unwrap_err();
    assert!(error.to_string().contains("old mitmdump cleanup failed"));
    recovery.stop_retries(&mut crash_rx);
    assert!(recovery.retry_deadline().is_none());
    recovery.task = Some(tokio::spawn(panicking_restart()));
    let error = recovery.wait(&mut mitm).await.unwrap_err();
    assert!(error.to_string().contains("mitmproxy recovery task failed"));
}
