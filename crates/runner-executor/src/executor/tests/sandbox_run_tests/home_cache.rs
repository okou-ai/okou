use super::*;
use httpmock::prelude::*;
use sha2::{Digest, Sha256};

use crate::executor::tests::support::RUN_IN_SANDBOX_TEST_TIMEOUT;
use crate::home_image_cache::{HomeImagePrepareLockTestGate, HomeImagePreparePolicy};
use crate::telemetry::{JobTelemetry, RunnerStartupPath};
use runner_host::home_observation::{
    HomeObservation, HomeObservationKind as HomeKind, HomeObservationOutcome as HomeOutcome,
};
use runner_storage::operation_test_support::RecordedHomeObservations;
use runner_types::types::HomeReuseResult;

fn enable_api_start_telemetry(context: &mut runner_types::types::ExecutionContext) {
    context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
}

fn consumption_facts(recorded: &JobTelemetry) -> Vec<HomeObservation> {
    recorded
        .pending_home_snapshot()
        .into_iter()
        .filter(|fact| fact.kind == HomeKind::Consumption)
        .collect()
}

fn assert_home_fallback(recorded: &JobTelemetry, run_id: RunId, reason: &str) {
    let facts = consumption_facts(recorded);
    assert_eq!(facts.len(), 2, "{facts:#?}");
    assert_eq!(facts[0].outcome, HomeOutcome::Failed);
    assert_eq!(facts[0].reason.as_deref(), Some("sandbox_prepare_failed"));
    assert_eq!(facts[1].outcome, HomeOutcome::Fallback);
    assert_eq!(facts[1].reason.as_deref(), Some(reason));
    assert!(facts.iter().all(|fact| fact.run_id == Some(run_id)));
    assert!(facts[0].image_generation.is_some());
    assert_eq!(facts[0].image_generation, facts[1].image_generation);
}

fn assert_api_to_spawn_path(
    telemetry: &JobTelemetry,
    expected_path: RunnerStartupPath,
    expected_reuse_result: SandboxReuseResult,
) {
    let operations = telemetry.pending_ops_with_runner_startup_snapshot();
    let startup_operations: Vec<_> = operations
        .iter()
        .filter(|operation| operation.action_type == "api_to_spawn")
        .collect();
    let [operation] = startup_operations.as_slice() else {
        panic!("expected one api_to_spawn operation, got {operations:?}");
    };
    assert_eq!(operation.runner_startup_path, Some(expected_path));
    assert_eq!(operation.sandbox_reuse_result, Some(expected_reuse_result));
}

fn set_reuse_and_session_identity(
    context: &mut runner_types::types::ExecutionContext,
    session_id: &str,
) {
    context.reuse_key = Some(format!("thread:home-cache-{session_id}"));
    context.native_continuation = Some(guest_contracts::env::NativeContinuation {
        session_id: Some(session_id.into()),
        generation_run_id: Some(context.run_id.to_string()),
        recovery_prompt: None,
    });
}

#[tokio::test]
async fn invalid_storage_preparation_preserves_the_selected_home_for_the_next_run() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(overrides.clone());
    let mut context = minimal_context();
    let session = "unused-home-preflight";
    set_reuse_and_session_identity(&mut context, session);
    let seed = seed_home_image_cache(&cache, &paths, session, 16).await;
    let metadata = seed.parent().unwrap().join("metadata.json");
    let original = tokio::fs::read(&metadata).await.unwrap();
    let mut artifact = api_artifact(
        "memory",
        "/home/user/data",
        "storage-id",
        "v1",
        "https://archive.invalid/unused",
    );
    artifact.archive_url = None;
    context.storage_manifest = Some(StorageManifest {
        storages: Vec::new(),
        artifacts: vec![artifact],
    });
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let mut telemetry = test_telemetry(&config, &context);
    let result = execute_new_sandbox(
        &factory,
        &context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;
    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("missing archiveUrl")
    );
    assert!(overrides.create_configs().is_empty());
    assert_eq!(tokio::fs::read(metadata).await.unwrap(), original);
    assert!(seed.is_file());
    let next = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                rootfs_hash: &params.rootfs_hash,
                reuse_key: context.reuse_key(),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: 16 * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert!(next.is_cache_hit());
    assert_eq!(
        next.source_identity().unwrap().image_generation,
        seed.file_stem()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix("image-")
            .unwrap()
    );
}

