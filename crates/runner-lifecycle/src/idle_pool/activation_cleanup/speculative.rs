//! Borrowed speculative transitions sharing the ordinary required cleanup owner.

use std::time::Instant;

use crate::guest_timezone::GuestTimezoneIntent;
use futures_util::future::BoxFuture;
use sandbox::SandboxParkOutcome;
use uuid::Uuid;

use crate::home_image_cache::HomeImagePromotionIdentityRequest;
use crate::idle_reuse_preparation::IdleReusePreparation;
use crate::restored_session_identity::RestoredSessionIdentity;

use super::*;
use crate::idle_pool::entry::IdleSandboxResources;
use crate::idle_pool::{IdleEntry, IdlePoolIncoming};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpeculativeActivationState {
    Parked,
    Prepared,
    Uncertain,
    Reparked,
    Transferred,
}

/// Keep this owner outside preparation and rollback futures. Only a verified
/// repark can become incoming inventory; all uncertain states retain required
/// data and the original full-profile lease for shared covered cleanup.
#[must_use]
pub struct GuardedSpeculativeIdleOwner {
    owner: Option<IdleActivationOwner>,
    parked_at: Instant,
    insertion_epoch: Uuid,
    state: SpeculativeActivationState,
    run_id: Option<RunId>,
}

impl GuardedSpeculativeIdleOwner {
    pub fn new(reservation: ReservedIdleSandbox) -> Result<Self, Box<ReservedIdleSandbox>> {
        let entry = reservation.into_parked_entry_preserving_owner()?;
        let parked_at = entry.parked_at;
        let insertion_epoch = entry.insertion_epoch;
        let owner = IdleActivationOwner::from_entry(entry);
        Ok(Self {
            owner: Some(owner),
            parked_at,
            insertion_epoch,
            state: SpeculativeActivationState::Parked,
            run_id: None,
        })
    }

    pub fn state(&self) -> SpeculativeActivationState {
        self.state
    }

    /// Observe real terminal unpark while retaining the original capsule.
    /// Fixtures cancel this borrowed wait before releasing response IO;
    /// covered cleanup still owns all saving and state transitions.
    #[cfg(feature = "test-support")]
    pub async fn observe_terminal_unpark_for_test(&mut self) -> Result<(), String> {
        if self.state != SpeculativeActivationState::Uncertain {
            return Err("terminal observation requires uncertain speculative custody".into());
        }
        let owner = self.owner.as_mut().ok_or("speculative resource consumed")?;
        Self::validate(owner).map_err(|error| error.to_string())?;
        owner
            .sandbox
            .as_mut()
            .ok_or("speculative resource consumed")?
            .unpark_for_terminal_operations()
            .await
            .map_err(|error| error.to_string())?;
        Self::validate(owner).map_err(|error| error.to_string())
    }

    pub fn matches_claim(
        &self,
        reuse_key: Option<&str>,
        history: Option<RunId>,
        profile: &str,
    ) -> bool {
        self.owner.as_ref().is_some_and(|owner| {
            reuse_key.is_some()
                && history.is_some()
                && owner.metadata.reuse_key() == reuse_key
                && owner.metadata.history_generation_run_id == history
                && owner.metadata.profile_name == profile
        })
    }

    pub fn matches_source_claim(
        &self,
        reuse_key: Option<&str>,
        source: RunId,
        profile: &str,
    ) -> bool {
        self.owner.as_ref().is_some_and(|owner| {
            reuse_key.is_some()
                && owner.metadata.reuse_key() == reuse_key
                && owner.metadata.source_run_id == Some(source)
                && owner.metadata.profile_name == profile
        })
    }

    /// Capture once before any provider wait, with no pool/accounting lock.
    pub fn capture_backing(&mut self) -> Result<(), MemoryOperationError> {
        let owner = self.owner.as_mut().ok_or(MemoryOperationError::Consumed)?;
        std::panic::catch_unwind(AssertUnwindSafe(|| {
            if owner.original_backing.is_none() {
                let process = owner
                    .sandbox
                    .as_deref()
                    .ok_or(MemoryOperationError::Consumed)?
                    .backing_process()
                    .ok_or(MemoryOperationError::MissingBacking)?;
                owner.original_backing = Some(CapturedBacking {
                    identity: process.identity(),
                    process,
                });
            }
            Self::validate(owner)
        }))
        .unwrap_or(Err(MemoryOperationError::ProducerLost))
    }

