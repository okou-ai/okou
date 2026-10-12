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
    Waiting,
    Received,
    Uncertain,
}

/// Store this capsule outside every observed future. Provider claims are
/// independently tracked once accepted; their auth/result remains here even
/// when preparation or result observation is cancelled.
#[must_use]
pub struct GuardedSpeculativeAdmission {
    resource: Resource,
    claim: Option<ClaimResult>,
    claim_response: Option<oneshot::Receiver<ClaimResult>>,
    claim_observation: ClaimObservation,
    run_id: Option<RunId>,
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
            claim_response: None,
            claim_observation: ClaimObservation::Waiting,
            run_id: None,
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
        if self.run_id.is_some() {
            return Err("speculative claim already began; observe its retained response".into());
        }
        let Resource::Speculative(owner) = &mut self.resource else {
            return Err("speculative resource already transferred".into());
        };
        if !owner.matches_claim(
            candidate.reuse_key(),
            candidate.history_generation_run_id(),
            candidate.profile_name(),
        ) {
            return Err(
                "speculative candidate does not match original exact history/profile".into(),
            );
        }
        owner.capture_backing().map_err(|e| e.to_string())?;
        let token = tracker.acceptance_token().map_err(|e| e.to_string())?;
        let run_id = candidate.run_id();
        let (response, wait) = oneshot::channel();
        self.run_id = Some(run_id);
        self.claim_response = Some(wait);
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
        match self.claim_observation {
            ClaimObservation::Received => return Ok(()),
            ClaimObservation::Uncertain => return Err(MemoryOperationError::ProducerLost),
            ClaimObservation::Waiting => {}
        }
        let result = self
            .claim_response
            .as_mut()
            .ok_or(MemoryOperationError::Consumed)?
            .await;
        self.claim_response = None;
        match result {
            Ok(response) => self.record_claim(response),
            Err(_) => {
                self.claim_observation = ClaimObservation::Uncertain;
                Err(MemoryOperationError::ProducerLost)
            }
        }
    }

    fn record_claim(&mut self, response: ClaimResult) -> Result<(), MemoryOperationError> {
        let definite = response.is_ok();
        self.claim = Some(response);
        if definite {
            self.claim_observation = ClaimObservation::Received;
            Ok(())
        } else {
            self.claim_observation = ClaimObservation::Uncertain;
            Err(MemoryOperationError::ProducerLost)
        }
    }

    fn receive_ready_claim(&mut self) -> Result<(), MemoryOperationError> {
        if self.claim.is_some() {
            return Ok(());
        }
        let response = self
            .claim_response
            .as_mut()
            .ok_or(MemoryOperationError::Consumed)?
            .try_recv();
        match response {
            Ok(response) => {
                self.claim_response = None;
                // Preserve the actual error receipt for its explicit take.
                let _ = self.record_claim(response);
                Ok(())
            }
            Err(oneshot::error::TryRecvError::Empty) => Err(MemoryOperationError::Consumed),
            Err(oneshot::error::TryRecvError::Closed) => {
                self.claim_response = None;
                self.claim_observation = ClaimObservation::Uncertain;
                Err(MemoryOperationError::ProducerLost)
            }
        }
    }

    pub fn preparation_error(&self) -> Option<&str> {
        self.preparation_error.as_deref()
    }

    /// A failed/rejected preparation may still have a successful claim requiring
    /// completion. Take its exact original auth explicitly at that boundary.
    pub fn take_claim_response(&mut self) -> Result<Option<ClaimedJob>, MemoryOperationError> {
        self.receive_ready_claim()?;
        self.claim.take().ok_or(MemoryOperationError::Consumed)?
    }

    /// Verify run identity before atomically transferring claim/resource/full
    /// lease. Mismatch keeps both original owners for completion and cleanup.
    pub fn commit(
        &mut self,
    ) -> Result<(ClaimedJob, Box<ReusableIdleSandbox>, BudgetLease), String> {
        let run_id = self.run_id.ok_or("speculative claim has not begun")?;
        self.receive_ready_claim().map_err(|e| e.to_string())?;
        let claimed = match self.claim.take() {
            Some(Ok(Some(claimed))) if claimed.context().run_id == run_id => claimed,
            receipt => {
                self.claim = receipt;
                return Err("speculative claim response missing, failed or mismatched".into());
            }
        };
        let Resource::Speculative(owner) = &mut self.resource else {
            self.claim = Some(Ok(Some(claimed)));
            return Err("speculative resource already transferred".into());
        };
        let claimed_timezone =
            runner_lifecycle::guest_timezone::GuestTimezoneIntent::from_context(claimed.context());
        let (sandbox, lease) = match owner.commit(run_id, &claimed_timezone) {
            Ok(resource) => resource,
            Err(error) => {
                self.claim = Some(Ok(Some(claimed)));
                return Err(error);
            }
        };
        self.resource = Resource::Transferred;
        Ok((claimed, sandbox, lease))
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
        if self.run_id.is_some() {
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