#[tokio::test]
async fn rejected_seed_handoff_rebuilds_current_storage_before_one_fresh_create() {
    use crate::home_image_cache::HomeImageHandoffTestGate;
    use guest_contracts::home_cache_history::{
        HomeCacheHistoryProof, HomeCacheHistoryProofBinding,
    };
    use guest_contracts::session_history_identity::{
        SessionHistoryIdentity, SessionHistorySourceRef,
    };

    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(paths.clone());
    let gate = HomeImageHandoffTestGate::default();
    let _release = gate.release_on_drop();
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone().with_handoff_test_gate(gate.clone()));
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(overrides.clone());
    let server = MockServer::start_async().await;
    let archive = storage_archive(b"current-storage");
    let archive_get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/storage.tar.gz")
                .header_missing("range");
            then.status(200).body(archive.clone());
        })
        .await;
    let history = br#"{"type":"init"}"#;
    let mut context = minimal_context();
    let session = "seed-handoff-changed";
    set_reuse_and_session_identity(&mut context, session);
    let mut storage = api_storage(
        "current-storage",
        "/home/user/workspace/data",
        "v1",
        &server.url("/storage.tar.gz"),
    );
    storage.archive_size = Some(archive.len() as u64);
    let manifest = StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    };
    let fingerprints = crate::storage_fingerprints::StorageFingerprints::from_manifest(&manifest);
    context.storage_manifest = Some(manifest);
    let seed =
        seed_home_image_cache_with_fingerprints(&cache, &paths, session, 16, &fingerprints).await;
    let generation = seed
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap()
        .strip_prefix("image-")
        .unwrap();
    let identity = SessionHistoryIdentity::new(
        guest_contracts::session_history_identity::SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session.as_bytes())),
        guest_contracts::session_history_identity::SessionHistoryRefKind::LocalHome,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: "/home/user/.claude".into(),
            working_dir: CANONICAL_WORKING_DIR.into(),
            session_id: session.into(),
        },
    )
    .unwrap();
    let proof = HomeCacheHistoryProof {
        format_version: 1,
        generation: generation.into(),
        identity,
    };
    let binding = HomeCacheHistoryProofBinding {
        sha256: hex::encode(Sha256::digest(proof.to_json_vec().unwrap())),
        proof,
    };
    // A current-format fixture commit containing both derived-input candidates.
    let metadata_path = seed.parent().unwrap().join("metadata.json");
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&metadata_path).await.unwrap()).unwrap();
    metadata["historyProof"] = serde_json::to_value(binding).unwrap();
    tokio::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
        .await
        .unwrap();
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let mut telemetry = test_telemetry(&config, &context);
    let execution = execute_new_sandbox_with_prepared_notifier(
        &factory,
        &context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        NewSandboxHooks {
            preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
            controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepared_run_payload: prepare_run_payload_for_run(&context).unwrap(),
            sandbox_prepared: None,
        },
    );
    let replace_seed = async {
        gate.wait_entered(RUN_IN_SANDBOX_TEST_TIMEOUT).await;
        archive_get.assert_calls_async(0).await;
        tokio::fs::rename(&seed, dir.path().join("selected-original.ext4"))
            .await
            .unwrap();
        tokio::fs::File::create(&seed)
            .await
            .unwrap()
            .set_len(16 * 1024 * 1024)
            .await
            .unwrap();
        gate.release();
    };
    let (outcome, ()) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        tokio::join!(execution, replace_seed)
    })
    .await
    .expect("seed replacement must finish through the existing bounded fallback");
    let outcome = outcome.unwrap();
    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.home_image.is_none());
    let configs = overrides.create_configs();
    assert_eq!(
        configs.len(),
        1,
        "rejected handoff must not create a seeded VM"
    );
    assert!(configs[0].home_drive.as_ref().unwrap().seed_image.is_none());
    let calls = overrides.storage_manifest_calls();
    assert_eq!(calls.len(), 1);
    let applied: guest_contracts::storage_manifest::Manifest =
        serde_json::from_slice(&calls[0].manifest_json).unwrap();
    assert_eq!(applied.storages.len(), 1);
    assert!(
        !applied.storages[0].cached,
        "fresh storage cannot use the old seed's fingerprint shortcut"
    );
    assert_eq!(applied.storages[0].vas_version_id.as_deref(), Some("v1"));
    archive_get.assert_calls_async(1).await;
    assert!(
        !overrides
            .exec_calls()
            .iter()
            .any(|call| call.cmd.contains("verify-home-cache-history"))
    );
    assert_home_fallback(&telemetry, context.run_id, "home_preparation_failed");
    config.background_fill.shutdown().await;
    config.decoded_cache.shutdown().await;
}

