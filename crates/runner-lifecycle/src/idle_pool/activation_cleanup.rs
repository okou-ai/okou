//! Exclusively caller-owned ordinary activation and required terminal cleanup.
//!
//! These supplied-policy entries do not activate production memory policy. An
//! uncertain activation never returns to generic parked inventory. Completion
//! observation and retained resource ownership are independent.

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use sandbox::{BackingProcessIdentity, Sandbox, SandboxBackingProcess, SandboxFactory, SandboxId};

use crate::home_image_cache::{HomeImagePromotionContext, IdleHomeReclamationPermit};
use crate::home_mount::{ensure_home_drive_mounted, freeze_home_drive};
use crate::home_promotion::{PreparedHomeImagePromotion, prepare_terminal_cache_runtime};
use crate::host_memory_operations::{
    HostMemoryOperations, MemoryOperation, MemoryOperationError, MemoryOperationPlan,
    MemoryOperationTask,
};
use crate::resource_budget::BudgetLease;
use runner_types::ids::RunId;

use super::entry::IdleSandboxMetadata;
use super::inventory_retirement::CapturedBacking;
use super::retirement::{Allowance, IdleRetirementEnvelope};
use super::{ReservedIdleSandbox, ReusableIdleSandbox};

mod speculative;
pub use speculative::{GuardedSpeculativeIdleOwner, SpeculativeActivationState};
mod finalizing;
pub use finalizing::{
    ActivatedFinalizingHandoff, FinalizingHandoffState, GuardedFinalizingHandoffOwner,
};

/// Conservative physical state, never a proof of reusable inventory.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdleActivationState {
    Parked,
    Reused,
    Uncertain,
    TerminalReady,
    Frozen,
    Exited,
    Destroyed,
}

struct Coverage {
    live: Allowance,
    tail: Allowance,
    backing: Arc<dyn SandboxBackingProcess>,
    identity: BackingProcessIdentity,
}

/// An activation wait borrows this owner. Cancellation, returned error and
/// provider panic preserve the original resource, data and full logical lease.
#[must_use = "retain this exclusive owner until reuse succeeds or covered cleanup completes"]
pub struct IdleActivationOwner {
    sandbox: Option<Box<dyn Sandbox>>,
    factory: Arc<Box<dyn SandboxFactory>>,
    metadata: IdleSandboxMetadata,
    promotion: Option<HomeImagePromotionContext>,
    prepared: Option<PreparedHomeImagePromotion>,
    lease: Option<BudgetLease>,
    state: IdleActivationState,
    coverage: Option<Coverage>,
    reclamation: Option<IdleHomeReclamationPermit>,
    accepted: bool,
    admission: Option<(HostMemoryOperations, IdleRetirementEnvelope)>,
    cleanup_completed: bool,
    cleanup_error: Option<String>,
    // Preserve an already captured speculative generation across cleanup
    // conversion; a later provider generation is never a substitute.
    original_backing: Option<CapturedBacking>,
}

impl IdleActivationOwner {
    /// Running finalizing handoffs stay with their exact original owner; they
    /// are not ordinary parked reservations and are a separate composition.
    pub fn new(reservation: ReservedIdleSandbox) -> Result<Self, Box<ReservedIdleSandbox>> {
        let entry = reservation.into_parked_entry_preserving_owner()?;
        Ok(Self::from_entry(entry))
    }

    pub(super) fn from_entry(entry: super::IdleEntry) -> Self {
        Self::from_parts(
            entry.resources,
            entry.metadata,
            entry.budget_lease,
            IdleActivationState::Parked,
            entry.retirement_backing,
        )
    }

    pub(super) fn from_parts(
        resources: super::entry::IdleSandboxResources,
        metadata: IdleSandboxMetadata,
        lease: BudgetLease,
        state: IdleActivationState,
        original_backing: Option<CapturedBacking>,
    ) -> Self {
        Self::from_resources(resources, metadata, Some(lease), state, original_backing)
    }

