//! Keep recovery inventory, physical identity and capacity with Supervisor.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use futures_util::FutureExt;
use sandbox::SandboxId;
use tokio_util::sync::CancellationToken;

use super::job_spawn::SpawnContext;
use crate::SharedFactory;
use crate::executor::{JobParams, SandboxRecoveryHooks};
use crate::idle_lifecycle::SharedIdlePool;
use crate::idle_pool::{DestroyOutcome, IdleDestroyJob, IdleUnparkResult, ReusableIdleSandbox};
use crate::orphan_reap::OrphanedActiveRuns;
use crate::status::StatusTracker;
use runner_executor::ExecutorError;
use runner_types::ids::RunId;

/// Per-job physical identity shared by execution, finalization and panic cleanup.
#[derive(Clone)]
pub(super) struct ActiveSandboxIdentity {
    id: Arc<Mutex<SandboxId>>,
    unresolved: Arc<AtomicBool>,
}

impl ActiveSandboxIdentity {
    pub(super) fn new(id: SandboxId) -> Self {
        Self {
            id: Arc::new(Mutex::new(id)),
            unresolved: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(super) fn current(&self) -> SandboxId {
        *self
            .id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn replace(&self, id: SandboxId) {
        *self
            .id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = id;
    }

    pub(super) fn is_unresolved(&self) -> bool {
        self.unresolved.load(Ordering::Acquire)
    }

    fn mark_unresolved(&self) {
        self.unresolved.store(true, Ordering::Release);
    }
}

#[derive(Clone)]
struct BlankRecovery {
    pool: SharedIdlePool,
    status: Arc<StatusTracker>,
    notify: Arc<tokio::sync::Notify>,
    orphaned: OrphanedActiveRuns,
    factory: SharedFactory,
    current: ActiveSandboxIdentity,
    profile: String,
    rootfs_hash: String,
    device_limits: Option<sandbox::DeviceRateLimits>,
}

pub(super) fn source(
    context: &SpawnContext,
    params: &JobParams,
    factory: SharedFactory,
    current: ActiveSandboxIdentity,
) -> SandboxRecoveryHooks {
    let recovery = BlankRecovery {
        pool: context.idle_pool.clone(),
        status: context.status.clone(),
        notify: context.reuse_state_notify.clone(),
        orphaned: context.orphaned_active_runs.clone(),
        factory,
        current,
        profile: params.profile_name.clone(),
        rootfs_hash: params.rootfs_hash.clone(),
        device_limits: params.device_rate_limits.clone(),
    };
    let retired = recovery.clone();
    let prepared = recovery.clone();
    let uncertain = recovery.clone();
    SandboxRecoveryHooks::new(move |run_id, retired, cancel| {
        let recovery = recovery.clone();
        async move { recovery.acquire(run_id, retired, cancel).await }.boxed()
    })
    .with_retired_notifier(crate::executor::SandboxPreparedNotifier::new(
        move |run_id, sandbox_id| {
            let retired = retired.clone();
            async move {
                if retired.current.current() != sandbox_id {
                    return Err(ExecutorError::Internal(
                        "retired sandbox identity changed".into(),
                    ));
                }
                let snapshot = retired.pool.lock().await.status_snapshot();
                let committed = retired
                    .status
                    .replace_run_sandbox_if_matching(run_id, sandbox_id, sandbox_id, snapshot)
                    .await
                    .map_err(|error| {
                        ExecutorError::Internal(format!("persist retired sandbox status: {error}"))
                    })?;
                if !committed {
                    return Err(ExecutorError::Internal(
                        "retired sandbox status ownership changed".into(),
                    ));
                }
                Ok(())
            }
            .boxed()
        },
    ))
    .with_uncertain_notifier(move |run_id, sandbox_id| {
        uncertain.current.mark_unresolved();
        uncertain.orphaned.insert(run_id, sandbox_id);
    })
    .with_prepared_notifier(crate::executor::SandboxPreparedNotifier::new(
        move |run_id, sandbox_id| {
            let prepared = prepared.clone();
            async move {
                if prepared.current.current() != sandbox_id {
                    return Err(ExecutorError::Internal(
                        "prepared replacement identity changed".into(),
                    ));
                }
                let committed = prepared
                    .status
                    .mark_run_running_if_matching(run_id, sandbox_id)
                    .await
                    .map_err(|error| {
                        ExecutorError::Internal(format!("persist prepared replacement: {error}"))
                    })?;
                if committed {
                    Ok(())
                } else {
                    Err(ExecutorError::Internal(
                        "prepared replacement status ownership changed".into(),
                    ))
                }
            }
            .boxed()
        },
    ))
}

impl BlankRecovery {
    async fn acquire(
        &self,
        run_id: RunId,
        retired: SandboxId,
        cancel: CancellationToken,
    ) -> Result<Option<ReusableIdleSandbox>, ExecutorError> {
        if cancel.is_cancelled() {
            return Err(ExecutorError::Cancelled);
        }
        let (entry, snapshot) = {
            let mut pool = self.pool.lock().await;
            let Ok(entry) = pool.reserve_blank(&self.profile, &self.device_limits) else {
                tracing::info!(%run_id, reason = "no_compatible_blank", "disk recovery blank unavailable");
                return Ok(None);
            };
            (entry, pool.status_snapshot())
        };
        let replacement = entry.sandbox_id();
        // A persistence failure can follow an in-memory commit. Panic cleanup
        // must already name this exclusively owned blank before that await.
        self.current.replace(replacement);
        self.notify.notify_one();
        let committed = self
            .status
            .replace_run_sandbox_if_matching(run_id, retired, replacement, snapshot)
            .await;
        if !matches!(committed, Ok(true)) {
            self.retire(run_id, retired, replacement, entry.into_destroy_job())
                .await?;
            return Err(ExecutorError::Internal(
                "blank replacement status ownership was not committed".into(),
            ));
        }
        if entry.rootfs_hash() != self.rootfs_hash || cancel.is_cancelled() {
            tracing::info!(%run_id, %replacement, reason = "incompatible_or_cancelled", "disk recovery blank rejected");
            self.retire(
                run_id,
                retired,
                replacement,
                entry.into_destroy_job_without_home_promotion_for_mismatch(),
            )
            .await?;
            return if cancel.is_cancelled() {
                Err(ExecutorError::Cancelled)
            } else {
                Ok(None)
            };
        }
        match entry.try_unpark_for_run(run_id).await {
            IdleUnparkResult::Failed { destroy_job, .. } => {
                tracing::info!(%run_id, %replacement, reason = "unpark_failed", "disk recovery blank activation failed");
                self.retire(run_id, retired, replacement, *destroy_job)
                    .await?;
                Ok(None)
            }
            IdleUnparkResult::Reused {
                sandbox,
                budget_lease,
            } => {
                let running = self
                    .status
                    .mark_run_running_if_matching(run_id, replacement)
                    .await;
                if !matches!(running, Ok(true)) || cancel.is_cancelled() {
                    let job = sandbox.into_destroy_job(
                        self.factory.clone(),
                        budget_lease,
                        "disk_replacement_activation_failed",
                    );
                    self.retire(run_id, retired, replacement, job).await?;
                    return Err(if cancel.is_cancelled() {
                        ExecutorError::Cancelled
                    } else {
                        ExecutorError::Internal(
                            "blank replacement running ownership was not committed".into(),
                        )
                    });
                }
                // The caller invokes us only after confirmed old destruction.
                // Its retained active lease now covers this compatible VM, so
                // the blank's duplicate lease can be released at this transfer.
                drop(budget_lease);
                Ok(Some(*sandbox))
            }
        }
    }

    async fn retire(
        &self,
        run_id: RunId,
        retired: SandboxId,
        replacement: SandboxId,
        job: IdleDestroyJob,
    ) -> Result<(), ExecutorError> {
        let cleanup = job
            .run_retaining_lease("disk_replacement_blank_failed")
            .await;
        if cleanup.outcome != DestroyOutcome::Completed {
            self.current.mark_unresolved();
            self.orphaned
                .insert_retaining_budget(run_id, replacement, cleanup.budget_lease);
            return Err(ExecutorError::Internal(
                "blank replacement cleanup was uncertain".into(),
            ));
        }
        drop(cleanup.budget_lease);
        self.current.replace(retired);
        let snapshot = self.pool.lock().await.status_snapshot();
        let restored = self
            .status
            .replace_run_sandbox_if_matching(run_id, replacement, retired, snapshot)
            .await;
        if !matches!(restored, Ok(true)) {
            return Err(ExecutorError::Internal(
                "cold replacement status ownership was not committed".into(),
            ));
        }
        self.notify.notify_one();
        Ok(())
    }
}
