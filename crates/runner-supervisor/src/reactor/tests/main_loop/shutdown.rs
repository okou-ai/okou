use super::super::super::signals::{SignalController, SignalHandlerTask};
use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, minimal_context, mock_run_config, mock_run_config_with_overrides,
    push_job, shutdown, test_profiles, wait_cancel_token, wait_cancel_token_removed,
    wait_discover_entered, wait_status_mode, wait_usage_flush_requested,
};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

// -----------------------------------------------------------------------
// Test 3: Shutdown completes without deadlock (regression #8898)
//
// Uses REAL time (not paused) because a Mutex deadlock blocks the
// tokio runtime — paused time can't advance past a non-timer await.
//
// Only sends Draining (does NOT cancel the token). This forces the
// worst-case race: mode_rx.changed() wins the select!, loop breaks
// at the top-of-loop check, and discover_fut is never polled again.
// The explicit `drop(discover_fut)` releases the Mutex so shutdown()
// can proceed. Without that drop, shutdown() deadlocks on the Mutex.
// -----------------------------------------------------------------------

#[tokio::test]
async fn shutdown_completes_without_deadlock() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Let the main loop start and enter the discover select arm.
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Only send Draining — do NOT cancel. The Draining path sees
    // `jobs.is_empty()` immediately (no active jobs), breaks to
    // teardown, and `drop(discover_fut)` releases the Mutex before
    // `provider.shutdown()`. Without that drop → deadlock (regression #8898).
    env.drain();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(2),
        "deadlock detected: run() did not finish within 2s (regression #8898)",
    )
    .await;
}

#[tokio::test]
async fn discovery_end_publishes_stopping_without_cancelling_active_job() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("job should enter its process wait");

    drop(env.handle.discover_tx);
    wait_status_mode(&status_path, "stopping", Duration::from_secs(5)).await;
    assert!(!token.is_cancelled(), "ending discovery is not a hard stop");
    assert!(!run_handle.is_finished(), "active job still owns its drain");
    wait_gate.release_one();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "discovery end should drain the active job normally",
    )
    .await;
    let completions = env.handle.completions.lock().unwrap();
    let completion = completions
        .iter()
        .find(|entry| entry.run_id == run_id)
        .unwrap();
    assert_eq!(completion.exit_code, 0);
    assert!(completion.error.is_none());
}

#[tokio::test]
async fn shutdown_joins_accepted_fresh_archive_before_stopped() {
    use tokio::io::AsyncReadExt;

    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let admission = config.exec_config.fresh_archive_delivery.clone();
    let status_path = env._temp_dir.path().join("status.json");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (requested_tx, requested_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        assert!(request.starts_with(b"GET "));
        requested_tx.send(()).unwrap();
        release_rx.await.unwrap();
    });
    let manifest = runner_types::storage_manifest::StorageManifest {
        storages: vec![runner_types::storage_manifest::StorageEntry {
            name: "shutdown-archive".into(),
            mount_path: "/mnt/archive".into(),
            vas_storage_name: "shutdown-archive".into(),
            vas_version_id: "v1".into(),
            archive_url: format!("http://{address}/archive.tar.gz"),
            archive_size: Some(32),
        }],
        artifacts: Vec::new(),
    };
    let mut plan = runner_storage::storage_plan::build_storage_plan(&manifest, None).unwrap();
    let mut telemetry = crate::telemetry::JobTelemetry::new(
        config.exec_config.http.clone(),
        RunId::new_v4(),
        "test".into(),
        None,
    );
    let delivery = crate::storage_cache::prepare_fresh_archive_delivery(
        &mut plan,
        &config.exec_config.home,
        &admission,
        &CancellationToken::new(),
        &mut telemetry,
        None,
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), requested_rx)
        .await
        .expect("fresh archive fetch must be accepted before teardown")
        .unwrap();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    env.drain();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !admission.is_closed_for_test() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("real reactor teardown must close fresh archive admission");
    assert!(
        !run_handle.is_finished(),
        "accepted fetch still owns shutdown"
    );
    let status: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    assert_ne!(status["mode"], "stopped");

    drop(delivery);
    release_tx.send(()).unwrap();
    server.await.unwrap();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "shutdown must finish after original archive ownership retires",
    )
    .await;
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[derive(Clone, Copy)]
enum NetworkLogTestComponent {
    Kmsg,
    Dns,
}

