//! Ordinary local resource admission for supplied HTTP and filesystem work.
use crate::blank_pool::BlankPoolDiagnostics;
use crate::finalizing_admission::FinalizingAdmission;
use crate::idle_lifecycle::{
    IdleDestroyTracker, IdlePressureOutcome, IdlePressureRequest, IdlePressureSelection,
    ReservedIdleActivation, SharedIdlePool, rollback_reserved_idle_for_spawn,
    select_idle_entries_for_pressure, set_idle_status_snapshot,
};
use runner_executor::executor::BlankPoolSelection;
use runner_lifecycle::active_runs::ActiveRuns;
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::StatusTracker;
use runner_provider::{
    ClaimedJob, JobCandidate, JobProvider, LocalJobSource, RunCancellationRegistration,
    RunCancellationRegistry,
};
use runner_types::ids::RunId;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{Notify, oneshot, watch};
use tracing::warn;

/// Narrow, borrowed composition inputs required for the admission-to-claim transaction.
#[derive(Clone, Copy)]
pub struct PreClaimResources<'a> {
    pub active_runs: &'a ActiveRuns,
    pub idle_pool: &'a SharedIdlePool,
    pub status: &'a Arc<StatusTracker>,
    pub mode_rx: &'a watch::Receiver<RunnerMode>,
    pub cancel_tokens: &'a RunCancellationRegistry,
    pub provider: &'a dyn JobProvider,
    pub budget: &'a Arc<ResourceBudget>,
    pub idle_destroy_tracker: &'a IdleDestroyTracker,
    pub reuse_state_notify: &'a Notify,
    pub blank_pool_diagnostics: &'a BlankPoolDiagnostics,
}

/// Local custody retained through activation or ordinary rollback.
pub enum AdmittedResource {
    Finalizing(FinalizingAdmission),
    Fresh(BudgetLease),
    Reusable(ReservedIdleActivation),
}

/// Ordinary local resources, excluding a finalizing predecessor proof.
pub enum SandboxAdmittedResource {
    Fresh(BudgetLease),
    Reusable(ReservedIdleActivation),
}

pub struct AdmittedClaim {
    pub claimed: ClaimedJob,
    pub resource: AdmittedResource,
    pub cancellation: RunCancellationRegistration,
    pub claim_returned_at: Instant,
    pub blank_pool_selection: Option<BlankPoolSelection>,
}

/// Concrete profile facts supplied by Runner, without exposing a pre-claim reservation.
pub struct PreClaimRequest<'a> {
    pub candidate: JobCandidate,
    pub profile_name: &'a str,
    pub job_vcpu: u32,
    pub job_memory: u32,
    pub device_rate_limits: &'a Option<sandbox::DeviceRateLimits>,
}

pub enum PreClaimOutcome {
    Claimed(Box<AdmittedClaim>),
    Deferred,
}
pub(crate) enum SuppliedAdmission {
    Admitted(Box<AdmittedClaim>),
    Rejected,
    Unknown,
}

/// Complete-input resource admission, including a matching local producer handoff.
/// No remote acquisition participates here.
pub(crate) async fn admit_supplied(
    context: runner_types::types::ExecutionContext,
    request: PreClaimRequest<'_>,
    deadline: tokio::time::Instant,
    ctx: &PreClaimResources<'_>,
    admission_ready: oneshot::Sender<()>,
) -> SuppliedAdmission {
    if *ctx.mode_rx.borrow() != RunnerMode::Running || tokio::time::Instant::now() >= deadline {
        return SuppliedAdmission::Rejected;
    }
    let run_id = context.run_id;
    // Live Run ownership outlasts the short HTTP deduplication window.
    if ctx.cancel_tokens.handle(run_id).await.is_some() {
        return SuppliedAdmission::Unknown;
    }
    // Public completion can precede local sandbox/home publication. Identify
    // the actual producer from authoritative complete input, never acquisition advice.
    let finalizing = context
        .native_continuation
        .as_ref()
        .filter(|native| native.session_id.is_some())
        .and_then(|native| native.generation_run_id.as_deref())
        .and_then(|source| source.parse::<RunId>().ok())
        .filter(|source| *source != run_id)
        .and_then(|source_run_id| {
            let reuse_key = context.reuse_key()?;
            let predecessor = ctx.active_runs.finalizing_predecessor(
                source_run_id,
                reuse_key,
                request.profile_name,
            )?;
            Some(FinalizingAdmission {
                predecessor,
                deadline: deadline.into_std(),
                reuse_key: reuse_key.to_owned(),
                source_run_id,
                // Revalidated against the bound execution context before waiting.
                native_generation_run_id: None,
            })
        });
    let (resource, blank_pool_selection) = if let Some(finalizing) = finalizing {
        (AdmittedResource::Finalizing(finalizing), None)
    } else {
        let Some(resource) = acquire_local_admission_resource(
            &request.candidate,
            request.profile_name,
            request.job_vcpu,
            request.job_memory,
            request.device_rate_limits,
            ctx,
        )
        .await
        else {
            return SuppliedAdmission::Rejected;
        };
        resource
    };
    let cancellation = match ctx.cancel_tokens.register(run_id).await {
        Ok(registration) => registration,
        Err(_) => {
            rollback_untracked_resource(resource, ctx).await;
            return SuppliedAdmission::Unknown;
        }
    };
    let claimed = match ctx.provider.bind_supplied(context).await {
        Ok(claimed) if claimed.context().run_id == run_id => claimed,
        _ => {
            cancellation.unregister().await;
            rollback_untracked_resource(resource, ctx).await;
            return SuppliedAdmission::Rejected;
        }
    };
    if *ctx.mode_rx.borrow() != RunnerMode::Running || tokio::time::Instant::now() >= deadline {
        cancellation.unregister().await;
        rollback_untracked_resource(resource, ctx).await;
        return SuppliedAdmission::Rejected;
    }
    let _ = admission_ready.send(());
    SuppliedAdmission::Admitted(Box::new(AdmittedClaim {
        claimed,
        resource,
        cancellation,
        // The shared local startup timer begins at custody transfer. Supplied
        // jobs have no remote acquisition phase.
        claim_returned_at: Instant::now(),
        blank_pool_selection,
    }))
}

