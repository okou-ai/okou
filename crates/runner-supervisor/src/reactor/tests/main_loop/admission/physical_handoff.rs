use super::terminal_reuse::generic_finalizing_candidate;
use super::*;
use crate::home_image_cache::{
    HomeCacheCheckoutResult, HomeImageLeaseIdentity, HomeImagePrepareLockPolicy,
    HomeImagePrepareRequest,
};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use guest_contracts::diagnostics::{
    AgentFramework, CliTerminationDiagnostic, CliTerminationReason, FailureClass,
    FailureDiagnostic, PromptMetadata,
};
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};

#[derive(Clone, Copy)]
enum Terminal {
    Nonzero,
    Cancelled,
    Timeout,
}

#[tokio::test]
async fn nonzero_predecessor_hands_off_home_before_full_park() {
    assert_physical_handoff(Terminal::Nonzero, None).await;
}

#[tokio::test]
async fn cooperative_cancellation_hands_off_home_before_full_park() {
    assert_physical_handoff(Terminal::Cancelled, None).await;
}

#[tokio::test]
async fn execution_timeout_hands_off_home_before_full_park() {
    assert_physical_handoff(Terminal::Timeout, None).await;
}

#[tokio::test]
async fn physical_handoff_restores_successor_with_another_native_generation() {
    assert_physical_handoff(Terminal::Nonzero, Some(RunId::new_v4())).await;
}

async fn assert_physical_handoff(terminal: Terminal, native_generation: Option<RunId>) {
    let process_gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(process_gate.clone());
    let handoff_point = match terminal {
        Terminal::Nonzero => sandbox::SandboxFinalExecParkHandoffPoint::BeforeBalloon,
        Terminal::Cancelled => sandbox::SandboxFinalExecParkHandoffPoint::DuringBalloonSettle,
        Terminal::Timeout => sandbox::SandboxFinalExecParkHandoffPoint::DuringDeflation,
    };
    overrides.push_final_exec_park_handoff_point(handoff_point);
    let exit_code = if matches!(terminal, Terminal::Timeout) {
        guest_contracts::diagnostics::AGENT_EXECUTION_TIMEOUT_EXIT_CODE
    } else {
        1
    };
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(
        1,
        exit_code,
        Vec::new(),
        Vec::new(),
    ));
    if matches!(terminal, Terminal::Timeout) {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliExecutionError,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("continue until the execution deadline"),
        )
        .with_cli_exit_code(143)
        .with_cli_termination(CliTerminationDiagnostic::new(
            CliTerminationReason::ExecutionTimeout,
        ));
        overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
        overrides.push_read_file_result(Ok(Some(b"Agent execution timed out".to_vec())));
    }

    let mut profiles = test_profiles();
    let profile = profiles.get_mut("vm0/default").unwrap();
    profile.home_disk_mb = 1;
    let rootfs_hash = profile.rootfs_hash.clone();
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache.clone());
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let reuse_key = "thread:physical-home-handoff";
    let predecessor = RunId::new_v4();
    push_job(
        &env,
        predecessor,
        "vm0/default",
        Some(context_with_reuse_key(predecessor, reuse_key)),
    );
    process_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    // The external mock provider does not allocate a disk. Supply its writable
    // image under the same real path/custody used by production home promotion.
    let sandbox_id = overrides.create_configs()[0].id;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    let image = vec![17; 1024 * 1024];
    let active_image = paths.active_home_image(&sandbox_id);
    tokio::fs::write(&active_image, &image).await.unwrap();
    assert_home_locked(&cache, reuse_key, &rootfs_hash).await;
    let restores_before = overrides.guest_state_restore_calls().len();

    let successor = RunId::new_v4();
    let context = native_generation.map_or_else(
        || context_with_reuse_key(successor, reuse_key),
        |source| context_with_native_source(successor, reuse_key, source),
    );
    env.provider.set_claim_result(successor, Some(context));
    env.handle
        .discover_tx
        .send(generic_finalizing_candidate(
            successor,
            reuse_key,
            predecessor,
            std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME,
        ))
        .unwrap();
    wait_cancel_handle(&env.cancel_tokens, successor, Duration::from_secs(5)).await;
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    if matches!(terminal, Terminal::Cancelled) {
        let cancellation =
            wait_cancel_handle(&env.cancel_tokens, predecessor, Duration::from_secs(5)).await;
        cancellation.request_cooperative_user_cancellation().await;
        assert!(
            overrides
                .wait_for_process_control_calls(1, Duration::from_secs(5))
                .await
        );
    }
    process_gate.release_one();
    process_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("physical handoff should start the successor before full park");
    let first = env
        .handle
        .wait_completion(predecessor, Duration::from_secs(5))
        .await
        .unwrap();
    assert_ne!(first.exit_code, 0);
    assert_eq!(overrides.park_call_count(), 0);
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(
        overrides.completed_final_exec_park_handoff_points(),
        vec![handoff_point]
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(
        overrides.guest_state_restore_calls().len() > restores_before,
        "physical reuse must still restore the successor's managed guest state"
    );
    assert_home_locked(&cache, reuse_key, &rootfs_hash).await;
    assert_eq!(tokio::fs::read(&active_image).await.unwrap(), image);

    process_gate.release_one();
    let second = env
        .handle
        .wait_completion(successor, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(second.exit_code, 0);
    assert_eq!(second.sandbox_id, first.sandbox_id);
    shutdown(&env, run_handle).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
    let states = cache.held_home_states().await;
    assert!(
        states.iter().any(|state| state.reuse_key == reuse_key
            && state
                .home_caches
                .iter()
                .any(|home| home.source_run_id == successor)),
        "the successor must retain and publish the original home custody"
    );
}

async fn assert_home_locked(cache: &HomeImageCache, reuse_key: &str, rootfs_hash: &str) {
    let checkout = cache
        .prepare_with_lock_policy(
            HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    rootfs_hash,
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: 1024 * 1024,
                },
                home_drive_required: true,
            },
            HomeImagePrepareLockPolicy::ImmediateFallback,
        )
        .await;
    assert_eq!(checkout.result(), HomeCacheCheckoutResult::LockBusy);
}
