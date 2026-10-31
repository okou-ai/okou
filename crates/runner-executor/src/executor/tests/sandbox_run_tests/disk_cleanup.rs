use super::*;
use guest_contracts::disk_cleanup::{DiskCleanupFilesystem, DiskCleanupReport};
use httpmock::prelude::*;
use runner_types::types::HomeReuseResult;

fn confirmed_backing() -> Arc<dyn sandbox::SandboxBackingProcess> {
    let (completion, backing) = sandbox_mock::MockBackingProcess::channel();
    completion.confirm_exit();
    backing
}

fn retiring_factory(overrides: Arc<sandbox_mock::MockSandboxOverrides>) -> MockSandboxFactory {
    overrides.push_create_backing(confirmed_backing());
    MockSandboxFactory::with_overrides(overrides)
}

fn full_filesystem(
    overrides: &sandbox_mock::MockSandboxOverrides,
    filesystem: DiskCleanupFilesystem,
) {
    let stdout = match filesystem {
        DiskCleanupFilesystem::Home => b"VM0_DF_BLOCKS_V1\n/dev/root 12000000 6000000 6000000 50% /\n/dev/vdb 24000000 24000000 0 100% /home/user\nVM0_DF_INODES_V1\n/dev/root 800000 100000 700000 13% /\n/dev/vdb 1500000 300000 1200000 20% /home/user\n".to_vec(),
        DiskCleanupFilesystem::Rootfs => b"VM0_DF_BLOCKS_V1\n/dev/root 12000000 12000000 0 100% /\n/dev/vdb 24000000 1000000 23000000 5% /home/user\nVM0_DF_INODES_V1\n/dev/root 800000 100000 700000 13% /\n/dev/vdb 1500000 300000 1200000 20% /home/user\n".to_vec(),
    };
    overrides.add_persistent_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".into(),
        exit_code: 0,
        stdout,
        stderr: Vec::new(),
    });
}

fn both_filesystems_full(overrides: &sandbox_mock::MockSandboxOverrides) {
    overrides.add_persistent_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".into(),
        exit_code: 0,
        stdout: b"VM0_DF_BLOCKS_V1\n/dev/root 12000000 12000000 0 100% /\n/dev/vdb 24000000 24000000 0 100% /home/user\nVM0_DF_INODES_V1\n/dev/root 800000 100000 700000 13% /\n/dev/vdb 1500000 300000 1200000 20% /home/user\n".to_vec(),
        stderr: Vec::new(),
    });
}

fn cleanup_report(
    overrides: &sandbox_mock::MockSandboxOverrides,
    filesystem: DiskCleanupFilesystem,
    available_bytes_after: u64,
) {
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: format!("recover-disk-space {}", filesystem.as_str()),
        exit_code: 0,
        stdout: serde_json::to_vec(&DiskCleanupReport {
            filesystem,
            available_bytes_before: 0,
            available_bytes_after,
            available_inodes_before: 1000,
            available_inodes_after: 1010,
            removed_entries: 10,
        })
        .unwrap(),
        stderr: Vec::new(),
    });
}

fn cleanup_calls(overrides: &sandbox_mock::MockSandboxOverrides) -> Vec<sandbox_mock::ExecCall> {
    overrides
        .exec_calls()
        .into_iter()
        .filter(|call| call.cmd.contains("recover-disk-space"))
        .collect()
}

