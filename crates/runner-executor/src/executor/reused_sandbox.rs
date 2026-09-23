//! Own reused preparation until optional prefetch can safely hand off to Agent execution.

use std::time::{Duration, Instant};

use sandbox::{Sandbox, SandboxFactory};
use tracing::{info, warn};

use super::agent_run::{PreparedGuestRuntime, PreparedRunInputs, RunStart};
use super::sandbox_run::{
    FreshPreparation, NewSandboxHooks, PreparedSandboxRun, cancel_prepared_storage,
    destroy_sandbox_panic_safe, execute_new_sandbox_with_prepared_notifier,
    execute_prepared_sandbox_run, prepare_storage, register_proxy, unregister_proxy_registry,
};
use super::{ExecuteOutcome, ExecutionFailure, ExecutorConfig, JobParams, NewSandboxDispatch};
use crate::error::RunnerError;
use crate::idle_pool::IdleSandboxKind;
use crate::telemetry::JobTelemetry;
use crate::workspace_image_cache::WorkspaceImageLease;
use runner_types::types::ExecutionContext;

const BLANK_PREFETCH_REPLACEMENT: &str = "runner_blank_sandbox_retry_without_codex_prefetch";

pub(super) struct ReusedSandboxRun<'a> {
    pub(super) sandbox_id: sandbox::SandboxId,
    pub(super) factory: &'a dyn SandboxFactory,
    pub(super) params: &'a JobParams,
    pub(super) sandbox: Box<dyn Sandbox>,
    pub(super) source_ip: String,
    pub(super) workspace_image: Option<WorkspaceImageLease>,
    pub(super) kind: IdleSandboxKind,
}

pub(super) async fn execute_reused_sandbox(
    run: ReusedSandboxRun<'_>,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    mut inputs: PreparedRunInputs,
) -> ExecuteOutcome {
    info!(run_id = %context.run_id, sandbox_id = %run.sandbox.id(), "reusing kept-alive sandbox");
    let prepare_started = Instant::now();
    let prepared_storage = prepare_storage(
        context,
        start.prev_storage,
        config,
        &inputs.controls.cancel,
        telemetry,
    )
    .await;
    let network_log_session = match prepared_storage {
        Ok(storage) => {
            inputs.controls.prepared_storage = storage;
            register_proxy(config, context, &run.source_ip).await
        }
        Err(error) => Err(error),
    };
    let network_log_session = match network_log_session {
        Ok(session) => session,
        Err(error) => {
            cancel_prepared_storage(&mut inputs.controls, telemetry).await;
            inputs
                .controls
                .session_history_restore_plan
                .cancel_and_drain()
                .await;
            telemetry.record(
                "runner_reused_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            return ExecuteOutcome::reused_sandbox_failure(
                ExecutionFailure::from_error(error.to_string()),
                run.sandbox,
                run.source_ip,
                run.workspace_image,
            );
        }
    };
    telemetry.record(
        "runner_reused_sandbox_prepare",
        prepare_started.elapsed(),
        true,
        None,
    );

    // Exact reuse does not prefetch. For blanks, inspect the existing preparation
    // result while inputs and sandbox ownership are still available for recovery.
    let prepared_guest_runtime = if run.kind == IdleSandboxKind::Blank {
        inputs
            .controls
            .prepare_codex_model_catalog_prefetch(run.sandbox.as_ref(), context, &start, telemetry)
            .await
    } else {
        None
    };
    let prepared = PreparedSandboxRun {
        sandbox: run.sandbox,
        source_ip: run.source_ip,
        network_log_session,
        prepared_guest_runtime: None,
    };
    if let Some(PreparedGuestRuntime::SandboxUnusable(error)) = prepared_guest_runtime {
        // Drop the retired blank's lease without publishing or freezing its image.
        drop(run.workspace_image);
        return replace_unusable_blank(
            run.factory,
            run.params,
            prepared,
            context,
            config,
            telemetry,
            BlankReplacement {
                sandbox_id: run.sandbox_id,
                error,
                reuse_result: start.reuse_result,
                inputs,
            },
        )
        .await;
    }
    let mut outcome = execute_prepared_sandbox_run(
        PreparedSandboxRun {
            prepared_guest_runtime,
            ..prepared
        },
        context,
        config,
        start,
        telemetry,
        inputs,
    )
    .await;
    outcome.workspace_image = run.workspace_image;
    outcome
}