impl NetworkLogTestComponent {
    fn label(self) -> &'static str {
        match self {
            Self::Kmsg => "kmsg",
            Self::Dns => "dns",
        }
    }

    fn eof_error_prefix(self) -> &'static str {
        match self {
            Self::Kmsg => "kmsg monitor exited unexpectedly: Eof",
            Self::Dns => "dns monitor exited unexpectedly: Eof",
        }
    }

    async fn install(self, config: &mut RunConfig) -> (tokio::process::ChildStdin, u32, u64) {
        match self {
            Self::Kmsg => install_controllable_kmsg(config).await,
            Self::Dns => install_controllable_dns(config).await,
        }
    }

    fn set_reap_gate(self, config: &mut RunConfig, gate: crate::test_fixtures::ReapGate) {
        match self {
            Self::Kmsg => config.shutdown.kmsg_handle.set_reap_gate(gate),
            Self::Dns => config.shutdown.dns_handle.set_reap_gate(gate),
        }
    }
}

async fn assert_network_log_eof_stops_runner(component: NetworkLogTestComponent) {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let (stdin, pid, starttime) = component.install(&mut config).await;
    let reap_gate = crate::test_fixtures::ReapGate::new();
    component.set_reap_gate(&mut config, reap_gate.clone());
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.handle.block_heartbeats();
    drop(stdin);

    tokio::time::timeout(Duration::from_secs(2), reap_gate.entered.notified())
        .await
        .expect("EOF should start child cleanup");

    assert!(
        env.handle
            .wait_heartbeat_in_flight(1, Duration::from_secs(2))
            .await,
        "{} EOF should drive runner teardown",
        component.label(),
    );
    assert!(
        !run_handle.is_finished(),
        "blocked final heartbeat should hold teardown open",
    );
    assert!(
        env.cancel.is_cancelled(),
        "{} EOF should stop discovery",
        component.label(),
    );

    // Teardown can start while child cleanup is pending. Only run() joining
    // the cleanup task guarantees that the process has been reaped.
    reap_gate.release.add_permits(1);
    env.handle.unblock_heartbeats();
    assert_run_error_contains(run_handle, component.eof_error_prefix()).await;
    assert_child_reaped(component.label(), pid, starttime).await;
}

async fn assert_network_log_read_error_stops_runner(component: NetworkLogTestComponent) {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let (mut stdin, pid, starttime) = component.install(&mut config).await;
    let reap_gate = crate::test_fixtures::ReapGate::new();
    component.set_reap_gate(&mut config, reap_gate.clone());
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.handle.block_heartbeats();
    stdin.write_all(&[0xff, b'\n']).await.unwrap();
    stdin.flush().await.unwrap();

    tokio::time::timeout(Duration::from_secs(2), reap_gate.entered.notified())
        .await
        .expect("read error should start child cleanup");

    assert!(
        env.handle
            .wait_heartbeat_in_flight(1, Duration::from_secs(2))
            .await,
        "{} read error should drive runner teardown",
        component.label(),
    );
    assert!(
        env.cancel.is_cancelled(),
        "{} read error should stop discovery",
        component.label(),
    );

    reap_gate.release.add_permits(1);
    env.handle.unblock_heartbeats();
    assert_run_error_contains(run_handle, "ReadError").await;
    assert_child_reaped(component.label(), pid, starttime).await;
}

async fn assert_normal_shutdown_reaps_network_log_child(component: NetworkLogTestComponent) {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let (_stdin, pid, starttime) = component.install(&mut config).await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.trigger_stopping().await;

    let timeout_message = format!(
        "normal hard shutdown should stop the {} monitor",
        component.label(),
    );
    assert_run_exits_within(run_handle, Duration::from_secs(3), &timeout_message).await;
    assert_child_reaped(component.label(), pid, starttime).await;
}

