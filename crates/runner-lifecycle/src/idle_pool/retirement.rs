//! Mandatory, supplied coverage for one real idle terminal lifecycle.
//!
//! This component does not detach inventory or select production calibration.
//! Its owner retains the original job until both allowances transfer atomically.

use std::fmt;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use sandbox::{BackingProcessIdentity, SandboxBackingProcess};
use tokio::sync::Notify;

use crate::host_memory_operations::{
    HostMemoryOperations, MemoryGrowthPermit, MemoryGrowthRequest, MemoryOperation,
    MemoryOperationError, MemoryOperationPlan, MemoryOperationTask,
};

use super::{DestroyOutcome, IdleDestroyJob, RetainedIdleDestroyResult};

/// Positive measured/supplied growth, not guessed residency or eviction yield.
/// Both phases consume cleanup slots and bytes in the same P2 authority.
#[derive(Clone, Copy, Debug)]
pub struct IdleRetirementEnvelope {
    pub live_growth_bytes: u64,
    pub tail_growth_bytes: u64,
}

pub(super) enum Allowance {
    Queued(MemoryGrowthRequest),
    Granted(MemoryGrowthPermit),
}

impl Allowance {
    pub(super) async fn try_grant(&mut self) -> Result<(), MemoryOperationError> {
        if let Self::Queued(request) = self {
            let permit = request.try_grant().await?;
            *self = Self::Granted(permit);
        }
        Ok(())
    }
}

/// Parked terminal work, with no physical preparation before both grants/start.
/// Losing a grant waiter does not move the job out of this owner. Callers must
/// recover/retain this owner on no-progress rather than drop parked resources.
#[must_use = "retain the parked job on no-progress, or transfer it to accepted cleanup"]
pub struct GuardedIdleRetirement {
    job: IdleDestroyJob,
    live: Allowance,
    tail: Allowance,
    backing: Arc<dyn SandboxBackingProcess>,
    backing_identity: BackingProcessIdentity,
}

/// Registration/capture failed before physical work; original data stays owned.
#[must_use = "recover the original idle job instead of dropping its resources"]
pub struct IdleRetirementAdmissionFailure {
    error: MemoryOperationError,
    job: IdleDestroyJob,
}

impl IdleRetirementAdmissionFailure {
    pub fn error(&self) -> &MemoryOperationError {
        &self.error
    }

    pub fn into_job(self) -> IdleDestroyJob {
        self.job
    }
}

impl fmt::Debug for IdleRetirementAdmissionFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdleRetirementAdmissionFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

/// An atomic start rejection returns the still-unstarted real owner.
#[must_use = "retain or recover the unstarted retirement after rejection"]
pub struct IdleRetirementStartFailure {
    error: MemoryOperationError,
    retirement: GuardedIdleRetirement,
}

impl IdleRetirementStartFailure {
    pub fn error(&self) -> &MemoryOperationError {
        &self.error
    }

    pub fn into_retirement(self) -> GuardedIdleRetirement {
        self.retirement
    }
}

impl fmt::Debug for IdleRetirementStartFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdleRetirementStartFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl GuardedIdleRetirement {
    /// Capture exact provider backing and register mandatory positive phases.
    /// Call at an existing exclusive resource-owner boundary outside pool locks.
    /// Missing backing, invalid policy or bounded registration failure cannot
    /// take the original logical lease, promotion or physical resource away.
    pub fn new(
        job: IdleDestroyJob,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
    ) -> Result<Self, Box<IdleRetirementAdmissionFailure>> {
        let register = || {
            let backing = job
                .payload
                .resources
                .sandbox
                .backing_process()
                .ok_or(MemoryOperationError::MissingBacking)?;
            let live = operations.request(MemoryOperationPlan::Retire {
                growth_bytes: envelope.live_growth_bytes,
                backing: Arc::clone(&backing),
            })?;
            let tail = operations.request(MemoryOperationPlan::CleanupIo {
                growth_bytes: envelope.tail_growth_bytes,
            })?;
            let identity = backing.identity();
            Ok((live, tail, backing, identity))
        };
        let registered = std::panic::catch_unwind(AssertUnwindSafe(register))
            .unwrap_or(Err(MemoryOperationError::ProducerLost));
        match registered {
            Ok((live, tail, backing, backing_identity)) => Ok(Self {
                job,
                live: Allowance::Queued(live),
                tail: Allowance::Queued(tail),
                backing,
                backing_identity,
            }),
            Err(error) => Err(Box::new(IdleRetirementAdmissionFailure { error, job })),
        }
    }