/// Atomic filesystem acquisition after reversible ordinary local admission.
/// The owning task is joined through claim settlement and activation/rollback.
pub async fn admit_and_claim(
    request: PreClaimRequest<'_>,
    source: &dyn LocalJobSource,
    ctx: &PreClaimResources<'_>,
    admission_ready: oneshot::Sender<()>,
) -> PreClaimOutcome {
    let run_id = request.candidate.run_id();
    let Some((resource, blank_pool_selection)) = acquire_local_admission_resource(
        &request.candidate,
        request.profile_name,
        request.job_vcpu,
        request.job_memory,
        request.device_rate_limits,
        ctx,
    )
    .await
    else {
        return PreClaimOutcome::Deferred;
    };
    let cancellation = match ctx.cancel_tokens.register(run_id).await {
        Ok(registration) => registration,
        Err(_) => {
            rollback_untracked_resource(resource, ctx).await;
            return PreClaimOutcome::Deferred;
        }
    };
    let mode = *ctx.mode_rx.borrow();
    match mode {
        RunnerMode::Running => {}
        RunnerMode::Stopping => {
            cancellation.request_hard_cancellation().await;
        }
        RunnerMode::Starting | RunnerMode::Draining | RunnerMode::Stopped => {
            cancellation.unregister().await;
            rollback_untracked_resource(resource, ctx).await;
            return PreClaimOutcome::Deferred;
        }
    }
    let _ = admission_ready.send(());
    let claimed = source.claim(request.candidate).await;
    let claim_returned_at = Instant::now();
    let Some(claimed) = claimed else {
        cancellation.unregister().await;
        rollback_untracked_resource(resource, ctx).await;
        return PreClaimOutcome::Deferred;
    };
    if claimed.context().run_id != run_id {
        warn!(%run_id, context_run_id = %claimed.context().run_id, "local source returned a mismatched run_id");
        cancellation.unregister().await;
        rollback_untracked_resource(resource, ctx).await;
        return PreClaimOutcome::Deferred;
    }
    PreClaimOutcome::Claimed(Box::new(AdmittedClaim {
        claimed,
        resource,
        cancellation,
        claim_returned_at,
        blank_pool_selection,
    }))
}

async fn acquire_local_admission_resource(
    candidate: &JobCandidate,
    profile_name: &str,
    job_vcpu: u32,
    job_memory: u32,
    device_rate_limits: &Option<sandbox::DeviceRateLimits>,
    ctx: &PreClaimResources<'_>,
) -> Option<(AdmittedResource, Option<BlankPoolSelection>)> {
    let IdlePressureOutcome {
        selection,
        blank_pool_selection,
        idle_snapshot,
    } = select_idle_entries_for_pressure(
        ctx.idle_pool,
        ctx.idle_destroy_tracker,
        ctx.budget,
        Vec::new(),
        IdlePressureRequest {
            run_id: candidate.run_id(),
            reuse_key: candidate.reuse_key(),
            profile_name,
            device_rate_limits,
            allow_compatible_blank: true,
            blank_pool_diagnostics: Some(ctx.blank_pool_diagnostics),
            vcpu: job_vcpu,
            memory_mb: job_memory,
            context: "candidate_admission_oldest",
        },
    )
    .await;
    if let Some(snapshot) = idle_snapshot {
        let status = Arc::clone(ctx.status);
        ctx.idle_destroy_tracker.spawn_cleanup(
            async move { set_idle_status_snapshot(&status, snapshot).await },
            "candidate_admission_idle_status",
        );
    }
    match selection {
        IdlePressureSelection::Reusable(reservation) => Some((
            AdmittedResource::Reusable(reservation),
            blank_pool_selection,
        )),
        IdlePressureSelection::Fresh(lease) => {
            // Claimed activation rechecks the pool, so claim need not wait for it.
            Some((AdmittedResource::Fresh(lease), blank_pool_selection))
        }
        IdlePressureSelection::Exhausted(retiring_leases) => {
            drop(retiring_leases);
            None
        }
    }
}

async fn rollback_untracked_resource(resource: AdmittedResource, ctx: &PreClaimResources<'_>) {
    match resource {
        AdmittedResource::Finalizing(admission) => drop(admission),
        AdmittedResource::Fresh(lease) => drop(lease),
        AdmittedResource::Reusable(reservation) => {
            rollback_reserved_idle_for_spawn(
                reservation,
                ctx.idle_pool,
                ctx.status,
                ctx.reuse_state_notify,
                ctx.idle_destroy_tracker,
            )
            .await
        }
    }
}

/// Recover ordinary local custody after execution/reporting ownership is settled.
pub async fn rollback_sandbox_admitted_resource(
    resource: SandboxAdmittedResource,
    ctx: &PreClaimResources<'_>,
) {
    let resource = match resource {
        SandboxAdmittedResource::Fresh(lease) => AdmittedResource::Fresh(lease),
        SandboxAdmittedResource::Reusable(reservation) => AdmittedResource::Reusable(reservation),
    };
    rollback_untracked_resource(resource, ctx).await;
}

#[cfg(test)]
mod tests;
