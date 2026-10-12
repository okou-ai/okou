//! Before-detach replacement with an untouched, caller-owned incoming resource.

use std::{fmt, panic::AssertUnwindSafe, sync::Arc, time::Instant};

use sandbox::SandboxId;
use uuid::Uuid;

use crate::host_memory_operations::{
    HostMemoryOperations, MemoryOperationError, MemoryOperationTask,
};

use super::inventory_retirement::CapturedBacking;
use super::{
    IdleEntry, IdlePool, IdlePoolRetirement, IdleRetirementCandidate, IdleRetirementEnvelope,
    ParkedIdleCandidate, ReservedIdleSandbox, RetainedIdleDestroyResult,
};

/// Keep this capsule outside the admission future. Cancelling a borrowed grant
/// or insertion future cannot drop the incoming sandbox, home data or lease.
#[must_use]
pub struct IdlePoolIncoming {
    entry: Option<IdleEntry>,
    restore: bool,
    token: Uuid,
}

pub enum IdlePoolIncomingOwner {
    Parked(ParkedIdleCandidate),
    Reserved(ReservedIdleSandbox),
}

impl IdlePoolIncoming {
    pub fn park(candidate: ParkedIdleCandidate) -> Self {
        Self {
            entry: Some(candidate.into_idle_entry(Instant::now())),
            restore: false,
            token: Uuid::new_v4(),
        }
    }

    /// Running handoffs are returned unchanged, never converted into generic
    /// parked inventory or a cleanup fallback.
    pub fn restore(reservation: ReservedIdleSandbox) -> Result<Self, Box<ReservedIdleSandbox>> {
        Ok(Self {
            entry: Some(reservation.into_parked_entry_preserving_owner()?),
            restore: true,
            token: Uuid::new_v4(),
        })
    }

    /// Exclusive caller-owned provider boundary; call before taking pool locks.
    pub fn capture_backing(&mut self) -> Result<(), MemoryOperationError> {
        let entry = self.entry.as_mut().ok_or(MemoryOperationError::Consumed)?;
        entry.retirement_backing = None;
        let backing = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let process = entry
                .resources
                .sandbox
                .backing_process()
                .ok_or(MemoryOperationError::MissingBacking)?;
            Ok(CapturedBacking {
                identity: process.identity(),
                process,
            })
        }))
        .unwrap_or(Err(MemoryOperationError::ProducerLost))?;
        entry.retirement_backing = Some(backing);
        Ok(())
    }

    pub fn sandbox_id(&self) -> Option<SandboxId> {
        self.entry.as_ref().map(|entry| entry.metadata.sandbox_id)
    }

    /// Validate the original incoming generation outside pool locks after
    /// observation/lock waits. Never replace its captured proof with a new one.
    pub fn validate_captured_backing(&self) -> Result<(), MemoryOperationError> {
        std::panic::catch_unwind(AssertUnwindSafe(|| {
            let entry = self.entry.as_ref().ok_or(MemoryOperationError::Consumed)?;
            let captured = entry
                .retirement_backing
                .as_ref()
                .ok_or(MemoryOperationError::MissingBacking)?;
            let current = entry
                .resources
                .sandbox
                .backing_process()
                .ok_or(MemoryOperationError::MissingBacking)?;
            if entry.resources.sandbox.id() != entry.metadata.sandbox_id.to_string()
                || current.identity() != captured.identity
                || captured.process.identity() != captured.identity
            {
                return Err(MemoryOperationError::OwnershipInvariant);
            }
            Ok(())
        }))
        .unwrap_or(Err(MemoryOperationError::ProducerLost))
    }

    /// A rejected speculative repark retains this borrowed capsule until an
    /// explicit required-cleanup decision. No provider work or await occurs.
    pub fn take_required_cleanup_owner(
        &mut self,
    ) -> Result<super::IdleActivationOwner, MemoryOperationError> {
        let entry = self.entry.take().ok_or(MemoryOperationError::Consumed)?;
        Ok(super::IdleActivationOwner::from_entry(entry))
    }

    /// Pure full-shape check for a blank replenishment owner.
    pub fn is_compatible_blank(
        &self,
        profile_name: &str,
        rootfs_hash: &str,
        device_rate_limits: &Option<sandbox::DeviceRateLimits>,
        vcpu: u32,
        memory_mb: u32,
    ) -> bool {
        self.entry.as_ref().is_some_and(|entry| {
            entry.is_blank()
                && entry.metadata.profile_name == profile_name
                && entry.metadata.rootfs_hash == rootfs_hash
                && &entry.metadata.device_rate_limits == device_rate_limits
                && entry.budget_lease.vcpu() == vcpu
                && entry.budget_lease.memory_mb() == memory_mb
        })
    }

    /// Cached exclusive-owner proof for the same authority's preparation
    /// completion. This accessor makes no provider call.
    pub fn captured_backing(
        &self,
    ) -> Result<Arc<dyn sandbox::SandboxBackingProcess>, MemoryOperationError> {
        self.entry
            .as_ref()
            .ok_or(MemoryOperationError::Consumed)?
            .retirement_backing
            .as_ref()
            .map(|backing| backing.process.clone())
            .ok_or(MemoryOperationError::MissingBacking)
    }

    /// Recover the complete physically parked owner after refusal. Its caller
    /// decides activation/restoration or required cleanup; no implicit disposal.
    pub fn into_owner(mut self) -> Option<IdlePoolIncomingOwner> {
        let entry = self.entry.take()?;
        Some(if self.restore {
            IdlePoolIncomingOwner::Reserved(ReservedIdleSandbox::parked(entry))
        } else {
            let IdleEntry {
                resources,
                metadata,
                budget_lease,
                retirement_backing,
                ..
            } = entry;
            IdlePoolIncomingOwner::Parked(ParkedIdleCandidate {
                resources,
                metadata,
                budget_lease,
                retirement_backing,
            })
        })
    }
}