#[tokio::test]
async fn home_mount_retry_starts_a_new_codex_catalog_prefetch_owner() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let recorded = runner_storage::operation_test_support::RecordedHomeObservations::default();
    let cache = HomeImageCache::new(runner_paths.clone()).with_telemetry(recorded.handle());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_home_drive_mount_result(Ok(ExecResult::new(
        64,
        Vec::new(),
        b"cached mount denied".to_vec(),
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = codex_oauth_context();
    let session_id = "00000000-0000-4000-8000-000000023425";
    set_reuse_and_session_identity(&mut ctx, session_id);
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    seed_home_image_cache(&cache, &runner_paths, session_id, 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.home_image.is_none());
    assert_eq!(overrides.create_configs().len(), 2);
    let facts = telemetry.pending_home_snapshot();
    assert_eq!(
        facts
            .iter()
            .filter(|fact| fact.kind
                == runner_host::home_observation::HomeObservationKind::Consumption
                && fact.outcome == runner_host::home_observation::HomeObservationOutcome::Failed)
            .count(),
        1,
    );
    assert!(facts.iter().any(|fact| fact.kind
        == runner_host::home_observation::HomeObservationKind::Consumption
        && fact.outcome == runner_host::home_observation::HomeObservationOutcome::Fallback
        && fact.run_id == Some(ctx.run_id)
        && fact.image_generation.is_some()));
    assert_eq!(overrides.destroy_call_count(), 1);
    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 2);
    assert!(start_calls[0].cmd.contains("codex --version"));
    assert!(start_calls[1].cmd.contains("codex --version"));
    let agent_calls = overrides.start_agent_process_calls();
    assert_eq!(agent_calls.len(), 1);
    assert_eq!(
        telemetry
            .pending_ops_snapshot()
            .iter()
            .filter(|(action, _, _)| action == "runner_codex_model_catalog_prefetch")
            .count(),
        2
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn post_write_prefetch_failure_replaces_consumed_cache_hit_with_fresh_home() {
    for start_error in [
        SandboxError::OperationTimeout {
            operation: sandbox::SandboxOperation::StartProcess,
            stage: sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse,
            timeout_ms: 1_000,
        },
        SandboxError::OperationWrite {
            operation: sandbox::SandboxOperation::StartProcess,
            stage: sandbox::SandboxOperationWriteStage::FrameWrite,
            source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "partial write"),
        },
    ] {
        let dir = tempfile::tempdir().unwrap();
        let runner_paths = RunnerPaths::new(dir.path().join("runner"));
        let recorded = RecordedHomeObservations::default();
        let cache = HomeImageCache::new(runner_paths.clone()).with_telemetry(recorded.handle());
        let mut config = test_executor_config(dir.path()).await;
        config.home_cache = Some(cache.clone());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_start_process_error(start_error);
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut context = codex_oauth_context();
        let session_id = "00000000-0000-4000-8000-000000032219";
        set_reuse_and_session_identity(&mut context, session_id);
        let params = JobParams {
            home_disk_mb: 16,
            ..default_params()
        };
        let expected_seed = seed_home_image_cache(&cache, &runner_paths, session_id, 16).await;
        let mut telemetry = test_telemetry(&config, &context);

        let outcome = execute_new_sandbox(
            &factory,
            &context,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.exit_code(), 0);
        assert!(outcome.home_image.is_none());
        assert!(
            telemetry
                .pending_ops_with_runner_startup_snapshot()
                .iter()
                .any(|op| {
                    op.action_type == "runner_agent_start_to_ready"
                        && op.runner_startup_path == Some(RunnerStartupPath::Cold)
                })
        );
        let configs = overrides.create_configs();
        assert_eq!(configs.len(), 2);
        assert_eq!(
            configs[0].home_drive,
            Some(sandbox::HomeDriveConfig {
                space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
                size_mb: 16,
                seed_image: Some(sandbox::HomeDriveSeedImage::Move(expected_seed.clone(),)),
            })
        );
        assert_eq!(
            configs[1].home_drive,
            Some(sandbox::HomeDriveConfig {
                space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
                size_mb: 16,
                seed_image: None,
            })
        );
        assert!(!expected_seed.exists());
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(overrides.start_process_calls().len(), 1);
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
        assert_eq!(
            telemetry
                .pending_ops_snapshot()
                .iter()
                .filter(|(action, _, _)| action == "runner_codex_model_catalog_prefetch")
                .count(),
            1
        );
        assert_telemetry_action(
            &telemetry,
            "runner_fresh_sandbox_retry_without_codex_prefetch",
            true,
            None,
        );
        assert_home_fallback(&telemetry, context.run_id, "codex_prefetch_replacement");
        assert_proxy_registry_empty(dir.path()).await;
    }
}

#[tokio::test]
async fn execute_inner_retries_fresh_after_home_cache_hit_create_failure() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let recorded = RecordedHomeObservations::default();
    let cache = HomeImageCache::new(runner_paths.clone()).with_telemetry(recorded.handle());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_create_result(Err(sandbox_create_error("bad seed image")));
    let create_gate = MockLifecycleGate::new();
    overrides.set_create_lifecycle_gate(create_gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let server = httpmock::MockServer::start_async().await;
    let body = storage_archive(b"home retry archive");
    let full_get = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/home-retry.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let mut ctx = minimal_context();
    let mut storage = api_storage(
        "home-retry",
        "/data",
        "v1",
        &server.url("/home-retry.tar.gz"),
    );
    storage.archive_size = Some(body.len() as u64);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    set_reuse_and_session_identity(&mut ctx, "sess-cache-hit");
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let expected_seed = seed_home_image_cache(&cache, &runner_paths, "sess-cache-hit", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let execution = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    );
    let admission = async {
        create_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while full_get.calls_async().await == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first archive owner should request before create failure");
        create_gate.release_one();
        create_gate
            .wait_entered(2, Duration::from_secs(5))
            .await
            .unwrap();
        create_gate.release_one();
    };
    let (outcome, ()) = tokio::join!(execution, admission);
    let outcome = outcome.unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.home_image.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[0].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 16,
            seed_image: Some(sandbox::HomeDriveSeedImage::Move(expected_seed.clone(),)),
        })
    );
    assert_eq!(
        configs[1].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(
        !expected_seed.exists(),
        "failed cache hit should invalidate the unusable baseline"
    );

    assert_telemetry_action(&telemetry, "runner_fresh_home_image_prepare", true, None);
    assert_home_fallback(&telemetry, ctx.run_id, "home_preparation_failed");
    let factory_create_outcomes =
        telemetry_action_outcomes(&telemetry, "runner_fresh_sandbox_factory_create");
    assert_eq!(
        factory_create_outcomes,
        vec![
            (false, Some("sandbox_factory_create_failed".into())),
            (true, None)
        ]
    );
    assert!(
        (1..=2).contains(&full_get.calls_async().await),
        "the cancelled owner may be stopped before its request reaches the fixture"
    );
    let ops = telemetry.pending_ops_snapshot();
    assert_eq!(
        ops.iter()
            .filter(|(action, _, _)| action == "storage_cache_fresh_delivery_single_request")
            .count(),
        2,
        "home fallback must replace, not retain, the old owner: {ops:?}"
    );
    assert!(ops.iter().any(|(action, success, _)| {
        action == "storage_cache_fresh_delivery_drained" && *success
    }));
}

