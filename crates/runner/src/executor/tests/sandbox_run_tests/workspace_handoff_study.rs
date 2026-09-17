use super::*;
use crate::executor::ExecuteOutcome;
use crate::executor::session_history_restore_plan::{
    SessionHistoryRestorePlanInput, build_session_history_restore_plan,
};
use crate::executor::telemetry::RunnerPreSpawnTiming;
use crate::executor::{SessionHistoryRestoreFallback, SessionHistoryRestorePlan};
use crate::idle_pool::IdleSandboxKind;
use crate::telemetry::{JobTelemetry, RunnerStartupPath};
use crate::types::{
    ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind, WorkspaceReuseResult,
};
use crate::workspace_image_cache::WorkspaceSessionHistorySidecarRepresentation;
use httpmock::prelude::*;
use sandbox_mock::MockSandboxOverrides;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

async fn run_study(
    root: &std::path::Path,
    overrides: Arc<MockSandboxOverrides>,
    enable_handoff: bool,
    cancel: CancellationToken,
) -> (
    ExecuteOutcome,
    JobTelemetry,
    WorkspaceImageCache,
    RunnerPaths,
) {
    let paths = RunnerPaths::new(root.join("runner"));
    let cache = WorkspaceImageCache::new(paths.clone());
    let mut config = test_executor_config(root).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    seed_workspace_image_cache(&cache, &paths, "study", params.workspace_disk_mb).await;
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let sandbox_id = sandbox.id().parse().unwrap();
    if enable_handoff {
        overrides.set_workspace_handoff_target(paths.active_workspace_image(&sandbox_id));
    }
    let mut context = minimal_context();
    context.run_id = RunId::new_v4();
    context.reuse_key = Some("thread:workspace-cache-study".into());
    context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
    let mut telemetry = test_telemetry(&config, &context);
    let outcome = execute_reused_sandbox(
        ReusedSandboxRun {
            sandbox_id,
            factory: &factory,
            params: &params,
            source_ip: sandbox.source_ip().into(),
            sandbox,
            workspace_image: None,
            kind: IdleSandboxKind::Blank,
        },
        &context,
        &config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: WorkspaceReuseResult::CacheMiss,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(cancel, None).with_guest_state_prepared(true),
            prepare_run_payload_for_run(&context).unwrap(),
        ),
    )
    .await;
    (outcome, telemetry, cache, paths)
}

#[tokio::test]
async fn cached_blank_handoff_preserves_workspace_telemetry_and_promotion() {
    let dir = tempfile::tempdir().unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (mut outcome, telemetry, cache, paths) = run_study(
        dir.path(),
        Arc::clone(&overrides),
        true,
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(WorkspaceReuseResult::Reused)
    );
    assert_eq!(overrides.workspace_handoff_calls().len(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    let operations = telemetry.pending_ops_with_runner_startup_snapshot();
    let startup: Vec<_> = operations
        .iter()
        .filter(|op| op.action_type == "api_to_spawn")
        .collect();
    assert_eq!(startup.len(), 1);
    assert_eq!(
        startup[0].runner_startup_path,
        Some(RunnerStartupPath::Workspace)
    );
    let sandbox_id = outcome.sandbox.as_ref().unwrap().id().parse().unwrap();
    let active = paths.active_workspace_image(&sandbox_id);
    // Simulate an Agent write to the attached canonical image, then exercise the
    // real cache promotion and checkout lifecycle on that same file.
    use tokio::io::AsyncWriteExt;
    let mut image = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&active)
        .await
        .unwrap();
    image.write_all(b"written-after-handoff").await.unwrap();
    drop(image);
    let lease = outcome.workspace_image.take().unwrap();
    assert!(
        lease
            .promote(
                RunId::new_v4(),
                WorkspaceCacheTerminalStatus::Success,
                "2026-09-17T00:00:00Z".into(),
                &crate::storage_fingerprints::StorageFingerprints::default()
            )
            .await
            .unwrap()
    );
    let next = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some("thread:workspace-cache-study"),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: 16 * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    assert!(next.is_cache_hit());
    let sandbox::WorkspaceDriveSeedImage::Move(seed) =
        next.workspace_drive_config().unwrap().seed_image.unwrap()
    else {
        panic!("cache checkout must retain exclusive Move ownership");
    };
    use tokio::io::AsyncReadExt;
    let mut image = tokio::fs::File::open(seed).await.unwrap();
    let mut marker = [0; b"written-after-handoff".len()];
    image.read_exact(&mut marker).await.unwrap();
    assert_eq!(&marker, b"written-after-handoff");
}

#[tokio::test]
async fn failed_cached_blank_handoff_never_spawns_or_promotes() {
    let dir = tempfile::tempdir().unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let root = dir.path().to_path_buf();
    let task_overrides = Arc::clone(&overrides);
    let task = tokio::spawn(async move {
        run_study(&root, task_overrides, false, CancellationToken::new()).await
    });
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    let cache = WorkspaceImageCache::new(RunnerPaths::new(dir.path().join("runner")));
    let competing = cache
        .prepare_with_lock_policy(
            WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    reuse_key: Some("thread:workspace-cache-study"),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: 16 * 1024 * 1024,
                },
                workspace_drive_required: true,
            },
            crate::workspace_image_cache::WorkspaceImagePrepareLockPolicy::ImmediateFallback,
        )
        .await;
    assert_eq!(
        competing.result(),
        WorkspaceCacheCheckoutResult::LockBusy,
        "cache ownership must remain exclusive until VM destruction completes"
    );
    drop(competing);
    assert!(overrides.start_agent_process_calls().is_empty());
    destroy_gate.release_one();
    let (outcome, telemetry, _, _) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(outcome.exit_code(), 0);
    assert!(
        outcome.sandbox.is_none(),
        "candidate is destroyed before releasing its cache lease"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(outcome.workspace_image.is_none());
    assert!(!outcome.sandbox_reuse_disposition.is_eligible());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(
        telemetry
            .pending_ops_with_runner_startup_snapshot()
            .iter()
            .all(|op| op.action_type != "api_to_spawn")
    );
}

