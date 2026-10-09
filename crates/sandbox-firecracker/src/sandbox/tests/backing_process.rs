use super::*;

#[tokio::test]
async fn retained_backing_exit_precedes_later_guest_cleanup_without_signalling() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    assert!(sandbox.backing_process().is_none());
    let mut child = tokio::process::Command::new("cat")
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let pid = child.id().unwrap();
    let monitor = monitor_process(
        &sandbox.id,
        child.into(),
        Arc::clone(&sandbox.state),
        Arc::clone(&sandbox.state_publish_lock),
        sandbox.state_tx.clone(),
        Arc::clone(&sandbox.guest),
        sandbox.runtime_cancel.clone(),
    );
    sandbox.runtime.set_process(monitor);
    let retained = sandbox.backing_process().unwrap();
    let other = sandbox.backing_process().unwrap();
    let identity = retained.identity();
    assert_eq!(other.identity(), identity);
    assert!(
        tokio::time::timeout(Duration::ZERO, retained.exit_confirmed())
            .await
            .is_err()
    );
    assert!(pid_is_running(pid));

    // The real monitor waits/reaps before acquiring this guest lock. Neither
    // a retained observer nor cancelling another observer may need that lock.
    let guest = sandbox.guest.lock().await;
    drop(stdin);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), other.exit_confirmed())
            .await
            .unwrap()
    );
    assert!(retained.exit_confirmed().await);
    assert!(!pid_is_running(pid));
    assert!(!sandbox.runtime.process.as_ref().unwrap().task.is_finished());
    drop(guest);
    tokio::time::timeout(Duration::from_secs(5), sandbox.runtime.kill_process())
        .await
        .unwrap();
    assert_eq!(sandbox.backing_process().unwrap().identity(), identity);
}

#[tokio::test]
async fn retained_backing_generation_survives_same_sandbox_label() {
    let mut identities = Vec::new();
    for _ in 0..2 {
        let mut sandbox = test_sandbox_with_state(SandboxState::Created);
        let child = tokio::process::Command::new("sh")
            .args(["-c", "exit 7"])
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let monitor = monitor_process(
            &sandbox.id,
            child.into(),
            Arc::clone(&sandbox.state),
            Arc::clone(&sandbox.state_publish_lock),
            sandbox.state_tx.clone(),
            Arc::clone(&sandbox.guest),
            sandbox.runtime_cancel.clone(),
        );
        sandbox.runtime.set_process(monitor);
        let retained = sandbox.backing_process().unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), retained.exit_confirmed())
                .await
                .unwrap()
        );
        identities.push(retained.identity());
        sandbox.runtime.kill_process().await;
    }
    assert_ne!(identities[0], identities[1]);
}

#[tokio::test]
async fn retained_backing_failed_or_closed_wait_producer_never_confirms_exit() {
    for publish_failure in [true, false] {
        let mut sandbox = test_sandbox_with_state(SandboxState::Created);
        let (exit_tx, exit) = ProcessExitCompletion::channel();
        let (kill_tx, _kill_rx) = mpsc::channel(1);
        let task = tokio::spawn(async move {
            if publish_failure {
                exit_tx.send(false).unwrap();
            } else {
                drop(exit_tx);
            }
        });
        sandbox.runtime.set_process(ProcessMonitorHandle {
            kill_tx,
            task,
            exit,
        });
        let retained = sandbox.backing_process().unwrap();
        let identity = retained.identity();
        sandbox.runtime.kill_process().await;
        assert!(sandbox.backing_process().is_some());
        assert!(
            !tokio::time::timeout(Duration::from_secs(5), retained.exit_confirmed())
                .await
                .unwrap()
        );
        assert!(!retained.exit_confirmed().await);
        assert_eq!(retained.identity(), identity);
    }
}

#[tokio::test]
async fn retained_backing_aborted_producer_remains_unconfirmed() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Created);
    let (exit_tx, exit) = ProcessExitCompletion::channel();
    let (kill_tx, _kill_rx) = mpsc::channel(1);
    let task = tokio::spawn(async move {
        let _producer = exit_tx;
        std::future::pending::<()>().await;
    });
    task.abort();
    sandbox.runtime.set_process(ProcessMonitorHandle {
        kill_tx,
        task,
        exit,
    });
    let retained = sandbox.backing_process().unwrap();
    sandbox.runtime.kill_process().await;
    assert!(
        !tokio::time::timeout(Duration::from_secs(5), retained.exit_confirmed())
            .await
            .unwrap()
    );
}