#[tokio::test]
async fn execute_inner_dns_readiness_retry_replaces_consumed_home_cache_hit() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let recorded = RecordedHomeObservations::default();
    let cache = HomeImageCache::new(runner_paths.clone()).with_telemetry(recorded.handle());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::GuestDnsReadiness {
        reason: SandboxGuestDnsReadinessReason::DnsPath,
        message: "first attachment failed".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, "sess-cache-dns-retry");
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_home_image_cache(&cache, &runner_paths, "sess-cache-dns-retry", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_sandbox_run_events(execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    ))
    .await;
    let outcome = outcome.unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.home_image.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[0].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 16,
            seed_image: Some(sandbox::HomeDriveSeedImage::Move(expected_seed.clone(),)),
        })
    );
    assert_eq!(
        configs[1].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(!expected_seed.exists());
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
    assert_home_fallback(&telemetry, ctx.run_id, "guest_dns_replacement");
    let completion = captured_events_named(&events, "guest DNS readiness replacement completed");
    assert_eq!(completion.len(), 1, "events={events:#?}");
    assert_captured_field(completion[0], "success", "true");
    assert_captured_field(completion[0], "home_fallback", "true");
}

#[tokio::test]
async fn process_timeout_invalidates_consumed_home_cache_without_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let recorded = RecordedHomeObservations::default();
    let cache = HomeImageCache::new(runner_paths.clone()).with_telemetry(recorded.handle());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::GuestDnsReadiness {
        reason: SandboxGuestDnsReadinessReason::ProcessTimeout,
        message: "guest process timed out".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let session_id = "sess-cache-dns-process-timeout";
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id);
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_home_image_cache(&cache, &runner_paths, session_id, params.home_disk_mb).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = result
        .err()
        .expect("guest process timeout must be returned");
    assert!(
        error.to_string().contains("guest process timed out"),
        "got: {error}"
    );
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: params.home_disk_mb,
            seed_image: Some(sandbox::HomeDriveSeedImage::Move(expected_seed.clone(),)),
        })
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_process_calls().is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(!expected_seed.exists());
    assert_no_telemetry_action(&telemetry, "runner_fresh_sandbox_dns_readiness_retry");
    let consumption = consumption_facts(&telemetry);
    assert_eq!(consumption.len(), 1);
    assert_eq!(consumption[0].outcome, HomeOutcome::Failed);
    assert_eq!(consumption[0].run_id, Some(ctx.run_id));
    assert_eq!(
        consumption[0].reason.as_deref(),
        Some("sandbox_prepare_failed")
    );

    let checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                rootfs_hash: "test-rootfs",
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:home-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.home_disk_mb) * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), HomeCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn dns_replacement_storage_classification_failure_prevents_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::GuestDnsReadiness {
        reason: SandboxGuestDnsReadinessReason::DnsPath,
        message: "first attachment failed".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let mount_path = format!("{CANONICAL_WORKING_DIR}/data");
    let mut manifest = StorageManifest {
        storages: vec![api_storage(
            "dns-retry-storage",
            &mount_path,
            "v1",
            "https://storage.example/archive.tar.gz",
        )],
        artifacts: Vec::new(),
    };
    manifest.storages[0].archive_size = Some(1);
    let storage_fingerprints =
        crate::storage_fingerprints::StorageFingerprints::from_manifest(&manifest);
    ctx.storage_manifest = Some(manifest);
    set_reuse_and_session_identity(&mut ctx, "sess-cache-dns-prepare-failure");
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    seed_home_image_cache_with_fingerprints(
        &cache,
        &runner_paths,
        "sess-cache-dns-prepare-failure",
        16,
        &storage_fingerprints,
    )
    .await;
    tokio::fs::write(config.home.locks_dir(), b"not a directory")
        .await
        .unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (result, events) = capture_sandbox_run_events(execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    ))
    .await;

    let outcome = result.unwrap();
    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.failure.unwrap().error.contains("lock dir"));
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.create_configs().len(), 2,);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_dns_readiness_retry",
        true,
        None,
    );
    let completion = captured_events_named(&events, "guest DNS readiness replacement completed");
    assert_eq!(completion.len(), 1, "events={events:#?}");
    assert_captured_field(completion[0], "success", "true");
    assert_captured_field(completion[0], "home_fallback", "true");
}

#[tokio::test]
async fn execute_inner_cache_hit_retry_requires_completed_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let recorded = runner_storage::operation_test_support::RecordedHomeObservations::default();
    let cache = HomeImageCache::new(runner_paths.clone()).with_telemetry(recorded.handle());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::Start {
        message: "start failed".into(),
    }));
    overrides.push_destroy_panic("simulated destroy panic");
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, "sess-cache-cleanup-uncertain");
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let _seed =
        seed_home_image_cache(&cache, &runner_paths, "sess-cache-cleanup-uncertain", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    let error = result
        .err()
        .expect("uncertain cleanup must preserve the first preparation failure");
    assert!(error.to_string().contains("start failed"));
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    let consumption: Vec<_> = telemetry
        .pending_home_snapshot()
        .into_iter()
        .filter(|fact| fact.kind == runner_host::home_observation::HomeObservationKind::Consumption)
        .collect();
    assert_eq!(consumption.len(), 1);
    assert_eq!(
        consumption[0].outcome,
        runner_host::home_observation::HomeObservationOutcome::Failed,
    );
    assert_eq!(consumption[0].run_id, Some(ctx.run_id));
    assert!(consumption[0].image_generation.is_some());
    assert_eq!(consumption[0].reason.as_deref(), Some("cleanup_uncertain"));
}

