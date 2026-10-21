//! Supplied-policy real claim/guest preparation and ownership-safe rollback.

use runner_lifecycle::host_memory_operations::{HostMemoryOperations, MemoryOperationError};
use runner_lifecycle::idle_pool::{
    GuardedSpeculativeIdleOwner, IdleActivationOwner, IdlePoolIncoming, IdleRetirementEnvelope,
    ReusableIdleSandbox, SpeculativeActivationState,
};

use super::*;
use crate::idle_lifecycle::{GuardedActivationCleanupTask, IdlePoolInsertionResult};

enum Resource {
    Speculative(Box<GuardedSpeculativeIdleOwner>),
    Incoming(Box<IdlePoolIncoming>),
    Cleanup(Box<Option<IdleActivationOwner>>),
    Transferred,
}

type ClaimResult = Result<Option<ClaimedJob>, MemoryOperationError>;

enum ClaimObservation {
    Pending(oneshot::Receiver<ClaimResult>),
    Claimed(Box<ClaimedJob>),
    Rejected,
    Consumed,
    Uncertain(Option<MemoryOperationError>),
}

/// Begun identity outlives receipt consumption, including successful transfer.
struct BegunClaim {
    run_id: RunId,
    observation: ClaimObservation,
}

impl BegunClaim {
    async fn wait(&mut self) -> Result<(), MemoryOperationError> {
        let response = match &mut self.observation {
            ClaimObservation::Pending(receiver) => receiver.await,
            ClaimObservation::Uncertain(_) => return Err(MemoryOperationError::ProducerLost),
            ClaimObservation::Claimed(_)
            | ClaimObservation::Rejected
            | ClaimObservation::Consumed => {
                return Ok(());
            }
        };
        // Only replace the receiver after its borrowed wait completes.
        match response {
            Ok(response) => self.record(response),
            Err(_) => {
                self.observation = ClaimObservation::Uncertain(None);
                Err(MemoryOperationError::ProducerLost)
            }
        }
    }

    fn record(&mut self, response: ClaimResult) -> Result<(), MemoryOperationError> {
        self.observation = match response {
            Ok(Some(claimed)) => ClaimObservation::Claimed(Box::new(claimed)),
            Ok(None) => ClaimObservation::Rejected,
            Err(error) => ClaimObservation::Uncertain(Some(error)),
        };
        if matches!(self.observation, ClaimObservation::Uncertain(_)) {
            Err(MemoryOperationError::ProducerLost)
        } else {
            Ok(())
        }
    }

    fn receive_ready(&mut self) -> Result<(), MemoryOperationError> {
        let response = match &mut self.observation {
            ClaimObservation::Pending(receiver) => receiver.try_recv(),
            ClaimObservation::Consumed | ClaimObservation::Uncertain(None) => {
                return Err(MemoryOperationError::Consumed);
            }
            ClaimObservation::Claimed(_)
            | ClaimObservation::Rejected
            | ClaimObservation::Uncertain(Some(_)) => return Ok(()),
        };
        match response {
            Ok(response) => {
                // Preserve the actual error receipt for its explicit take.
                let _ = self.record(response);
                Ok(())
            }
            Err(oneshot::error::TryRecvError::Empty) => Err(MemoryOperationError::Consumed),
            Err(oneshot::error::TryRecvError::Closed) => {
                self.observation = ClaimObservation::Uncertain(None);
                Err(MemoryOperationError::ProducerLost)
            }
        }
    }

    fn take_response(&mut self) -> ClaimResult {
        self.receive_ready()?;
        // Uncertainty remains sticky after taking its actual error receipt.
        if let ClaimObservation::Uncertain(error) = &mut self.observation {
            return Err(error.take().ok_or(MemoryOperationError::Consumed)?);
        }
        match std::mem::replace(&mut self.observation, ClaimObservation::Consumed) {
            ClaimObservation::Claimed(claimed) => Ok(Some(*claimed)),
            ClaimObservation::Rejected => Ok(None),
            observation => {
                self.observation = observation;
                Err(MemoryOperationError::Consumed)
            }
        }
    }

