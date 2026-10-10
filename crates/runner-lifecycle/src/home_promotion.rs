//! Terminal preparation of a generation-owned raw whole-home image.

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;
use futures_util::FutureExt;
use guest_contracts::guest_binary::AGENT_PATH;
use guest_contracts::home_cache_history::{
    TerminalHomeCachePreparationReport, TerminalHomeCachePreparationRequest,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use sha2::{Digest, Sha256};
use tracing::{Level, warn};

use crate::error::LifecycleError;
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
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

pub async fn prepare_home_image_from_active_sandbox(
    sandbox: &dyn Sandbox,
    promotion: Option<HomeImagePromotionContext>,
    reason: &'static str,
) -> Option<PreparedHomeImagePromotion> {
    let mut promotion = promotion?;
    // Existing terminal callers have finished checkpoint/identity/log readers
    // and own the sandbox exclusively. The helper captures a proof, cleans all
    // managed private namespaces, and returns before freeze. No body is copied.
    let result = AssertUnwindSafe(async {
        // A privileged workload could have replaced the visible mount since
        // startup. Cleanup must cover the actual whole-home filesystem, never
        // a same-device subtree whose hidden private namespaces would survive.
        ensure_home_drive_mounted(sandbox, promotion.run_id())
            .await
            .map_err(|failure| failure.error)?;
        prepare_terminal_cache_runtime(sandbox, &mut promotion).await?;
        freeze_home_drive(sandbox, promotion.run_id()).await
    })
    .catch_unwind()
    .await;
    match result {
        Ok(Ok(())) => Some(PreparedHomeImagePromotion { promotion, reason }),
        Ok(Err(error)) => {
            log_guest_operation_failure(&promotion, reason, &error);
            abandon_unpublished_home_promotion(Some(promotion), reason).await;
            None
        }
        Err(_) => {
            warn!(run_id = %promotion.run_id(), reason, "home image preparation panicked");
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
        emit!(Level::INFO);
    } else {
        emit!(Level::WARN);
    }
}

async fn prepare_terminal_cache_runtime(
    sandbox: &dyn Sandbox,
    promotion: &mut HomeImagePromotionContext,
) -> crate::error::LifecycleResult<()> {
    let current_runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(
        CANONICAL_GUEST_HOME_DIR,
        &promotion.run_id().to_string(),
    )
    .map_err(|error| LifecycleError::Internal(format!("resolve terminal runtime scope: {error}")))?
    .to_string_lossy()
    .into_owned();
    let retained_runtime_dir = promotion
        .restored_session_identity()
        .and_then(|identity| identity.final_metadata_verification())
        .map(|verification| verification.runtime_dir.to_owned());
    let generation = promotion.publication_generation();
    let request = TerminalHomeCachePreparationRequest {
        current_runtime_dir,
        retained_runtime_dir,
        generation: generation.clone(),
    };
    request
        .validate()
        .map_err(|error| LifecycleError::Internal(error.to_string()))?;
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
        || result.stdout.len()
            > guest_contracts::home_cache_history::HOME_CACHE_HISTORY_HELPER_MAX_BYTES
    {
        return Err(LifecycleError::Internal(format_helper_exec_failure(
            "terminal home cache preparation",
            &result,
        )));
    }
    let report: TerminalHomeCachePreparationReport = serde_json::from_slice(&result.stdout)
        .map_err(|_| LifecycleError::Internal("invalid terminal home cleanup report".into()))?;
    if let Some(binding) = &report.history_proof {
        binding
            .validate()
            .map_err(|error| LifecycleError::Internal(error.to_string()))?;
        let bytes = binding
            .proof
            .to_json_vec()
            .map_err(|error| LifecycleError::Internal(error.to_string()))?;
        if binding.proof.generation != generation
            || hex::encode(Sha256::digest(bytes)) != binding.sha256
        {
            return Err(LifecycleError::Internal(
                "terminal home proof binding mismatch".into(),
            ));
        }
    }
    // Clear a previous candidate even on an ordinary history miss. This setter
    // validates the publication generation before storing optional evidence.
    promotion.set_home_history_proof(report.history_proof)?;
    Ok(())
}

impl PreparedHomeImagePromotion {
    pub async fn publish(mut self) -> bool {
        match AssertUnwindSafe(self.publish_inner()).catch_unwind().await {
            Ok(HomePromotionAction::Promoted) => true,
            Ok(HomePromotionAction::PreservedExisting) => false,
            Ok(HomePromotionAction::AbandonUnpublished) | Err(_) => {
                let reason = self.reason;
                self.abandon(reason).await;
                false
            }
        }
    }

    pub async fn abandon(self, reason: &'static str) {
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
    match AssertUnwindSafe(sandbox.unpark_for_terminal_operations())
        .catch_unwind()
        .await
    {
        Ok(Ok(())) => {
            prepare_home_image_from_active_sandbox(sandbox, Some(promotion), reason).await
        }
        Ok(Err(_)) | Err(_) => {
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
