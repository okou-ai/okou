//! Terminal preparation of a generation-owned raw home image.

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;
use futures_util::FutureExt;
use guest_contracts::guest_binary::AGENT_PATH;
use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_HELPER_MAX_BYTES, ReusePreparationReport, ReusePreparationRequest,
};
use runner_host::home_observation::HomeObservationOutcome;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use tracing::{Level, warn};

use crate::error::LifecycleError;
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::home_image_cache::timing::{HomePhase, HomePhaseTimer};
use crate::home_image_cache::{
    HomeCacheTerminalStatus, HomeImagePromotionContext, HomeImagePromotionOutcome,
};
use crate::home_mount::{ensure_home_drive_mounted, freeze_home_drive};

const TERMINAL_CACHE_PREPARATION_TIMEOUT: Duration = Duration::from_secs(10);

enum HomePromotionAction {
    Promoted,
    PreservedExisting,
    AbandonUnpublished,
}

/// A frozen home whose sandbox must be successfully terminated before publication.
///
/// Callers must never thaw, resume, hand off or return this sandbox to an idle pool.
#[must_use = "terminate the sandbox, then publish or abandon the prepared home"]
pub struct PreparedHomeImagePromotion {
    promotion: HomeImagePromotionContext,
    reason: &'static str,
}

/// Diagnostic observer only; dropping it does not cancel or release termination.
pub struct HomeTerminationTiming(HomePhaseTimer);

impl HomeTerminationTiming {
    pub fn finish(self, stopped: bool) {
        self.0.finish(if stopped {
            HomeObservationOutcome::Completed
        } else {
            HomeObservationOutcome::Failed
        });
    }
}

pub async fn prepare_home_image_from_active_sandbox(
    sandbox: &dyn Sandbox,
    promotion: Option<HomeImagePromotionContext>,
    reason: &'static str,
) -> Option<PreparedHomeImagePromotion> {
    let promotion = promotion?;
    // Existing terminal callers have finished finalization/log readers
    // and own the sandbox exclusively. The helper cleans all managed private
    // namespaces and returns capacity stats before freeze. No body is copied.
    let result = AssertUnwindSafe(async {
        // A privileged workload could have replaced the visible mount since
        // startup. Cleanup must cover the actual home filesystem, never
        // a same-device subtree whose hidden private namespaces would survive.
        let timing = promotion.start_timing(HomePhase::TerminalMount);
        let mounted = ensure_home_drive_mounted(sandbox, promotion.run_id()).await;
        timing.finish(if mounted.is_ok() {
            HomeObservationOutcome::Completed
        } else {
            HomeObservationOutcome::Failed
        });
        mounted.map_err(|failure| failure.error)?;
        if !prepare_terminal_cache_runtime(sandbox, &promotion).await? {
            return Ok(false);
        }
        let timing = promotion.start_timing(HomePhase::TerminalFreeze);
        let frozen = freeze_home_drive(sandbox, promotion.run_id()).await;
        timing.finish(if frozen.is_ok() {
            HomeObservationOutcome::Completed
        } else {
            HomeObservationOutcome::Failed
        });
        frozen?;
        Ok(true)
    })
    .catch_unwind()
    .await;
    match result {
        Ok(Ok(true)) => Some(PreparedHomeImagePromotion { promotion, reason }),
        Ok(Ok(false)) => {
            abandon_unpublished_home_promotion(Some(promotion), reason).await;
            None
        }
        Ok(Err(error)) => {
            log_guest_operation_failure(&promotion, reason, &error);
            abandon_unpublished_home_promotion(Some(promotion), reason).await;
            None
        }
        Err(_) => {
            warn!(run_id = %promotion.run_id(), reason, "home image preparation panicked");
            promotion
                .observe_publication(HomeObservationOutcome::Failed, "guest_preparation_panicked");
            abandon_unpublished_home_promotion(Some(promotion), reason).await;
            None
        }
    }
}

fn log_guest_operation_failure(
    promotion: &HomeImagePromotionContext,
    reason: &'static str,
    error: &LifecycleError,
) {
    let skipped_after_cancellation = promotion.terminal_status()
        == HomeCacheTerminalStatus::Cancelled
        && matches!(
            error,
            LifecycleError::Sandbox(sandbox::SandboxError::Operation {
                reason: sandbox::SandboxOperationReason::GuestConnectionUnavailable,
                ..
            })
        );
    macro_rules! emit {
        ($level:expr) => {
            tracing::event!($level, run_id = %promotion.run_id(), sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(), reason, skipped_after_cancellation, error = %error,
                "home image publication rejected because guest preparation failed");
        };
    }
    if skipped_after_cancellation {
        promotion.observe_publication(
            HomeObservationOutcome::Skipped,
            "cancelled_guest_unavailable",
        );
        emit!(Level::INFO);
    } else {
        promotion.observe_publication(HomeObservationOutcome::Failed, "guest_preparation_failed");
        emit!(Level::WARN);
    }
}