    fn take_matching_claim(&mut self) -> Result<Box<ClaimedJob>, String> {
        self.receive_ready().map_err(|e| e.to_string())?;
        match std::mem::replace(&mut self.observation, ClaimObservation::Consumed) {
            ClaimObservation::Claimed(claimed) if claimed.context().run_id == self.run_id => {
                Ok(claimed)
            }
            observation => {
                self.observation = observation;
                Err("speculative claim response missing, failed or mismatched".into())
            }
        }
    }

    fn restore_claim(&mut self, claimed: Box<ClaimedJob>) {
        self.observation = ClaimObservation::Claimed(claimed);
    }
}

/// Store this capsule outside every observed future. Provider claims are
/// independently tracked once accepted; their auth/result remains here even
/// when preparation or result observation is cancelled.
#[must_use]
pub struct GuardedSpeculativeAdmission {
    resource: Resource,
    claim: Option<BegunClaim>,
    preparation_error: Option<String>,
}

pub enum GuardedSpeculativeRollback {
    Restored(IdlePoolInsertionResult),
    Cleanup(GuardedActivationCleanupTask),
}

impl GuardedSpeculativeAdmission {
    pub fn new(reservation: ReservedIdleSandbox) -> Result<Self, Box<ReservedIdleSandbox>> {
        Ok(Self {
            resource: Resource::Speculative(Box::new(GuardedSpeculativeIdleOwner::new(
                reservation,
            )?)),
            claim: None,
            preparation_error: None,
        })
    }

    /// Start exactly one non-cancellable provider claim before borrowing the
    /// actual guest resource. Joined shutdown includes claim producer lifetime.
    pub async fn prepare_and_claim(
        &mut self,
        provider: Arc<dyn JobProvider>,
        candidate: JobCandidate,
        tracker: &IdleDestroyTracker,
    ) -> Result<(), String> {
        if self.claim.is_some() {
            return Err("speculative claim already began; observe its retained response".into());
        }
        let Resource::Speculative(owner) = &mut self.resource else {
            return Err("speculative resource already transferred".into());
        };
        let matches = candidate
            .runner_preference()
            .and_then(|p| p.target().source_run_id())
            .is_some_and(|source| {
                owner.matches_source_claim(candidate.reuse_key(), source, candidate.profile_name())
            });
        if !matches {
            return Err(
                "speculative candidate does not match original resource identity/profile".into(),
            );
        }
        owner.capture_backing().map_err(|e| e.to_string())?;
        let token = tracker.acceptance_token().map_err(|e| e.to_string())?;
        let run_id = candidate.run_id();
        let (response, wait) = oneshot::channel();
        self.claim = Some(BegunClaim {
            run_id,
            observation: ClaimObservation::Pending(wait),
        });
        tracker.spawn_cleanup(
            async move {
                let _token = token;
                let result = AssertUnwindSafe(async { provider.claim(candidate).await })
                    .catch_unwind()
                    .await
                    .map_err(|_| MemoryOperationError::ProducerLost);
                // A provider panic is an uncertain response, never a rejection.
                // The receiver belongs to the external capsule, including
                // while its borrowed observation future is cancelled.
                let _ = response.send(result);
            },
            "guarded_speculative_claim",
        );
        let result = owner
            .prepare(run_id, |sandbox, run_id, timezone| {
                Box::pin(async move {
                    restore_guest_state_with_intent(sandbox, run_id, timezone)
                        .await
                        .map_err(|error| error.to_string())
                })
            })
            .await;
        self.preparation_error = result.as_ref().err().cloned();
        self.wait_for_claim().await.map_err(|e| e.to_string())?;
        result
    }

    pub async fn wait_for_claim(&mut self) -> Result<(), MemoryOperationError> {
        self.claim
            .as_mut()
            .ok_or(MemoryOperationError::Consumed)?
            .wait()
            .await
    }

    pub fn preparation_error(&self) -> Option<&str> {
        self.preparation_error.as_deref()
    }

