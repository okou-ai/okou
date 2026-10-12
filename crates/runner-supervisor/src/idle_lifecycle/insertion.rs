//! Actual pool replacement acceptance and shutdown adoption.

use runner_lifecycle::host_memory_operations::MemoryOperationTask;
use runner_lifecycle::idle_pool::{IdlePoolIncoming, IdlePoolInsertion, IdlePoolInsertionStarted};
use tokio_util::task::task_tracker::TaskTrackerToken;

use super::*;

/// No victim means no cleanup receiver. Incoming ownership transfers only on
/// success; an error leaves the borrowed capsule complete and caller-owned.
pub struct IdlePoolInsertionResult {
    pub snapshot: IdlePoolSnapshot,
    pub retirement: Option<GuardedIdleCleanupTask>,
}

impl IdleDestroyTracker {
    pub async fn insert_pool_entry(
        &self,
        pool: &SharedIdlePool,
        incoming: &mut IdlePoolIncoming,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
        context: &'static str,
    ) -> Result<IdlePoolInsertionResult, MemoryOperationError> {
        let candidate = pool.lock().await.insertion_candidate(incoming)?;
        let mut insertion = IdlePoolInsertion::new(candidate, operations, envelope)?;
        AssertUnwindSafe(insertion.try_grant())
            .catch_unwind()
            .await
            .map_err(|_| MemoryOperationError::ProducerLost)??;
        // Wait for contention without provider callbacks under the pool lock.
        // Revalidate after that wait, then accept only with synchronous lock
        // acquisition: another wait would make this proof stale again.
        drop(pool.lock().await);
        incoming.validate_captured_backing()?;
        let mut pool = pool
            .try_lock()
            .map_err(|_| MemoryOperationError::OwnershipInvariant)?;
        let token = self.tasks.token();
        if self.tasks.is_closed() {
            drop(pool);
            return Err(MemoryOperationError::Closed);
        }
        let started = match insertion.start(&mut pool, incoming, context) {
            Ok(started) => started,
            Err(failure) => {
                drop(pool);
                return Err(failure.into_error());
            }
        };
        let retirement = match started {
            IdlePoolInsertionStarted::Inserted => None,
            IdlePoolInsertionStarted::Replaced(task) => {
                Some(self.adopt_pool_retirement(task, token, context))
            }
        };
        self.notify_reuse_state();
        Ok(IdlePoolInsertionResult {
            snapshot: pool.status_snapshot(),
            retirement,
        })
    }

    pub(crate) fn adopt_pool_retirement(
        &self,
        task: MemoryOperationTask<RetainedIdleDestroyResult>,
        token: TaskTrackerToken,
        context: &'static str,
    ) -> GuardedIdleCleanupTask {
        let notify = self.reuse_state_notify.clone();
        self.track(
            async move {
                let _token = token;
                let result = task.join().await;
                if result
                    .as_ref()
                    .is_ok_and(|result| result.home_cache_promoted)
                {
                    notify.notify_one();
                }
                result
            },
            context,
        )
    }

    /// Registration before synchronous acceptance bridges shutdown to adoption.
    pub(crate) fn acceptance_token(&self) -> Result<TaskTrackerToken, MemoryOperationError> {
        let token = self.tasks.token();
        if self.tasks.is_closed() {
            return Err(MemoryOperationError::Closed);
        }
        Ok(token)
    }
}