pub(crate) async fn prepare_terminal_cache_runtime(
    sandbox: &dyn Sandbox,
    promotion: &HomeImagePromotionContext,
) -> crate::error::LifecycleResult<bool> {
    let timing = promotion.start_timing(HomePhase::TerminalPreparation);
    let current_runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(
        CANONICAL_GUEST_HOME_DIR,
        &promotion.run_id().to_string(),
    )
    .map_err(|error| LifecycleError::Internal(format!("resolve terminal runtime scope: {error}")))?
    .to_string_lossy()
    .into_owned();
    let request = ReusePreparationRequest {
        current_runtime_dir,
    };
    let request_bytes = serde_json::to_vec(&request).map_err(|error| {
        LifecycleError::Internal(format!("serialize terminal cleanup: {error}"))
    })?;
    let command = format!("{AGENT_PATH} prepare-for-cache");
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &command,
                timeout: TERMINAL_CACHE_PREPARATION_TIMEOUT,
                env: &[],
                sudo: true,
                expected_exit_codes: &[],
                stdin_bytes: Some(&request_bytes),
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            "terminal-cache-preparation",
        )
        .await?;
    if !helper_exec_succeeded(&result)
        || result.stdout_truncated
        || result.stdout.len() > REUSE_PREPARATION_HELPER_MAX_BYTES
    {
        return Err(LifecycleError::Internal(format_helper_exec_failure(
            "terminal home cache preparation",
            &result,
        )));
    }
    let report: ReusePreparationReport = serde_json::from_slice(&result.stdout)
        .map_err(|_| LifecycleError::Internal("invalid terminal home cleanup report".into()))?;
    if let Some(reason) = report.home.home_rejection_reason() {
        tracing::info!(run_id = %promotion.run_id(), sandbox_id = %promotion.sandbox_id(),
            reason, home_available_bytes = report.home.available_bytes,
            home_available_inodes = report.home.available_inodes,
            "home image rejected below reuse reserve");
        promotion.observe_publication(HomeObservationOutcome::Skipped, reason);
        timing.finish(HomeObservationOutcome::Skipped);
        return Ok(false);
    }
    timing.finish(HomeObservationOutcome::Completed);
    Ok(true)
}

impl PreparedHomeImagePromotion {
    pub fn start_termination_timing(&self) -> HomeTerminationTiming {
        HomeTerminationTiming(self.promotion.start_timing(HomePhase::SandboxStop))
    }

    /// The caller has completed required preparation and freeze, retaining the
    /// context on every error. This does not prove backing exit or publication.
    pub(crate) fn required(promotion: HomeImagePromotionContext, reason: &'static str) -> Self {
        Self { promotion, reason }
    }

    /// Required saving never abandons the original context on publication error.
    pub(crate) async fn publish_required(&self) -> crate::error::LifecycleResult<bool> {
        match self.promotion.promote().await? {
            HomeImagePromotionOutcome::Promoted => Ok(true),
            HomeImagePromotionOutcome::PreservedExisting => Ok(false),
            HomeImagePromotionOutcome::SkippedUnpublished => Err(LifecycleError::Internal(
                "required home publication did not complete".into(),
            )),
        }
    }

    pub async fn publish(mut self) -> bool {
        match AssertUnwindSafe(self.publish_inner()).catch_unwind().await {
            Ok(HomePromotionAction::Promoted) => true,
            Ok(HomePromotionAction::PreservedExisting) => false,
            Ok(HomePromotionAction::AbandonUnpublished) => {
                let reason = self.reason;
                abandon_unpublished_home_promotion(Some(self.promotion), reason).await;
                false
            }
            Err(_) => {
                self.promotion
                    .observe_publication(HomeObservationOutcome::Failed, "publication_panicked");
                abandon_unpublished_home_promotion(Some(self.promotion), self.reason).await;
                false
            }
        }
    }

    pub async fn abandon(self, reason: &'static str) {
        self.promotion
            .observe_publication(HomeObservationOutcome::Skipped, reason);
        abandon_unpublished_home_promotion(Some(self.promotion), reason).await;
    }

    async fn publish_inner(&mut self) -> HomePromotionAction {
        match self.promotion.promote().await {
            Ok(HomeImagePromotionOutcome::Promoted) => HomePromotionAction::Promoted,
            Ok(HomeImagePromotionOutcome::PreservedExisting) => {
                HomePromotionAction::PreservedExisting
            }
            Ok(HomeImagePromotionOutcome::SkippedUnpublished) => {
                HomePromotionAction::AbandonUnpublished
            }
            Err(error) => {
                warn!(run_id = %self.promotion.run_id(), reason = self.reason, error = %error, "home image publication failed");
                HomePromotionAction::AbandonUnpublished
            }
        }
    }
}

pub async fn prepare_home_image_from_parked_sandbox(
    sandbox: &mut dyn Sandbox,
    promotion: Option<HomeImagePromotionContext>,
    reason: &'static str,
) -> Option<PreparedHomeImagePromotion> {
    let promotion = promotion?;
    let timing = promotion.start_timing(HomePhase::TerminalUnpark);
    let result = AssertUnwindSafe(sandbox.unpark_for_terminal_operations())
        .catch_unwind()
        .await;
    timing.finish(match &result {
        Ok(Ok(())) => HomeObservationOutcome::Completed,
        Ok(Err(_)) => HomeObservationOutcome::Failed,
        Err(_) => HomeObservationOutcome::Incomplete,
    });
    match result {
        Ok(Ok(())) => {
            prepare_home_image_from_active_sandbox(sandbox, Some(promotion), reason).await
        }
        Ok(Err(_)) | Err(_) => {
            promotion.observe_publication(
                HomeObservationOutcome::Failed,
                "unpark_for_publication_failed",
            );
            abandon_unpublished_home_promotion(Some(promotion), reason).await;
            None
        }
    }
}

pub async fn abandon_unpublished_home_promotion(
    promotion: Option<HomeImagePromotionContext>,
    reason: &'static str,
) -> bool {
    let Some(promotion) = promotion else {
        return false;
    };
    match promotion.abandon_unpublished(reason).await {
        Ok(abandoned) => abandoned,
        Err(error) => {
            warn!(error = %error, reason, "home image context abandonment failed");
            false
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
#[cfg(test)]
mod tests;