#[tokio::test]
async fn fresh_home_policy_skips_cached_bytes_and_never_enters_lock_retry() {
    for busy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = HomeImageCache::new(paths.clone());
        let retry = HomeImagePrepareLockTestGate::default();
        let mut config = test_executor_config(dir.path()).await;
        config.home_cache = Some(cache.clone().with_prepare_lock_test_gate(retry.clone()));
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(overrides.clone());
        let mut context = minimal_context();
        let session = "no-hint-home-policy";
        set_reuse_and_session_identity(&mut context, session);
        context.native_continuation = None;
        context.is_first_run = Some(true);
        let params = JobParams {
            home_disk_mb: 16,
            home_image_prepare_policy: HomeImagePreparePolicy::SkipCache,
            ..default_params()
        };
        let seed = seed_home_image_cache(&cache, &paths, session, 16).await;
        let metadata = seed.parent().unwrap().join("metadata.json");
        let original = tokio::fs::read(&metadata).await.unwrap();
        let key = scoped_home_image_cache_key(
            "",
            &params.profile_name,
            context.reuse_key().unwrap(),
            u64::from(params.home_disk_mb) * 1024 * 1024,
        );
        let lock = if busy {
            Some(
                runner_host::lock::acquire(runner_host::paths::home_image_cache_lock_path(
                    &paths.base_dir().join("locks"),
                    &key,
                ))
                .await
                .unwrap(),
            )
        } else {
            None
        };
        let mut telemetry = test_telemetry(&config, &context);
        let execution = execute_new_sandbox(
            &factory,
            &context,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        );
        tokio::pin!(execution);
        let outcome = tokio::select! {
            result = &mut execution => result.unwrap(),
            () = retry.wait_entered(RUN_IN_SANDBOX_TEST_TIMEOUT) => {
                panic!("a fresh start must not wait for the old Home entry lock");
            }
        };
        assert_eq!(outcome.exit_code(), 0);
        let created = overrides.create_configs();
        assert_eq!(created.len(), 1);
        assert!(created[0].home_drive.as_ref().unwrap().seed_image.is_none());
        assert_eq!(tokio::fs::read(&metadata).await.unwrap(), original);
        assert!(seed.exists());
        drop(outcome);
        drop(lock);
    }
}

#[tokio::test]
async fn execute_inner_waits_for_transient_home_cache_lock() {
    const LOCK_CONTENTION_WATCHDOG: Duration = Duration::from_secs(1);

    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let prepare_lock_gate = HomeImagePrepareLockTestGate::default();
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(
        cache
            .clone()
            .with_prepare_lock_test_gate(prepare_lock_gate.clone()),
    );
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-transient-lock";
    set_reuse_and_session_identity(&mut ctx, session_id);
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let seeded_cache = seed_home_image_cache(&cache, &runner_paths, session_id, 16).await;
    let cache_key = scoped_home_image_cache_key(
        "",
        &params.profile_name,
        &format!("thread:home-cache-{session_id}"),
        u64::from(params.home_disk_mb) * 1024 * 1024,
    );
    let held_lock = runner_host::lock::acquire(runner_host::paths::home_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    ))
    .await
    .unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = {
        let outcome = tokio::time::timeout(
            RUN_IN_SANDBOX_TEST_TIMEOUT,
            execute_new_sandbox(
                &factory,
                &ctx,
                NewSandboxDispatch {
                    id: SandboxId::new_v4(),
                    reuse_result: SandboxReuseResult::PoolMiss,
                },
                &config,
                &params,
                &mut telemetry,
                tokio_util::sync::CancellationToken::new(),
            ),
        );
        tokio::pin!(outcome);
        tokio::select! {
            () = prepare_lock_gate.wait_entered(LOCK_CONTENTION_WATCHDOG) => {}
            _ = &mut outcome => panic!("sandbox execution ended before home cache lock contention"),
        }
        drop(held_lock);
        prepare_lock_gate.release();
        outcome
            .await
            .expect("transient home lock wait should remain bounded")
            .unwrap()
    };

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.home_image.is_some());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 16,
            seed_image: Some(sandbox::HomeDriveSeedImage::Move(seeded_cache)),
        })
    );

    assert_telemetry_action(&telemetry, "runner_fresh_home_image_prepare", true, None);
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_proxy_register",
        true,
        None,
    );
    assert_telemetry_action(&telemetry, "runner_fresh_sandbox_start", true, None);
}

#[tokio::test]
async fn actual_startup_correlates_the_consumed_generation_but_not_a_discarded_candidate() {
    for fresh_retry in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let runner_paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = HomeImageCache::new(runner_paths.clone());
        let (mut config, server) = test_executor_config_with_startup_api(dir.path()).await;
        config.home_cache = Some(cache.clone());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        if fresh_retry {
            overrides.push_create_result(Err(sandbox_create_error("unusable home seed")));
        }
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut ctx = minimal_context();
        ctx.is_first_run = Some(false);
        let session_id = "sess-source-identity";
        set_reuse_and_session_identity(&mut ctx, session_id);
        let params = JobParams {
            home_disk_mb: 16,
            ..default_params()
        };
        let seed = seed_home_image_cache(&cache, &runner_paths, session_id, 16).await;
        let generation = seed
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix("image-")
            .unwrap()
            .strip_suffix(".ext4")
            .unwrap();
        let cache_key = seed
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let startup = server
            .mock_async(|when, then| {
                let when = when
                    .method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .body_includes("runner_sandbox_startup")
                    .body_includes(ctx.run_id.to_string())
                    .body_includes(r#""is_first_run":false"#);
                if fresh_retry {
                    when.body_includes(r#""runner_startup_path":"cold""#)
                        .body_excludes("image_generation")
                        .body_excludes("cache_key");
                } else {
                    when.body_includes(r#""runner_startup_path":"home""#)
                        .body_includes(generation)
                        .body_includes(cache_key)
                        .body_includes(r#""profile_name":"vm0/default""#);
                }
                then.status(200)
                    .json_body(serde_json::json!({"success": true}));
            })
            .await;
        let batch = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/agent/telemetry")
                    .body_excludes("runner_sandbox_startup");
                then.status(200)
                    .json_body(serde_json::json!({"success": true}));
            })
            .await;
        let mut telemetry = test_telemetry(&config, &ctx);
        telemetry.set_first_run(ctx.is_first_run);
        let mut outcome = execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(outcome.exit_code(), 0);
        assert_eq!(
            outcome.home_reuse_result == Some(HomeReuseResult::Reused),
            !fresh_retry
        );
        assert_eq!(
            overrides.create_configs().len(),
            if fresh_retry { 2 } else { 1 }
        );
        outcome.startup_report.take().unwrap().finish().await;
        telemetry.flush().await;
        startup.assert_calls_async(1).await;
        batch.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn execute_inner_immediate_lock_policy_still_consumes_available_cache() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-immediate-lock-policy";
    set_reuse_and_session_identity(&mut ctx, session_id);
    let params = JobParams {
        home_disk_mb: 16,
        home_image_prepare_policy: HomeImagePreparePolicy::TryCacheWithoutLockWait,
        ..default_params()
    };
    let seeded_cache = seed_home_image_cache(&cache, &runner_paths, session_id, 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(outcome.home_reuse_result, Some(HomeReuseResult::Reused),);
    assert!(
        telemetry
            .pending_ops_with_runner_startup_snapshot()
            .iter()
            .any(|op| {
                op.action_type == "runner_agent_start_to_ready"
                    && op.runner_startup_path == Some(RunnerStartupPath::Home)
            })
    );
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 16,
            seed_image: Some(sandbox::HomeDriveSeedImage::Move(seeded_cache)),
        })
    );
}

