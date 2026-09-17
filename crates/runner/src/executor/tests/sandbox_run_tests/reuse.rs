use std::time::Duration;

use super::*;
use httpmock::Method::GET;
use httpmock::MockServer;
use tokio_util::sync::CancellationToken;

use crate::executor::tests::support::RUN_IN_SANDBOX_TEST_TIMEOUT;
use crate::types::ExecutionContext;

// -----------------------------------------------------------------------
// Keep-alive sandbox reuse integration tests
// -----------------------------------------------------------------------

fn context_with_remote_storage(archive_url: &str, archive_size: usize) -> ExecutionContext {
    let mut context = minimal_context();
    let mut storage = api_storage("reused-archive", "/data", "v1", archive_url);
    storage.archive_size = Some(archive_size as u64);
    context.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    context
}

#[tokio::test]
async fn execute_job_reuse_succeeds() {
    for clear_accounts in [false, true] {
        assert_reused_connector_projection(clear_accounts).await;
    }
}

async fn assert_reused_connector_projection(clear_accounts: bool) {
    use crate::types::ConnectorRuntimeTargetRegistration;
    use guest_contracts::connector_account_context::{
        RunConnectorAccountContext, RunConnectorAccountTarget,
    };

    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut first_context = minimal_context();
    first_context.run_id = RunId::new_v4();
    let targets = vec![
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "github".into(),
            base_url_vars: None,
            source_id: Some("550e8400-e29b-41d4-a716-446655440000".into()),
        },
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "github".into(),
            base_url_vars: None,
            source_id: Some("550e8400-e29b-41d4-a716-446655440001".into()),
        },
    ];
    if clear_accounts {
        first_context.connector_runtime_targets = targets.clone();
    }

    // First: create a sandbox via normal execute_job
    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        first_context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    // Reuse the sandbox for a second turn
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut reused_context = minimal_context();
    reused_context.run_id = RunId::new_v4();
    if !clear_accounts {
        reused_context.connector_runtime_targets = targets;
    }
    let reused_context_path =
        guest_connector_account_context_file_path(reused_context.run_id).unwrap();
    let (reuse_outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        reused_context,
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.error().is_none());
    assert!(reuse_outcome.sandbox.is_some());
    let connector_account_context_writes = overrides
        .private_write_files_calls()
        .into_iter()
        .map(|batch| {
            assert_eq!(batch.files.len(), 3);
            let user_env: HashMap<String, String> =
                serde_json::from_slice(&batch.files[1].content).unwrap();
            assert_eq!(
                user_env[guest_contracts::env::CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV],
                batch.files[0].path,
            );
            batch.files[0].clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(connector_account_context_writes.len(), 2);
    assert_eq!(
        connector_account_context_writes[1].path,
        reused_context_path
    );
    assert!(overrides.private_write_file_calls().is_empty());
    let selected = vec![
        RunConnectorAccountTarget::Builtin {
            connector_slug: "github".into(),
            connection_id: Some("550e8400-e29b-41d4-a716-446655440000".into()),
        },
        RunConnectorAccountTarget::Builtin {
            connector_slug: "github".into(),
            connection_id: Some("550e8400-e29b-41d4-a716-446655440001".into()),
        },
    ];
    let expected = if clear_accounts {
        [selected, Vec::new()]
    } else {
        [Vec::new(), selected]
    };
    for (write, targets) in connector_account_context_writes.iter().zip(expected) {
        let projection: RunConnectorAccountContext =
            serde_json::from_slice(&write.content).unwrap();
        assert_eq!(
            projection,
            RunConnectorAccountContext {
                schema_version: guest_contracts::connector_account_context::SCHEMA_VERSION,
                targets,
            }
        );
    }
}

#[tokio::test]
async fn execute_job_reuse_bypasses_fresh_pre_spawn_admission() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let holder = config
        .pre_spawn_admission
        .acquire(2, &CancellationToken::new())
        .await
        .unwrap();
    let sandbox =
        create_overridden_sandbox(Arc::new(sandbox_mock::MockSandboxOverrides::new())).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _budget_lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;

    let (outcome, telemetry) = tokio::time::timeout(
        Duration::from_secs(2),
        execute_job_reuse(
            idle_sandbox,
            minimal_context(),
            &config,
            &default_params(),
            CancellationToken::new(),
        ),
    )
    .await
    .expect("exact reuse must not wait for fresh pre-spawn admission");

    assert_eq!(outcome.exit_code(), 0);
    assert_no_telemetry_action(&telemetry, "runner_fresh_pre_spawn_admission_wait");
    drop(holder);
}

#[tokio::test]
async fn execute_job_reuse_materializes_runner_owned_decoded_files_once() {
    for with_instructions in [false, true] {
        assert_reused_decoded_delivery(with_instructions).await;
    }
}

