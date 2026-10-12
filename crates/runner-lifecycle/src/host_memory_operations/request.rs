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
    /// receiver cannot abort it. The guard retains the same tracked owner when
    /// transferred into blocking I/O, even if its async producer panics. Existing
    /// I/O/producer owners must still be joined by `work`; dropping their futures
    /// does not cancel physical I/O.
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
            // One bounded owner spans both the callback (including settled-phase
            // tails) and its physical guard. A producer panic cannot unregister
            // unfinished blocking I/O merely by dropping its async waiter.
            let tracking = Arc::new(self.shared.tasks.token());
            let operation = MemoryOperation {
                shared: Arc::clone(&self.shared),
                id: Some(id),
                plan: self.plan.clone(),
                _tracking: Arc::clone(&tracking),
            };
            // Registration is serialized with close; runtime spawn/rejection and
            // destruction of either owner occur outside accounting's lock.
            async move {
                let _tracking = tracking;
                let result = work(operation).await;
                let _ = sender.send(result);
            }
        };
        drop(runtime.spawn(owned));
        Ok(MemoryOperationTask { completion })
    }

    /// Terminal-specific transfer. A rejection returns both unused allowances
    /// and the parked payload, rather than dropping resources captured in a
    /// rejected callback. Both guards share one bounded real work owner.
    pub(crate) fn spawn_retirement<P, F, Fut, T>(
        mut self,
        mut tail: Self,
        payload: P,
        work: F,
    ) -> std::result::Result<MemoryOperationTask<T>, Box<RetirementStartFailure<P>>>
    where
        P: Send + 'static,
        F: FnOnce(MemoryOperation, MemoryOperation, P) -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let prepare = || {
            let runtime = tokio::runtime::Handle::try_current().map_err(|_| Error::NoRuntime)?;
            if !Arc::ptr_eq(&self.shared, &tail.shared) {
                return Err(Error::OwnershipInvariant);
            }
            let live_id = self.id.ok_or(Error::Consumed)?;
            let tail_id = tail.id.ok_or(Error::Consumed)?;
            let tracking = {
                let mut ledger = self.shared.lock()?;
                if self.shared.tasks.len() >= self.shared.policy.max_operations {
                    return Err(Error::TaskLimit);
                }
                ledger.start_retirement(live_id, tail_id)?;
                Arc::new(self.shared.tasks.token())
            };
            Ok((runtime, live_id, tail_id, tracking))
        };
        let (runtime, live_id, tail_id, tracking) = match prepare() {
            Ok(prepared) => prepared,
            Err(error) => {
                return Err(Box::new(RetirementStartFailure {
                    error,
                    live: self,
                    tail,
                    payload,
                }));
            }
        };
        self.id = None;
        tail.id = None;
        let live = MemoryOperation {
            shared: Arc::clone(&self.shared),
            id: Some(live_id),
            plan: self.plan.clone(),
            _tracking: Arc::clone(&tracking),
        };
        let tail = MemoryOperation {
            shared: Arc::clone(&tail.shared),
            id: Some(tail_id),
            plan: tail.plan.clone(),
            _tracking: Arc::clone(&tracking),
        };
        let (sender, completion) = oneshot::channel();
        drop(runtime.spawn(async move {
            let _tracking = tracking;
            let result = work(live, tail, payload).await;
            let _ = sender.send(result);
        }));
        Ok(MemoryOperationTask { completion })
    }
}

pub(crate) struct RetirementStartFailure<P> {
    pub error: Error,
    pub live: MemoryGrowthPermit,
    pub tail: MemoryGrowthPermit,
    pub payload: P,
}

impl Drop for MemoryGrowthPermit {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.shared.abandon(id);
        }
    }
}