#[tokio::test]
async fn execute_inner_records_home_cache_lock_busy_prepare_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-lock-busy-prepare";
    set_reuse_and_session_identity(&mut ctx, session_id);
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let cache_key = scoped_home_image_cache_key(
        "",
        &params.profile_name,
        &format!("thread:home-cache-{session_id}"),
        u64::from(params.home_disk_mb) * 1024 * 1024,
    );
    let _held_lock = runner_host::lock::acquire(runner_host::paths::home_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    ))
    .await
    .unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        ),
    )
    .await
    .expect("persistent home lock wait should remain bounded")
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    let configs = overrides.create_configs();
    assert_eq!(outcome.home_reuse_result, Some(HomeReuseResult::LockBusy),);
    assert!(
        telemetry
            .pending_ops_with_runner_startup_snapshot()
            .iter()
            .any(|op| {
                op.action_type == "runner_agent_start_to_ready"
                    && op.runner_startup_path == Some(RunnerStartupPath::Cold)
            })
    );
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 16,
            seed_image: None,
        })
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_home_image_prepare",
        false,
        Some("home_image_prepare_lock_busy"),
    );
    assert_telemetry_action(&telemetry, "runner_home_image_consumption", true, None);
    assert!(telemetry.pending_ops_with_outcome_snapshot().contains(&(
        "runner_home_image_consumption".into(),
        true,
        Some("busy".into()),
        Some("unknown".into()),
    )));
}

#[tokio::test]
async fn execute_inner_logs_home_cache_lock_error_separately() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    let session_id = "sess-cache-lock-error-prepare";
    set_reuse_and_session_identity(&mut ctx, session_id);
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let cache_key = scoped_home_image_cache_key(
        "",
        &params.profile_name,
        &format!("thread:home-cache-{session_id}"),
        u64::from(params.home_disk_mb) * 1024 * 1024,
    );
    let lock_path = runner_host::paths::home_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    );
    tokio::fs::create_dir_all(lock_path.parent().unwrap())
        .await
        .unwrap();
    let lock_target = dir.path().join("lock-target");
    tokio::fs::write(&lock_target, b"not a lock").await.unwrap();
    std::os::unix::fs::symlink(lock_target, lock_path).unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let (outcome, events) = capture_sandbox_run_events(tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        execute_new_sandbox(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            tokio_util::sync::CancellationToken::new(),
        ),
    ))
    .await;
    let outcome = outcome
        .expect("home lock errors should return without waiting for the contention timeout")
        .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].home_drive,
        Some(sandbox::HomeDriveConfig {
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
            size_mb: 16,
            seed_image: None,
        })
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_home_image_prepare",
        false,
        Some("home_image_prepare_lock_busy"),
    );
    assert!(telemetry.pending_ops_with_outcome_snapshot().contains(&(
        "runner_home_image_consumption".into(),
        true,
        Some("unavailable".into()),
        None,
    )));
    let errors = captured_events_named(
        &events,
        "home image cache lock unavailable; using fresh home image",
    );
    assert_eq!(errors.len(), 1, "events={events:#?}");
    assert!(errors[0].fields.contains_key("error"));
    assert!(
        captured_events_named(
            &events,
            "home image cache lock remained busy; using fresh home image",
        )
        .is_empty(),
        "events={events:#?}"
    );
}