async fn assert_reused_decoded_delivery(with_instructions: bool) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _budget_lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let server = MockServer::start_async().await;
    let body = storage_archive(b"reused archive");
    let home = crate::paths::HomePaths::with_root(dir.path().to_owned());
    let archive_dir = home.storage_cache_dir("reused-archive", "v1");
    std::fs::create_dir_all(&archive_dir).unwrap();
    std::fs::write(archive_dir.join("archive.tar.gz"), &body).unwrap();
    drop(
        crate::lock::acquire(home.storage_lock("reused-archive", "v1"))
            .await
            .unwrap(),
    );
    config
        .decoded_cache
        .warm_from_archive("reused-archive", "v1")
        .await
        .unwrap();
    // A prior background fill is sufficient even after compressed-cache GC.
    // Production source preparation must not start another archive request.
    std::fs::remove_file(archive_dir.join("archive.tar.gz")).unwrap();
    let full_get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/reused-archive.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let archive_url = server.url("/reused-archive.tar.gz");
    let mut context = context_with_remote_storage(&archive_url, body.len());
    if with_instructions {
        let instructions_dir = home.storage_cache_dir("instructions", "v1");
        std::fs::create_dir_all(&instructions_dir).unwrap();
        std::fs::write(instructions_dir.join("archive.tar.gz"), &body).unwrap();
        drop(
            crate::lock::acquire(home.storage_lock("instructions", "v1"))
                .await
                .unwrap(),
        );
        let manifest = context.storage_manifest.as_mut().unwrap();
        manifest.storages[0].mount_path = "/home/user/.claude/skills/workflow".into();
        let mut instructions = api_storage(
            "instructions",
            "/home/user/.claude",
            "v1",
            &server.url("/instructions.tar.gz"),
        );
        instructions.instructions_target_filename = Some("CLAUDE.md".into());
        manifest.storages.push(instructions);
    }

    let task = tokio::spawn(async move {
        execute_job_reuse(
            idle_sandbox,
            context,
            &config,
            &default_params(),
            CancellationToken::new(),
        )
        .await
    });

    let (outcome, telemetry) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, task)
        .await
        .expect("decoded-only reused run should finish without downloading the archive")
        .expect("reused execution task should not panic");

    assert_eq!(outcome.exit_code(), 0, "error={:?}", outcome.error());
    full_get.assert_calls_async(0).await;
    let writes = overrides.write_files_calls();
    assert_eq!(writes.len(), usize::from(with_instructions));
    let manifests = overrides.storage_manifest_calls();
    assert_eq!(manifests.len(), 1);
    let (json, payload) =
        guest_contracts::storage_files::split_input(&manifests[0].manifest_json).unwrap();
    let manifest: guest_contracts::storage_manifest::Manifest =
        serde_json::from_slice(json).unwrap();
    let groups = guest_contracts::storage_files::decode(payload).unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].mount_path, manifest.storages[0].mount_path);
    assert_eq!(groups[0].files[0].content, b"reused archive");
    assert_eq!(
        manifest.storages[0].archive_url.as_deref(),
        Some(archive_url.as_str())
    );
    if with_instructions {
        assert_eq!(manifest.storages.len(), 2);
        assert_eq!(
            manifest.storages[1].instructions_target_filename.as_deref(),
            Some("CLAUDE.md")
        );
        assert!(manifest.storages[1].extract_path.is_some());
        assert_eq!(writes[0].files.len(), 1);
        assert_eq!(writes[0].files[0].content, body);
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(format!("file://{}", writes[0].files[0].path).as_str())
        );
    }
    assert_no_telemetry_action(&telemetry, "storage_cache_fresh_delivery_single_request");
    assert_telemetry_action(&telemetry, "storage_cache_decoded", true, None);
}