#[tokio::test]
async fn kmsg_stdout_eof_stops_runner_and_reaps_child_before_exit() {
    assert_network_log_eof_stops_runner(NetworkLogTestComponent::Kmsg).await;
}

#[tokio::test]
async fn kmsg_stdout_read_error_stops_runner_and_kills_child() {
    assert_network_log_read_error_stops_runner(NetworkLogTestComponent::Kmsg).await;
}

#[tokio::test]
async fn normal_shutdown_cancels_kmsg_and_reaps_child_without_error() {
    assert_normal_shutdown_reaps_network_log_child(NetworkLogTestComponent::Kmsg).await;
}

#[tokio::test]
async fn dns_stderr_eof_stops_runner_and_reaps_child_before_exit() {
    assert_network_log_eof_stops_runner(NetworkLogTestComponent::Dns).await;
}

#[tokio::test]
async fn dns_stderr_read_error_stops_runner_and_kills_child() {
    assert_network_log_read_error_stops_runner(NetworkLogTestComponent::Dns).await;
}

#[tokio::test]
async fn dns_monitor_task_panic_stops_runner_and_cancels_active_job() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let (_stdin, pid, starttime) = install_controllable_dns(&mut config).await;
    let reap_gate = crate::test_fixtures::ReapGate::new();
    config.shutdown.dns_handle.set_reap_gate(reap_gate.clone());
    let panic_trigger = config
        .shutdown
        .dns_handle
        .replace_monitor_with_panic_trigger_for_test()
        .await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter the lifecycle gate");

    assert!(
        env.handle
            .wait_heartbeat_in_flight(0, Duration::from_secs(2))
            .await,
        "ordinary heartbeats should be idle before the DNS monitor panic",
    );
    env.handle.block_heartbeats();
    panic_trigger.notify_one();

    tokio::time::timeout(Duration::from_secs(2), token.cancelled())
        .await
        .expect("DNS monitor panic should cancel the active job");
    assert!(
        env.cancel.is_cancelled(),
        "DNS monitor panic should stop discovery",
    );
    assert!(
        env.handle
            .wait_heartbeat_in_flight(1, Duration::from_secs(2))
            .await,
        "DNS monitor panic should drive runner teardown",
    );
    assert!(
        !run_handle.is_finished(),
        "blocked final heartbeat should hold teardown open",
    );
    tokio::time::timeout(Duration::from_secs(2), reap_gate.entered.notified())
        .await
        .unwrap();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "stopping",
        Duration::from_secs(2),
    )
    .await;
    reap_gate.release.add_permits(1);

    env.handle.unblock_heartbeats();
    assert_run_error_contains(run_handle, "dns monitor task failed").await;
    assert_child_reaped("dns", pid, starttime).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    let completions = env.handle.completions.lock().unwrap();
    let completion = completions
        .iter()
        .find(|completion| completion.run_id == run_id)
        .expect("cancelled job should report completion");
    assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
}

#[tokio::test]
async fn normal_shutdown_cancels_dns_and_reaps_child_without_error() {
    assert_normal_shutdown_reaps_network_log_child(NetworkLogTestComponent::Dns).await;
}