#[tokio::test]
async fn full_cached_home_is_replaced_with_current_inputs_and_only_final_cold_reporting() {
    let dir = tempfile::tempdir().unwrap();
    let api = MockServer::start_async().await;
    let mut config = test_executor_config(dir.path()).await;
    config.http = runner_provider::http::HttpClient::new(runner_provider::http::HttpClientConfig {
        api_url: api.base_url(),
        vercel_bypass: None,
        client_session_id: "disk-replacement-test".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = HomeImageCache::new(paths.clone());
    config.home_cache = Some(cache.clone());
    let mut context = minimal_context();
    let session = "disk-full";
    context.reuse_key = Some(format!("thread:home-cache-{session}"));
    context.native_continuation = Some(guest_contracts::env::NativeContinuation {
        session_id: Some(session.into()),
        generation_run_id: Some(context.run_id.to_string()),
        recovery_prompt: None,
    });
    context.prompt = "Use these captured current inputs".into();
    context.environment = Some(HashMap::from([(
        "CURRENT_INPUT".into(),
        "current-value".into(),
    )]));
    let seed = seed_home_image_cache(&cache, &paths, session, 16).await;
    let metadata = seed.parent().unwrap().join("metadata.json");
    let cold = api.mock(|when, then| {
        when.method(PUT)
            .path(format!("/api/runners/runs/{}/startup", context.run_id))
            .json_body(serde_json::json!({"sandboxStartupPath":"cold"}));
        then.status(204);
    });
    let home = api.mock(|when, then| {
        when.method(PUT)
            .path(format!("/api/runners/runs/{}/startup", context.run_id))
            .json_body(serde_json::json!({"sandboxStartupPath":"home"}));
        then.status(204);
    });
    let startup = api.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/telemetry")
            .body_includes("runner_sandbox_startup")
            .body_includes("sandboxPrepareFallback")
            .body_includes("bootstrap_home_disk_full")
            .body_includes(r#""runner_startup_path":"cold""#);
        then.status(200);
    });
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 1024);
    let factory = retiring_factory(overrides.clone());
    let mut telemetry = test_telemetry(&config, &context);
    let mut outcome = execute_new_sandbox(
        &factory,
        &context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &JobParams {
            home_disk_mb: 16,
            ..default_params()
        },
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.failure);
    assert_eq!(
        outcome.home_reuse_result,
        Some(HomeReuseResult::SandboxPrepareFallback)
    );
    assert!(outcome.home_image.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert!(configs[0].home_drive.as_ref().unwrap().seed_image.is_some());
    assert!(configs[1].home_drive.as_ref().unwrap().seed_image.is_none());
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    let writes = overrides.private_write_files_calls();
    assert_eq!(writes.len(), 2);
    let payload: guest_contracts::env::RunPayload =
        serde_json::from_slice(&writes[1].files[2].content).unwrap();
    assert_eq!(payload.prompt, context.prompt);
    let native: guest_contracts::env::NativeContinuation =
        serde_json::from_str(&payload.native_continuation).unwrap();
    assert_eq!(native.session_id.as_deref(), Some(session));
    let environment: HashMap<String, String> =
        serde_json::from_slice(&writes[1].files[1].content).unwrap();
    assert_eq!(environment["CURRENT_INPUT"], "current-value");
    assert!(!seed.exists());
    assert!(!metadata.exists());
    assert!(cache.held_home_states().await.is_empty());
    outcome.startup_report.take().unwrap().finish().await;
    telemetry.flush().await;
    cold.assert_calls_async(1).await;
    home.assert_calls_async(0).await;
    startup.assert_calls_async(1).await;
    let next = cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                rootfs_hash: "test-rootfs",
                reuse_key: context.reuse_key(),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: 16 * 1024 * 1024,
            },
            home_drive_required: true,
        })
        .await;
    assert!(!next.is_cache_hit());
}

#[tokio::test]
async fn reused_vm_disk_exhaustion_runs_one_clean_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = retiring_factory(overrides.clone());
    let mut context = minimal_context();
    context.prompt = "Current reused run".into();
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 1024);
    let id = SandboxId::new_v4();
    let sandbox = Box::new(
        MockSandbox::with_overrides(id.to_string(), overrides.clone())
            .with_backing_process(confirmed_backing()),
    );
    let mut telemetry = test_telemetry(&config, &context);
    let mut outcome = execute_reused_sandbox(
        ReusedSandboxRun {
            sandbox_id: id,
            factory: &factory,
            params: &default_params(),
            sandbox,
            source_ip: "172.16.0.1".into(),
            home_image: None,
            kind: crate::idle_pool::IdleSandboxKind::Exact,
        },
        &context,
        &config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::Reused,
            home_reuse_result: HomeReuseResult::SandboxReused,
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Sandbox,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepare_run_payload_for_run(&context).unwrap(),
        ),
    )
    .await;
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.failure);
    assert_eq!(
        outcome.home_reuse_result,
        Some(HomeReuseResult::SandboxPrepareFallback)
    );
    assert_eq!(overrides.create_configs().len(), 1);
    assert!(
        overrides.create_configs()[0]
            .home_drive
            .as_ref()
            .unwrap()
            .seed_image
            .is_none()
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    outcome.startup_report.take().unwrap().finish().await;
}

#[tokio::test]
async fn bootstrap_recovers_home_and_rootfs_before_starting_one_agent() {
    for filesystem in [DiskCleanupFilesystem::Home, DiskCleanupFilesystem::Rootfs] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_private_write_files_result(Err(sandbox_write_file_error(
            "No space left on device (os error 28)",
        )));
        full_filesystem(&overrides, filesystem);
        cleanup_report(&overrides, filesystem, 256 * 1024 * 1024);
        let factory = retiring_factory(Arc::clone(&overrides));

        let outcome =
            run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();

        assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.failure);
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
        let writes = overrides.private_write_files_calls();
        assert_eq!(writes.len(), 2);
        assert_eq!(writes[0].files, writes[1].files);
        let calls = cleanup_calls(&overrides);
        assert_eq!(calls.len(), 1);
        assert!(calls[0].cmd.ends_with(filesystem.as_str()));
        assert!(calls[0].sudo);
        assert!(calls[0].stdin_bytes.is_none());
    }
}