/// Pure policy/resource selection. It grants no authority and detaches nothing.
pub struct IdlePoolInsertionCandidate {
    pool: Uuid,
    max_idle: usize,
    incoming: Uuid,
    backing: CapturedBacking,
    victim: Option<IdleRetirementCandidate>,
}

impl IdlePool {
    fn insertion_victim(
        &self,
        incoming: &IdlePoolIncoming,
    ) -> Result<Option<IdleRetirementCandidate>, MemoryOperationError> {
        let entry = incoming
            .entry
            .as_ref()
            .ok_or(MemoryOperationError::Consumed)?;
        self.insertion_victim_identity(&entry.metadata.identity, incoming.restore)?
            .map(|identity| self.retirement_candidate(&identity))
            .transpose()
    }

    pub fn insertion_candidate(
        &self,
        incoming: &IdlePoolIncoming,
    ) -> Result<IdlePoolInsertionCandidate, MemoryOperationError> {
        if self.revision >= u64::MAX - 1 {
            return Err(MemoryOperationError::AccountingOverflow);
        }
        let entry = incoming
            .entry
            .as_ref()
            .ok_or(MemoryOperationError::Consumed)?;
        let backing = entry
            .retirement_backing
            .clone()
            .ok_or(MemoryOperationError::MissingBacking)?;
        Ok(IdlePoolInsertionCandidate {
            pool: self.generation,
            max_idle: self.config.max_idle,
            incoming: incoming.token,
            backing,
            victim: self.insertion_victim(incoming)?,
        })
    }
}

enum InsertionAdmission {
    Direct,
    Replacement(Box<IdlePoolRetirement>),
}

/// Supplied guard is mandatory even though an insertion with no physical
/// victim naturally needs no retirement phases.
#[must_use]
pub struct IdlePoolInsertion {
    candidate: IdlePoolInsertionCandidate,
    admission: InsertionAdmission,
    ready: bool,
}

#[must_use]
pub struct IdlePoolInsertionStartFailure {
    error: MemoryOperationError,
    insertion: IdlePoolInsertion,
}

impl IdlePoolInsertionStartFailure {
    pub fn error(&self) -> &MemoryOperationError {
        &self.error
    }
    /// Release unused claims outside the pool lock.
    pub fn into_error(self) -> MemoryOperationError {
        self.error
    }
    pub fn into_insertion(self) -> IdlePoolInsertion {
        self.insertion
    }
}

impl fmt::Debug for IdlePoolInsertionStartFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdlePoolInsertionStartFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