    /// Only an accepted full-profile substitution may detach logical custody.
    pub(super) fn after_substitution(
        resources: super::entry::IdleSandboxResources,
        metadata: IdleSandboxMetadata,
        original_backing: Option<CapturedBacking>,
    ) -> Self {
        Self::from_resources(
            resources,
            metadata,
            None,
            IdleActivationState::Parked,
            original_backing,
        )
    }

    pub(super) fn accept_substitution(
        &mut self,
        operations: HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
    ) {
        self.accepted = true;
        self.admission = Some((operations, envelope));
    }

    fn from_resources(
        resources: super::entry::IdleSandboxResources,
        metadata: IdleSandboxMetadata,
        lease: Option<BudgetLease>,
        state: IdleActivationState,
        original_backing: Option<CapturedBacking>,
    ) -> Self {
        Self {
            sandbox: Some(resources.sandbox),
            factory: resources.factory,
            metadata,
            promotion: resources.home_promotion,
            prepared: None,
            lease,
            state,
            coverage: None,
            reclamation: None,
            accepted: false,
            admission: None,
            cleanup_completed: false,
            cleanup_error: None,
            original_backing,
        }
    }

    pub(super) fn capture_original_backing(&mut self) -> Result<(), MemoryOperationError> {
        std::panic::catch_unwind(AssertUnwindSafe(|| {
            let sandbox = self
                .sandbox
                .as_deref()
                .ok_or(MemoryOperationError::Consumed)?;
            if sandbox.id() != self.metadata.sandbox_id.to_string() {
                return Err(MemoryOperationError::OwnershipInvariant);
            }
            if self.original_backing.is_none() {
                let process = sandbox
                    .backing_process()
                    .ok_or(MemoryOperationError::MissingBacking)?;
                self.original_backing = Some(CapturedBacking {
                    identity: process.identity(),
                    process,
                });
            }
            self.validate_original_backing()
        }))
        .unwrap_or(Err(MemoryOperationError::ProducerLost))
    }