struct BlankReplacement {
    sandbox_id: sandbox::SandboxId,
    error: RunnerError,
    reuse_result: runner_types::types::SandboxReuseResult,
    inputs: PreparedRunInputs,
}

async fn replace_unusable_blank(
    factory: &dyn SandboxFactory,
    params: &JobParams,
    prepared: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    telemetry: &mut JobTelemetry,
    replacement: BlankReplacement,
) -> ExecuteOutcome {
    let BlankReplacement {
        sandbox_id,
        error,
        reuse_result,
        mut inputs,
    } = replacement;
    info!(run_id = %context.run_id, %sandbox_id, %error,
        "retiring unusable blank before Agent start; skipping guest cleanup");
    cancel_prepared_storage(&mut inputs.controls, telemetry).await;
    let unregister_completed =
        match unregister_proxy_registry(config, &prepared.source_ip, context.run_id).await {
            Ok(()) => true,
            Err(cleanup_error) => {
                warn!(run_id = %context.run_id, %sandbox_id, error = %cleanup_error,
                "failed to unregister proxy for unusable blank");
                false
            }
        };
    prepared
        .network_log_session
        .close_for_upload(context.run_id, &config.network_log_drain)
        .await;
    let destroy_completed = destroy_sandbox_panic_safe(factory, prepared.sandbox)
        .await
        .is_completed();
    if !unregister_completed || !destroy_completed {
        telemetry.record(
            BLANK_PREFETCH_REPLACEMENT,
            Duration::ZERO,
            false,
            Some("cleanup_uncertain"),
        );
        inputs
            .controls
            .session_history_restore_plan
            .cancel_and_drain()
            .await;
        warn!(run_id = %context.run_id, %sandbox_id,
            "blank Codex prefetch replacement suppressed after uncertain cleanup");
        return ExecuteOutcome::preparation_failure(error);
    }
    if inputs.controls.cancel.is_cancelled() {
        telemetry.record(
            BLANK_PREFETCH_REPLACEMENT,
            Duration::ZERO,
            false,
            Some("cancelled"),
        );
        inputs
            .controls
            .session_history_restore_plan
            .cancel_and_drain()
            .await;
        let mut outcome = ExecuteOutcome::preparation_failure(RunnerError::Cancelled);
        outcome.mark_cancelled();
        return outcome;
    }
    // Like the fresh retry action, this records admission to the replacement
    // attempt. Fresh preparation and Agent execution retain their own outcomes.
    telemetry.record(BLANK_PREFETCH_REPLACEMENT, Duration::ZERO, true, None);
    info!(run_id = %context.run_id, %sandbox_id,
        "retrying retired blank with Codex prefetch disabled");
    let cancel = inputs.controls.cancel.clone();
    let result = execute_new_sandbox_with_prepared_notifier(
        factory,
        context,
        NewSandboxDispatch {
            id: sandbox_id,
            reuse_result,
        },
        config,
        params,
        telemetry,
        NewSandboxHooks {
            preparation: FreshPreparation::WithoutCodexPrefetchReplacement,
            controls: inputs.controls.with_guest_state_prepared(false),
            prepared_run_payload: inputs.run_payload,
            sandbox_prepared: None,
        },
    )
    .await;
    let mut outcome = result.unwrap_or_else(ExecuteOutcome::preparation_failure);
    if cancel.is_cancelled() {
        outcome.mark_cancelled();
    }
    outcome
}