#[tokio::test]
async fn execute_inner_does_not_retry_home_cache_hit_after_proxy_register_failure() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let create_gate = MockLifecycleGate::new();
    overrides.set_create_lifecycle_gate(create_gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, "sess-register-fail");
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let expected_seed = seed_home_image_cache(
        &cache,
        &runner_paths,
        "sess-register-fail",
        params.home_disk_mb,
    )
    .await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        let execution = execute_new_sandbox_with_prepared_notifier(
            &factory,
            &ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &params,
            &mut telemetry,
            NewSandboxHooks {
                preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
                controls: RunControls::new(tokio_util::sync::CancellationToken::new(), None),
                prepared_run_payload: prepare_run_payload_for_run(&ctx).unwrap(),
                sandbox_prepared: None,
            },
        );
        tokio::pin!(execution);
        tokio::select! {
            _ = &mut execution => panic!("execution escaped the create gate before sandbox creation"),
            () = async {
                create_gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
                    .await.expect("sandbox create must enter its gate");
            } => {}
        }
        create_gate.release_one();
        execution.await
    })
    .await
    .expect("proxy registration failure must finish cleanup");

    assert!(
        result.is_err(),
        "proxy registration failure must return an error"
    );
    let err = result.err().unwrap();
    assert!(
        err.to_string()
            .contains("register sandbox in proxy registry"),
        "got: {err}"
    );
    assert_eq!(
        overrides.create_configs().len(),
        1,
        "proxy registration failure must not retry with a fresh home image"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "agent must not start when proxy registry registration fails"
    );
    assert!(
        expected_seed.exists(),
        "proxy registration failure must not invalidate the unrelated home cache hit"
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "runner_fresh_sandbox_proxy_register",
        false,
        Some("sandbox_proxy_register_failed"),
    );
}

#[tokio::test]
async fn execute_job_reuse_uses_home_cache_when_configured() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths);
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-default";
    let factory = MockSandboxFactory::new();
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            home_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let (idle_sandbox, _lease) = make_reusable_idle_sandbox(sandbox, source_ip, session_id).await;

    let mut ctx = minimal_context();
    ctx.is_first_run = Some(false);
    let run_id = ctx.run_id;
    enable_api_start_telemetry(&mut ctx);
    set_reuse_and_session_identity(&mut ctx, session_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.home_image.is_some());
    let fact = reuse_outcome
        .home_image
        .as_ref()
        .unwrap()
        .consumption_observation(Some(run_id), HomeOutcome::Retained, Some("reuse"));
    assert_eq!(fact.is_first_run, Some(false));
    assert_eq!(
        reuse_outcome.home_reuse_result,
        Some(HomeReuseResult::SandboxReused),
    );
    assert_api_to_spawn_path(
        &telemetry,
        RunnerStartupPath::Sandbox,
        SandboxReuseResult::Reused,
    );

    let checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                rootfs_hash: "test-rootfs",
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:home-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.home_disk_mb) * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), HomeCacheCheckoutResult::LockBusy);
}

#[tokio::test]
async fn cached_reuse_home_promotion_identity_mismatch_stops_before_agent() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let promotion_params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let current_params = JobParams {
        home_disk_mb: 32,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-identity-mismatch";
    let (idle_sandbox, current_image, overrides) = reusable_idle_sandbox_with_home_promotion(
        &cache,
        &runner_paths,
        &promotion_params,
        session_id,
    )
    .await;

    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &current_params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.home_image.is_none());
    let error = reuse_outcome.error().expect("error should be set");
    assert!(error.contains("home promotion identity mismatch"));
    assert!(!error.contains(session_id));
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "agent must not start after home promotion identity mismatch"
    );
    assert!(
        !current_image.exists(),
        "identity mismatch must explicitly abandon the consumed cache hit"
    );
    let checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                rootfs_hash: "test-rootfs",
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &promotion_params.profile_name,
                reuse_key: Some(&format!("thread:home-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(promotion_params.home_disk_mb) * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), HomeCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn execute_job_reuse_without_home_cache_config_invalidates_held_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse";
    let (idle_sandbox, _current_image, _overrides) =
        reusable_idle_sandbox_with_home_promotion(&cache, &runner_paths, &params, session_id).await;

    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);

    let checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                rootfs_hash: "test-rootfs",
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:home-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.home_disk_mb) * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), HomeCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn unconfigured_cache_reuse_stops_when_cache_invalidation_fails() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse-invalidate-error";
    let (idle_sandbox, _generation_image, overrides) =
        reusable_idle_sandbox_with_home_promotion(&cache, &runner_paths, &params, session_id).await;
    let cache_key = scoped_home_image_cache_key(
        "",
        &params.profile_name,
        &format!("thread:home-cache-{session_id}"),
        u64::from(params.home_disk_mb) * 1024 * 1024,
    );
    // Exercise failure for a consumed generation, not a miss that preserves
    // the older committed baseline. A parent loop causes deterministic ELOOP
    // without relying on permissions or a retired fixed image path.
    let entry_dir = cache.entry_paths(&cache_key).entry_dir().to_path_buf();
    let cache_parent = entry_dir.parent().unwrap();
    let displaced_parent = runner_paths.base_dir().join("owned-displaced-home-cache");
    tokio::fs::rename(cache_parent, &displaced_parent)
        .await
        .unwrap();
    std::os::unix::fs::symlink(cache_parent, cache_parent).unwrap();

    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, session_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    tokio::fs::remove_file(cache_parent).await.unwrap();
    tokio::fs::rename(&displaced_parent, cache_parent)
        .await
        .unwrap();
    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(
        reuse_outcome
            .error()
            .unwrap()
            .contains("failed to invalidate home image cache before unconfigured-cache reuse")
    );
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| call.cmd.contains("prepare-for-reuse")),
        "reused sandbox must not run after stale cache invalidation fails"
    );
}