    /// A failed/rejected preparation may still have a successful claim requiring
    /// completion. Take its exact original auth explicitly at that boundary.
    pub fn take_claim_response(&mut self) -> Result<Option<ClaimedJob>, MemoryOperationError> {
        self.claim
            .as_mut()
            .ok_or(MemoryOperationError::Consumed)?
            .take_response()
    }

    /// Verify run identity before atomically transferring claim/resource/full
    /// lease. Mismatch keeps both original owners for completion and cleanup.
    pub fn commit(
        &mut self,
    ) -> Result<(ClaimedJob, Box<ReusableIdleSandbox>, BudgetLease), String> {
        let claim = self
            .claim
            .as_mut()
            .ok_or("speculative claim has not begun")?;
        let run_id = claim.run_id;
        let claimed = claim.take_matching_claim()?;
        let Resource::Speculative(owner) = &mut self.resource else {
            claim.restore_claim(claimed);
            return Err("speculative resource already transferred".into());
        };
        let claimed_timezone =
            runner_lifecycle::guest_timezone::GuestTimezoneIntent::from_context(claimed.context());
        let (sandbox, lease) = match owner.commit(run_id, &claimed_timezone) {
            Ok(resource) => resource,
            Err(error) => {
                claim.restore_claim(claimed);
                return Err(error);
            }
        };
        self.resource = Resource::Transferred;
        Ok((*claimed, sandbox, lease))
    }

    /// Convert a rejected pool incoming owner to the shared required-cleanup
    /// capsule explicitly. This is synchronous and keeps its original fence.
    pub fn require_cleanup(&mut self) -> Result<(), MemoryOperationError> {
        let owner = match &mut self.resource {
            Resource::Speculative(owner) => owner.take_cleanup_owner()?,
            Resource::Incoming(incoming) => incoming.take_required_cleanup_owner()?,
            Resource::Cleanup(_) => return Ok(()),
            Resource::Transferred => return Err(MemoryOperationError::Consumed),
        };
        self.resource = Resource::Cleanup(Box::new(Some(owner)));
        Ok(())
    }

    /// Repark/insertion and cleanup admission borrow the persistent owner.
    /// Errors (including contention/no headroom) leave it available for an
    /// explicit retry or required cleanup. Successful acceptance precedes status.
    pub async fn rollback(
        &mut self,
        pool: &SharedIdlePool,
        tracker: &IdleDestroyTracker,
        status: &StatusTracker,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
        home_image_size_bytes: u64,
    ) -> Result<GuardedSpeculativeRollback, MemoryOperationError> {
        if self.claim.is_some() {
            self.wait_for_claim().await?;
        }
        if let Resource::Speculative(owner) = &mut self.resource {
            if owner.state() == SpeculativeActivationState::Prepared
                && let Err(error) = owner.repark(home_image_size_bytes).await
            {
                self.preparation_error = Some(error);
            }
            if matches!(
                owner.state(),
                SpeculativeActivationState::Parked | SpeculativeActivationState::Reparked
            ) {
                self.resource = Resource::Incoming(Box::new(owner.take_incoming()?));
            } else {
                self.require_cleanup()?;
            }
        }
        match &mut self.resource {
            Resource::Incoming(incoming) => {
                let result = tracker
                    .insert_pool_entry(
                        pool,
                        incoming,
                        operations,
                        envelope,
                        "guarded_speculative_rollback_restore",
                    )
                    .await?;
                self.resource = Resource::Transferred;
                set_idle_status_snapshot(status, result.snapshot.clone()).await;
                Ok(GuardedSpeculativeRollback::Restored(result))
            }
            Resource::Cleanup(owner) => {
                let task = tracker
                    .retire_activation_owner(
                        owner,
                        operations,
                        envelope,
                        "guarded_speculative_rollback_cleanup",
                    )
                    .await?;
                self.resource = Resource::Transferred;
                Ok(GuardedSpeculativeRollback::Cleanup(task))
            }
            _ => Err(MemoryOperationError::Consumed),
        }
    }
}

#[cfg(test)]
mod tests;