#[tokio::test]
async fn bootstrap_recovers_both_full_filesystems_before_starting_one_agent() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    both_filesystems_full(&overrides);
    cleanup_report(&overrides, DiskCleanupFilesystem::Rootfs, 256 * 1024 * 1024);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 256 * 1024 * 1024);
    let factory = retiring_factory(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.failure);
    let writes = overrides.private_write_files_calls();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].files, writes[1].files);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    let calls = cleanup_calls(&overrides);
    assert_eq!(calls.len(), 2);
    assert!(calls[0].cmd.ends_with(" home"));
    assert!(calls[1].cmd.ends_with(" rootfs"));
}

#[tokio::test]
async fn insufficient_capacity_on_either_full_filesystem_still_cleans_both() {
    for insufficient in [DiskCleanupFilesystem::Home, DiskCleanupFilesystem::Rootfs] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_private_write_files_result(Err(sandbox_write_file_error(
            "No space left on device (os error 28)",
        )));
        both_filesystems_full(&overrides);
        for filesystem in [DiskCleanupFilesystem::Home, DiskCleanupFilesystem::Rootfs] {
            let available = if filesystem == insufficient {
                1024
            } else {
                256 * 1024 * 1024
            };
            cleanup_report(&overrides, filesystem, available);
        }
        let factory = retiring_factory(Arc::clone(&overrides));

        let outcome =
            run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();

        assert_eq!(outcome.exit_code(), 0, "{insufficient:?}");
        assert_eq!(overrides.create_configs().len(), 2);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(overrides.private_write_files_calls().len(), 2);
        assert_eq!(overrides.start_agent_process_calls().len(), 1);
        let calls = cleanup_calls(&overrides);
        assert_eq!(calls.len(), 2, "{insufficient:?}");
        assert!(calls[0].cmd.ends_with(" home"));
        assert!(calls[1].cmd.ends_with(" rootfs"));
    }
}

#[tokio::test]
async fn insufficient_capacity_replaces_the_sandbox_before_starting_one_agent() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 1024);
    let factory = retiring_factory(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(overrides.private_write_files_calls().len(), 2);
    assert_eq!(cleanup_calls(&overrides).len(), 1);
}

#[tokio::test]
async fn failed_or_untrusted_cleanup_reports_retire_the_vm_without_in_place_replay() {
    let report = DiskCleanupReport {
        filesystem: DiskCleanupFilesystem::Home,
        available_bytes_before: 0,
        available_bytes_after: 256 * 1024 * 1024,
        available_inodes_before: 1000,
        available_inodes_after: 1010,
        removed_entries: 10,
    };
    let valid_json = serde_json::to_vec(&report).unwrap();
    let mut wrong_filesystem = report.clone();
    wrong_filesystem.filesystem = DiskCleanupFilesystem::Rootfs;
    let mut unchanged_capacity = report.clone();
    unchanged_capacity.available_bytes_before = report.available_bytes_after;
    unchanged_capacity.available_inodes_before = report.available_inodes_after;
    let mut insufficient_inodes = report;
    insufficient_inodes.available_inodes_after = 127;
    let mut truncated_json = valid_json.clone();
    truncated_json.extend(std::iter::repeat_n(b' ', 64 * 1024));

    for (case, exit_code, stdout) in [
        ("failed helper", 1, valid_json),
        ("invalid json", 0, b"unavailable".to_vec()),
        (
            "wrong filesystem",
            0,
            serde_json::to_vec(&wrong_filesystem).unwrap(),
        ),
        (
            "no measured improvement",
            0,
            serde_json::to_vec(&unchanged_capacity).unwrap(),
        ),
        (
            "insufficient inodes",
            0,
            serde_json::to_vec(&insufficient_inodes).unwrap(),
        ),
        ("truncated output", 0, truncated_json),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_private_write_files_result(Err(sandbox_write_file_error(
            "No space left on device (os error 28)",
        )));
        full_filesystem(&overrides, DiskCleanupFilesystem::Home);
        overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
            pattern: "recover-disk-space home".into(),
            exit_code,
            stdout,
            stderr: Vec::new(),
        });
        let factory = retiring_factory(Arc::clone(&overrides));

        let outcome =
            run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();

        assert_eq!(outcome.exit_code(), 0, "{case}");
        assert_eq!(overrides.create_configs().len(), 2, "{case}");
        assert_eq!(overrides.destroy_call_count(), 1, "{case}");
        assert_eq!(overrides.private_write_files_calls().len(), 2, "{case}");
        assert_eq!(overrides.start_agent_process_calls().len(), 1, "{case}");
        assert_eq!(cleanup_calls(&overrides).len(), 1, "{case}");
    }
}

