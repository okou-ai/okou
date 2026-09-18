//! Ownership-preserving transitions from an active sandbox to idle reuse.
//!
//! The transition has ownership boundaries that must not be conflated:
//! [`IdleParkRequest`] owns an active sandbox until physical parking and
//! reuse-preparation validation complete, while a [`ParkedIdleCandidate`] owns
//! a sandbox that has physically parked but has not yet been accepted by
//! [`super::IdlePool`]. Only an accepted [`super::entry::IdleEntry`] is
//! pool-owned. A running exact handoff carries a separate candidate and can
//! never be represented by a parked candidate or restored to idle inventory.
//!
//! The transition contract is:
//!
//! 1. **Active-owned.** The request owns the sandbox, factory, budget lease,
//!    metadata, and any unpublished workspace promotion. A promotion identity
//!    mismatch is abandoned before returning. A preparation-construction error
//!    or a returned park error returns the promotion to the active finalization
//!    cleanup path. A panic makes the park state uncertain, so the promotion is
//!    abandoned before active ownership is returned. If an active failure is
//!    instead converted into a speculative rollback destroy job, that path
//!    abandons the unpublished promotion because it is not active finalization.
//! 2. **Parked-owned.** Once the sandbox park operation succeeds, validation of
//!    the reuse-preparation result can still reject admission. That rejection
//!    is represented by [`IdleParkFailureParts::Parked`]; the finalization
//!    caller must destroy the rejected parked candidate and must not treat it as
//!    an active sandbox or insert it into the pool. Its destroy payload keeps
//!    [`super::entry::WorkspacePromotionPolicy::Promote`], so the parked
//!    cleanup lifecycle may unpark, prepare, and publish a valid promotion
//!    before destruction.
//! 3. **Idle-pool-owned.** A successful ordinary outcome becomes a pool entry
//!    only after the caller passes its [`ParkedIdleCandidate`] to
//!    [`super::IdlePool::park`]. A reusable candidate may be admitted; a
//!    non-reusable result remains caller-owned and is destroyed. An immediate
//!    handoff candidate must be delivered to the waiting exact successor or
//!    destroyed.
//! 4. **Exact handoff.** The finalization caller supplies the optional handoff
//!    only for the exact-history predecessor/successor path. The transition
//!    does not independently prove that caller-side relationship. A successful
//!    handoff changes the result from generic idle publication to a candidate
//!    bound to that waiting successor; an undelivered candidate remains owned
//!    by the caller for cleanup.
//!    Its Guest operations remain fenced while the VM is still running. Failed
//!    validation, failed delivery, or cancellation destroys that candidate
//!    without invoking parked workspace promotion.
//! 5. **Speculative rollback.** A reserved exact-generation entry can be
//!    unparked for claim-time preparation without becoming committed to a job.
//!    [`SpeculativeIdleSandbox::repark_for_claim_rollback`] re-runs preparation
//!    against the entry's original history-generation runtime directory, not
//!    the rollback operation's diagnostic run directory. A successful repark
//!    restores the original `parked_at` and metadata. Every other result
//!    returns an [`IdleDestroyJob`] with the appropriate promotion policy.
//!
//! The finalization cleanup and speculative rollback callers consume
//! [`IdleParkFailureParts`] and [`SpeculativeReparkResult`], respectively. The
//! focused coverage for these ownership rules lives in
//! `park_transition_tests.rs`.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::FutureExt;
use guest_contracts::reuse_preparation::ReusePreparationReport;
use sandbox::{
    DeviceRateLimits, Sandbox, SandboxFactory, SandboxFinalExecParkHandoff,
    SandboxFinalExecParkHandoffOutcome, SandboxFinalExecParkObserver, SandboxId,
    SandboxParkNonReusableReason, SandboxParkOutcome,
};

