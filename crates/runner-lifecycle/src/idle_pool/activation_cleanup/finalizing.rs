//! Typed finalizing custody over the shared required saving engine.

use super::*;
use crate::idle_pool::entry::{
    IdleSandboxResources, ImmediateHandoffCandidate, ParkedIdleCandidate,
};
use crate::idle_pool::{FinalizingHandoffCandidate, IdleParkCandidate};
use sandbox::SandboxFinalExecParkHandoffPoint;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalizingHandoffState {
    Parked,
    Running(SandboxFinalExecParkHandoffPoint),
    Uncertain,
    Transferred,
}

#[derive(Clone, Copy)]
enum Binding {
    Delivered {
        successor: RunId,
        predecessor: RunId,
    },
    Undelivered {
        predecessor: RunId,
    },
}

#[must_use]
pub struct ActivatedFinalizingHandoff {
    pub sandbox: Box<ReusableIdleSandbox>,
    pub budget_lease: BudgetLease,
    pub factory: Arc<Box<dyn SandboxFactory>>,
}

/// Keep outside every observation/activation future. Running ownership is never
/// converted to parked inventory; only explicit covered cleanup may dispose it.
#[must_use]
pub struct GuardedFinalizingHandoffOwner {
    owner: Option<IdleActivationOwner>,
    binding: Binding,
    state: FinalizingHandoffState,
    capture_failed: bool,
    activation_ready: bool,
}

impl GuardedFinalizingHandoffOwner {
    pub fn new(candidate: Box<FinalizingHandoffCandidate>) -> Self {
        let (candidate, successor, predecessor) = candidate.into_guarded_parts();
        Self::from_candidate(
            candidate,
            Binding::Delivered {
                successor,
                predecessor,
            },
        )
    }

    pub fn undelivered(candidate: IdleParkCandidate, predecessor: RunId) -> Self {
        Self::from_candidate(candidate, Binding::Undelivered { predecessor })
    }

    fn from_candidate(candidate: IdleParkCandidate, binding: Binding) -> Self {
        let (owner, state) = match candidate {
            IdleParkCandidate::Ordinary(candidate) => (
                IdleActivationOwner::from_entry(
                    candidate.into_idle_entry(std::time::Instant::now()),
                ),
                FinalizingHandoffState::Parked,
            ),
            IdleParkCandidate::Immediate(candidate) => {
                let state = FinalizingHandoffState::Running(candidate.handoff_point);
                (
                    IdleActivationOwner::from_parts(
                        candidate.resources,
                        candidate.metadata,
                        candidate.budget_lease,
                        IdleActivationState::Uncertain,
                        candidate.retirement_backing,
                    ),
                    state,
                )
            }
        };
        Self {
            owner: Some(owner),
            binding,
            state,
            capture_failed: false,
            activation_ready: false,
        }
    }

    pub fn state(&self) -> FinalizingHandoffState {
        self.state
    }

    pub fn sandbox_id(&self) -> Option<SandboxId> {
        self.owner.as_ref().map(IdleActivationOwner::sandbox_id)
    }

    pub fn reuse_key(&self) -> Option<&str> {
        self.owner
            .as_ref()
            .and_then(|owner| owner.metadata.reuse_key())
    }

    pub fn has_captured_backing(&self) -> bool {
        self.owner
            .as_ref()
            .is_some_and(|owner| owner.original_backing.is_some())
    }

    fn predecessor(&self) -> RunId {
        match self.binding {
            Binding::Delivered { predecessor, .. } | Binding::Undelivered { predecessor } => {
                predecessor
            }
        }
    }