#[tokio::test]
async fn cancellation_during_cached_blank_handoff_waits_then_returns_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_workspace_handoff_gate(gate.clone());
    let cancel = CancellationToken::new();
    let task_overrides = Arc::clone(&overrides);
    let task_cancel = cancel.clone();
    let task =
        tokio::spawn(async move { run_study(&root, task_overrides, true, task_cancel).await });
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    cancel.cancel();
    assert!(
        !task.is_finished(),
        "partial disk operation must retain ownership"
    );
    assert!(overrides.start_agent_process_calls().is_empty());
    gate.release_one();
    let (outcome, _, _, _) = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    assert!(!outcome.sandbox_reuse_disposition.is_eligible());
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn study_blank_history_uses_checked_out_sidecar_or_one_remote_fallback() {
    for cache_hit in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths.clone());
        let mut config = test_executor_config(dir.path()).await;
        config.workspace_cache = Some(cache.clone());
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let sandbox_id = sandbox.id().parse().unwrap();
        overrides.set_workspace_handoff_target(paths.active_workspace_image(&sandbox_id));
        let params = JobParams {
            workspace_disk_mb: 16,
            ..default_params()
        };
        let server = MockServer::start_async().await;
        let history = br#"{"type":"init"}"#;
        let history_mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/history.blob");
                then.status(200).body(history);
            })
            .await;
        let mut context = minimal_context();
        context.run_id = RunId::new_v4();
        context.reuse_key = Some("thread:study-blank-history".into());
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "sess-study-blank-history".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: hex::encode(Sha256::digest(history)),
                    url: server.url("/history.blob"),
                    encoding: ResumeSessionHistoryEncoding::Identity,
                    raw_size: history.len() as u64,
                    encoded_size: history.len() as u64,
                    download_source: None,
                },
            },
        });
        if cache_hit {
            seed_workspace_image_cache_with_sidecar(
                &cache,
                &paths,
                &context,
                params.workspace_disk_mb,
                history,
                WorkspaceSessionHistorySidecarRepresentation::Raw,
            )
            .await;
        }
        let cancel = CancellationToken::new();
        let mut timing = RunnerPreSpawnTiming::start_after_claim();
        let plan = build_session_history_restore_plan(SessionHistoryRestorePlanInput {
            http: &config.http,
            cpu: &config.session_history_cpu,
            context: &context,
            cancel: cancel.clone(),
            reuse_result: SandboxReuseResult::PoolMiss,
            idle_kind: Some(IdleSandboxKind::Blank),
            workspace_cache_available: config.workspace_cache.is_some(),
            restored_identity: None,
            pre_spawn_timing: &mut timing,
            probe: Some(&config.session_history_probe),
        });
        assert!(matches!(
            plan,
            SessionHistoryRestorePlan::DeferredHashBacked {
                fallback: Some(SessionHistoryRestoreFallback::NonReuse)
            }
        ));
        let mut telemetry = test_telemetry(&config, &context);
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            execute_reused_sandbox(
                ReusedSandboxRun {
                    sandbox_id,
                    factory: &factory,
                    params: &params,
                    source_ip: sandbox.source_ip().into(),
                    sandbox,
                    workspace_image: None,
                    kind: IdleSandboxKind::Blank,
                },
                &context,
                &config,
                RunStart {
                    restore_guest_state: true,
                    reuse_result: SandboxReuseResult::PoolMiss,
                    workspace_reuse_result: WorkspaceReuseResult::CacheMiss,
                    prev_storage: None,
                },
                &mut telemetry,
                PreparedRunInputs::new(
                    RunControls::new(cancel, None)
                        .with_guest_state_prepared(true)
                        .with_session_history_restore_plan(plan),
                    prepare_run_payload_for_run(&context).unwrap(),
                ),
            ),
        )
        .await
        .expect("Blank history restore should complete");
        assert_eq!(outcome.exit_code(), 0);
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
        let writes = overrides.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].content, history);
        assert_eq!(
            overrides.workspace_handoff_calls().len(),
            usize::from(cache_hit)
        );
        history_mock
            .assert_calls_async(usize::from(!cache_hit))
            .await;
        if cache_hit {
            assert_telemetry_action(
                &telemetry,
                "session_history_workspace_cache_hit",
                true,
                None,
            );
            assert_telemetry_action(
                &telemetry,
                "session_history_workspace_cache_restore",
                true,
                None,
            );
            assert_no_telemetry_action(&telemetry, "session_history_download");
        } else {
            assert_telemetry_action(&telemetry, "session_history_download", true, None);
            assert_no_telemetry_action(&telemetry, "session_history_workspace_cache_hit");
        }
    }
}