#[tokio::test]
async fn required_monitor_failure_publishes_stopping_before_delayed_child_reap() {
    for component in [NetworkLogTestComponent::Dns, NetworkLogTestComponent::Kmsg] {
        let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let (mut stdin, pid, starttime) = component.install(&mut config).await;
        let gate = crate::test_fixtures::ReapGate::new();
        component.set_reap_gate(&mut config, gate.clone());
        let status_path = env._temp_dir.path().join("status.json");
        let run_handle = tokio::spawn(run(config));
        wait_discover_entered(&env, Duration::from_secs(2)).await;
        stdin.write_all(&[0xff, b'\n']).await.unwrap();
        stdin.flush().await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
            .await
            .unwrap();
        wait_status_mode(&status_path, "stopping", Duration::from_secs(2)).await;
        assert!(env.cancel.is_cancelled());
        assert!(
            !run_handle.is_finished(),
            "cleanup must remain owned until the child wait finishes"
        );
        gate.release.add_permits(1);
        assert_run_error_contains(run_handle, "ReadError").await;
        assert_child_reaped(component.label(), pid, starttime).await;
        wait_status_mode(&status_path, "stopped", Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn cancelled_reactor_does_not_abort_owned_network_log_child_cleanup() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let (mut stdin, pid, starttime) = install_controllable_dns(&mut config).await;
    let gate = crate::test_fixtures::ReapGate::new();
    config.shutdown.dns_handle.set_reap_gate(gate.clone());
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    stdin.write_all(&[0xff, b'\n']).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();
    run_handle.abort();
    assert!(run_handle.await.unwrap_err().is_cancelled());
    gate.release.add_permits(1);
    wait_for_child_cleanup("dns", pid, starttime).await;
}

#[tokio::test]
async fn mitm_recovery_keeps_lifecycle_live_and_shutdown_joins_old_child_cleanup() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let starttime = runner_host::process::read_process_stat(pid)
        .await
        .unwrap()
        .starttime;
    let gate = crate::test_fixtures::ReapGate::new();
    config.proxy.mitm.set_child_for_test(child);
    config.proxy.mitm.set_reap_gate_for_test(gate.clone());
    let (crash_tx, crash_rx) = mpsc::channel(1);
    config.proxy.mitm_crash_rx = crash_rx;
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    crash_tx.send(()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
        .await
        .unwrap();
    crash_tx.send(()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while crash_tx.capacity() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reactor should consume the late crash notification");
    // An expired retry timer must not busy-loop while old-child cleanup is
    // still owned. Only the timer is advanced; the real child gate stays held.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    env.trigger_stopping().await;
    wait_status_mode(&status_path, "stopping", Duration::from_secs(2)).await;
    assert!(
        !run_handle.is_finished(),
        "shutdown must join the restart's old-child cleanup"
    );
    gate.release.add_permits(1);
    // The noop proxy has no replacement runtime. Its startup failure still
    // follows cleanup and is handled without abandoning the old process.
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "restart cleanup did not finish",
    )
    .await;
    assert_child_reaped("mitmdump", pid, starttime).await;
}

#[tokio::test]
async fn mitm_recovery_panic_stops_runner_instead_of_retrying_unknown_cleanup() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let starttime = runner_host::process::read_process_stat(pid)
        .await
        .unwrap()
        .starttime;
    let gate = crate::test_fixtures::ReapGate::new();
    config.proxy.mitm.set_child_for_test(child);
    config.proxy.mitm.set_reap_gate_for_test(gate.clone());
    let (crash_tx, crash_rx) = mpsc::channel(1);
    config.proxy.mitm_crash_rx = crash_rx;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    crash_tx.send(()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
        .await
        .unwrap();
    // A duplicate notification must not create another restart after failure.
    crash_tx.send(()).await.unwrap();
    gate.release.close();
    assert_run_error_contains(run_handle, "mitmproxy recovery task failed").await;
    assert!(env.cancel.is_cancelled());
    assert!(crash_tx.is_closed());
    wait_for_child_cleanup("mitmdump", pid, starttime).await;
}

#[tokio::test]
async fn job_drain_services_mitm_crashes_and_joins_held_recovery() {
    let wait = Duration::from_secs(5);
    let job_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(job_gate.clone());
    let (mut config, mut env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let starttime = runner_host::process::read_process_stat(pid)
        .await
        .unwrap()
        .starttime;
    let reap_gate = crate::test_fixtures::ReapGate::new();
    config.proxy.mitm.set_child_for_test(child);
    config.proxy.mitm.set_reap_gate_for_test(reap_gate.clone());
    let (crash_tx, crash_rx) = mpsc::channel(1);
    config.proxy.mitm_crash_rx = crash_rx;
    let usage_flush_tx = config.usage_flush_tx.clone();
    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let token = wait_cancel_token(&env.cancel_tokens, run_id, wait).await;
    job_gate.wait_entered(1, wait).await.unwrap();

    // Exhaust discovery without a hard stop so this job keeps the real drain
    // select alive. Persisted Stopping alone is not evidence of drain entry.
    env.handle.discover_tx = mpsc::unbounded_channel().0;
    env.start_observer
        .wait_for(wait, "running-job drain", |event| {
            matches!(event, StartLoopEvent::RunningJobsDrainEntered).then_some(())
        })
        .await;
    assert!(!token.is_cancelled());
    assert!(!env.cancel.is_cancelled());
    crash_tx.send(()).await.unwrap();
    tokio::time::timeout(wait, reap_gate.entered.notified())
        .await
        .expect("drain must schedule old-child cleanup");

    crash_tx.send(()).await.unwrap();
    tokio::time::timeout(wait, async {
        while crash_tx.capacity() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("drain must consume a late crash during recovery");
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    usage_flush_tx.send(()).await.unwrap();
    wait_usage_flush_requested(&env, wait).await;
    assert!(!token.is_cancelled());
    assert!(!run_handle.is_finished());

    job_gate.release_one();
    let completion = env.handle.wait_completion(run_id, wait).await.unwrap();
    assert_eq!(completion.exit_code, 0);
    assert!(completion.error.is_none());
    env.start_observer
        .wait_destroy_tasks_drain_entered(wait)
        .await;
    assert!(
        !run_handle.is_finished(),
        "finishing the job must not abandon in-flight proxy cleanup"
    );
    reap_gate.release.add_permits(1);
    assert_run_exits_within(run_handle, wait, "drain must join proxy recovery").await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, wait).await;
    assert_child_reaped("mitmdump", pid, starttime).await;
}

#[tokio::test]
async fn job_drain_mitm_recovery_panic_cancels_and_joins_all_jobs() {
    let wait = Duration::from_secs(5);
    let job_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(job_gate.clone());
    overrides.set_process_cancel_releases_wait_gate(false);
    let (mut config, mut env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let starttime = runner_host::process::read_process_stat(pid)
        .await
        .unwrap()
        .starttime;
    let reap_gate = crate::test_fixtures::ReapGate::new();
    config.proxy.mitm.set_child_for_test(child);
    config.proxy.mitm.set_reap_gate_for_test(reap_gate.clone());
    let (crash_tx, crash_rx) = mpsc::channel(1);
    config.proxy.mitm_crash_rx = crash_rx;
    let run_handle = tokio::spawn(run(config));
    let runs = [RunId::new_v4(), RunId::new_v4()];
    for &run_id in &runs {
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    }
    let first_token = wait_cancel_token(&env.cancel_tokens, runs[0], wait).await;
    let second_token = wait_cancel_token(&env.cancel_tokens, runs[1], wait).await;
    job_gate.wait_entered(2, wait).await.unwrap();
    env.handle.discover_tx = mpsc::unbounded_channel().0;
    env.start_observer
        .wait_for(wait, "running-job drain", |event| {
            matches!(event, StartLoopEvent::RunningJobsDrainEntered).then_some(())
        })
        .await;
    assert!(!first_token.is_cancelled());
    assert!(!second_token.is_cancelled());
    assert!(!env.cancel.is_cancelled());

    crash_tx.send(()).await.unwrap();
    tokio::time::timeout(wait, reap_gate.entered.notified())
        .await
        .expect("drain must schedule old-child cleanup");
    crash_tx.send(()).await.unwrap();
    reap_gate.release.close();
    // Cancel requests may arrive in a different order from the shared gate's
    // FIFO tickets. Observe both requests before releasing either process so
    // one job's cancel cannot let the other job finish without sending its own.
    assert!(
        overrides
            .wait_for_process_cancel_calls(runs.len(), wait)
            .await,
        "fatal recovery must cancel every held guest process",
    );
    assert!(
        !run_handle.is_finished(),
        "fatal recovery must join every held job before returning",
    );
    job_gate.release_many(runs.len());
    assert_run_error_contains(run_handle, "mitmproxy recovery task failed").await;
    assert!(crash_tx.is_closed(), "fatal recovery must disable retries");
    assert!(env.cancel.is_cancelled());
    assert!(first_token.is_cancelled());
    assert!(second_token.is_cancelled());
    for &run_id in &runs {
        wait_cancel_token_removed(&env.cancel_tokens, run_id, wait).await;
        let completions = env.handle.completions.lock().unwrap();
        let completion = completions
            .iter()
            .find(|entry| entry.run_id == run_id)
            .expect("fatal recovery must still join every accepted job");
        assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
    }
    wait_for_child_cleanup("mitmdump", pid, starttime).await;
}

/// SIGTERM while a job is in flight: per-job cancellation fires, the
/// executor aborts, and run() exits within a couple of seconds rather
/// than blocking on the 2h JOB_TIMEOUT.
#[tokio::test]
async fn hard_shutdown_cancels_active_jobs() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter the lifecycle gate");

    // SIGTERM equivalent: latch hard-shutdown, cancel all in-flight jobs.
    env.trigger_stopping().await;
    assert!(token.is_cancelled(), "hard shutdown must cancel the job");

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "hard shutdown should exit within 3s — got stuck",
    )
    .await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // The cancelled job reports the synthetic "cancelled by user" error.
    let comps = env.handle.completions.lock().unwrap();
    let c = comps
        .iter()
        .find(|c| c.run_id == run_id)
        .expect("cancelled job should still report completion");
    assert_eq!(c.error.as_deref(), Some("cancelled by user"));
}

#[tokio::test]
async fn signal_handler_exit_cancels_active_jobs() {
    let handler_exit = Arc::new(tokio::sync::Notify::new());
    let handler_task = {
        let handler_exit = Arc::clone(&handler_exit);
        tokio::spawn(async move {
            handler_exit.notified().await;
        })
    };

    assert_signal_handler_task_end_cancels_active_jobs(handler_task, || {
        handler_exit.notify_one();
    })
    .await;
}

#[tokio::test]
async fn signal_handler_panic_cancels_active_jobs() {
    let handler_panic = Arc::new(tokio::sync::Notify::new());
    let handler_task = {
        let handler_panic = Arc::clone(&handler_panic);
        tokio::spawn(async move {
            handler_panic.notified().await;
            panic!("signal handler task panic");
        })
    };

    assert_signal_handler_task_end_cancels_active_jobs(handler_task, || {
        handler_panic.notify_one();
    })
    .await;
}

#[tokio::test]
async fn graceful_shutdown_aborts_signal_handler_task() {
    struct ReleaseOnDrop(Arc<tokio::sync::Semaphore>);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            self.0.add_permits(1);
        }
    }

    let started = Arc::new(tokio::sync::Notify::new());
    let dropped = Arc::new(tokio::sync::Semaphore::new(0));
    let handler_task = {
        let started = Arc::clone(&started);
        let dropped = Arc::clone(&dropped);
        tokio::spawn(async move {
            let _guard = ReleaseOnDrop(dropped);
            started.notify_one();
            std::future::pending::<()>().await;
        })
    };
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("signal handler test task should start");

    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    config.signals.signal_source = SignalSource::Override(SignalController {
        mode_rx: env.mode_tx.subscribe(),
        lifecycle: env.lifecycle.clone(),
        handler_task: Some(SignalHandlerTask::new(handler_task)),
    });
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    shutdown(&env, run_handle).await;

    let _permit = dropped
        .try_acquire()
        .expect("graceful shutdown should await signal handler task abort");
}

async fn assert_signal_handler_task_end_cancels_active_jobs(
    handler_task: tokio::task::JoinHandle<()>,
    trigger_handler_task_end: impl FnOnce(),
) {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    config.signals.signal_source = SignalSource::Override(SignalController {
        mode_rx: env.mode_tx.subscribe(),
        lifecycle: env.lifecycle.clone(),
        handler_task: Some(SignalHandlerTask::new(handler_task)),
    });
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter the lifecycle gate before handler termination");

    // Complete real setup before controlling the shutdown deadline. Tokio holds
    // paused time while blocking filesystem work runs, so status-file latency
    // cannot consume the cancellation budget; a stuck async job still times out.
    tokio::time::pause();
    trigger_handler_task_end();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "signal handler exit should cancel active jobs and stop promptly",
    )
    .await;
    tokio::time::resume();
    assert!(
        token.is_cancelled(),
        "handler termination must cancel the job"
    );
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    let comps = env.handle.completions.lock().unwrap();
    let c = comps
        .iter()
        .find(|c| c.run_id == run_id)
        .expect("cancelled job should still report completion");
    assert_eq!(c.error.as_deref(), Some("cancelled by user"));
}

