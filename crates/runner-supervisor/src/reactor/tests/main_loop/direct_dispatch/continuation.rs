use super::*;
use crate::home_image_cache::HomeImageCache;
use crate::idle_pool::{ParkResult, ParkedIdleCandidate};
use runner_host::paths::RunnerPaths;
use sandbox::SandboxId;
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides};

const WAIT: Duration = Duration::from_secs(5);

enum Successor {
    Continue,
    Cancel,
    OtherGeneration,
}

#[tokio::test]
async fn supplied_http_continuation_preserves_finalizing_home_with_a_blank_available() {
    assert_finalizing_home(Successor::Continue).await;
}

#[tokio::test]
async fn supplied_http_cancellation_releases_a_waiting_continuation_without_a_sandbox() {
    assert_finalizing_home(Successor::Cancel).await;
}

#[tokio::test]
async fn supplied_http_other_native_generation_keeps_the_available_blank() {
    assert_finalizing_home(Successor::OtherGeneration).await;
}

async fn assert_finalizing_home(successor: Successor) {
    let execution = MockLifecycleGate::new();
    let parking = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    overrides.set_park_lifecycle_gate(parking.clone());
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let rootfs_hash = profiles["vm0/default"].rootfs_hash.clone();
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 16384, 2, overrides.clone());
    // The two-slot capacity rounds the blank refill target down to zero;
    // offer one explicit blank after the producer enters finalization.
    let budget = config.capacity.budget.clone();
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(HomeImageCache::shared(
        paths.clone(),
        &config.paths.home,
        &config.runner.group,
    ));
    let peer = super::super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(&env._temp_dir.path().join("status.json"), "running", WAIT).await;

    let reuse_key = "thread:direct-finalizing-home";
    let source = RunId::new_v4();
    let mut first = envelope(identity, source);
    first["executionContext"]["reuseKey"] = json!(reuse_key);
    assert_eq!(
        client(&socket, identity, source, &first.to_string())
            .await
            .2["disposition"],
        "accepted"
    );
    execution.wait_entered(1, WAIT).await.unwrap();
    let source_sandbox = overrides.create_configs()[0].id;
    // The external sandbox mock does not allocate disks. Supply its writable
    // home at the production path; the real cache owns its entry lock.
    let image = paths.active_home_image(&source_sandbox);
    tokio::fs::create_dir_all(image.parent().unwrap())
        .await
        .unwrap();
    let home_bytes = vec![0x5a; 1024 * 1024];
    tokio::fs::write(&image, &home_bytes).await.unwrap();
    execution.release_one();
    parking.wait_entered(1, WAIT).await.unwrap();

    let blank_id = SandboxId::new_v4();
    let blank = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::with_overrides(
            blank_id.to_string(),
            overrides.clone(),
        )),
        Arc::new(Box::new(MockSandboxFactory::with_overrides(
            overrides.clone(),
        ))),
        ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        blank_id,
        "vm0/default".into(),
        rootfs_hash,
        None,
    );
    assert!(matches!(
        env.idle_pool.lock().await.park(blank),
        ParkResult::Parked
    ));

    let run_id = RunId::new_v4();
    let mut next = envelope(identity, run_id);
    next["executionContext"]["reuseKey"] = json!(reuse_key);
    next["executionContext"]["nativeContinuation"] = json!({
        "sessionId": RunId::new_v4(),
        "generationRunId": if matches!(successor, Successor::OtherGeneration) {
            RunId::new_v4()
        } else {
            source
        },
        "recoveryPrompt": null
    });
    let next = next.to_string();
    assert_eq!(
        client(&socket, identity, run_id, &next).await.2["disposition"],
        "accepted"
    );

    if matches!(successor, Successor::OtherGeneration) {
        // A different native producer must execute without waiting for this
        // sandbox, even though its reuse key matches the finalizing producer.
        execution.wait_entered(2, WAIT).await.unwrap();
    } else {
        // Either causal event lets the baseline finish: before the repair the
        // second process starts on the blank, and the completion identity below
        // exposes the lost home continuity. No elapsed delay creates the race.
        tokio::select! {
            () = env.start_observer.wait_finalizing_handoff_requested(source, run_id, WAIT) => {}
            entered = execution.wait_entered(2, WAIT) => { entered.unwrap(); }
        }
    }

    if matches!(successor, Successor::Cancel) {
        env.cancel_tokens
            .handle(run_id)
            .await
            .unwrap()
            .request_hard_cancellation()
            .await;
        let cancelled = env.handle.wait_completion(run_id, WAIT).await.unwrap();
        assert_ne!(cancelled.exit_code, 0);
        assert_eq!(cancelled.sandbox_id, None);
        wait_cancel_token_removed(&env.cancel_tokens, run_id, WAIT).await;
        parking.release_one();
    } else {
        assert_eq!(
            client(&socket, identity, run_id, &next).await.2["disposition"],
            "accepted"
        );
        parking.release_one();
        execution.wait_entered(2, WAIT).await.unwrap();
        assert_eq!(tokio::fs::read(&image).await.unwrap(), home_bytes);
        execution.release_one();
        parking.wait_entered(2, WAIT).await.unwrap();
        parking.release_one();
    }
    let first = env.handle.wait_completion(source, WAIT).await.unwrap();
    let second = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_eq!(first.exit_code, 0);
    assert_eq!(first.sandbox_id, Some(source_sandbox));
    if !matches!(successor, Successor::Cancel) {
        assert_eq!(second.exit_code, 0);
        assert_eq!(
            second.sandbox_id,
            Some(if matches!(successor, Successor::OtherGeneration) {
                blank_id
            } else {
                source_sandbox
            }),
            "a matching continuation must retain the producer's actual home"
        );
    }
    assert_eq!(
        env.handle
            .completions
            .lock()
            .unwrap()
            .iter()
            .filter(|completion| completion.run_id == run_id)
            .count(),
        1
    );
    peer.shutdown().await;
    shutdown(&env, runner).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, WAIT).await;
    wait_budget_count(&budget, 0, WAIT).await;
}
