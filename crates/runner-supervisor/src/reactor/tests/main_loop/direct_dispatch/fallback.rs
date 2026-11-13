use super::*;
use crate::home_image_cache::HomeImageCache;
use crate::idle_pool::{ParkResult, ParkedIdleCandidate};
use crate::reactor::tests::support::{seed_home_cache_state, seed_idle_pool_with_overrides};
use runner_host::paths::RunnerPaths;
use sandbox::{HomeDriveSeedImage, SandboxId};
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides};

const WAIT: Duration = Duration::from_secs(5);
const IMAGE_BYTES: u64 = 1024 * 1024;

enum Available {
    Retained,
    BlankAndHome,
    Blank,
    Home,
    Neither,
}

#[tokio::test]
async fn supplied_fallback_reuses_retained_sandbox_before_blank_and_home() {
    assert_fallback(Available::Retained).await;
}

#[tokio::test]
async fn supplied_fallback_combines_available_blank_and_home() {
    assert_fallback(Available::BlankAndHome).await;
}

#[tokio::test]
async fn supplied_fallback_reuses_blank_when_home_is_unavailable() {
    assert_fallback(Available::Blank).await;
}

#[tokio::test]
async fn supplied_fallback_uses_home_for_new_vm_when_no_sandbox_is_available() {
    assert_fallback(Available::Home).await;
}

#[tokio::test]
async fn supplied_fallback_creates_cold_vm_when_sandbox_and_home_are_unavailable() {
    assert_fallback(Available::Neither).await;
}

async fn assert_fallback(available: Available) {
    let execution = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let rootfs_hash = profiles["vm0/default"].rootfs_hash.clone();
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 16384, 2, overrides.clone());
    let budget = config.capacity.budget.clone();
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    let key = "thread:supplied-home-fallback";
    let cached_home = matches!(
        available,
        Available::Retained | Available::BlankAndHome | Available::Home
    );
    // Match the old Claim's finalizing-to-home fixture: real published bytes
    // and a controlled producer transition, with the successor entering by HTTP.
    let source = if cached_home {
        seed_home_cache_state(&cache, &paths, key, "vm0/default", IMAGE_BYTES).await
    } else {
        RunId::new_v4()
    };
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache);
    let producer = env
        .active_runs
        .register(source, Some(key.into()), "vm0/default".into());
    let retained = if matches!(available, Available::Retained) {
        Some(
            seed_idle_pool_with_overrides(
                &env.idle_pool,
                &budget,
                &overrides,
                key,
                "vm0/default",
                2,
                4096,
            )
            .await,
        )
    } else {
        None
    };
    let blank = if matches!(
        available,
        Available::Retained | Available::BlankAndHome | Available::Blank
    ) {
        let id = SandboxId::new_v4();
        let candidate = ParkedIdleCandidate::blank(
            Box::new(MockSandbox::with_overrides(
                id.to_string(),
                overrides.clone(),
            )),
            Arc::new(Box::new(MockSandboxFactory::with_overrides(
                overrides.clone(),
            ))),
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            id,
            "vm0/default".into(),
            rootfs_hash,
            None,
        );
        assert!(matches!(
            env.idle_pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        Some(id)
    } else {
        None
    };
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
    let run_id = RunId::new_v4();
    let mut body = envelope(identity, run_id);
    body["executionContext"]["reuseKey"] = json!(key);
    body["executionContext"]["nativeContinuation"] = json!({
        "sessionId": RunId::new_v4(), "generationRunId": source, "recoveryPrompt": null
    });
    assert_eq!(
        client(&socket, identity, run_id, &body.to_string()).await.2["disposition"],
        "accepted"
    );
    env.start_observer
        .wait_finalizing_handoff_requested(source, run_id, WAIT)
        .await;
    assert!(producer.reuse_publisher().publish_no_exact_sandbox());
    execution.wait_entered(1, WAIT).await.unwrap();
    if cached_home && retained.is_none() {
        let drive = if blank.is_some() {
            overrides.home_drive_replacements().last().cloned()
        } else {
            overrides
                .create_configs()
                .last()
                .and_then(|config| config.home_drive.clone())
        };
        // Check the selected bytes as well as VM identity; a blank with a
        // pristine home is not a successful cached-home fallback.
        let drive = drive.expect("cached home must be attached to the selected VM");
        let seed = match drive.seed_image.as_ref().unwrap() {
            HomeDriveSeedImage::Move(path) | HomeDriveSeedImage::Copy(path) => path,
        };
        assert_eq!(tokio::fs::metadata(seed).await.unwrap().len(), IMAGE_BYTES);
    }
    execution.release_one();
    let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_eq!(completion.exit_code, 0);
    let expected = retained
        .or(blank)
        .unwrap_or_else(|| overrides.create_configs().last().unwrap().id);
    assert_eq!(
        completion.sandbox_id,
        Some(expected),
        "available VM capacity must be reused before creating a fresh VM"
    );
    drop(producer);
    peer.shutdown().await;
    shutdown(&env, runner).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, WAIT).await;
    wait_budget_count(&budget, 0, WAIT).await;
}
