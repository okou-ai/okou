//! Required cleanup acceptance and completion-independent resource recovery.

use runner_lifecycle::host_memory_operations::MemoryOperationTask;
use runner_lifecycle::idle_pool::{
    AcceptedActivationCleanup, ActivationCleanupOutcome, IdleActivationOwner,
};
use tokio_util::task::task_tracker::TaskTrackerToken;

use super::*;

/// Observes accepted work and explicitly retrieves its original logical lease.
/// Supervisor independently retains the resource/lease if this observer drops.
pub struct GuardedActivationCleanupTask {
    completion: IdleCleanupTask<Result<ActivationCleanupOutcome, MemoryOperationError>>,
    retained: RetainedActivationCleanup,
}

impl GuardedActivationCleanupTask {
    pub async fn join(
        &mut self,
    ) -> Result<Result<ActivationCleanupOutcome, MemoryOperationError>, oneshot::error::RecvError>
    {
        self.completion.join().await
    }

    pub fn take_completed_lease(&self) -> Result<BudgetLease, MemoryOperationError> {
        self.retained.take_completed_lease()
    }
}

impl IdleDestroyTracker {
    /// Admission borrows the exclusive capsule, so caller cancellation before
    /// acceptance cannot discard it. Acceptance, shutdown token and retention
    /// installation are synchronous before the first completion/status await.
    pub async fn retire_activation_owner(
        &self,
        owner: &mut Option<IdleActivationOwner>,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
        context: &'static str,
    ) -> Result<GuardedActivationCleanupTask, MemoryOperationError> {
        owner
            .as_mut()
            .ok_or(MemoryOperationError::Consumed)?
            .grant_cleanup(operations, envelope)
            .await?;
        let token = self.acceptance_token()?;
        let accepted = IdleActivationOwner::start_cleanup(owner, context)?;
        Ok(self.adopt_activation_cleanup(accepted, token, context))
    }

    pub(crate) fn retain_activation_cleanup(
        &self,
        accepted: AcceptedActivationCleanup,
    ) -> (
        MemoryOperationTask<ActivationCleanupOutcome>,
        RetainedActivationCleanup,
    ) {
        let (task, retained) = accepted.into_parts();
        let mut registry = self
            .activation_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        registry.retain(RetainedActivationCleanup::needs_retention);
        registry.push(retained.clone());
        (task, retained)
    }

    pub(crate) fn adopt_activation_cleanup(
        &self,
        accepted: AcceptedActivationCleanup,
        token: TaskTrackerToken,
        context: &'static str,
    ) -> GuardedActivationCleanupTask {
        let (task, retained) = self.retain_activation_cleanup(accepted);
        let owners = self.activation_owners.clone();
        let notify = self.reuse_state_notify.clone();
        let completion = self.track(
            async move {
                let _token = token;
                let result = task.join().await;
                if matches!(
                    result,
                    Ok(ActivationCleanupOutcome::Completed {
                        home_cache_promoted: true
                    })
                ) {
                    notify.notify_one();
                }
                owners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .retain(RetainedActivationCleanup::needs_retention);
                result
            },
            context,
        );
        GuardedActivationCleanupTask {
            completion,
            retained,
        }
    }

    /// Recover every retained capsule or unclaimed completed lease after joined shutdown.
    /// The production root must keep these owners and uncertainty until its
    /// explicit reconciliation boundary; taking them is not physical credit.
    pub fn take_retained_activation_owners(
        &self,
    ) -> Result<Vec<IdleActivationOwner>, MemoryOperationError> {
        if !self.tasks.is_closed() || !self.tasks.is_empty() {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        Ok(self
            .activation_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain(..)
            .filter_map(|retained| retained.take_owner())
            .map(|owner| *owner)
            .collect())
    }
}