#[tokio::test]
async fn acknowledged_enospc_can_replace_a_vm_when_capacity_inspection_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    let factory = retiring_factory(overrides.clone());
    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();
    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.private_write_files_calls().len(), 2);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert!(cleanup_calls(&overrides).is_empty());
}

#[tokio::test]
async fn second_disk_failure_replaces_once_without_repeating_old_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    for _ in 0..2 {
        overrides.push_private_write_files_result(Err(sandbox_write_file_error(
            "No space left on device (os error 28)",
        )));
    }
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 256 * 1024 * 1024);
    let factory = retiring_factory(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(overrides.private_write_files_calls().len(), 3);
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(cleanup_calls(&overrides).len(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
}

#[tokio::test]
async fn disk_full_pristine_replacement_is_terminal_without_a_third_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    for _ in 0..2 {
        overrides.push_private_write_files_result(Err(sandbox_write_file_error(
            "No space left on device (os error 28)",
        )));
        cleanup_report(&overrides, DiskCleanupFilesystem::Home, 1024);
    }
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    let factory = retiring_factory(overrides.clone());
    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();
    assert_eq!(outcome.exit_code(), 1);
    assert!(
        outcome
            .failure
            .unwrap()
            .error
            .contains("No space left on device")
    );
    assert_eq!(overrides.create_configs().len(), 2);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(overrides.private_write_files_calls().len(), 2);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(cleanup_calls(&overrides).len(), 2);
    assert!(outcome.startup_report.is_none());
}

#[tokio::test]
async fn uncertain_old_sandbox_destruction_prevents_disk_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    overrides.push_destroy_panic("uncertain disk-full VM destruction");
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 1024);
    let factory = retiring_factory(overrides.clone());
    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();
    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(outcome.startup_report.is_none());
}

#[tokio::test]
async fn cancellation_while_retiring_disk_full_sandbox_prevents_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 1024);
    let gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let factory = retiring_factory(overrides.clone());
    let cancel = tokio_util::sync::CancellationToken::new();
    let context = minimal_context();
    let mut telemetry = test_telemetry(&config, &context);
    let params = default_params();
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
        cancel.clone(),
    );
    let cancellation = async {
        gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
        cancel.cancel();
        gate.release_one();
    };
    let (outcome, ()) = tokio::join!(execution, cancellation);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.failure.unwrap().exit_code, EXIT_SIGKILL);
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(outcome.startup_report.is_none());
}

#[tokio::test]
async fn normal_destroy_without_positive_child_wait_never_starts_a_replacement() {
    for missing in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_private_write_files_result(Err(sandbox_write_file_error(
            "No space left on device (os error 28)",
        )));
        full_filesystem(&overrides, DiskCleanupFilesystem::Home);
        cleanup_report(&overrides, DiskCleanupFilesystem::Home, 1024);
        if !missing {
            let (completion, backing) = sandbox_mock::MockBackingProcess::channel();
            completion.fail_wait();
            overrides.push_create_backing(backing);
        }
        let factory = MockSandboxFactory::with_overrides(overrides.clone());
        let outcome =
            run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();
        assert_eq!(outcome.exit_code(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(overrides.create_configs().len(), 1);
        assert!(overrides.start_agent_process_calls().is_empty());
        assert!(outcome.startup_report.is_none());
    }
}

#[tokio::test]
async fn uncertain_bootstrap_write_is_not_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox::SandboxError::OperationTimeout {
        operation: sandbox::SandboxOperation::WriteFile,
        stage: sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse,
        timeout_ms: 1000,
    }));
    let factory = retiring_factory(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.home_reuse_result.is_none());
    assert_eq!(overrides.private_write_files_calls().len(), 1);
    assert!(cleanup_calls(&overrides).is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn bootstrap_enospc_recovers_before_private_inputs_and_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 256 * 1024 * 1024);
    let factory = retiring_factory(Arc::clone(&overrides));
    let context = minimal_context();

    let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(overrides.private_write_file_calls().is_empty());
    let writes = overrides.private_write_files_calls();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].files, writes[1].files);
    assert_eq!(writes[0].files.len(), 3);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(cleanup_calls(&overrides).len(), 1);
}

#[tokio::test]
async fn disk_error_from_process_start_is_not_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(SandboxError::Operation {
        operation: sandbox::SandboxOperation::StartProcess,
        reason: SandboxOperationReason::Guest,
        message: "No space left on device (os error 28)".into(),
    });
    let factory = retiring_factory(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(overrides.private_write_files_calls().len(), 1);
    assert!(cleanup_calls(&overrides).is_empty());
}
