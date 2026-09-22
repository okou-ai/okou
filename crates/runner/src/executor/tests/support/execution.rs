use std::time::Duration;

use sandbox::{Sandbox, SandboxId};
use sandbox_mock::MockSandboxFactory;
use tokio_util::sync::CancellationToken;

use super::super::super::agent_run::{
    AgentExecutionResult, PreparedRunInputs, ProcessCancelTimeouts, RunControls, RunStart,
    run_in_sandbox_with_process_cancel_timeouts,
};
use super::super::super::env::prepare_run_payload_for_run;
use super::super::super::sandbox_run::execute_new_sandbox;
use super::super::super::{
    ExecuteOutcome, ExecutorConfig, JobParams, NewSandboxDispatch, PROCESS_CANCEL_TIMEOUTS,
};
use super::config::test_telemetry;
use crate::error::RunnerResult;
use crate::run_cancellation::RunCancellationSignals;
use runner_types::types::{ExecutionContext, SandboxReuseResult};

pub(in crate::executor::tests) const RUN_IN_SANDBOX_TEST_TIMEOUT: Duration = Duration::from_secs(5);

pub(in crate::executor::tests) async fn run_new_sandbox_outcome(
    factory: &MockSandboxFactory,
    ctx: &ExecutionContext,
    config: &ExecutorConfig,
    params: &JobParams,
) -> RunnerResult<ExecuteOutcome> {
    let mut telemetry = test_telemetry(config, ctx);
    let cancel = CancellationToken::new();
    execute_new_sandbox(
        factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        config,
        params,
        &mut telemetry,
        cancel,
    )
    .await
}

pub(in crate::executor::tests) async fn run_new_sandbox_status(
    factory: &MockSandboxFactory,
    ctx: &ExecutionContext,
    config: &ExecutorConfig,
    params: &JobParams,
) -> RunnerResult<(i32, Option<String>)> {
    let outcome = run_new_sandbox_outcome(factory, ctx, config, params).await?;
    Ok((outcome.exit_code(), outcome.error().map(ToOwned::to_owned)))
}

pub(in crate::executor::tests) fn spawn_run_in_sandbox_test(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    spawn_run_in_sandbox_test_with_timeouts(sandbox, ctx, config, cancel, PROCESS_CANCEL_TIMEOUTS)
}

pub(in crate::executor::tests) fn spawn_run_in_sandbox_test_with_timeouts(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancel: CancellationToken,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        let prepared_run_payload = prepare_run_payload_for_run(&ctx)?;
        run_in_sandbox_with_process_cancel_timeouts(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            PreparedRunInputs::new(RunControls::new(cancel, None), prepared_run_payload),
            process_cancel_timeouts,
        )
        .await
    })
}

pub(in crate::executor::tests) fn spawn_run_in_sandbox_test_with_cancellation(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancellation: RunCancellationSignals,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        let prepared_run_payload = prepare_run_payload_for_run(&ctx)?;
        run_in_sandbox_with_process_cancel_timeouts(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            PreparedRunInputs::new(
                RunControls::from_cancellation(cancellation, None),
                prepared_run_payload,
            ),
            process_cancel_timeouts,
        )
        .await
    })
}