use crate::guest_timezone::GuestTimezoneIntent;
use crate::idle_reuse_preparation::IdleReusePreparation;
use crate::ids::RunId;
use crate::resource_budget::BudgetLease;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    WorkspaceImagePromotionContext, WorkspaceImagePromotionIdentityRequest,
};
use crate::workspace_promotion::abandon_unpublished_workspace_promotion;

use super::entry::{
    IdleDestroyJob, IdleDestroyPayload, IdleEntry, IdleSandboxMetadata, IdleSandboxResources,
    ImmediateHandoffCandidate, ParkedIdleCandidate, RejectedParkedIdleCandidate,
    ReservedIdleSandbox, SpeculativeIdleSandbox, WorkspacePromotionPolicy,
};

/// One-shot request to transition an active sandbox into same-reuse-key idle
/// ownership.
///
/// The request remains active-owned until [`Self::park_for_idle_with_observer`]
/// returns. Its caller must consume either the returned [`IdleParkOutcome`] or
/// [`IdleParkFailure`]; neither result may be silently dropped because both
/// encode resources that still need an ownership handoff or cleanup.
#[must_use = "idle park requests own active sandbox and budget; call a park_for_idle method"]
pub(crate) struct IdleParkRequest {
    pub(super) parts: IdleParkRequestParts,
}

/// Resources and metadata supplied while the active job still owns the
/// sandbox.
///
/// The optional `handoff` is a caller-side exact-history capability: the
/// finalization path supplies it only when a waiting successor is claiming the
/// predecessor's exact history generation. Speculative rollback deliberately
/// calls the shared transition without an observer or handoff.
#[must_use = "idle park request parts own active sandbox and budget"]
pub(crate) struct IdleParkRequestParts {
    pub(crate) run_id: RunId,
    pub(crate) sandbox: Box<dyn Sandbox>,
    pub(crate) factory: Arc<Box<dyn SandboxFactory>>,
    pub(crate) reuse_key: String,
    pub(crate) sandbox_id: SandboxId,
    pub(crate) profile_name: String,
    pub(crate) device_rate_limits: Option<DeviceRateLimits>,
    pub(crate) budget_lease: BudgetLease,
    pub(crate) source_ip: String,
    pub(crate) storage_fingerprints: StorageFingerprints,
    pub(crate) restored_session_identity: Option<RestoredSessionIdentity>,
    pub(crate) history_generation_run_id: Option<RunId>,
    pub(crate) guest_timezone_intent: GuestTimezoneIntent,
    pub(crate) workspace_image_size_bytes: u64,
    pub(crate) workspace_promotion: Option<WorkspaceImagePromotionContext>,
    pub(crate) handoff: Option<SandboxFinalExecParkHandoff>,
}

/// Result after the sandbox reaches a parked or fenced running-handoff boundary
/// and reuse preparation validates.
///
/// Every candidate remains owned by the caller until it is accepted by
/// [`super::IdlePool::park`], handed directly to an exact successor, or
/// converted into an [`IdleDestroyJob`]. `NonReusable` is not an admission
/// success: it carries a parked candidate plus diagnostics for the caller to
/// log and destroy.
#[must_use = "parked outcomes must be admitted for reuse or explicitly destroyed"]
pub(crate) enum IdleParkOutcome {
    /// A normally parked candidate that may be inserted into the idle pool.
    Reusable(ParkedIdleCandidate),
    /// A candidate returned through the exact finalizing handoff path.
    Handoff(ImmediateHandoffCandidate),
    /// The sandbox parked, but the sandbox reported a state that is unsafe for
    /// generic reuse. The candidate is still parked-owned and must be cleaned
    /// up by the caller.
    NonReusable {
        candidate: ParkedIdleCandidate,
        reason: SandboxParkNonReusableReason,
        preparation_report: ReusePreparationReport,
    },
}