    pub(super) fn validate_original_backing(&self) -> Result<(), MemoryOperationError> {
        if self
            .sandbox
            .as_ref()
            .ok_or(MemoryOperationError::Consumed)?
            .id()
            != self.metadata.sandbox_id.to_string()
        {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let backing = self
            .original_backing
            .as_ref()
            .ok_or(MemoryOperationError::MissingBacking)?;
        validate_backing(self.sandbox.as_deref(), &backing.process, backing.identity)
    }

    pub(super) fn take_reused(
        &mut self,
    ) -> Result<(Box<ReusableIdleSandbox>, BudgetLease), String> {
        let lease = self.lease.take().ok_or("activation lease consumed")?;
        let sandbox = match self.sandbox.take() {
            Some(sandbox) => sandbox,
            None => {
                self.lease = Some(lease);
                return Err("activation resource consumed".into());
            }
        };
        self.state = IdleActivationState::Reused;
        Ok((
            Box::new(ReusableIdleSandbox {
                sandbox,
                metadata: self.metadata.clone(),
                home_promotion: self.promotion.take(),
                guest_state_prepared: false,
            }),
            lease,
        ))
    }

    pub fn sandbox_id(&self) -> SandboxId {
        self.metadata.sandbox_id
    }

    pub fn state(&self) -> IdleActivationState {
        self.state
    }

    pub fn cleanup_completed(&self) -> bool {
        self.cleanup_completed
    }

    pub fn cleanup_error(&self) -> Option<&str> {
        self.cleanup_error.as_deref()
    }

    /// Physical completion preserves the original full lease for its caller's
    /// admission/completion boundary, including recovery after observer loss.
    pub fn take_completed_lease(&mut self) -> Result<BudgetLease, MemoryOperationError> {
        if !self.cleanup_completed {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        self.lease.take().ok_or(MemoryOperationError::Consumed)
    }

    /// Only successful activation transfers the original full-profile lease.
    /// An error or a dropped future leaves this capsule exclusively owned and
    /// forbids another business activation or restoration to the idle pool.
    pub async fn activate(
        &mut self,
        run_id: RunId,
    ) -> Result<(Box<ReusableIdleSandbox>, BudgetLease), String> {
        if self.accepted || self.state != IdleActivationState::Parked || self.coverage.is_some() {
            return Err("ordinary idle activation owner is no longer parked".into());
        }
        self.state = IdleActivationState::Uncertain;
        let result = AssertUnwindSafe(async {
            let sandbox = self
                .sandbox
                .as_mut()
                .ok_or("activation resource consumed")?;
            sandbox
                .bind_run_control(&run_id.to_string())
                .map_err(|e| e.to_string())?;
            sandbox.unpark().await.map_err(|e| e.to_string())
        })
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err("ordinary idle activation panicked".into()));
        result?;
        // No await separates successful readiness from resource transfer.
        self.take_reused()
    }

    /// Register once while exclusively owned, outside resource/accounting locks.
    /// Errors and cancellation release no logical or physical ownership.
    pub async fn grant_cleanup(
        &mut self,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
    ) -> Result<(), MemoryOperationError> {
        if self.accepted {
            return Err(MemoryOperationError::Consumed);
        }
        if let Some((authority, supplied)) = &self.admission
            && (!authority.same_authority(operations) || *supplied != envelope)
        {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let result = AssertUnwindSafe(async {
            if let Some(backing) = &self.original_backing {
                validate_backing(self.sandbox.as_deref(), &backing.process, backing.identity)?;
            }
            if self.coverage.is_none() {
                // Coverage must share the original captured generation. A
                // provider change after validation cannot replace that fence.
                let (backing, identity) = if let Some(backing) = &self.original_backing {
                    (backing.process.clone(), backing.identity)
                } else {
                    let backing = self
                        .sandbox
                        .as_ref()
                        .ok_or(MemoryOperationError::Consumed)?
                        .backing_process()
                        .ok_or(MemoryOperationError::MissingBacking)?;
                    let identity = backing.identity();
                    (backing, identity)
                };
                let live = operations.request(MemoryOperationPlan::Retire {
                    growth_bytes: envelope.live_growth_bytes,
                    backing: backing.clone(),
                })?;
                let tail = operations.request(MemoryOperationPlan::CleanupIo {
                    growth_bytes: envelope.tail_growth_bytes,
                })?;
                self.coverage = Some(Coverage {
                    live: Allowance::Queued(live),
                    tail: Allowance::Queued(tail),
                    backing,
                    identity,
                });
                self.admission = Some((operations.clone(), envelope));
            }
            self.coverage
                .as_mut()
                .ok_or(MemoryOperationError::Consumed)?
                .live
                .try_grant()
                .await?;
            self.validate_backing()?;
            self.coverage
                .as_mut()
                .ok_or(MemoryOperationError::Consumed)?
                .tail
                .try_grant()
                .await?;
            self.validate_backing()
        })
        .catch_unwind()
        .await;
        result.unwrap_or(Err(MemoryOperationError::ProducerLost))
    }

    fn validate_backing(&self) -> Result<(), MemoryOperationError> {
        let coverage = self
            .coverage
            .as_ref()
            .ok_or(MemoryOperationError::Consumed)?;
        validate_backing(
            self.sandbox.as_deref(),
            &coverage.backing,
            coverage.identity,
        )
    }

    /// Both phase guards and the real resource transfer synchronously. Rejection
    /// puts the same capsule/unused grants back into the borrowed owner slot.
    pub fn start_cleanup(
        owner: &mut Option<Self>,
        context: &'static str,
    ) -> Result<AcceptedActivationCleanup, MemoryOperationError> {
        let current = owner.as_ref().ok_or(MemoryOperationError::Consumed)?;
        std::panic::catch_unwind(AssertUnwindSafe(|| current.validate_backing()))
            .unwrap_or(Err(MemoryOperationError::ProducerLost))?;
        let mut current = owner.take().ok_or(MemoryOperationError::Consumed)?;
        let coverage = match current.coverage.take() {
            Some(coverage) => coverage,
            None => {
                *owner = Some(current);
                return Err(MemoryOperationError::Consumed);
            }
        };
        let Coverage {
            live,
            tail,
            backing,
            identity,
        } = coverage;
        let (live, tail) = match (live, tail) {
            (Allowance::Granted(live), Allowance::Granted(tail)) => (live, tail),
            (live, tail) => {
                current.coverage = Some(Coverage {
                    live,
                    tail,
                    backing,
                    identity,
                });
                *owner = Some(current);
                return Err(MemoryOperationError::Consumed);
            }
        };
        current.accepted = true;
        let retained = RetainedActivationCleanup::new();
        let payload = (
            Box::new(current),
            retained.clone(),
            backing,
            identity,
            context,
        );
        match live.spawn_retirement(tail, payload, run_cleanup) {
            Ok(task) => Ok(AcceptedActivationCleanup { task, retained }),
            Err(failure) => {
                let (mut current, _, backing, identity, _) = failure.payload;
                current.accepted = false;
                current.coverage = Some(Coverage {
                    live: Allowance::Granted(failure.live),
                    tail: Allowance::Granted(failure.tail),
                    backing,
                    identity,
                });
                *owner = Some(*current);
                Err(failure.error)
            }
        }
    }
}

/// Completion contains no resource: losing a result receiver cannot discharge
/// a no-progress owner's lease, promotion or required home/history data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivationCleanupOutcome {
    Completed { home_cache_promoted: bool },
    NoProgress(String),
}

/// Supervisor keeps a clone through joined shutdown, independently of observers.
#[derive(Clone)]
#[must_use = "keep retained cleanup ownership through shutdown or recover its capsule"]
pub struct RetainedActivationCleanup(Arc<Mutex<RetainedState>>);

struct RetainedState {
    owner: Option<Box<IdleActivationOwner>>,
    finished: bool,
}

impl RetainedActivationCleanup {
    pub(super) fn new() -> Self {
        Self(Arc::new(Mutex::new(RetainedState {
            owner: None,
            finished: false,
        })))
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, RetainedState> {
        // This lock contains only ownership moves, never provider work or awaits.
        // Preserve the actual capsule across poisoning; do not invent completion
        // or let synchronization failure discharge its original lease.
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Successful physical cleanup does not release logical admission. Its
    /// original caller decides when to reuse or release the full-profile lease.
    /// Losing a completion receiver leaves this lease retained by Supervisor.
    pub fn take_completed_lease(&self) -> Result<BudgetLease, MemoryOperationError> {
        let owner = {
            let mut state = self.lock_state();
            if !state.finished
                || !state
                    .owner
                    .as_ref()
                    .is_some_and(|owner| owner.cleanup_completed && owner.lease.is_some())
            {
                return Err(MemoryOperationError::OwnershipInvariant);
            }
            state.owner.take().ok_or(MemoryOperationError::Consumed)?
        };
        // Provider/factory Drop stays outside the retained-state lock.
        let mut owner = owner;
        owner.take_completed_lease()
    }

    /// The original full lease was explicitly transferred at acceptance.
    /// Release completed physical custody without touching the replacement lease.
    pub fn release_completed_substitution(&self) -> Result<(), MemoryOperationError> {
        let owner = {
            let mut state = self.lock_state();
            if !state.finished
                || !state
                    .owner
                    .as_ref()
                    .is_some_and(|owner| owner.cleanup_completed && owner.lease.is_none())
            {
                return Err(MemoryOperationError::OwnershipInvariant);
            }
            state.owner.take().ok_or(MemoryOperationError::Consumed)?
        };
        drop(owner);
        Ok(())
    }

    /// Call after joining accepted work. None while in flight is not completion.
    pub fn take_owner(&self) -> Option<Box<IdleActivationOwner>> {
        self.lock_state().owner.take()
    }

    pub fn has_owner(&self) -> bool {
        self.lock_state().owner.is_some()
    }

    /// Unfinished work, no-progress capsules and unclaimed completed leases
    /// remain owned independently. An explicitly claimed slot can be pruned.
    pub fn needs_retention(&self) -> bool {
        let state = self.lock_state();
        !state.finished || state.owner.is_some()
    }
}

#[must_use = "adopt accepted cleanup and retain its independent resource slot"]
pub struct AcceptedActivationCleanup {
    task: MemoryOperationTask<ActivationCleanupOutcome>,
    retained: RetainedActivationCleanup,
}

impl AcceptedActivationCleanup {
    pub(super) fn new(
        task: MemoryOperationTask<ActivationCleanupOutcome>,
        retained: RetainedActivationCleanup,
    ) -> Self {
        Self { task, retained }
    }

    pub fn into_parts(
        self,
    ) -> (
        MemoryOperationTask<ActivationCleanupOutcome>,
        RetainedActivationCleanup,
    ) {
        (self.task, self.retained)
    }
}

fn validate_backing(
    sandbox: Option<&dyn Sandbox>,
    backing: &Arc<dyn SandboxBackingProcess>,
    identity: BackingProcessIdentity,
) -> Result<(), MemoryOperationError> {
    if backing.identity() != identity {
        return Err(MemoryOperationError::OwnershipInvariant);
    }
    if let Some(sandbox) = sandbox {
        let current = sandbox
            .backing_process()
            .ok_or(MemoryOperationError::MissingBacking)?;
        // Firecracker returns fresh capability wrappers around the same owned
        // child wait. Provider generation, rather than wrapper address, fences
        // the actual backing resource.
        if current.identity() != identity {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
    }
    Ok(())
}

pub(super) async fn run_cleanup_from_entry(
    live: MemoryOperation,
    tail: MemoryOperation,
    (entry, retained, backing, identity, operations, envelope, context): (
        super::IdleEntry,
        RetainedActivationCleanup,
        Arc<dyn SandboxBackingProcess>,
        BackingProcessIdentity,
        HostMemoryOperations,
        IdleRetirementEnvelope,
        &'static str,
    ),
) -> ActivationCleanupOutcome {
    let mut owner = Box::new(IdleActivationOwner::from_entry(entry));
    owner.accepted = true;
    owner.admission = Some((operations, envelope));
    run_cleanup(live, tail, (owner, retained, backing, identity, context)).await
}

pub(super) async fn run_cleanup(
    mut live: MemoryOperation,
    mut tail: MemoryOperation,
    (mut owner, retained, backing, identity, context): (
        Box<IdleActivationOwner>,
        RetainedActivationCleanup,
        Arc<dyn SandboxBackingProcess>,
        BackingProcessIdentity,
        &'static str,
    ),
) -> ActivationCleanupOutcome {
    let result = AssertUnwindSafe(cleanup_phases(
        &mut owner, &mut live, &mut tail, &backing, identity, context,
    ))
    .catch_unwind()
    .await;
    let outcome = match result
        .unwrap_or_else(|_| Err("required caller-owned cleanup producer panicked".into()))
    {
        Ok(promoted) => {
            owner.cleanup_completed = true;
            ActivationCleanupOutcome::Completed {
                home_cache_promoted: promoted,
            }
        }
        Err(error) => {
            if let Some(permit) = &mut owner.reclamation {
                permit.retain_for_recovery();
            }
            owner.cleanup_error = Some(error.clone());
            ActivationCleanupOutcome::NoProgress(error)
        }
    };
    let mut state = retained.lock_state();
    state.owner = Some(owner);
    state.finished = true;
    outcome
}

async fn cleanup_phases(
    owner: &mut IdleActivationOwner,
    live: &mut MemoryOperation,
    tail: &mut MemoryOperation,
    backing: &Arc<dyn SandboxBackingProcess>,
    identity: BackingProcessIdentity,
    context: &'static str,
) -> Result<bool, String> {
    macro_rules! revalidate {
        () => {
            validate_backing(owner.sandbox.as_deref(), backing, identity)
                .map_err(|e| e.to_string())?
        };
    }
    revalidate!();
    if owner.prepared.is_none() && owner.promotion.is_some() {
        if owner.reclamation.is_none() {
            owner.reclamation = Some(
                owner
                    .promotion
                    .as_ref()
                    .ok_or("required home promotion consumed")?
                    .acquire_required_idle_home_reclamation_permit()
                    .await
                    .map_err(|e| e.to_string())?,
            );
            revalidate!();
        }
        let sandbox = owner
            .sandbox
            .as_mut()
            .ok_or("required cleanup resource consumed")?;
        owner.state = IdleActivationState::Uncertain;
        sandbox
            .unpark_for_terminal_operations()
            .await
            .map_err(|e| e.to_string())?;
        owner.state = IdleActivationState::TerminalReady;
        revalidate!();
        let promotion = owner
            .promotion
            .as_ref()
            .ok_or("required home promotion consumed")?;
        ensure_home_drive_mounted(
            owner
                .sandbox
                .as_deref()
                .ok_or("required cleanup resource consumed")?,
            promotion.run_id(),
        )
        .await
        .map_err(|e| e.error.to_string())?;
        revalidate!();
        let home_ready = prepare_terminal_cache_runtime(
            owner
                .sandbox
                .as_deref()
                .ok_or("required cleanup resource consumed")?,
            owner
                .promotion
                .as_mut()
                .ok_or("required home promotion consumed")?,
        )
        .await
        .map_err(|e| e.to_string())?;
        if !home_ready {
            return Err("required home publication rejected below reuse reserve".into());
        }
        revalidate!();
        owner.state = IdleActivationState::Uncertain;
        freeze_home_drive(
            owner
                .sandbox
                .as_deref()
                .ok_or("required cleanup resource consumed")?,
            owner
                .promotion
                .as_ref()
                .ok_or("required home promotion consumed")?
                .run_id(),
        )
        .await
        .map_err(|e| e.to_string())?;
        owner.state = IdleActivationState::Frozen;
        owner.prepared = Some(PreparedHomeImagePromotion::required(
            owner
                .promotion
                .take()
                .ok_or("required home promotion consumed")?,
            context,
        ));
        revalidate!();
    }
    if owner.state != IdleActivationState::Exited && owner.state != IdleActivationState::Destroyed {
        if owner.state == IdleActivationState::Parked {
            // Even a home-less cancellation can partially terminate its backing.
            // An accepted owner must never become ordinary reusable inventory.
            owner.state = IdleActivationState::Uncertain;
        }
        let sandbox = owner
            .sandbox
            .as_mut()
            .ok_or("required cleanup resource consumed")?;
        let termination = async {
            sandbox.kill().await.map_err(|e| e.to_string())?;
            validate_backing(Some(sandbox.as_ref()), backing, identity)
                .map_err(|e| e.to_string())?;
            if !backing.exit_confirmed().await {
                return Err("required caller cleanup backing exit is unconfirmed".to_owned());
            }
            validate_backing(Some(sandbox.as_ref()), backing, identity).map_err(|e| e.to_string())
        };
        let completion = super::retirement::settle(live, context);
        tokio::pin!(termination, completion);
        let settled = tokio::select! {
            result = &mut termination => {
                result?;
                completion.await
            }
            settled = &mut completion => {
                if settled {
                    owner.reclamation.take();
                }
                // An accepted kill/service tail is still real work. Join it
                // even if the independent live phase could not settle.
                termination.await?;
                settled
            }
        };
        owner.state = IdleActivationState::Exited;
        owner.reclamation.take();
        settled
            .then_some(())
            .ok_or("required caller live phase remains uncertain")?;
    } else {
        super::retirement::settle(live, context)
            .await
            .then_some(())
            .ok_or("required caller live phase remains uncertain")?;
    }
    revalidate!();
    let promoted = if let Some(prepared) = &owner.prepared {
        let promoted = prepared
            .publish_required()
            .await
            .map_err(|e| e.to_string())?;
        revalidate!();
        promoted
    } else {
        false
    };
    if let Some(sandbox) = owner.sandbox.take() {
        owner.factory.destroy(sandbox).await;
        owner.state = IdleActivationState::Destroyed;
        revalidate!();
    }
    super::retirement::settle(tail, context)
        .await
        .then_some(())
        .ok_or("required caller cleanup I/O phase remains uncertain")?;
    revalidate!();
    owner.prepared.take();
    Ok(promoted)
}