#[tokio::test]
async fn execute_reused_sandbox_drains_archive_when_guest_state_restore_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let registry_guard = crate::lock::acquire(dir.path().join("proxy-registry.json.lock"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_guest_state_restore_result(Err(sandbox_exec_error("restore failed")));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let server = MockServer::start_async().await;
    let body = b"reused restore failure".to_vec();
    let full_get = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/reused-restore-failure.tar.gz")
                .header_missing("range");
            then.status(200).body(body.clone());
        })
        .await;
    let archive_url = server.url("/reused-restore-failure.tar.gz");
    let context = context_with_remote_storage(&archive_url, body.len());
    let storage_lock_path = config.home.storage_lock("reused-archive", "v1");
    let previous_storage = crate::storage_fingerprints::StorageFingerprints::default();

    let task = tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &context);
        let outcome = execute_reused_sandbox(
            ReusedSandboxRun {
                sandbox_id: sandbox.id().parse().unwrap(),
                factory: &MockSandboxFactory::new(),
                params: &default_params(),
                sandbox,
                source_ip,
                workspace_image: None,
                kind: crate::idle_pool::IdleSandboxKind::Exact,
            },
            &context,
            &config,
            RunStart {
                restore_guest_state: true,
                reuse_result: crate::types::SandboxReuseResult::Reused,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::SandboxReused,
                prev_storage: Some(&previous_storage),
            },
            &mut telemetry,
            PreparedRunInputs::new(
                RunControls::new(CancellationToken::new(), None),
                prepare_run_payload_for_run(&context).unwrap(),
            ),
        )
        .await;
        (outcome, telemetry)
    });

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        while full_get.calls_async().await == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("archive request should start before proxy registration completes");
    assert!(
        !task.is_finished(),
        "proxy lock should keep reused preparation from reaching guest state restore"
    );
    drop(registry_guard);

    let (outcome, telemetry) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, task)
        .await
        .expect("guest state failure should drain prepared storage")
        .expect("reused execution task should not panic");

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("restore failed"));
    full_get.assert_calls_async(1).await;
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_telemetry_action(
        &telemetry,
        "storage_cache_fresh_delivery_cancelled",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "storage_cache_fresh_delivery_drained",
        true,
        None,
    );
    assert!(matches!(
        crate::lock::try_acquire_or_busy(storage_lock_path)
            .await
            .unwrap(),
        crate::lock::TryLock::Acquired(_)
    ));
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_reuse_rejects_invalid_storage_plan_before_proxy_registration() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _budget_lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let mut context = minimal_context();
    let mut artifact = api_artifact(
        "memory",
        "/home/user/.claude/projects/project",
        "storage-id-1",
        "version-2",
        "https://storage.example/artifact.tar.gz",
    );
    artifact.archive_url = None;
    context.storage_manifest = Some(StorageManifest {
        storages: Vec::new(),
        artifacts: vec![artifact],
    });

    let (outcome, telemetry) = execute_job_reuse(
        idle_sandbox,
        context,
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("missing archiveUrl"), "got: {error}");
    assert!(outcome.network_log_session.is_none());
    assert!(overrides.start_agent_process_calls().is_empty());
    let registry: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(dir.path().join("proxy-registry.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(registry["updatedAt"], 0);
    assert_eq!(
        registry["sandboxes"]
            .as_object()
            .map(|entries| entries.len()),
        Some(0)
    );
    assert_telemetry_action(
        &telemetry,
        "runner_storage_manifest_apply",
        false,
        Some(error),
    );
    assert_telemetry_action(
        &telemetry,
        "runner_reused_sandbox_prepare",
        false,
        Some(error),
    );
}

#[tokio::test]
async fn execute_job_reuse_model_provider_env_validation_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let secret = "sk-proj-real-openai-secret";
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains(secret));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_none());
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after env validation failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_claude_tool_validation_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec!["   ".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("OKOU_DISALLOWED_TOOLS"));
    assert!(error.contains("must not be empty"));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_none());
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after tool validation failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_invalid_resume_session_does_not_lease_workspace_image() {
    let dir = tempfile::tempdir().unwrap();
    let cache = WorkspaceImageCache::new(RunnerPaths::new(dir.path().join("runner")));
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "bad-session").await;
    let raw_session_id = "../bad-session";
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(raw_session_id.into(), "{}".into()));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(raw_session_id));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_none());
    assert!(reuse_outcome.workspace_image.is_none());
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start a process after resume session validation failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_appends_stream_limit_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"reuse partial stdout".to_vec(),
        truncated: true,
    }]);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.error().is_none());
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_some());
    assert_proxy_registry_empty(dir.path()).await;
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"reuse partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_job_reuse_with_session_context() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    // First turn: execute with resume_session
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        "test-session-abc".into(),
        r#"{"type":"human","text":"hello"}"#.into(),
    ));
    assert_eq!(ctx.cli_agent_session_id(), Some("test-session-abc"));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    // Second turn: reuse with new session history
    let mut ctx2 = minimal_context();
    ctx2.resume_session = Some(ResumeSession::inline(
        "test-session-abc".into(),
        r#"{"type":"human","text":"hello"}
{"type":"assistant","text":"hi"}
{"type":"human","text":"do something"}"#
            .into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx2, &config, &default_params(), cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.sandbox.is_some());
}

#[tokio::test]
async fn execute_job_reuse_guest_state_restore_exec_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    // The guest state restore transport fails.
    let sandbox = MockSandbox::new("reuse-clock-fail");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock broken")));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("vsock broken"));
    // Critical: sandbox must be returned so caller can stop + destroy it
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on guest state restore failure"
    );
    assert!(
        outcome.network_log_session.is_some(),
        "network log session must be returned so finalization can close it"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_reuse_reseed_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    // The combined guest state restore reports a guest-state-restore failure.
    let sandbox = MockSandbox::new("reuse-reseed-fail");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"guest-state-restore failed\nreseed timeout".to_vec(),
    )));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(
        outcome
            .error()
            .unwrap()
            .contains("guest-state-restore failed")
    );
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on reseed failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_skips_workspace_mount_validation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.error().is_none());
    assert!(outcome.sandbox.is_some());
    assert!(
        overrides.exec_calls().iter().all(|call| !call
            .cmd
            .contains(guest_contracts::guest_binary::WORKSPACE_MOUNT_PATH)),
        "reused execution must rely on the idle-admission mount proof"
    );
}

/// Verify that session restore failure during reuse still returns the sandbox.
#[tokio::test]
async fn execute_job_reuse_session_restore_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    let sandbox = MockSandbox::new("reuse-session-fail");
    // clock fix and reseed succeed (default), but write_file for session
    // history fails.
    sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline(
        "sess-abc".into(),
        r#"{"type":"init"}"#.into(),
    ));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-abc").await;
    let (outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("disk full"));
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on session restore failure"
    );
}