/// A prepared sandbox before the finalization caller transfers it to the idle
/// pool or its exact successor.
pub(crate) enum IdleParkCandidate {
    /// Ordinary idle-pool candidate, including a candidate later reported as
    /// non-reusable by the park outcome.
    Ordinary(ParkedIdleCandidate),
    /// Candidate with a physical handoff point for an exact successor.
    Immediate(ImmediateHandoffCandidate),
}

impl IdleParkCandidate {
    pub(crate) fn into_finalizing_handoff(
        self,
        successor_run_id: RunId,
        predecessor_run_id: RunId,
    ) -> super::entry::FinalizingHandoffCandidate {
        match self {
            Self::Ordinary(candidate) => {
                candidate.into_finalizing_handoff(successor_run_id, predecessor_run_id)
            }
            Self::Immediate(candidate) => {
                candidate.into_finalizing_handoff(successor_run_id, predecessor_run_id)
            }
        }
    }

    pub(crate) fn with_last_completed_at(self, last_completed_at: String) -> Self {
        match self {
            Self::Ordinary(candidate) => {
                Self::Ordinary(candidate.with_last_completed_at(last_completed_at))
            }
            Self::Immediate(candidate) => {
                Self::Immediate(candidate.with_last_completed_at(last_completed_at))
            }
        }
    }

    pub(crate) fn into_active_destroy_parts(self) -> (IdleDestroyPayload, BudgetLease) {
        match self {
            Self::Ordinary(candidate) => candidate.into_active_destroy_parts(),
            Self::Immediate(candidate) => candidate.into_active_destroy_parts(),
        }
    }
}

/// Diagnostics attached to a successfully parked candidate that cannot be
/// admitted for generic reuse.
pub(crate) struct IdleParkNonReusable {
    pub(crate) reason: SandboxParkNonReusableReason,
    pub(crate) preparation_report: ReusePreparationReport,
}

/// Failure that preserves the ownership phase in which idle admission failed.
///
/// Call [`Self::into_parts`] before cleanup. `Active` means the transition did
/// not establish a safe parked candidate (or park state became uncertain), so
/// the finalization caller receives the sandbox, factory, lease, and any
/// still-publishable promotion. `Parked` means physical parking succeeded but
/// post-park reuse validation rejected the candidate; its parked destroy path
/// must be used instead. `RunningHandoff` preserves the distinct fenced-running
/// ownership and must be destroyed without parked workspace promotion.
#[must_use = "idle park failures must be explicitly destroyed or otherwise handled"]
pub(crate) struct IdleParkFailure {
    ownership: IdleParkFailureOwnership,
    reason: &'static str,
    error: String,
    expected_capacity_rejection: bool,
}

enum IdleParkFailureOwnership {
    Active {
        resources: Box<IdleSandboxResources>,
        budget_lease: BudgetLease,
    },
    Parked {
        rejected: Box<RejectedParkedIdleCandidate>,
    },
    RunningHandoff {
        candidate: Box<ImmediateHandoffCandidate>,
    },
}

/// Active-owned resources returned by [`IdleParkFailureParts::Active`].
///
/// The finalization caller owns the sandbox and lease and must complete active
/// cleanup. A retained `workspace_promotion` is still unpublished but may be
/// promoted by that cleanup after a successful stop; mismatch and panic paths
/// return `None` because the transition has already abandoned it.
#[must_use = "active idle-park parts still own a sandbox and budget lease"]
pub(crate) struct IdleParkActiveParts {
    pub(crate) sandbox: Box<dyn Sandbox>,
    pub(crate) factory: Arc<Box<dyn SandboxFactory>>,
    pub(crate) budget_lease: BudgetLease,
    pub(crate) workspace_promotion: Option<WorkspaceImagePromotionContext>,
}

