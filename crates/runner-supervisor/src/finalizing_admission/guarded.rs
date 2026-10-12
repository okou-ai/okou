//! Borrowed custody across the real finalizing broker and provider claim.

#[cfg(test)]
mod tests;

use runner_lifecycle::active_runs::{
    ActiveRunHandoffRequest, ActiveRunReusePublisher, RetainedActiveRunHandoffDeliveryResult,
};
use runner_lifecycle::host_memory_operations::{HostMemoryOperations, MemoryOperationError};
use runner_lifecycle::idle_pool::{
    ActivatedFinalizingHandoff, FinalizingHandoffCandidate, GuardedFinalizingHandoffOwner,
    IdleActivationOwner, IdleParkCandidate, IdleRetirementEnvelope,
};
use runner_provider::ClaimedJob;
use runner_types::ids::RunId;

use crate::idle_lifecycle::{GuardedActivationCleanupTask, IdleDestroyTracker};

/// Recovery transfers custody, never physical credit or completion proof.
pub enum RetainedFinalizingResource {
    Handoff(Box<GuardedFinalizingHandoffOwner>),
    RequiredCleanup(Box<IdleActivationOwner>),
}

/// Does not retain a tracker handle: registry ownership cannot form an Arc cycle.
pub struct GuardedFinalizingRecovery {
    pub claimed: Option<ClaimedJob>,
    pub resource: Option<RetainedFinalizingResource>,
    /// Lost delivery is unresolved even when the original claim is recovered.
    pub delivery_uncertain: bool,
}

enum Resource {
    Handoff(Box<GuardedFinalizingHandoffOwner>),
    Cleanup(Box<Option<IdleActivationOwner>>),
    Transferred,
}

impl Resource {
    fn take_recovery(&mut self) -> Option<RetainedFinalizingResource> {
        match std::mem::replace(self, Self::Transferred) {
            Self::Handoff(owner) => Some(RetainedFinalizingResource::Handoff(owner)),
            Self::Cleanup(owner) => {
                (*owner).map(|owner| RetainedFinalizingResource::RequiredCleanup(Box::new(owner)))
            }
            Self::Transferred => None,
        }
    }