#[tokio::test]
async fn cached_reuse_validation_failure_keeps_home_cache_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths.clone()).with_first_run(Some(true));
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-validation-failure";
    let (idle_sandbox, _current_image, overrides) =
        reusable_idle_sandbox_with_home_promotion(&cache, &runner_paths, &params, session_id).await;

    let mut ctx = minimal_context();
    ctx.is_first_run = Some(false);
    let run_id = ctx.run_id;
    set_reuse_and_session_identity(&mut ctx, session_id);
    ctx.environment = Some(HashMap::from([(
        "OPENAI_API_KEY".into(),
        "sk-proj-real-openai-secret".into(),
    )]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.home_image.is_some());
    let fact = reuse_outcome
        .home_image
        .as_ref()
        .unwrap()
        .consumption_observation(Some(run_id), HomeOutcome::Retained, Some("reuse"));
    assert_eq!(
        fact.is_first_run,
        Some(false),
        "current Run replaces the producer's first-run flag"
    );
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after env validation failure"
    );

    let checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                rootfs_hash: "test-rootfs",
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:home-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.home_disk_mb) * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        HomeCacheCheckoutResult::LockBusy,
        "pre-run validation failure must not release the hidden cache baseline before finalization can promote or invalidate the live home"
    );
}

#[tokio::test]
async fn cached_reuse_invalid_resume_session_keeps_existing_home_cache_hidden() {
    for is_first_run in [Some(false), None] {
        assert_invalid_resume_session_publication_attribution(is_first_run).await;
    }
}

async fn assert_invalid_resume_session_publication_attribution(is_first_run: Option<bool>) {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let recorded = RecordedHomeObservations::default();
    let cache = HomeImageCache::new(runner_paths.clone())
        .with_first_run(Some(true))
        .with_telemetry(recorded.handle());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-invalid-resume";
    let (idle_sandbox, _current_image, overrides) =
        reusable_idle_sandbox_with_home_promotion(&cache, &runner_paths, &params, session_id).await;

    let raw_session_id = "../invalid-resume";
    let mut ctx = minimal_context();
    ctx.is_first_run = is_first_run;
    let run_id = ctx.run_id;
    set_reuse_and_session_identity(&mut ctx, raw_session_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(raw_session_id));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.home_image.is_some());
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after resume session validation failure"
    );

    let checkout = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                rootfs_hash: "test-rootfs",
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: &params.profile_name,
                reuse_key: Some(&format!("thread:home-cache-{session_id}")),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.home_disk_mb) * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        HomeCacheCheckoutResult::LockBusy,
        "invalid resume sessions must not release the hidden cache baseline before finalization can promote or invalidate the live home"
    );
    assert!(
        !reuse_outcome
            .home_image
            .unwrap()
            .promote(
                run_id,
                HomeCacheTerminalStatus::NonzeroExit,
                "2026-06-01T00:00:02.000Z".into(),
                &crate::storage_fingerprints::StorageFingerprints::default(),
            )
            .await
            .unwrap(),
        "the mock sandbox has no new live image to publish"
    );
    let publication: Vec<_> = recorded
        .events()
        .into_iter()
        .filter(|fact| fact.kind == HomeKind::Publication && fact.run_id == Some(run_id))
        .collect();
    assert_eq!(publication.len(), 1);
    assert_eq!(publication[0].outcome, HomeOutcome::Skipped);
    assert_eq!(publication[0].reason.as_deref(), Some("source_unavailable"));
    assert_eq!(
        publication[0].is_first_run, is_first_run,
        "early validation failure must not attribute this Run to the previous producer"
    );
}

#[tokio::test]
async fn cached_reuse_invalid_resume_session_without_promotion_skips_home_lease() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(runner_paths);
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache);
    let params = JobParams {
        home_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-invalid-resume-no-promotion";
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            home_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let (idle_sandbox, _lease) = make_reusable_idle_sandbox(sandbox, source_ip, session_id).await;

    let raw_session_id = "../invalid-resume";
    let mut ctx = minimal_context();
    set_reuse_and_session_identity(&mut ctx, raw_session_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(raw_session_id));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.home_image.is_none());
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after resume session validation failure"
    );
}

async fn reusable_idle_sandbox_with_home_promotion(
    cache: &HomeImageCache,
    runner_paths: &RunnerPaths,
    params: &JobParams,
    session_id: &str,
) -> (
    crate::idle_pool::ReusableIdleSandbox,
    PathBuf,
    Arc<sandbox_mock::MockSandboxOverrides>,
) {
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, IdleUnparkResult,
        ParkResult,
    };
    use crate::storage_fingerprints::StorageFingerprints;

    let reuse_key = format!("thread:home-cache-{session_id}");
    let current_image =
        seed_home_image_cache(cache, runner_paths, session_id, params.home_disk_mb).await;

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let mut lease = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                rootfs_hash: "test-rootfs",
                run_id,
                sandbox_id,
                profile_name: &params.profile_name,
                reuse_key: Some(&reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(params.home_disk_mb) * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert!(lease.is_cache_hit());
    let home_drive = lease.home_drive_config().await.unwrap();
    let promotion = lease
        .into_promotion_context(crate::home_image_cache::HomeImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: HomeCacheTerminalStatus::Success,
            completed_at: "2026-06-01T00:00:01.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            home_drive,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let candidate = IdleParkRequest::new(IdleParkRequestParts {
        run_id,
        sandbox,
        factory,
        reuse_key: reuse_key.clone(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        rootfs_hash: params.rootfs_hash.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        restored_session_identity: None,
        native_generation_run_id: None,
        guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
        home_image_size_bytes: u64::from(params.home_disk_mb) * 1024 * 1024,
        home_promotion: Some(promotion),
        handoff: None,
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_error();
        panic!("test sandbox should park: {error}");
    })
    .expect_reusable()
    .with_last_completed_at("2026-06-01T00:00:01.000Z".into());

    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(&reuse_key).expect("idle entry should exist");
    let idle_sandbox = match entry
        .try_unpark_for_run(runner_types::ids::RunId::new_v4())
        .await
    {
        IdleUnparkResult::Reused { sandbox, .. } => *sandbox,
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };

    (idle_sandbox, current_image, overrides)
}