/// Failure parts split by the last proven ownership boundary.
///
/// The finalization caller in `sandbox_finalization.rs` must consume every
/// variant. `Active` returns an active sandbox and its budget lease for the
/// active stop/destroy path. `Parked` returns a physically parked candidate
/// that failed reuse validation; the caller must convert it through
/// [`RejectedParkedIdleCandidate::into_active_destroy_parts`] and destroy it,
/// rather than handing it back to the active sandbox path or the idle pool.
/// The parked conversion preserves the `Promote` policy for a valid workspace
/// image, while speculative active failures use `AbandonUnpublished` when they
/// are converted to a rollback destroy job.
#[must_use = "idle park failure parts must be logged and cleaned up"]
pub(crate) enum IdleParkFailureParts {
    /// Park was not proven successful, or the transition state is uncertain.
    Active {
        active: IdleParkActiveParts,
        reason: &'static str,
        error: String,
    },
    /// Park succeeded, but reuse-preparation validation rejected admission.
    Parked {
        rejected: RejectedParkedIdleCandidate,
        reason: &'static str,
        error: String,
        expected_capacity_rejection: bool,
    },
    /// Running takeover succeeded, but preparation validation rejected reuse.
    /// This candidate must be destroyed without parked workspace promotion.
    RunningHandoff {
        candidate: Box<ImmediateHandoffCandidate>,
        reason: &'static str,
        error: String,
        expected_capacity_rejection: bool,
    },
}

struct IdleParkTransitionInput {
    /// Run that triggered this transition and owns its diagnostics.
    operation_run_id: RunId,
    /// Run whose guest runtime directory must survive reuse cleanup.
    current_runtime_run_id: RunId,
    resources: IdleSandboxResources,
    metadata: IdleSandboxMetadata,
    budget_lease: BudgetLease,
    workspace_image_size_bytes: u64,
}

/// Result of returning a speculatively activated exact-reuse sandbox to idle
/// ownership during claim rollback.
///
/// `Reparked` preserves the original idle timestamp and metadata. `Destroy`
/// owns a complete [`IdleDestroyJob`] and must be run when the reserved entry
/// cannot safely return to the pool.
pub(crate) enum SpeculativeReparkResult {
    /// The reserved entry can be restored to the idle pool.
    Reparked(Box<ReservedIdleSandbox>),
    /// The reserved entry must be destroyed instead of restored.
    Destroy {
        destroy_job: Box<IdleDestroyJob>,
        reason: &'static str,
        error: String,
        expected_capacity_rejection: bool,
    },
}

impl IdleParkRequest {
    /// Wrap an active-owned sandbox and its cleanup resources in a park request.
    pub(crate) fn new(parts: IdleParkRequestParts) -> Self {
        Self { parts }
    }

    #[cfg(test)]
    pub(crate) async fn park_for_idle(self) -> Result<IdleParkOutcome, IdleParkFailure> {
        self.park_for_idle_with_optional_observer(None).await
    }

    /// Run reuse preparation and physical parking, optionally producing an
    /// immediate exact-successor handoff.
    ///
    /// The returned candidate or failure retains the cleanup obligation for
    /// the caller. In particular, an observer does not change ownership; it
    /// only records the finalization stages. The finalization caller is the
    /// owner that decides whether an ordinary candidate enters the pool, a
    /// handoff candidate is delivered, or a candidate is destroyed.
    pub(crate) async fn park_for_idle_with_observer(
        self,
        observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> Result<IdleParkOutcome, IdleParkFailure> {
        self.park_for_idle_with_optional_observer(Some(observer))
            .await
    }

    async fn park_for_idle_with_optional_observer(
        self,
        observer: Option<&mut dyn SandboxFinalExecParkObserver>,
    ) -> Result<IdleParkOutcome, IdleParkFailure> {
        let IdleParkRequestParts {
            run_id,
            sandbox,
            factory,
            reuse_key,
            sandbox_id,
            profile_name,
            device_rate_limits,
            budget_lease,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id,
            guest_timezone_intent,
            workspace_image_size_bytes,
            workspace_promotion,
            handoff,
        } = self.parts;

        let metadata = IdleSandboxMetadata {
            identity: super::entry::IdleSandboxIdentity::Exact(reuse_key),
            sandbox_id,
            profile_name,
            device_rate_limits,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id,
            guest_timezone_intent,
            last_completed_at: None,
        };

        park_idle_transition(
            IdleParkTransitionInput {
                operation_run_id: run_id,
                current_runtime_run_id: run_id,
                resources: IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion,
                },
                metadata,
                budget_lease,
                workspace_image_size_bytes,
            },
            observer,
            handoff,
        )
        .await
    }
}

