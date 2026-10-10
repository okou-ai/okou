use std::future::Future;
use std::sync::Arc;

use tokio::sync::oneshot;

use super::accounting::{CapturedPlan, Stage};
use super::work::MemoryOperationTask;
use super::{
    MemoryOperation, MemoryOperationError as Error, MemoryOperationId, MemoryOperationPlan, Result,
    Shared,
};

/// A bounded queued request; dropping it releases only its unused queue claim.
#[must_use]
pub struct MemoryGrowthRequest {
    pub(super) shared: Arc<Shared>,
    pub(super) id: Option<MemoryOperationId>,
    // Keep provider payloads alive until after the mutation guard has dropped.
    pub(super) plan: CapturedPlan,
}

impl MemoryGrowthRequest {
    pub fn id(&self) -> Option<MemoryOperationId> {
        self.id
    }

    /// A failed/deferred decision preserves this request for an owned retry.
    /// Every call starts a new observation, never reuses an earlier sample.
    pub async fn try_grant(&mut self) -> Result<MemoryGrowthPermit> {
        let id = self.id.ok_or(Error::Consumed)?;
        let sample = self.shared.sample().await?;
        let mut ledger = self.shared.lock()?;
        let plan = ledger.plan(id, Stage::Queued)?;
        ledger.grant(id, plan, Stage::Queued, sample, self.shared.policy)?;
        self.id = None;
        Ok(MemoryGrowthPermit {
            shared: Arc::clone(&self.shared),
            id: Some(id),
            plan: self.plan.clone(),
        })
    }
}

impl Drop for MemoryGrowthRequest {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.shared.abandon(id);
        }
    }
}

/// Proven-not-started allowance. No physical preparation may begin before
/// `spawn` transfers this guard to the real tracked phase owner.
#[must_use]
pub struct MemoryGrowthPermit {
    shared: Arc<Shared>,
    id: Option<MemoryOperationId>,
    plan: CapturedPlan,
}

impl MemoryGrowthPermit {
    pub fn id(&self) -> Option<MemoryOperationId> {
        self.id
    }

    /// Follow actual resource selection before start. Failure leaves the old
    /// captured allowance/backing intact; a started replacement needs a new guard.
    pub async fn rebind(&mut self, plan: MemoryOperationPlan) -> Result<()> {
        let id = self.id.ok_or(Error::Consumed)?;
        let plan = CapturedPlan::capture(plan, self.shared.policy)?;
        let sample = self.shared.sample().await?;
        self.shared
            .lock()?
            .grant(id, plan.clone(), Stage::Granted, sample, self.shared.policy)?;
        // Old provider payloads can run Drop only outside accounting.
        self.plan = plan;
        Ok(())
    }

    /// Transfer accepted work to an independently progressing tracked owner.
    /// `work` is invoked inside that task, not before registration. The returned
    /// receiver cannot abort it. Existing blocking I/O/producer owners must still
    /// be joined by `work`; dropping their futures does not cancel physical I/O.
    /// The real phase owner explicitly calls `complete_phase` after its positive
    /// boundary; merely returning a result never settles the allowance.
    pub fn spawn<F, Fut, T>(mut self, work: F) -> Result<MemoryOperationTask<T>>
    where
        F: FnOnce(MemoryOperation) -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| Error::NoRuntime)?;
        let id = self.id.ok_or(Error::Consumed)?;
        let (sender, completion) = oneshot::channel();
        let owned = {
            let mut ledger = self.shared.lock()?;
            // Settled VM phases can still have required tails. Registry capacity
            // alone cannot bound those retained futures/provider payloads.
            if self.shared.tasks.len() >= self.shared.policy.max_operations {
                return Err(Error::TaskLimit);
            }
            ledger.start(id)?;
            self.id = None;
            let operation = MemoryOperation {
                shared: Arc::clone(&self.shared),
                id: Some(id),
                plan: self.plan.clone(),
            };
            // Register before shutdown can observe the transfer. Only wrapping
            // happens here: spawning (including synchronous rejection/drop by a
            // stopped runtime) must occur outside accounting's mutation lock.
            self.shared.tasks.track_future(async move {
                let result = work(operation).await;
                let _ = sender.send(result);
            })
        };
        drop(runtime.spawn(owned));
        Ok(MemoryOperationTask { completion })
    }
}

impl Drop for MemoryGrowthPermit {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.shared.abandon(id);
        }
    }
}
