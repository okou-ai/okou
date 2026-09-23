use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{minimal_context, test_executor_config, test_telemetry};
use runner_types::types::SandboxReuseResult;

#[tokio::test]
async fn run_in_sandbox_folds_timezone_sync_into_fixed_restore_operation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::Reused,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::SandboxReused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    let restore_calls = sandbox.guest_state_restore_calls();
    assert_eq!(
        restore_calls.len(),
        1,
        "restore should run once; calls: {restore_calls:?}"
    );
    assert_eq!(
        restore_calls[0].timezone,
        sandbox_mock::GuestStateRestoreTimezoneCall::BestEffort("Asia/Shanghai".into())
    );
    let exec_calls = sandbox.exec_calls();
    let standalone_timezone_calls = exec_calls
        .iter()
        .filter(|call| call.cmd == "/sbin/guest-state-restore --sync-timezone Asia/Shanghai")
        .collect::<Vec<_>>();
    assert!(
        standalone_timezone_calls.is_empty(),
        "restore path should not run a separate timezone exec; calls: {exec_calls:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_runs_standalone_timezone_sync_without_restore_exec() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    let exec_calls = sandbox.exec_calls();
    assert!(
        exec_calls
            .iter()
            .any(|call| call.cmd == "/sbin/guest-state-restore --sync-timezone Asia/Shanghai"),
        "fresh path should keep standalone timezone sync; calls: {exec_calls:?}"
    );
    assert!(sandbox.guest_state_restore_calls().is_empty());
}