/// Transition active execution to physical park or fenced running handoff.
///
/// This function validates promotion identity before invoking the sandbox,
/// then validates the reuse-preparation report after the sandbox confirms park
/// or running handoff. Failures retain [`IdleParkFailureParts::Active`],
/// [`IdleParkFailureParts::Parked`], or [`IdleParkFailureParts::RunningHandoff`]
/// ownership according to the completed boundary. The handoff argument is
/// supplied by the finalization caller for an exact
/// predecessor; this function does not infer that relationship from the
/// metadata.
async fn park_idle_transition(
    input: IdleParkTransitionInput,
    observer: Option<&mut dyn SandboxFinalExecParkObserver>,
    handoff: Option<SandboxFinalExecParkHandoff>,
) -> Result<IdleParkOutcome, IdleParkFailure> {
    let IdleParkTransitionInput {
        operation_run_id,
        current_runtime_run_id,
        resources,
        metadata,
        budget_lease,
        workspace_image_size_bytes,
    } = input;
    let IdleSandboxResources {
        mut sandbox,
        factory,
        workspace_promotion,
    } = resources;
    let retained_runtime_dir = metadata
        .restored_session_identity
        .as_ref()
        .and_then(RestoredSessionIdentity::final_metadata_verification)
        .map(|verification| verification.runtime_dir.to_owned());

    if let Some(promotion) = workspace_promotion.as_ref()
        && let Err(mismatch) = metadata
            .reuse_key()
            .ok_or(crate::workspace_image_cache::WorkspaceImagePromotionIdentityMismatch::ReuseKey)
            .and_then(|reuse_key| {
                promotion.validate_stored_cache_identity(WorkspaceImagePromotionIdentityRequest {
                    sandbox_id: metadata.sandbox_id,
                    profile_name: &metadata.profile_name,
                    reuse_key,
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: workspace_image_size_bytes,
                })
            })
    {
        tracing::warn!(
            sandbox_id = %metadata.sandbox_id,
            profile_name = %metadata.profile_name,
            mismatch = mismatch.as_str(),
            "workspace promotion identity mismatch before idle park; destroying without workspace promotion"
        );
        abandon_unpublished_workspace_promotion(workspace_promotion, "promotion_identity_mismatch")
            .await;
        return Err(IdleParkFailure {
            ownership: IdleParkFailureOwnership::Active {
                resources: Box::new(IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion: None,
                }),
                budget_lease,
            },
            reason: "promotion_identity_mismatch",
            error: format!("workspace promotion identity mismatch: {mismatch}"),
            expected_capacity_rejection: false,
        });
    }

    let preparation = match IdleReusePreparation::new(
        sandbox.id(),
        operation_run_id,
        current_runtime_run_id,
        retained_runtime_dir.as_deref(),
    ) {
        Ok(preparation) => preparation,
        Err(error) => {
            return Err(IdleParkFailure {
                ownership: IdleParkFailureOwnership::Active {
                    resources: Box::new(IdleSandboxResources {
                        sandbox,
                        factory,
                        workspace_promotion,
                    }),
                    budget_lease,
                },
                reason: "reuse_preparation_failed",
                error: error.to_string(),
                expected_capacity_rejection: false,
            });
        }
    };

    let final_exec_and_park = {
        let request = preparation.exec_request();
        let transition = async {
            match (observer, handoff.as_ref()) {
                (Some(observer), Some(handoff)) => {
                    sandbox
                        .final_exec_and_park_for_handoff(
                            &request,
                            "idle-reuse-preparation-and-park",
                            handoff,
                            observer,
                        )
                        .await
                }
                (Some(observer), None) => sandbox
                    .final_exec_and_park_with_observer(
                        &request,
                        "idle-reuse-preparation-and-park",
                        observer,
                    )
                    .await
                    .map(SandboxFinalExecParkHandoffOutcome::Parked),
                (None, _) => sandbox
                    .final_exec_and_park(&request, "idle-reuse-preparation-and-park")
                    .await
                    .map(SandboxFinalExecParkHandoffOutcome::Parked),
            }
        };
        AssertUnwindSafe(transition).catch_unwind().await
    };
    match final_exec_and_park {
        Ok(Ok(outcome)) => {
            let resources = IdleSandboxResources {
                sandbox,
                factory,
                workspace_promotion,
            };
            let exec_result = match &outcome {
                SandboxFinalExecParkHandoffOutcome::Parked(outcome) => &outcome.exec_result,
                SandboxFinalExecParkHandoffOutcome::Handoff { exec_result, .. } => exec_result,
            };
            let preparation_report = match preparation.validate_result(exec_result) {
                Ok(report) => report,
                Err(error) => {
                    let expected_capacity_rejection = error.is_expected_capacity_rejection();
                    let ownership = match outcome {
                        SandboxFinalExecParkHandoffOutcome::Parked(_) => {
                            let candidate = ParkedIdleCandidate {
                                resources,
                                metadata,
                                budget_lease,
                            };
                            IdleParkFailureOwnership::Parked {
                                rejected: Box::new(candidate.into_rejected()),
                            }
                        }
                        SandboxFinalExecParkHandoffOutcome::Handoff { point, .. } => {
                            IdleParkFailureOwnership::RunningHandoff {
                                candidate: Box::new(ImmediateHandoffCandidate {
                                    resources,
                                    metadata,
                                    budget_lease,
                                    handoff_point: point,
                                }),
                            }
                        }
                    };
                    return Err(IdleParkFailure {
                        ownership,
                        reason: "reuse_preparation_failed",
                        error: error.to_string(),
                        expected_capacity_rejection,
                    });
                }
            };
            Ok(match outcome {
                SandboxFinalExecParkHandoffOutcome::Handoff { point, .. } => {
                    IdleParkOutcome::Handoff(ImmediateHandoffCandidate {
                        resources,
                        metadata,
                        budget_lease,
                        handoff_point: point,
                    })
                }
                SandboxFinalExecParkHandoffOutcome::Parked(outcome) => {
                    let candidate = ParkedIdleCandidate {
                        resources,
                        metadata,
                        budget_lease,
                    };
                    match outcome.park_outcome {
                        SandboxParkOutcome::Reusable => IdleParkOutcome::Reusable(candidate),
                        SandboxParkOutcome::NonReusable(reason) => IdleParkOutcome::NonReusable {
                            candidate,
                            reason,
                            preparation_report,
                        },
                    }
                }
            })
        }
        Ok(Err(error)) => Err(IdleParkFailure {
            ownership: IdleParkFailureOwnership::Active {
                resources: Box::new(IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion,
                }),
                budget_lease,
            },
            reason: "park_failed",
            error: error.to_string(),
            expected_capacity_rejection: false,
        }),
        Err(_) => {
            // A panic leaves the park transition state uncertain; destroy
            // the sandbox, but do not publish a workspace cache image.
            abandon_unpublished_workspace_promotion(workspace_promotion, "park_panicked").await;
            Err(IdleParkFailure {
                ownership: IdleParkFailureOwnership::Active {
                    resources: Box::new(IdleSandboxResources {
                        sandbox,
                        factory,
                        workspace_promotion: None,
                    }),
                    budget_lease,
                },
                reason: "park_panicked",
                error: "sandbox park panicked".into(),
                expected_capacity_rejection: false,
            })
        }
    }
}