    fn validate_metadata(&self) -> Result<(), MemoryOperationError> {
        let owner = self.owner.as_ref().ok_or(MemoryOperationError::Consumed)?;
        if owner.metadata.source_run_id != Some(self.predecessor())
            || owner.metadata.history_generation_run_id != Some(self.predecessor())
            || owner.metadata.reuse_key().is_none()
        {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        if let Some(promotion) = &owner.promotion
            && (promotion.run_id() != self.predecessor()
                || promotion.sandbox_id() != owner.metadata.sandbox_id
                || promotion.profile_name() != owner.metadata.profile_name
                || promotion.rootfs_hash() != owner.metadata.rootfs_hash
                || Some(promotion.reuse_key()) != owner.metadata.reuse_key())
        {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        Ok(())
    }

    pub fn capture_backing(&mut self) -> Result<(), MemoryOperationError> {
        self.validate_metadata()?;
        if self.capture_failed {
            return Err(MemoryOperationError::ProducerLost);
        }
        if matches!(self.binding, Binding::Delivered { .. }) && !self.has_captured_backing() {
            // Delivery cannot create an original generation after a broker
            // wait. Only the exclusive producer may capture before transfer.
            return Err(MemoryOperationError::MissingBacking);
        }
        let result = self
            .owner
            .as_mut()
            .ok_or(MemoryOperationError::Consumed)?
            .capture_original_backing();
        if result.is_err() && !self.has_captured_backing() {
            // A failed initial capture cannot later adopt a replacement as
            // the original generation. Recovery needs explicit reconciliation.
            self.capture_failed = true;
            self.state = FinalizingHandoffState::Uncertain;
        }
        result
    }

    /// Synchronously capture or revalidate the original backing through provider
    /// callbacks before moving the candidate; this operation does not await.
    ///
    /// Call this before acquiring the broker lock. The returned parked/running
    /// candidate carries the captured backing proof, so the subsequent broker
    /// ownership transfer needs no new provider callbacks.
    pub fn take_undelivered_candidate(
        &mut self,
    ) -> Result<IdleParkCandidate, MemoryOperationError> {
        if !matches!(self.binding, Binding::Undelivered { .. })
            || !matches!(
                self.state,
                FinalizingHandoffState::Parked | FinalizingHandoffState::Running(_)
            )
        {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        self.capture_backing()?;
        let current = self.owner.as_ref().ok_or(MemoryOperationError::Consumed)?;
        if current.sandbox.is_none() || current.lease.is_none() {
            return Err(MemoryOperationError::Consumed);
        }
        let mut owner = self.owner.take().ok_or(MemoryOperationError::Consumed)?;
        let resources = IdleSandboxResources {
            sandbox: owner.sandbox.take().ok_or(MemoryOperationError::Consumed)?,
            factory: owner.factory,
            home_promotion: owner.promotion,
        };
        let candidate = match self.state {
            FinalizingHandoffState::Parked => IdleParkCandidate::Ordinary(ParkedIdleCandidate {
                resources,
                metadata: owner.metadata,
                budget_lease: owner.lease.take().ok_or(MemoryOperationError::Consumed)?,
                retirement_backing: owner.original_backing,
            }),
            FinalizingHandoffState::Running(point) => {
                IdleParkCandidate::Immediate(ImmediateHandoffCandidate {
                    resources,
                    metadata: owner.metadata,
                    budget_lease: owner.lease.take().ok_or(MemoryOperationError::Consumed)?,
                    handoff_point: point,
                    retirement_backing: owner.original_backing,
                })
            }
            _ => return Err(MemoryOperationError::OwnershipInvariant),
        };
        self.state = FinalizingHandoffState::Transferred;
        Ok(candidate)
    }

    pub async fn activate(
        &mut self,
        successor: RunId,
        predecessor: RunId,
    ) -> Result<ActivatedFinalizingHandoff, String> {
        self.prepare_activation(successor, predecessor).await?;
        self.commit_activation(successor, predecessor)
    }

    /// Readiness borrows the capsule; cancellation never moves a resource or claim.
    pub async fn prepare_activation(
        &mut self,
        successor: RunId,
        predecessor: RunId,
    ) -> Result<(), String> {
        if !matches!(self.binding, Binding::Delivered { successor: actual, predecessor: prior }
            if actual == successor && prior == predecessor)
            || !matches!(
                self.state,
                FinalizingHandoffState::Parked | FinalizingHandoffState::Running(_)
            )
        {
            return Err("finalizing handoff binding/state does not match the successor".into());
        }
        self.capture_backing().map_err(|e| e.to_string())?;
        self.state = FinalizingHandoffState::Uncertain;
        let owner = self.owner.as_mut().ok_or("finalizing resource consumed")?;
        owner.state = IdleActivationState::Uncertain;
        let result = AssertUnwindSafe(async {
            let sandbox = owner
                .sandbox
                .as_mut()
                .ok_or("finalizing resource consumed")?;
            sandbox
                .bind_run_control(&successor.to_string())
                .map_err(|e| e.to_string())?;
            sandbox.unpark().await.map_err(|e| e.to_string())?;
            owner.validate_original_backing().map_err(|e| e.to_string())
        })
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err("finalizing handoff activation panicked".into()));
        result?;
        self.activation_ready = true;
        Ok(())
    }

    /// The claim owner may move authorization only around this synchronous commit.
    pub fn commit_activation(
        &mut self,
        successor: RunId,
        predecessor: RunId,
    ) -> Result<ActivatedFinalizingHandoff, String> {
        if !self.activation_ready
            || !matches!(self.binding, Binding::Delivered { successor: actual, predecessor: prior }
                if actual == successor && prior == predecessor)
        {
            return Err("finalizing activation readiness/binding is unavailable".into());
        }
        self.capture_backing().map_err(|e| e.to_string())?;
        let owner = self.owner.as_mut().ok_or("finalizing resource consumed")?;
        let factory = owner.factory.clone();
        let (sandbox, budget_lease) = owner.take_reused()?;
        self.owner = None;
        self.state = FinalizingHandoffState::Transferred;
        Ok(ActivatedFinalizingHandoff {
            sandbox,
            budget_lease,
            factory,
        })
    }

    /// This borrows the original proof before a synchronous ownership move.
    /// Missing/stale/failed capture retains the entire typed handoff capsule.
    pub fn take_cleanup_owner(&mut self) -> Result<IdleActivationOwner, MemoryOperationError> {
        self.capture_backing()?;
        let mut owner = self.owner.take().ok_or(MemoryOperationError::Consumed)?;
        // Cleanup conversion relinquishes the exact-successor activation
        // capability even for a physically parked handoff. The shared ordinary
        // API must not activate it for an unrelated run after binding erasure.
        owner.state = IdleActivationState::Uncertain;
        self.activation_ready = false;
        self.state = FinalizingHandoffState::Transferred;
        Ok(owner)
    }
}
