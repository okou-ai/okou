//! Logical lease handoff without weakening the real physical retirement owner.

use crate::resource_budget::BudgetLease;

use super::super::IdleDestroyResult;
use super::super::entry::{HomePromotionPolicy, IdleSandboxMetadata, IdleSandboxResources};
use super::super::retirement::run_retirement_payload;
use super::*;

/// Accepted physical cleanup and the original full-profile logical lease.
/// Transferring this lease grants no physical memory credit.
pub struct IdlePoolSubstitutionStarted {
    pub task: MemoryOperationTask<IdleDestroyResult>,
    pub budget_lease: BudgetLease,
}

/// Every field of the original entry except its separately held logical lease.
/// Rejection reconstructs the same owner; conversion happens only inside P2 work.
struct SubstitutionResource {
    resources: IdleSandboxResources,
    metadata: IdleSandboxMetadata,
    parked_at: Instant,
    retirement_backing: Option<CapturedBacking>,
    insertion_epoch: Uuid,
}

impl SubstitutionResource {
    fn split(entry: IdleEntry) -> (Self, BudgetLease) {
        let IdleEntry {
            resources,
            metadata,
            budget_lease,
            parked_at,
            retirement_backing,
            insertion_epoch,
        } = entry;
        (
            Self {
                resources,
                metadata,
                parked_at,
                retirement_backing,
                insertion_epoch,
            },
            budget_lease,
        )
    }

    fn restore(self, budget_lease: BudgetLease) -> IdleEntry {
        let Self {
            resources,
            metadata,
            parked_at,
            retirement_backing,
            insertion_epoch,
        } = self;
        IdleEntry {
            resources,
            metadata,
            budget_lease,
            parked_at,
            retirement_backing,
            insertion_epoch,
        }
    }
}

impl IdlePoolRetirement {
    /// Accept both mandatory phases and return the full lease synchronously.
    /// The caller must adopt the task before yielding, then use ResourceBudget's
    /// atomic substitution. Old backing exit is not a logical-capacity barrier.
    /// Start refusal restores the complete original unconverted entry.
    pub fn start_for_substitution(
        self,
        pool: &mut IdlePool,
        context: &'static str,
    ) -> Result<IdlePoolSubstitutionStarted, Box<IdlePoolRetirementStartFailure>> {
        let DetachedRetirement {
            entry,
            candidate,
            live,
            tail,
        } = self.detach(pool)?;
        let (resource, budget_lease) = SubstitutionResource::split(entry);
        match live.spawn_retirement(
            tail,
            (resource, context, candidate),
            |live, tail, (resource, context, candidate)| {
                run_retirement_payload(
                    live,
                    tail,
                    (
                        resource
                            .resources
                            .into_destroy_payload(HomePromotionPolicy::Promote),
                        context,
                        candidate.backing.process,
                        candidate.backing.identity,
                    ),
                )
            },
        ) {
            Ok(task) => {
                pool.bump_revision();
                Ok(IdlePoolSubstitutionStarted { task, budget_lease })
            }
            Err(failure) => {
                let (resource, _, candidate) = failure.payload;
                Err(DetachedRetirement {
                    entry: resource.restore(budget_lease),
                    candidate,
                    live: failure.live,
                    tail: failure.tail,
                }
                .restore(pool, failure.error))
            }
        }
    }
}