impl SpeculativeIdleSandbox {
    /// Re-run reuse preparation while rolling back a speculative exact claim.
    ///
    /// `operation_run_id` identifies the rollback operation for diagnostics,
    /// but the current runtime directory comes from the entry's original
    /// `history_generation_run_id`. This preserves the runtime files needed by
    /// the exact history generation. A reusable result keeps the entry's
    /// original `parked_at`; an unexpected handoff, non-reusable result, or
    /// failure returns an owned [`IdleDestroyJob`] instead of a partially
    /// restored reservation.
    pub(crate) async fn repark_for_claim_rollback(
        self,
        operation_run_id: RunId,
        workspace_image_size_bytes: u64,
    ) -> SpeculativeReparkResult {
        let Some(current_runtime_run_id) = self.entry.metadata.history_generation_run_id else {
            const REASON: &str = "speculative_repark_missing_history_generation";
            return SpeculativeReparkResult::Destroy {
                destroy_job: Box::new(self.into_destroy_job(REASON)),
                reason: REASON,
                error: "speculative exact-reuse entry is missing a history generation".into(),
                expected_capacity_rejection: false,
            };
        };
        let Self { entry } = self;
        let IdleEntry {
            resources,
            metadata,
            budget_lease,
            parked_at,
        } = entry;
        let reuse_key = metadata.reuse_key().map(str::to_owned);
        let profile_name = metadata.profile_name.clone();
        match park_idle_transition(
            IdleParkTransitionInput {
                operation_run_id,
                current_runtime_run_id,
                resources,
                metadata,
                budget_lease,
                workspace_image_size_bytes,
            },
            None,
            None,
        )
        .await
        {
            Ok(IdleParkOutcome::Reusable(candidate)) => {
                SpeculativeReparkResult::Reparked(Box::new(ReservedIdleSandbox::parked(
                    candidate.into_idle_entry(parked_at),
                )))
            }
            Ok(IdleParkOutcome::Handoff(candidate)) => {
                let (payload, budget_lease) = candidate.into_active_destroy_parts();
                SpeculativeReparkResult::Destroy {
                    destroy_job: Box::new(IdleDestroyJob {
                        payload,
                        budget_lease,
                        reuse_key,
                        profile_name,
                    }),
                    reason: "speculative_repark_unexpected_handoff",
                    error: "speculative re-park unexpectedly produced an immediate handoff".into(),
                    expected_capacity_rejection: false,
                }
            }
            Ok(IdleParkOutcome::NonReusable {
                candidate, reason, ..
            }) => {
                let (payload, budget_lease) = candidate.into_active_destroy_parts();
                SpeculativeReparkResult::Destroy {
                    destroy_job: Box::new(IdleDestroyJob {
                        payload,
                        budget_lease,
                        reuse_key,
                        profile_name,
                    }),
                    reason: "speculative_repark_non_reusable",
                    error: format!("re-parked sandbox is not reusable: {}", reason.as_str()),
                    expected_capacity_rejection: false,
                }
            }
            Err(failure) => {
                let (destroy_job, reason, error, expected_capacity_rejection) =
                    failure.into_speculative_destroy_job(reuse_key, profile_name);
                SpeculativeReparkResult::Destroy {
                    destroy_job: Box::new(destroy_job),
                    reason,
                    error,
                    expected_capacity_rejection,
                }
            }
        }
    }
}

