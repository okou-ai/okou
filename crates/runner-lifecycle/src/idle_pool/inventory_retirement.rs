//! Admission before detach for one exact insertion of parked inventory.

use std::fmt;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Instant;

use sandbox::{BackingProcessIdentity, DeviceRateLimits, SandboxBackingProcess, SandboxId};
use uuid::Uuid;

use crate::host_memory_operations::{
    HostMemoryOperations, MemoryOperationError, MemoryOperationPlan, MemoryOperationTask,
};

use super::retirement::{Allowance, run_retirement};
use super::{
    IdleEntry, IdlePool, IdleRetirementEnvelope, IdleSandboxIdentity, RetainedIdleDestroyResult,
};

#[derive(Clone)]
pub(super) struct CapturedBacking {
    pub(super) process: Arc<dyn SandboxBackingProcess>,
    pub(super) identity: BackingProcessIdentity,
}

/// Immutable resource proof from one pool insertion. Cloning does not detach
/// inventory or grant memory authority. Provider methods never run under a pool
/// lock: the backing was captured while the parked candidate was caller-owned.
#[derive(Clone)]
pub struct IdleRetirementCandidate {
    pool: Uuid,
    epoch: Uuid,
    identity: IdleSandboxIdentity,
    sandbox_id: SandboxId,
    parked_at: Instant,
    profile_name: String,
    rootfs_hash: String,
    device_rate_limits: Option<DeviceRateLimits>,
    vcpu: u32,
    memory_mb: u32,
    backing: CapturedBacking,
}

impl IdlePool {
    /// Snapshot a captured, pool-owned resource without callbacks or removal.
    pub fn retirement_candidate(
        &self,
        identity: &IdleSandboxIdentity,
    ) -> Result<IdleRetirementCandidate, MemoryOperationError> {
        if self.revision == u64::MAX {
            return Err(MemoryOperationError::AccountingOverflow);
        }
        let entry = self
            .retirement_entry(identity)
            .ok_or(MemoryOperationError::ResourceChanged)?;
        let backing = entry
            .retirement_backing
            .clone()
            .ok_or(MemoryOperationError::MissingBacking)?;
        Ok(IdleRetirementCandidate {
            pool: self.generation,
            epoch: entry.insertion_epoch,
            identity: entry.metadata.identity.clone(),
            sandbox_id: entry.metadata.sandbox_id,
            parked_at: entry.parked_at,
            profile_name: entry.metadata.profile_name.clone(),
            rootfs_hash: entry.metadata.rootfs_hash.clone(),
            device_rate_limits: entry.metadata.device_rate_limits.clone(),
            vcpu: entry.budget_lease.vcpu(),
            memory_mb: entry.budget_lease.memory_mb(),
            backing,
        })
    }

    fn retirement_entry(&self, identity: &IdleSandboxIdentity) -> Option<&IdleEntry> {
        match identity {
            IdleSandboxIdentity::Exact(key) => self.exact_entries.get(key),
            IdleSandboxIdentity::Blank(id) => self.blank_entries.get(id),
        }
    }

    fn revalidate_retirement(&self, candidate: &IdleRetirementCandidate) -> bool {
        self.revision != u64::MAX
            && candidate.pool == self.generation
            && self
                .retirement_entry(&candidate.identity)
                .is_some_and(|entry| {
                    entry.insertion_epoch == candidate.epoch
                        && entry.metadata.sandbox_id == candidate.sandbox_id
                        && entry.parked_at == candidate.parked_at
                        && entry.metadata.profile_name == candidate.profile_name
                        && entry.metadata.rootfs_hash == candidate.rootfs_hash
                        && entry.metadata.device_rate_limits == candidate.device_rate_limits
                        && entry.budget_lease.vcpu() == candidate.vcpu
                        && entry.budget_lease.memory_mb() == candidate.memory_mb
                        && entry.retirement_backing.as_ref().is_some_and(|backing| {
                            backing.identity == candidate.backing.identity
                                && Arc::ptr_eq(&backing.process, &candidate.backing.process)
                        })
                })
    }
}

/// Unused allowances only: the real sandbox/data/lease stay in the pool through
/// every registration or grant wait. Dropping this admission cannot destroy them.
#[must_use]
pub struct IdlePoolRetirement {
    candidate: IdleRetirementCandidate,
    live: Allowance,
    tail: Allowance,
    ready: bool,
}

/// Unused provider claims survive rejection so their owner can release them
/// after dropping the pool lock. The real entry has already been restored.
#[must_use]
pub struct IdlePoolRetirementStartFailure {
    error: MemoryOperationError,
    retirement: IdlePoolRetirement,
}