/// SIGUSR1 → SIGTERM upgrade. Starts Draining, then hard-shutdown fires
/// mid-drain and the run exits promptly with the active job cancelled.
#[tokio::test]
async fn drain_then_hard_shutdown_upgrades() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        gate,
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Draining. Without hard shutdown, this would wait up to JOB_TIMEOUT = 2h.
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;

    // Upgrade to hard shutdown.
    env.trigger_stopping().await;

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "Draining → hard shutdown should exit within 3s",
    )
    .await;
}

async fn install_controllable_kmsg(
    config: &mut RunConfig,
) -> (tokio::process::ChildStdin, u32, u64) {
    let mut child = tokio::process::Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn controllable kmsg child");
    let stdin = child.stdin.take().expect("capture test child stdin");
    let pid = child.id().expect("test child pid");
    let starttime = runner_host::process::read_process_stat(pid)
        .await
        .expect("test child should be visible in procfs")
        .starttime;
    config.shutdown.kmsg_handle =
        crate::kmsg_log::KmsgHandle::from_test_child(child, NetworkLogManager::new())
            .expect("create test kmsg handle");
    (stdin, pid, starttime)
}

async fn install_controllable_dns(
    config: &mut RunConfig,
) -> (tokio::process::ChildStdin, u32, u64) {
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", "exec cat >&2"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn controllable dns child");
    let stdin = child.stdin.take().expect("capture test child stdin");
    let pid = child.id().expect("test child pid");
    let starttime = runner_host::process::read_process_stat(pid)
        .await
        .expect("test child should be visible in procfs")
        .starttime;
    config.shutdown.dns_handle =
        crate::dns::DnsProxy::from_test_child(child, NetworkLogManager::new())
            .await
            .expect("create test dns handle");
    (stdin, pid, starttime)
}

