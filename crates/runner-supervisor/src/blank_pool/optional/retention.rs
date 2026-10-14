use std::sync::MutexGuard;

use runner_lifecycle::host_memory_operations::MemoryOperation;
use runner_lifecycle::idle_pool::{
    BlankPreparationResource, IdleActivationOwner, IdlePoolIncoming,
};
use tokio::sync::Notify;
use tokio_util::task::TaskTracker;

use super::*;

#[derive(Clone)]
pub(super) struct Origin {
    pool: std::sync::Weak<tokio::sync::Mutex<IdlePool>>,
    budget: std::sync::Weak<ResourceBudget>,
    status: std::sync::Weak<StatusTracker>,
    tracker: std::sync::Weak<Mutex<Vec<OptionalBlankResult>>>,
    preparation_bytes: u64,
}

impl Origin {
    pub fn new(request: &OptionalBlankPoolRequest<'_>) -> Self {
        Self {
            pool: Arc::downgrade(request.pool),
            budget: Arc::downgrade(request.budget),
            status: Arc::downgrade(request.status),
            tracker: Arc::downgrade(&request.tracker.optional_blank_owners),
            preparation_bytes: request.preparation_bytes,
        }
    }
    pub fn matches(&self, request: &OptionalBlankPoolRequest<'_>) -> bool {
        std::sync::Weak::ptr_eq(&self.pool, &Arc::downgrade(request.pool))
            && std::sync::Weak::ptr_eq(&self.budget, &Arc::downgrade(request.budget))
            && std::sync::Weak::ptr_eq(&self.status, &Arc::downgrade(request.status))
            && std::sync::Weak::ptr_eq(
                &self.tracker,
                &Arc::downgrade(&request.tracker.optional_blank_owners),
            )
            && self.preparation_bytes == request.preparation_bytes
    }
}

#[derive(Clone, Debug, Default)]
pub struct OptionalBlankSnapshot {
    pub finished: bool,
    pub prepared: bool,
    pub published: bool,
    pub retired_exact: bool,
    pub retained_resource: bool,
    pub error: Option<String>,
}

pub(super) enum Payload {
    Creating(Arc<CreateHold>),
    Preparing(Box<BlankPreparationResource>),
    Incoming(Box<IdlePoolIncoming>),
    Cleanup(Box<Option<IdleActivationOwner>>),
}

pub(super) struct State {
    pub payload: Option<Payload>,
    pub borrowed: bool,
    pub snapshot: OptionalBlankSnapshot,
}

/// Outcome observation never owns the only copy of a physical resource/lease.
/// The tracker retains this slot independently through joined shutdown.
#[derive(Clone)]
pub struct OptionalBlankResult {
    pub(super) state: Arc<Mutex<State>>,
    pub(super) changed: Arc<Notify>,
    pub(super) cancel: CancellationToken,
    pub(super) pressure: OptionalPressureControl,
    pub(super) envelope: IdleRetirementEnvelope,
    pub(super) opportunity: Arc<OptionalPressureOpportunity>,
    pub(super) origin: Origin,
}

impl OptionalBlankResult {
    pub(super) fn new(
        pressure: OptionalPressureControl,
        envelope: IdleRetirementEnvelope,
        cancel: CancellationToken,
        opportunity: Arc<OptionalPressureOpportunity>,
        origin: Origin,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                payload: None,
                borrowed: false,
                snapshot: OptionalBlankSnapshot::default(),
            })),
            changed: Arc::new(Notify::new()),
            cancel,
            pressure,
            envelope,
            opportunity,
            origin,
        }
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn snapshot(&self) -> OptionalBlankSnapshot {
        let state = self.lock();
        let mut snapshot = state.snapshot.clone();
        snapshot.retained_resource = state.payload.is_some() || state.borrowed;
        snapshot
    }

    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    pub async fn wait(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.snapshot().finished {
                return;
            }
            changed.await;
        }
    }

    pub(super) fn finish(&self, result: Result<(), String>) {
        let mut state = self.lock();
        state.snapshot.finished = true;
        if let Err(error) = result {
            state.snapshot.error = Some(error);
        }
        drop(state);
        self.changed.notify_waiters();
    }

    pub(super) fn slot(&self) -> Result<Slot, MemoryOperationError> {
        let mut state = self.lock();
        if state.borrowed {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let payload = state.payload.take();
        state.borrowed = true;
        drop(state);
        Ok(Slot {
            result: self.clone(),
            payload,
        })
    }
}

/// Returning a borrowed admission/publication future restores the same capsule.
pub(super) struct Slot {
    pub result: OptionalBlankResult,
    pub payload: Option<Payload>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut state = self.result.lock();
        state.borrowed = false;
        if self.payload.is_some() {
            state.payload = self.payload.take();
        }
    }
}

pub(super) struct CreateHold {
    pub operation: Mutex<Option<MemoryOperation>>,
    pub lease: Mutex<Option<BudgetLease>>,
    pub physical: TaskTracker,
}

impl CreateHold {
    pub fn new(operation: MemoryOperation, lease: BudgetLease) -> Self {
        Self {
            operation: Mutex::new(Some(operation)),
            lease: Mutex::new(Some(lease)),
            physical: TaskTracker::new(),
        }
    }

    pub fn take_operation(&self) -> Result<MemoryOperation, MemoryOperationError> {
        self.operation
            .lock()
            .map_err(|_| MemoryOperationError::AccountingPoisoned)?
            .take()
            .ok_or(MemoryOperationError::Consumed)
    }

    pub fn take_lease(&self) -> Result<BudgetLease, MemoryOperationError> {
        self.lease
            .lock()
            .map_err(|_| MemoryOperationError::AccountingPoisoned)?
            .take()
            .ok_or(MemoryOperationError::Consumed)
    }
}

pub(super) struct CreateCustody {
    pub _hold: Arc<CreateHold>,
    pub _physical: tokio_util::task::task_tracker::TaskTrackerToken,
}

impl IdleDestroyTracker {
    pub fn take_retained_optional_blanks(
        &self,
    ) -> Result<Vec<OptionalBlankResult>, MemoryOperationError> {
        if !self.joined() {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        Ok(self
            .optional_blank_owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain(..)
            .filter(|result| result.snapshot().retained_resource)
            .collect())
    }
}
