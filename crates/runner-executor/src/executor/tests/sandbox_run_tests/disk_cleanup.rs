use super::*;
use guest_contracts::disk_cleanup::{DiskCleanupFilesystem, DiskCleanupReport};

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
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

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
async fn insufficient_capacity_preserves_failure_without_replaying_bootstrap() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 1024);
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    let failure = outcome.failure.unwrap();
    assert!(failure.error.contains("No space left on device"));
    assert_eq!(
        failure.resource_diagnostics.unwrap().failure_kind,
        Some(ResourceFailureKind::GuestHomeFilesystemFull)
    );
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.private_write_files_calls().len(), 1);
    assert_eq!(cleanup_calls(&overrides).len(), 1);
}

#[tokio::test]
async fn failed_or_untrusted_cleanup_reports_preserve_the_original_failure() {
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
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

        let outcome =
            run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();

        assert_eq!(outcome.exit_code(), 1, "{case}");
        assert!(
            outcome
                .failure
                .unwrap()
                .error
                .contains("No space left on device"),
            "{case}"
        );
        assert_eq!(overrides.private_write_files_calls().len(), 1, "{case}");
        assert!(overrides.start_agent_process_calls().is_empty(), "{case}");
        assert_eq!(cleanup_calls(&overrides).len(), 1, "{case}");
    }
}

#[tokio::test]
async fn second_disk_failure_does_not_repeat_cleanup_or_start_agent() {
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
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

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
    assert_eq!(overrides.private_write_files_calls().len(), 2);
    assert_eq!(cleanup_calls(&overrides).len(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
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
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(overrides.private_write_files_calls().len(), 1);
    assert!(cleanup_calls(&overrides).is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn inline_instruction_enospc_recovers_before_private_inputs_and_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    full_filesystem(&overrides, DiskCleanupFilesystem::Home);
    cleanup_report(&overrides, DiskCleanupFilesystem::Home, 256 * 1024 * 1024);
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut context = minimal_context();
    context.agent_instructions = Some("Preserve these current instructions".into());

    let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(overrides.private_write_file_calls().is_empty());
    let writes = overrides.private_write_files_calls();
    assert_eq!(writes.len(), 3);
    assert_eq!(writes[0].files, writes[1].files);
    assert_eq!(writes[2].files.len(), 3);
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
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let outcome = run_new_sandbox_outcome(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(overrides.private_write_files_calls().len(), 1);
    assert!(cleanup_calls(&overrides).is_empty());
}
