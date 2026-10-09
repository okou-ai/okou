use super::super::super::*;
use super::super::support::{
    TEST_HEARTBEAT_GENERATION, minimal_context, mock_run_config, mock_run_config_with_overrides,
    push_job, shutdown, test_profiles, wait_cancel_token, wait_status_mode,
};
use std::sync::Arc;
use tokio::net::UnixStream;

fn enable_wss(config: &mut RunConfig, dir: PathBuf) {
    config.wss = Some(WssConfig {
        socket_dir: dir,
        hostname: Some("runner.okou.ai".to_owned()),
        consumer: Arc::new(runner_wss::ApiTicketConsumer::new(
            config.exec_config.http.clone(),
            "test-official-token".to_owned(),
        )),
        fail_accept: None,
    });
}

#[tokio::test]
async fn missing_and_unsafe_socket_directory_fail_before_runner_ready_or_claims() {
    for unsafe_dir in [false, true] {
        let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let dir = env._temp_dir.path().join("wss");
        if unsafe_dir {
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o777))
                .unwrap();
        }
        enable_wss(&mut config, dir);
        let status_path = env._temp_dir.path().join("status.json");
        let result = run(config).await;
        assert!(
            result.is_err(),
            "unsafe/missing directory cannot start: {result:?}"
        );
        wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
        assert_eq!(env.handle.startup_readiness_calls(), 0);
        assert_eq!(env.handle.discover_started_count(), 0);
    }
}

#[tokio::test]
async fn listener_starts_before_ready_and_is_removed_after_stop() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let dir = env._temp_dir.path().join("wss");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o710)).unwrap();
    let path = dir.join(format!("{}.sock", config.runner.identity.runner_id()));
    enable_wss(&mut config, dir);
    env.handle.block_startup_readiness();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    assert!(
        env.handle
            .wait_startup_readiness_entered(Duration::from_secs(2))
            .await
    );
    // run() awaits the accept task's start signal before entering provider
    // readiness. Verify its socket is connectable while status is Starting.
    let mut connected = false;
    for _ in 0..40 {
        if UnixStream::connect(&path).await.is_ok() {
            connected = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(connected, "WSS socket must be connectable before ready");
    let state: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&status_path).await.unwrap()).unwrap();
    assert_eq!(state["mode"], "starting");
    assert_eq!(env.handle.discover_started_count(), 0);
    env.handle.release_startup_readiness();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    shutdown(&env, run_handle).await;
    assert!(
        !path.exists(),
        "only this process's socket is removed on stop"
    );
}

#[tokio::test]
async fn unauthenticated_socket_times_out_while_startup_readiness_is_blocked() {
    use tokio::io::AsyncReadExt;

    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let dir = env._temp_dir.path().join("wss");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o710)).unwrap();
    let path = dir.join(format!("{}.sock", config.runner.identity.runner_id()));
    enable_wss(&mut config, dir);
    env.handle.block_startup_readiness();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    assert!(
        env.handle
            .wait_startup_readiness_entered(Duration::from_secs(2))
            .await
    );
    let mut peer = UnixStream::connect(&path).await.unwrap();
    let mut byte = [0; 1];
    let closed = tokio::time::timeout(Duration::from_secs(7), peer.read(&mut byte)).await;
    let state: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&status_path).await.unwrap()).unwrap();
    assert_eq!(state["mode"], "starting");
    assert_eq!(env.handle.discover_started_count(), 0);
    // Always release readiness and join Runner before asserting the deadline,
    // including on the pre-fix timeout path.
    env.handle.release_startup_readiness();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    shutdown(&env, run_handle).await;
    assert_eq!(
        closed
            .expect("pre-auth timeout must not wait for Runner startup readiness")
            .unwrap(),
        0,
        "an unauthenticated peer must be closed without a response"
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn two_runner_ids_coexist_and_remove_only_their_own_socket() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("wss");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o710)).unwrap();
    let (mut first, first_env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let (mut second, second_env) = mock_run_config(test_profiles(), 8, 32768, 4);
    second.runner.identity = runner_host::runner_process_identity::RunnerProcessIdentity::new(
        uuid::Uuid::new_v4(),
        TEST_HEARTBEAT_GENERATION,
    )
    .unwrap();
    let first_path = dir.join(format!("{}.sock", first.runner.identity.runner_id()));
    let second_path = dir.join(format!("{}.sock", second.runner.identity.runner_id()));
    assert_ne!(first_path, second_path);
    enable_wss(&mut first, dir.clone());
    enable_wss(&mut second, dir);
    let first_handle = tokio::spawn(run(first));
    let second_handle = tokio::spawn(run(second));
    wait_status_mode(
        &first_env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;
    wait_status_mode(
        &second_env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;
    assert!(UnixStream::connect(&first_path).await.is_ok());
    assert!(UnixStream::connect(&second_path).await.is_ok());
    shutdown(&second_env, second_handle).await;
    assert!(!second_path.exists());
    assert!(UnixStream::connect(&first_path).await.is_ok());
    shutdown(&first_env, first_handle).await;
    assert!(!first_path.exists());
}

#[tokio::test]
async fn soft_drain_retains_socket_until_active_run_finishes() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let dir = env._temp_dir.path().join("wss");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o710)).unwrap();
    let path = dir.join(format!("{}.sock", config.runner.identity.runner_id()));
    enable_wss(&mut config, dir);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;
    assert!(
        !run_handle.is_finished(),
        "active job must survive soft drain"
    );
    assert!(
        UnixStream::connect(&path).await.is_ok(),
        "old Runner must retain its WSS socket for run reconnects"
    );

    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "active run must finish normally");
    tokio::time::timeout(Duration::from_secs(5), run_handle)
        .await
        .expect("drained Runner must exit after last run")
        .unwrap()
        .unwrap();
    assert!(!path.exists(), "socket must close after last run finishes");
}

#[tokio::test]
async fn accept_loop_failure_is_fatal_during_readiness_and_after_running() {
    for during_startup in [true, false] {
        let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let dir = env._temp_dir.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o710))
            .unwrap();
        let path = dir.join(format!("{}.sock", config.runner.identity.runner_id()));
        enable_wss(&mut config, dir);
        let (fail, failed) = tokio::sync::oneshot::channel();
        config.wss.as_mut().unwrap().fail_accept = Some(failed);
        if during_startup {
            env.handle.block_startup_readiness();
        }
        let status_path = env._temp_dir.path().join("status.json");
        let run_handle = tokio::spawn(run(config));
        if during_startup {
            assert!(
                env.handle
                    .wait_startup_readiness_entered(Duration::from_secs(2))
                    .await
            );
        } else {
            wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
        }
        fail.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), run_handle)
            .await
            .expect("failed accept must exit")
            .unwrap();
        assert!(
            result.is_err(),
            "unexpected listener exit cannot be healthy"
        );
        wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
        assert!(!path.exists());
        if during_startup {
            assert_eq!(env.handle.discover_started_count(), 0);
        }
    }
}