async fn assert_child_reaped(component: &str, pid: u32, starttime: u64) {
    let observed_starttime = runner_host::process::read_process_stat(pid)
        .await
        .map(|stat| stat.starttime);
    assert_ne!(
        observed_starttime,
        Some(starttime),
        "{component} child pid {pid} with start time {starttime} was not reaped",
    );
}

// Independently owned cleanup promises eventual process removal. Joined
// cleanup paths use assert_child_reaped to enforce the stronger postcondition.
async fn wait_for_child_cleanup(component: &str, pid: u32, starttime: u64) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while runner_host::process::read_process_stat(pid)
            .await
            .is_some_and(|stat| stat.starttime == starttime)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "{component} cleanup did not reap child pid {pid} with start time {starttime} within 2s"
        )
    });
}

async fn assert_run_error_contains(
    mut run_handle: tokio::task::JoinHandle<RunnerResult<()>>,
    expected: &str,
) {
    let result = match tokio::time::timeout(Duration::from_secs(5), &mut run_handle).await {
        Ok(result) => result.expect("run task should not panic"),
        Err(_) => {
            run_handle.abort();
            let _ = run_handle.await;
            panic!("runner did not finish after required component failure");
        }
    };
    let error = result.expect_err("required component failure should return a runner error");
    assert!(
        error.to_string().contains(expected),
        "expected error containing {expected:?}, got {error}",
    );
}
