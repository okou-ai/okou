use super::super::super::*;
use super::super::support::{mock_run_config, shutdown, test_profiles, wait_status_mode};
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
        guest: Arc::new(runner_wss::UnavailableGuest),
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
async fn listener_accepts_before_ready_and_is_removed_after_stop() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let dir = env._temp_dir.path().join("wss");
    std::fs::create_dir(&dir).unwrap();
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
    // A socket bound without an accept loop would fill its backlog; here the
    // connection is accepted and queued while readiness remains Starting.
    for _ in 0..40 {
        if UnixStream::connect(&path).await.is_ok() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(path.exists());
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
async fn accept_loop_failure_is_fatal_during_readiness_and_after_running() {
    for during_startup in [true, false] {
        let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let dir = env._temp_dir.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
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