    fn validate(owner: &IdleActivationOwner) -> Result<(), MemoryOperationError> {
        let backing = owner
            .original_backing
            .as_ref()
            .ok_or(MemoryOperationError::MissingBacking)?;
        let sandbox = owner
            .sandbox
            .as_deref()
            .ok_or(MemoryOperationError::Consumed)?;
        if sandbox.id() != owner.metadata.sandbox_id.to_string() {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        validate_backing(Some(sandbox), &backing.process, backing.identity)
    }

    /// The callback is the Executor guest preparation boundary. It borrows the
    /// real sandbox; no ownership or readiness proof is passed into its future.
    pub async fn prepare<F>(&mut self, run_id: RunId, restore: F) -> Result<(), String>
    where
        F: for<'a> FnOnce(
            &'a dyn Sandbox,
            RunId,
            &'a GuestTimezoneIntent,
        ) -> BoxFuture<'a, Result<(), String>>,
    {
        if self.state != SpeculativeActivationState::Parked {
            return Err("speculative preparation already began".into());
        }
        self.capture_backing().map_err(|e| e.to_string())?;
        self.run_id = Some(run_id);
        // A dropped provider future must never leave an apparently parked owner.
        self.state = SpeculativeActivationState::Uncertain;
        let owner = self.owner.as_mut().ok_or("speculative resource consumed")?;
        owner.state = IdleActivationState::Uncertain;
        let result: Result<(), String> = AssertUnwindSafe(async {
            let sandbox = owner
                .sandbox
                .as_mut()
                .ok_or("speculative resource consumed")?;
            sandbox
                .bind_run_control(&run_id.to_string())
                .map_err(|e| e.to_string())?;
            sandbox.unpark().await.map_err(|e| e.to_string())?;
            Self::validate(owner).map_err(|e| e.to_string())?;
            restore(
                owner
                    .sandbox
                    .as_deref()
                    .ok_or("speculative resource consumed")?,
                run_id,
                &owner.metadata.guest_timezone_intent,
            )
            .await?;
            Self::validate(owner).map_err(|e| e.to_string())
        })
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err("speculative preparation panicked".into()));
        result?;
        self.state = SpeculativeActivationState::Prepared;
        Ok(())
    }

    /// Re-run real guest cleanup/park with the original resource producer.
    /// A report rejection or provider panic retains required promotion/context.
    pub async fn repark(&mut self, home_image_size_bytes: u64) -> Result<(), String> {
        if self.state != SpeculativeActivationState::Prepared {
            return Err("only prepared speculative state can repark".into());
        }
        self.state = SpeculativeActivationState::Uncertain;
        let owner = self.owner.as_mut().ok_or("speculative resource consumed")?;
        let result: Result<(), String> = AssertUnwindSafe(async {
            Self::validate(owner).map_err(|e| e.to_string())?;
            let source = owner.metadata.source_run_id.ok_or("speculative resource producer missing")?;
            if let Some(promotion) = &owner.promotion {
                promotion.validate_stored_cache_identity(HomeImagePromotionIdentityRequest {
                    sandbox_id: owner.metadata.sandbox_id,
                    profile_name: &owner.metadata.profile_name,
                    rootfs_hash: &owner.metadata.rootfs_hash,
                    reuse_key: owner.metadata.reuse_key().ok_or("speculative reuse key missing")?,
                    working_dir: api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                    image_size_bytes: home_image_size_bytes,
                }).map_err(|e| e.to_string())?;
            }
            let retained = owner.metadata.restored_session_identity.as_ref()
                .and_then(RestoredSessionIdentity::final_metadata_verification)
                .map(|verification| verification.runtime_dir);
            let preparation = IdleReusePreparation::new(
                owner.sandbox.as_deref().ok_or("speculative resource consumed")?.id(),
                self.run_id.ok_or("speculative operation run missing")?, source, retained,
            ).map_err(|e| e.to_string())?;
            let outcome = owner.sandbox.as_mut().ok_or("speculative resource consumed")?
                .final_exec_and_park(&preparation.exec_request(), "idle-reuse-preparation-and-park")
                .await.map_err(|e| e.to_string())?;
            Self::validate(owner).map_err(|e| e.to_string())?;
            preparation.validate_result(&outcome.exec_result).map_err(|e| e.to_string())?;
            if !matches!(outcome.park_outcome, SandboxParkOutcome::Reusable) {
                return Err("speculative rollback park rejected reuse".into());
            }
            Ok(())
        }).catch_unwind().await.unwrap_or_else(|_| Err("speculative repark panicked".into()));
        result?;
        owner.state = IdleActivationState::Parked;
        self.state = SpeculativeActivationState::Reparked;
        Ok(())
    }

    pub fn commit(
        &mut self,
        run_id: RunId,
        claimed_timezone: &GuestTimezoneIntent,
    ) -> Result<(Box<ReusableIdleSandbox>, BudgetLease), String> {
        if self.state != SpeculativeActivationState::Prepared || self.run_id != Some(run_id) {
            return Err("speculative claim is not prepared for this run".into());
        }
        self.capture_backing().map_err(|e| e.to_string())?;
        let current = self.owner.as_ref().ok_or("speculative resource consumed")?;
        if current.sandbox.is_none() || current.lease.is_none() {
            return Err("speculative resource or lease consumed".into());
        }
        let mut owner = self.owner.take().ok_or("speculative resource consumed")?;
        let sandbox = owner
            .sandbox
            .take()
            .ok_or("speculative resource consumed")?;
        let lease = owner.lease.take().ok_or("speculative lease consumed")?;
        // A completed predicted restore cannot suppress actual Executor
        // preparation when the returned claim changes or lacks timezone proof.
        let guest_state_prepared = owner.metadata.guest_timezone_intent.is_usable_prediction()
            && owner.metadata.guest_timezone_intent == *claimed_timezone;
        self.state = SpeculativeActivationState::Transferred;
        Ok((
            Box::new(ReusableIdleSandbox {
                sandbox,
                metadata: owner.metadata,
                home_promotion: owner.promotion,
                guest_state_prepared,
            }),
            lease,
        ))
    }

    pub fn take_incoming(&mut self) -> Result<IdlePoolIncoming, MemoryOperationError> {
        if !matches!(
            self.state,
            SpeculativeActivationState::Parked | SpeculativeActivationState::Reparked
        ) {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        self.capture_backing()?;
        let current = self.owner.as_ref().ok_or(MemoryOperationError::Consumed)?;
        if current.sandbox.is_none() || current.lease.is_none() {
            return Err(MemoryOperationError::Consumed);
        }
        let mut owner = self.owner.take().ok_or(MemoryOperationError::Consumed)?;
        let entry = IdleEntry {
            resources: IdleSandboxResources {
                sandbox: owner.sandbox.take().ok_or(MemoryOperationError::Consumed)?,
                factory: owner.factory,
                home_promotion: owner.promotion,
            },
            metadata: owner.metadata,
            budget_lease: owner.lease.take().ok_or(MemoryOperationError::Consumed)?,
            parked_at: self.parked_at,
            insertion_epoch: self.insertion_epoch,
            retirement_backing: owner.original_backing,
        };
        self.state = SpeculativeActivationState::Transferred;
        // The entry above is constructed from a proved parked owner.
        IdlePoolIncoming::restore(ReservedIdleSandbox::parked(entry))
            .map_err(|_| MemoryOperationError::OwnershipInvariant)
    }

    /// Conversion has no wait and preserves the captured original generation.
    pub fn take_cleanup_owner(&mut self) -> Result<IdleActivationOwner, MemoryOperationError> {
        let owner = self.owner.take().ok_or(MemoryOperationError::Consumed)?;
        self.state = SpeculativeActivationState::Transferred;
        Ok(owner)
    }
}