    /// Fresh reads run outside resource locks. Failure keeps all unused claims
    /// and the original job for an owned retry/recovery; no cleanup has started.
    pub async fn try_grant(&mut self) -> Result<(), MemoryOperationError> {
        self.live.try_grant().await?;
        self.tail.try_grant().await
    }

    /// Recover the untouched job, releasing only unused phase claims.
    pub fn into_job(self) -> IdleDestroyJob {
        self.job
    }

    /// Synchronously accept both covered phases before invoking physical work.
    /// A completion receiver cannot abort them; start rejection returns this
    /// owner, including the original job and both unused allowances.
    pub fn start(
        self,
        context: &'static str,
    ) -> Result<MemoryOperationTask<RetainedIdleDestroyResult>, Box<IdleRetirementStartFailure>>
    {
        let Self {
            job,
            live,
            tail,
            backing,
            backing_identity,
        } = self;
        match (live, tail) {
            (Allowance::Granted(live), Allowance::Granted(tail)) => live
                .spawn_retirement(
                    tail,
                    (job, context, backing, backing_identity),
                    run_retirement,
                )
                .map_err(|failure| {
                    let (job, _, backing, backing_identity) = failure.payload;
                    Box::new(IdleRetirementStartFailure {
                        error: failure.error,
                        retirement: Self {
                            job,
                            live: Allowance::Granted(failure.live),
                            tail: Allowance::Granted(failure.tail),
                            backing,
                            backing_identity,
                        },
                    })
                }),
            (live, tail) => Err(Box::new(IdleRetirementStartFailure {
                error: MemoryOperationError::Consumed,
                retirement: Self {
                    job,
                    live,
                    tail,
                    backing,
                    backing_identity,
                },
            })),
        }
    }
}

async fn settle(operation: &mut MemoryOperation, context: &'static str) -> bool {
    loop {
        match AssertUnwindSafe(operation.complete_phase())
            .catch_unwind()
            .await
        {
            Ok(Ok(())) => return true,
            Ok(Err(MemoryOperationError::AccountingChanged)) => {
                // Concurrent independent owners must not manufacture uncertainty
                // just by finishing together. Every retry takes a new real read.
                tokio::task::yield_now().await;
            }
            Ok(Err(error)) => {
                tracing::warn!(context, %error, "idle retirement phase remains uncertain");
                return false;
            }
            Err(_) => {
                tracing::warn!(context, "idle retirement phase observer panicked");
                return false;
            }
        }
    }
}

pub(super) async fn run_retirement(
    mut live: MemoryOperation,
    mut tail: MemoryOperation,
    (job, context, backing, backing_identity): (
        IdleDestroyJob,
        &'static str,
        Arc<dyn SandboxBackingProcess>,
        BackingProcessIdentity,
    ),
) -> RetainedIdleDestroyResult {
    let (payload, budget_lease) = job.into_retiring_parts();
    let mut prepared = payload.prepare_terminal(context).await;
    let preparation_completed = prepared.preparation_completed();
    let reclamation_permit = prepared.take_reclamation_permit();
    let release_reclamation = Notify::new();
    let reclamation = async {
        // One owner holds the local CPU gate. Either positive exact exit or
        // joined teardown releases it; physical phases share no producer lock.
        let _held = reclamation_permit;
        release_reclamation.notified().await;
    };
    let complete_live = async {
        if preparation_completed && settle(&mut live, context).await {
            // Positive exact exit can precede generic kill's service/log tail.
            // Growing work remains covered by `tail`, not the CPU export gate.
            release_reclamation.notify_one();
            true
        } else {
            false
        }
    };
    let cleanup = async {
        let mut termination = prepared.terminate().await;
        if termination.terminated() {
            let proof = AssertUnwindSafe(async {
                backing.identity() == backing_identity
                    && backing.exit_confirmed().await
                    && backing.identity() == backing_identity
            })
            .catch_unwind()
            .await
            .unwrap_or(false);
            termination = termination.require_backing_exit(proof);
            if proof {
                release_reclamation.notify_one();
            }
        }
        // Failed kill must reach factory destruction while exact wait is still
        // pending: that owner may be what actually terminates the backing.
        let result = prepared.publish_and_destroy(termination, None).await;
        release_reclamation.notify_one();
        let tail_settled =
            result.outcome == DestroyOutcome::Completed && settle(&mut tail, context).await;
        (result, tail_settled)
    };
    let (live_settled, (result, tail_settled), ()) =
        tokio::join!(complete_live, cleanup, reclamation);
    RetainedIdleDestroyResult {
        outcome: if live_settled && tail_settled {
            DestroyOutcome::Completed
        } else {
            DestroyOutcome::Uncertain
        },
        home_cache_promoted: result.home_cache_promoted,
        budget_lease,
    }
}

#[cfg(test)]
mod tests;
