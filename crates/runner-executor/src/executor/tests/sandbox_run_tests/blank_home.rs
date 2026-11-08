use super::*;
use crate::idle_pool::{
    IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult, ParkedIdleCandidate,
};
use httpmock::prelude::*;
use runner_types::types::HomeReuseResult;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn blank_reuses_selected_home_and_preserves_vm_identity() {
    exercise(false, false).await;
}

#[tokio::test]
async fn failed_blank_home_replacement_never_starts_or_publishes() {
    exercise(true, false).await;
}

#[tokio::test]
async fn invalid_blank_storage_preserves_unconsumed_home() {
    exercise(false, true).await;
}

async fn exercise(fail_replacement: bool, invalid_storage: bool) {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.home_cache = Some(cache.clone());
    let session = "blank-cached-home";
    let server = MockServer::start_async().await;
    let archive_get = server
        .mock_async(|when, then| {
            when.method(GET).path("/retained-storage.tar.gz");
            then.status(500);
        })
        .await;
    let manifest = StorageManifest {
        storages: vec![api_storage(
            "retained-storage",
            "/home/user/workspace/data",
            "v1",
            &server.url("/retained-storage.tar.gz"),
        )],
        artifacts: Vec::new(),
    };
    let fingerprints = crate::storage_fingerprints::StorageFingerprints::from_manifest(&manifest);
    let seed =
        seed_home_image_cache_with_fingerprints(&cache, &paths, session, 16, &fingerprints).await;
    let metadata = seed.parent().unwrap().join("metadata.json");
    let original_metadata = tokio::fs::read(&metadata).await.unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    if fail_replacement {
        overrides.push_home_drive_mount_result(Ok(ExecResult::new(
            64,
            Vec::new(),
            b"busy Home".to_vec(),
        )));
    }
    let factory = Arc::new(
        Box::new(MockSandboxFactory::with_overrides(overrides.clone())) as Box<dyn SandboxFactory>,
    );
    let id = SandboxId::new_v4();
    let candidate = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::with_overrides(
            id.to_string(),
            overrides.clone(),
        )),
        factory,
        test_budget_lease(),
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    );
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.reserve_blank("vm0/default", &None).unwrap();
    let mut context = minimal_context();
    context.reuse_key = Some(format!("thread:home-cache-{session}"));
    context.is_first_run = Some(false);
    context.api_start_time = Some(chrono::Utc::now().timestamp_millis() as u64);
    context.storage_manifest = Some(manifest);
    if invalid_storage {
        let mut artifact = api_artifact(
            "invalid",
            "/home/user/data",
            "invalid-storage",
            "v1",
            "https://archive.invalid/test",
        );
        artifact.archive_url = None;
        context
            .storage_manifest
            .as_mut()
            .unwrap()
            .artifacts
            .push(artifact);
    }

    let IdleUnparkResult::Reused {
        sandbox,
        budget_lease: _lease,
    } = entry.try_unpark_for_run(context.run_id).await
    else {
        panic!("blank must unpark");
    };
    let (outcome, telemetry) = execute_job_reuse(
        *sandbox,
        context,
        &config,
        &JobParams {
            home_disk_mb: 16,
            ..default_params()
        },
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.sandbox.as_ref().unwrap().id(), id.to_string());
    assert!(
        overrides.create_configs().is_empty(),
        "combining resources must not allocate another VM"
    );
    let replacements = overrides.home_drive_replacements();
    if invalid_storage {
        assert!(replacements.is_empty());
        assert_ne!(outcome.exit_code(), 0);
        assert!(overrides.start_agent_process_calls().is_empty());
        assert_eq!(tokio::fs::read(metadata).await.unwrap(), original_metadata);
    } else {
        assert_eq!(replacements.len(), 1);
        assert!(
            matches!(&replacements[0].seed_image, Some(sandbox::HomeDriveSeedImage::Move(path)) if path == &seed)
        );
        assert!(
            !metadata.exists(),
            "cache discoverability must be revoked before image consumption"
        );
        if fail_replacement {
            assert_ne!(outcome.exit_code(), 0);
            assert!(overrides.start_agent_process_calls().is_empty());
            assert!(outcome.home_image.is_none());
            assert!(!outcome.sandbox_reuse_disposition.is_eligible());
        } else {
            assert_eq!(outcome.exit_code(), 0);
            assert_eq!(outcome.home_reuse_result, Some(HomeReuseResult::Reused));
            assert_eq!(overrides.start_agent_process_calls().len(), 1);
            assert!(
                telemetry
                    .pending_ops_with_runner_startup_snapshot()
                    .iter()
                    .any(|op| op.action_type == "api_to_spawn"
                        && op.runner_startup_path
                            == Some(crate::telemetry::RunnerStartupPath::Home))
            );
        }
    }
    archive_get.assert_calls_async(0).await;
    config.background_fill.shutdown().await;
    config.decoded_cache.shutdown().await;
}