impl IdleParkOutcome {
    /// Separate the candidate from the optional non-reusable diagnostic.
    ///
    /// The returned candidate remains caller-owned. A `Some` diagnostic means
    /// the candidate must be destroyed and must not be admitted as reusable.
    pub(crate) fn into_parts(self) -> (IdleParkCandidate, Option<IdleParkNonReusable>) {
        match self {
            Self::Reusable(candidate) => (IdleParkCandidate::Ordinary(candidate), None),
            Self::Handoff(candidate) => (IdleParkCandidate::Immediate(candidate), None),
            Self::NonReusable {
                candidate,
                reason,
                preparation_report,
            } => (
                IdleParkCandidate::Ordinary(candidate),
                Some(IdleParkNonReusable {
                    reason,
                    preparation_report,
                }),
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn expect_reusable(self) -> ParkedIdleCandidate {
        match self {
            Self::Reusable(candidate) => candidate,
            Self::Handoff(_) => panic!("expected ordinary reusable parked candidate, got handoff"),
            Self::NonReusable { reason, .. } => {
                panic!(
                    "expected reusable parked candidate, got {}",
                    reason.as_str()
                )
            }
        }
    }
}

impl IdleParkFailure {
    /// Convert this failure into an owned speculative rollback destroy job.
    ///
    /// Active parts use `AbandonUnpublished` because speculative rollback is
    /// not the active finalization promotion boundary. Parked parts retain a
    /// rejected parked candidate whose destroy payload uses the parked
    /// lifecycle's promotion policy. The conversion consumes the failure so
    /// the resources cannot be cleaned up twice.
    fn into_speculative_destroy_job(
        self,
        reuse_key: Option<String>,
        profile_name: String,
    ) -> (IdleDestroyJob, &'static str, String, bool) {
        let Self {
            ownership,
            reason,
            error,
            expected_capacity_rejection,
        } = self;
        let (payload, budget_lease) = match ownership {
            IdleParkFailureOwnership::Active {
                resources,
                budget_lease,
            } => (
                (*resources)
                    .into_destroy_payload(WorkspacePromotionPolicy::AbandonUnpublished(reason)),
                budget_lease,
            ),
            IdleParkFailureOwnership::Parked { rejected } => {
                (*rejected).into_active_destroy_parts()
            }
            IdleParkFailureOwnership::RunningHandoff { candidate } => {
                candidate.into_active_destroy_parts()
            }
        };
        (
            IdleDestroyJob {
                payload,
                budget_lease,
                reuse_key,
                profile_name,
            },
            reason,
            error,
            expected_capacity_rejection,
        )
    }

    /// Expose the ownership-bearing failure variant to the cleanup caller.
    ///
    /// The caller must use the returned variant as a phase proof: `Active`
    /// goes through active cleanup, while `Parked` goes through rejected parked
    /// cleanup. Neither variant is safe to ignore or send back to the pool.
    pub(crate) fn into_parts(self) -> IdleParkFailureParts {
        let Self {
            ownership,
            reason,
            error,
            expected_capacity_rejection,
        } = self;
        match ownership {
            IdleParkFailureOwnership::Active {
                resources,
                budget_lease,
            } => {
                let IdleSandboxResources {
                    sandbox,
                    factory,
                    workspace_promotion,
                } = *resources;
                IdleParkFailureParts::Active {
                    active: IdleParkActiveParts {
                        sandbox,
                        factory,
                        budget_lease,
                        workspace_promotion,
                    },
                    reason,
                    error,
                }
            }
            IdleParkFailureOwnership::Parked { rejected } => IdleParkFailureParts::Parked {
                rejected: *rejected,
                reason,
                error,
                expected_capacity_rejection,
            },
            IdleParkFailureOwnership::RunningHandoff { candidate } => {
                IdleParkFailureParts::RunningHandoff {
                    candidate,
                    reason,
                    error,
                    expected_capacity_rejection,
                }
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn into_error(self) -> String {
        match self.into_parts() {
            IdleParkFailureParts::Active { error, .. }
            | IdleParkFailureParts::Parked { error, .. }
            | IdleParkFailureParts::RunningHandoff { error, .. } => error,
        }
    }
}