pub enum IdlePoolInsertionStarted {
    Inserted,
    Replaced(MemoryOperationTask<RetainedIdleDestroyResult>),
}

impl IdlePoolInsertion {
    pub fn new(
        candidate: IdlePoolInsertionCandidate,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
    ) -> Result<Self, MemoryOperationError> {
        let admission = match candidate.victim.as_ref() {
            Some(victim) => InsertionAdmission::Replacement(Box::new(IdlePoolRetirement::new(
                victim.clone(),
                operations,
                envelope,
            )?)),
            None => InsertionAdmission::Direct,
        };
        Ok(Self {
            candidate,
            admission,
            ready: false,
        })
    }

    pub async fn try_grant(&mut self) -> Result<(), MemoryOperationError> {
        self.ready = false;
        if let InsertionAdmission::Replacement(retirement) = &mut self.admission {
            retirement.try_grant().await?;
        }
        let valid = std::panic::catch_unwind(AssertUnwindSafe(|| {
            self.candidate.backing.process.identity() == self.candidate.backing.identity
        }))
        .map_err(|_| MemoryOperationError::ProducerLost)?;
        if !valid {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        self.ready = true;
        Ok(())
    }

    /// No await or provider call. Old acceptance and incoming insertion happen
    /// under the same exclusive pool access. Every refusal preserves incoming.
    pub fn start(
        self,
        pool: &mut IdlePool,
        incoming: &mut IdlePoolIncoming,
        context: &'static str,
    ) -> Result<IdlePoolInsertionStarted, Box<IdlePoolInsertionStartFailure>> {
        let reject =
            |insertion: Self, error| Box::new(IdlePoolInsertionStartFailure { error, insertion });
        if !self.ready {
            return Err(reject(self, MemoryOperationError::Consumed));
        }
        if pool.generation != self.candidate.pool || incoming.token != self.candidate.incoming {
            return Err(reject(self, MemoryOperationError::OwnershipInvariant));
        }
        if pool.config.max_idle != self.candidate.max_idle || pool.revision >= u64::MAX - 1 {
            return Err(reject(self, MemoryOperationError::ResourceChanged));
        }
        let proof_matches = incoming
            .entry
            .as_ref()
            .and_then(|entry| entry.retirement_backing.as_ref())
            .is_some_and(|backing| {
                backing.identity == self.candidate.backing.identity
                    && Arc::ptr_eq(&backing.process, &self.candidate.backing.process)
            });
        if !proof_matches {
            return Err(reject(self, MemoryOperationError::ResourceChanged));
        }
        let current = match pool.insertion_victim(incoming) {
            Ok(current) => current,
            Err(error) => return Err(reject(self, error)),
        };
        let same = match (&self.candidate.victim, &current) {
            (None, None) => true,
            (Some(old), Some(current)) => old.same_insertion(current),
            _ => false,
        };
        if !same {
            return Err(reject(self, MemoryOperationError::ResourceChanged));
        }
        let Some(mut entry) = incoming.entry.take() else {
            return Err(reject(self, MemoryOperationError::Consumed));
        };
        let Self {
            candidate,
            admission,
            ..
        } = self;
        let started = match admission {
            InsertionAdmission::Direct => IdlePoolInsertionStarted::Inserted,
            InsertionAdmission::Replacement(retirement) => match (*retirement).start(pool, context)
            {
                Ok(task) => IdlePoolInsertionStarted::Replaced(task),
                Err(failure) => {
                    incoming.entry = Some(entry);
                    let (error, retirement) = failure.into_parts();
                    return Err(reject(
                        Self {
                            candidate,
                            admission: InsertionAdmission::Replacement(Box::new(retirement)),
                            ready: true,
                        },
                        error,
                    ));
                }
            },
        };
        // Policy was rechecked immediately above; acceptance removed its exact
        // victim. A second owner cannot enter this synchronous critical section.
        if !incoming.restore {
            // New park age starts at pool acceptance, as in ordinary park.
            // Only restoration preserves its original idle age across waits.
            entry.parked_at = Instant::now();
        }
        let previous = pool.insert_entry(entry);
        debug_assert!(previous.is_none());
        pool.bump_revision();
        Ok(started)
    }
}