impl IdlePoolRetirementStartFailure {
    pub fn error(&self) -> &MemoryOperationError {
        &self.error
    }

    pub fn into_retirement(self) -> IdlePoolRetirement {
        self.retirement
    }

    /// Call outside inventory locks: releasing unused claims can drop the last
    /// observer of a formerly selected provider backing.
    pub fn into_error(self) -> MemoryOperationError {
        self.error
    }
}

impl fmt::Debug for IdlePoolRetirementStartFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdlePoolRetirementStartFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl IdlePoolRetirement {
    /// Register both mandatory positive phases outside inventory locks.
    pub fn new(
        candidate: IdleRetirementCandidate,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
    ) -> Result<Self, MemoryOperationError> {
        let (live, tail) = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let live = operations.request(MemoryOperationPlan::Retire {
                growth_bytes: envelope.live_growth_bytes,
                backing: Arc::clone(&candidate.backing.process),
            })?;
            let tail = operations.request(MemoryOperationPlan::CleanupIo {
                growth_bytes: envelope.tail_growth_bytes,
            })?;
            Ok((live, tail))
        }))
        .unwrap_or(Err(MemoryOperationError::ProducerLost))?;
        Ok(Self {
            candidate,
            live: Allowance::Queued(live),
            tail: Allowance::Queued(tail),
            ready: false,
        })
    }

    /// Fresh observation and provider validation run outside inventory locks.
    /// Cancellation retains the inventory and unused claims for retry/drop.
    pub async fn try_grant(&mut self) -> Result<(), MemoryOperationError> {
        self.ready = false;
        self.live.try_grant().await?;
        self.tail.try_grant().await?;
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

    /// Revalidate and atomically accept both phases under short exclusive pool
    /// access, with no await or provider callback. Start rejection reinserts the
    /// original unconverted entry, retaining its age, epoch, promotion and lease.
    pub fn start(
        self,
        pool: &mut IdlePool,
        context: &'static str,
    ) -> Result<MemoryOperationTask<RetainedIdleDestroyResult>, Box<IdlePoolRetirementStartFailure>>
    {
        if !self.ready {
            return Err(self.reject(MemoryOperationError::Consumed));
        }
        if pool.revision == u64::MAX {
            return Err(self.reject(MemoryOperationError::AccountingOverflow));
        }
        if self.candidate.pool != pool.generation {
            return Err(self.reject(MemoryOperationError::OwnershipInvariant));
        }
        if !pool.revalidate_retirement(&self.candidate) {
            return Err(self.reject(MemoryOperationError::ResourceChanged));
        }
        let Self {
            candidate,
            live,
            tail,
            ..
        } = self;
        let (live, tail) = match (live, tail) {
            (Allowance::Granted(live), Allowance::Granted(tail)) => (live, tail),
            (live, tail) => {
                return Err(Self {
                    candidate,
                    live,
                    tail,
                    ready: false,
                }
                .reject(MemoryOperationError::Consumed));
            }
        };
        let entry = match &candidate.identity {
            IdleSandboxIdentity::Exact(key) => pool.exact_entries.remove(key),
            IdleSandboxIdentity::Blank(id) => pool.blank_entries.remove(id),
        };
        let Some(entry) = entry else {
            return Err(Self {
                candidate,
                live: Allowance::Granted(live),
                tail: Allowance::Granted(tail),
                ready: true,
            }
            .reject(MemoryOperationError::OwnershipInvariant));
        };
        match live.spawn_retirement(
            tail,
            (entry, context, candidate),
            |live, tail, (entry, context, candidate)| {
                run_retirement(
                    live,
                    tail,
                    (
                        entry.into_destroy_job(),
                        context,
                        candidate.backing.process,
                        candidate.backing.identity,
                    ),
                )
            },
        ) {
            Ok(task) => {
                pool.bump_revision();
                Ok(task)
            }
            Err(failure) => {
                // Deliberately bypass insert_entry: rejected work never became
                // a new insertion and must not invalidate other pending claims.
                let (entry, _, candidate) = failure.payload;
                match &entry.metadata.identity {
                    IdleSandboxIdentity::Exact(key) => {
                        pool.exact_entries.insert(key.clone(), entry);
                    }
                    IdleSandboxIdentity::Blank(id) => {
                        pool.blank_entries.insert(*id, entry);
                    }
                }
                Err(Self {
                    candidate,
                    live: Allowance::Granted(failure.live),
                    tail: Allowance::Granted(failure.tail),
                    ready: true,
                }
                .reject(failure.error))
            }
        }
    }

    fn reject(self, error: MemoryOperationError) -> Box<IdlePoolRetirementStartFailure> {
        Box::new(IdlePoolRetirementStartFailure {
            error,
            retirement: self,
        })
    }
}
