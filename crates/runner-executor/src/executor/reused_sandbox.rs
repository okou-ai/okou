//! Own reused preparation until optional prefetch can safely hand off to Agent execution.

use std::time::{Duration, Instant};

use sandbox::{Sandbox, SandboxFactory};
use tracing::{info, warn};

use super::agent_run::{PreparedGuestRuntime, PreparedRunInputs, RunStart};
use super::sandbox_run::{
    DiskReplacement, FreshPreparation, NewSandboxHooks, PreparedSandboxRun,
    SANDBOX_PROXY_REGISTER_FAILED, cancel_prepared_storage, destroy_sandbox_panic_safe,
    execute_new_sandbox_with_prepared_notifier, execute_prepared_sandbox_attempt, prepare_storage,
    register_proxy, replace_disk_full_sandbox, unregister_proxy_registry,
};
use super::{ExecuteOutcome, ExecutionFailure, ExecutorConfig, JobParams, NewSandboxDispatch};
use crate::error::RunnerError;
use crate::home_image_cache::HomeImageLease;
use crate::idle_pool::IdleSandboxKind;
use crate::telemetry::JobTelemetry;
use runner_types::types::ExecutionContext;

const BLANK_PREFETCH_REPLACEMENT: &str = "runner_blank_sandbox_retry_without_codex_prefetch";

pub(super) struct ReusedSandboxRun<'a> {
    pub(super) sandbox_id: sandbox::SandboxId,
    pub(super) factory: &'a dyn SandboxFactory,
    pub(super) params: &'a JobParams,
    pub(super) sandbox: Box<dyn Sandbox>,
    pub(super) source_ip: String,
    pub(super) home_image: Option<HomeImageLease>,
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
    let disk_recovery = inputs.controls.disk_recovery;
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
            // Time required registration separately from storage preparation;
            // addon receipt completion is not awaited.
            let proxy_register_started = Instant::now();
            let registration = register_proxy(config, context, &run.source_ip).await;
            telemetry.record(
                "runner_reused_sandbox_proxy_register",
                proxy_register_started.elapsed(),
                registration.is_ok(),
                registration
                    .as_ref()
                    .err()
                    .map(|_| SANDBOX_PROXY_REGISTER_FAILED),
            );
            registration
        }
        Err(error) => Err(error),
    };
    let network_log_session = match network_log_session {
        Ok(session) => session,
        Err(error) => {
            cancel_prepared_storage(&mut inputs.controls, telemetry).await;
            telemetry.record(
                "runner_reused_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            let outcome = ExecuteOutcome::reused_sandbox_failure(
                ExecutionFailure::from_error(error.to_string()),
                run.sandbox,
                run.source_ip.clone(),
                run.home_image,
            );
            if disk_recovery
                && unregister_proxy_registry(config, &run.source_ip, context.run_id)
                    .await
                    .is_ok()
            {
                return Box::pin(replace_disk_full_sandbox(
                    run.factory,
                    context,
                    config,
                    run.params,
                    telemetry,
                    DiskReplacement {
                        dispatch: NewSandboxDispatch {
                            id: run.sandbox_id,
                            reuse_result: start.reuse_result,
                        },
                        attempt: super::sandbox_run::PreparedSandboxAttempt {
                            outcome,
                            retry_inputs: Some(Box::new(inputs)),
                        },
                        home_image: None,
                    },
                ))
                .await;
            }
            return outcome;
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
        drop(run.home_image);
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
    let reuse_result = start.reuse_result;
    let attempt = execute_prepared_sandbox_attempt(
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
    if attempt.retry_inputs.is_some() {
        return replace_disk_full_sandbox(
            run.factory,
            context,
            config,
            run.params,
            telemetry,
            DiskReplacement {
                dispatch: NewSandboxDispatch {
                    id: run.sandbox_id,
                    reuse_result,
                },
                attempt,
                home_image: run.home_image,
            },
        )
        .await;
    }
    let mut outcome = attempt.outcome;
    outcome.home_image = run.home_image;
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
        if !destroy_completed
            && inputs.controls.disk_recovery
            && let Some(source) = inputs.controls.sandbox_recovery.as_ref()
        {
            source.uncertain(context.run_id, sandbox_id);
        }
        telemetry.record(
            BLANK_PREFETCH_REPLACEMENT,
            Duration::ZERO,
            false,
            Some("cleanup_uncertain"),
        );
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
        let mut outcome = ExecuteOutcome::preparation_failure(RunnerError::Cancelled);
        outcome.mark_cancelled();
        return outcome;
    }
    if inputs.controls.disk_recovery
        && let Some(source) = inputs.controls.sandbox_recovery.as_ref()
        && let Err(error) = source.retired(context.run_id, sandbox_id).await
    {
        return ExecuteOutcome::preparation_failure(error);
    }
    // Like the fresh retry action, this records admission to the replacement
    // attempt. Fresh preparation and Agent execution retain their own outcomes.
    telemetry.record(BLANK_PREFETCH_REPLACEMENT, Duration::ZERO, true, None);
    info!(run_id = %context.run_id, %sandbox_id,
        "retrying retired blank with Codex prefetch disabled");
    let cancel = inputs.controls.cancel.clone();
    let prepared_notifier = inputs
        .controls
        .sandbox_recovery
        .as_ref()
        .and_then(|source| source.prepared.clone());
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
            preparation: if inputs.controls.disk_recovery {
                FreshPreparation::DiskReplacement
            } else {
                FreshPreparation::WithoutCodexPrefetchReplacement
            },
            controls: inputs.controls.with_guest_state_prepared(false),
            prepared_run_payload: inputs.run_payload,
            sandbox_prepared: prepared_notifier.as_ref(),
        },
    )
    .await;
    let mut outcome = result.unwrap_or_else(ExecuteOutcome::preparation_failure);
    if cancel.is_cancelled() {
        outcome.mark_cancelled();
    }
    outcome
}
