use super::*;
use crate::network::{NetnsPool, NetnsPoolHandle};

#[tokio::test]
async fn sandbox_drop_hands_off_confirmed_process_exit() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    sandbox.leak_tx = Some(leak_tx);
    sandbox.destroyed = false;
    let mut child = tokio::process::Command::new("cat")
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let _stdin = child.stdin.take();
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
    {
        let confirmation = sandbox.process_exit_confirmed();
        tokio::pin!(confirmation);
        assert!(futures_util::poll!(&mut confirmation).is_pending());
    }

    drop(sandbox);
    let leaked = leak_rx.recv().await.unwrap();
    let exit = leaked.process_exit.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), exit.confirmed())
            .await
            .unwrap()
    );
    assert!(!pid_is_running(pid));
}

#[tokio::test]
async fn process_exit_confirms_nonzero_child_status() {
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

    assert!(
        tokio::time::timeout(Duration::from_secs(5), sandbox.process_exit_confirmed())
            .await
            .unwrap()
    );
    sandbox.runtime.kill_process().await;
    assert!(sandbox.process_exit_confirmed().await);
}

#[tokio::test]
async fn cancelled_kill_keeps_exit_completion_for_sandbox_drop() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    sandbox.leak_tx = Some(leak_tx);
    sandbox.destroyed = false;
    let (exit_tx, exit) = ProcessExitCompletion::channel();
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let monitor = ProcessMonitorHandle {
        kill_tx,
        task: tokio::spawn(async move {
            finish_rx.await.unwrap();
            finished_tx.send(()).unwrap();
        }),
        exit,
    };
    sandbox.runtime.set_process(monitor);

    {
        let kill = sandbox.kill();
        tokio::pin!(kill);
        assert!(futures_util::poll!(&mut kill).is_pending());
        assert!(kill_rx.try_recv().is_ok());
    }

    drop(sandbox);
    let leaked = leak_rx.recv().await.unwrap();
    let exit = leaked.process_exit.unwrap();
    {
        let confirmation = exit.confirmed();
        tokio::pin!(confirmation);
        assert!(futures_util::poll!(&mut confirmation).is_pending());
    }
    exit_tx.send(true).unwrap();
    assert!(exit.confirmed().await);
    finish_tx.send(()).unwrap();
    finished_rx.await.unwrap();
}

async fn sandbox_with_cleanup_resources() -> (
    tempfile::TempDir,
    FirecrackerSandbox,
    NetnsPoolHandle,
    tokio::sync::mpsc::UnboundedReceiver<LeakedResources>,
) {
    let tmp = tempfile::tempdir().unwrap();
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    sandbox.sock_paths = SockPaths::new(tmp.path().join("sock"));
    sandbox.sandbox_paths = SandboxPaths::new(tmp.path().join("workspace"));
    tokio::fs::create_dir(sandbox.sock_paths.dir())
        .await
        .unwrap();
    tokio::fs::create_dir(sandbox.sandbox_paths.workspace())
        .await
        .unwrap();
    let mut pool = NetnsPool::active_at_capacity_for_test();
    let network = pool.lease_for_test("test-cleanup-netns");
    pool.track_lease_for_test(&network);
    sandbox.network = SandboxNetwork::from_lease(network);
    let pool = NetnsPoolHandle::new_for_test(pool);
    let (leak_tx, leak_rx) = tokio::sync::mpsc::unbounded_channel();
    sandbox.leak_tx = Some(leak_tx);
    sandbox.destroyed = false;
    (tmp, sandbox, pool, leak_rx)
}

#[tokio::test]
async fn normal_destroy_preserves_resources_after_unconfirmed_process_exit() {
    let (tmp, mut sandbox, pool, mut leak_rx) = sandbox_with_cleanup_resources().await;
    let (exit_tx, exit) = ProcessExitCompletion::channel();
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    sandbox.runtime.set_process(ProcessMonitorHandle {
        kill_tx,
        task: tokio::spawn(async move {
            kill_rx.recv().await.unwrap();
            exit_tx.send(false).unwrap();
        }),
        exit,
    });

    crate::factory::destroy_firecracker_sandbox(sandbox, pool.clone()).await;

    assert!(pool.acquire().await.is_err());
    assert!(tmp.path().join("sock").exists());
    assert!(tmp.path().join("workspace").exists());
    let leaked = leak_rx.recv().await.unwrap();
    assert!(leaked.network.is_some());
    assert!(!leaked.process_exit.unwrap().confirmed().await);
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn normal_destroy_terminates_process_after_cancelled_stop() {
    let (tmp, mut sandbox, pool, mut leak_rx) = sandbox_with_cleanup_resources().await;
    let mut guest = attach_mock_shutdown_guest(&sandbox).await;
    let mut child = tokio::process::Command::new("cat")
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let _stdin = child.stdin.take();
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

    {
        let stop = sandbox.stop();
        tokio::pin!(stop);
        tokio::select! {
            result = &mut stop => panic!("stop completed before guest response: {result:?}"),
            request = read_vsock_message(&mut guest) => assert_eq!(request.msg_type, MSG_SHUTDOWN),
        }
    }
    assert!(pid_is_running(pid));

    tokio::time::timeout(
        Duration::from_secs(5),
        crate::factory::destroy_firecracker_sandbox(sandbox, pool.clone()),
    )
    .await
    .unwrap();

    assert!(!pid_is_running(pid));
    let mut network = Some(pool.acquire().await.unwrap());
    assert_eq!(network.as_ref().unwrap().name(), "test-cleanup-netns");
    assert!(!tmp.path().join("sock").exists());
    assert!(!tmp.path().join("workspace").exists());
    assert!(leak_rx.try_recv().is_err());
    assert!(pool.release(&mut network).await.invalid_message().is_none());
    pool.cleanup().await.unwrap();
}