    async fn cleanup(
        &mut self,
        tracker: &IdleDestroyTracker,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
        context: &'static str,
    ) -> Result<GuardedActivationCleanupTask, MemoryOperationError> {
        if let Self::Handoff(owner) = self {
            // Capture/validation precedes the ownership move; failure retains
            // the original typed parked/running capsule without disposition.
            let owner = owner.take_cleanup_owner()?;
            *self = Self::Cleanup(Box::new(Some(owner)));
        }
        let Self::Cleanup(owner) = self else {
            return Err(MemoryOperationError::Consumed);
        };
        tracker
            .retire_activation_owner(owner, operations, envelope, context)
            .await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuardedFinalizingOfferOutcome {
    Delivered,
    NotRequested,
    Undelivered,
    ReceiverLost,
}

/// Producer capsule stays outside futures and retains every refused delivery.
#[must_use]
pub struct GuardedFinalizingOffer {
    resource: Resource,
    predecessor: RunId,
    tracker: IdleDestroyTracker,
}

impl GuardedFinalizingOffer {
    pub fn new(
        candidate: IdleParkCandidate,
        predecessor: RunId,
        tracker: IdleDestroyTracker,
    ) -> Self {
        Self {
            resource: Resource::Handoff(Box::new(GuardedFinalizingHandoffOwner::undelivered(
                candidate,
                predecessor,
            ))),
            predecessor,
            tracker,
        }
    }

    pub fn owner(&self) -> Option<&GuardedFinalizingHandoffOwner> {
        match &self.resource {
            Resource::Handoff(owner) => Some(owner),
            _ => None,
        }
    }

    pub fn offer(
        &mut self,
        publisher: &ActiveRunReusePublisher,
    ) -> Result<GuardedFinalizingOfferOutcome, MemoryOperationError> {
        let _token = self.tracker.acceptance_token()?;
        if publisher.predecessor_run_id() != Some(self.predecessor) {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let Resource::Handoff(owner) = &mut self.resource else {
            return Err(MemoryOperationError::Consumed);
        };
        // All provider callbacks occur before the broker's short pure lock.
        let candidate = owner.take_undelivered_candidate()?;
        let (outcome, owner) =
            match publisher.deliver_exact_handoff_retained(candidate, self.predecessor) {
                RetainedActiveRunHandoffDeliveryResult::Delivered => {
                    (GuardedFinalizingOfferOutcome::Delivered, None)
                }
                RetainedActiveRunHandoffDeliveryResult::NotRequested(candidate) => (
                    GuardedFinalizingOfferOutcome::NotRequested,
                    Some(GuardedFinalizingHandoffOwner::undelivered(
                        candidate,
                        self.predecessor,
                    )),
                ),
                RetainedActiveRunHandoffDeliveryResult::Undelivered(candidate) => (
                    GuardedFinalizingOfferOutcome::Undelivered,
                    Some(GuardedFinalizingHandoffOwner::undelivered(
                        candidate,
                        self.predecessor,
                    )),
                ),
                RetainedActiveRunHandoffDeliveryResult::Failed(candidate) => (
                    GuardedFinalizingOfferOutcome::ReceiverLost,
                    Some(GuardedFinalizingHandoffOwner::new(candidate)),
                ),
            };
        self.resource = owner.map_or(Resource::Transferred, |owner| {
            Resource::Handoff(Box::new(owner))
        });
        Ok(outcome)
    }

    pub async fn cleanup(
        &mut self,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
    ) -> Result<GuardedActivationCleanupTask, MemoryOperationError> {
        self.resource
            .cleanup(&self.tracker, operations, envelope, "finalizing offer")
            .await
    }
}

impl Drop for GuardedFinalizingOffer {
    fn drop(&mut self) {
        self.tracker
            .retain_finalizing_recovery(GuardedFinalizingRecovery {
                claimed: None,
                resource: self.resource.take_recovery(),
                delivery_uncertain: false,
            });
    }
}

#[must_use]
pub struct ActivatedGuardedFinalizing {
    pub claimed: ClaimedJob,
    pub resource: ActivatedFinalizingHandoff,
}

/// Actual claim/auth and receiver remain owned if any borrowed wait is cancelled.
#[must_use]
pub struct GuardedFinalizingAdmission {
    claimed: Option<ClaimedJob>,
    request: Option<ActiveRunHandoffRequest>,
    predecessor: RunId,
    resource: Resource,
    delivery_uncertain: bool,
    tracker: IdleDestroyTracker,
}

impl GuardedFinalizingAdmission {
    pub fn new(
        claimed: ClaimedJob,
        request: ActiveRunHandoffRequest,
        predecessor: RunId,
        tracker: IdleDestroyTracker,
    ) -> Self {
        Self {
            claimed: Some(claimed),
            request: Some(request),
            predecessor,
            resource: Resource::Transferred,
            delivery_uncertain: false,
            tracker,
        }
    }

    pub fn claimed(&self) -> Option<&ClaimedJob> {
        self.claimed.as_ref()
    }

    pub fn owner(&self) -> Option<&GuardedFinalizingHandoffOwner> {
        match &self.resource {
            Resource::Handoff(owner) => Some(owner),
            _ => None,
        }
    }

    fn install(&mut self, candidate: Box<FinalizingHandoffCandidate>) {
        self.resource = Resource::Handoff(Box::new(GuardedFinalizingHandoffOwner::new(candidate)));
    }

    pub async fn receive(&mut self) -> Result<(), MemoryOperationError> {
        if self.delivery_uncertain {
            return Err(MemoryOperationError::ProducerLost);
        }
        if !matches!(self.resource, Resource::Transferred) {
            return Err(MemoryOperationError::Consumed);
        }
        let _token = self.tracker.acceptance_token()?;
        let received = self
            .request
            .as_mut()
            .ok_or(MemoryOperationError::Consumed)?
            .receive()
            .await;
        match received {
            Ok(candidate) => {
                self.install(candidate);
                self.request = None;
                let Resource::Handoff(owner) = &mut self.resource else {
                    return Err(MemoryOperationError::OwnershipInvariant);
                };
                // Guarded producer capture must predate this receiver wait.
                // A legacy uncaptured delivery remains retained, never upgraded
                // to a new generation proof after the fact.
                if !owner.has_captured_backing() {
                    return Err(MemoryOperationError::MissingBacking);
                }
                owner.capture_backing()
            }
            Err(_) => {
                self.delivery_uncertain = true;
                self.request = None;
                Err(MemoryOperationError::ProducerLost)
            }
        }
    }

    pub async fn activate(&mut self) -> Result<ActivatedGuardedFinalizing, String> {
        let _token = self.tracker.acceptance_token().map_err(|e| e.to_string())?;
        let successor = self
            .claimed
            .as_ref()
            .ok_or("finalizing claim consumed")?
            .context()
            .run_id;
        let Resource::Handoff(owner) = &mut self.resource else {
            return Err("finalizing handoff unavailable".into());
        };
        if !owner.has_captured_backing() {
            return Err("finalizing producer backing was not captured".into());
        }
        if self
            .claimed
            .as_ref()
            .and_then(|claimed| claimed.context().reuse_key.as_deref())
            != owner.reuse_key()
        {
            return Err("finalizing handoff reuse key does not match the actual claim".into());
        }
        owner
            .prepare_activation(successor, self.predecessor)
            .await?;
        // Readiness keeps resource custody; claim/auth move only around the
        // synchronous commit and are restored on any commit refusal.
        let claimed = self
            .claimed
            .take()
            .ok_or("finalizing claim consumed before commit")?;
        let resource = match owner.commit_activation(successor, self.predecessor) {
            Ok(resource) => resource,
            Err(error) => {
                self.claimed = Some(claimed);
                return Err(error);
            }
        };
        self.resource = Resource::Transferred;
        Ok(ActivatedGuardedFinalizing { claimed, resource })
    }

    pub fn cancel_delivery(&mut self) {
        if let Some(mut request) = self.request.take()
            && let Some(candidate) = request.cancel_and_recover_delivery()
        {
            self.install(candidate);
        }
    }

    /// Explicit fallback/terminal owner takes the original provider authorization.
    pub fn take_claim_for_completion(&mut self) -> Option<ClaimedJob> {
        self.claimed.take()
    }

    pub async fn cleanup(
        &mut self,
        operations: &HostMemoryOperations,
        envelope: IdleRetirementEnvelope,
    ) -> Result<GuardedActivationCleanupTask, MemoryOperationError> {
        self.cancel_delivery();
        if let Resource::Handoff(owner) = &self.resource
            && !owner.has_captured_backing()
        {
            return Err(MemoryOperationError::MissingBacking);
        }
        self.resource
            .cleanup(&self.tracker, operations, envelope, "finalizing successor")
            .await
    }
}

impl Drop for GuardedFinalizingAdmission {
    fn drop(&mut self) {
        self.cancel_delivery();
        self.tracker
            .retain_finalizing_recovery(GuardedFinalizingRecovery {
                claimed: self.claimed.take(),
                resource: self.resource.take_recovery(),
                delivery_uncertain: self.delivery_uncertain,
            });
    }
}
