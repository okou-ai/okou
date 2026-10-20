//! Invocation-owned observations after actual Guest preparation succeeds.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use sandbox::{Sandbox, SandboxBackingProcess, SandboxError, SandboxInitializationPhase};

use crate::sandbox::FirecrackerSandbox;

/// Actual successful preparation boundary observed by an opt-in native fixture.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuestPreparationStage {
    /// Real backend launch and Guest readiness have completed.
    Start,
    /// The real home-mount RPC completed successfully.
    Mount,
    /// The real blank-pool park completed with reusable eligibility.
    Park,
    /// The real fixed Guest state-restore RPC returned success.
    Restore,
}

impl GuestPreparationStage {
    /// Stable label for the fixture's external evidence.
    pub fn label(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Mount => "mount",
            Self::Park => "park",
            Self::Restore => "restore",
        }
    }
}

/// Exact actual Guest and independently retained backing at a completed stage.
pub struct GuestPreparationObservation {
    /// Successful real preparation boundary.
    pub stage: GuestPreparationStage,
    /// Actual returned provider sandbox identity.
    pub sandbox_id: String,
    /// Original positive-wait capability, never a PID or fabricated generation.
    pub backing: Arc<dyn SandboxBackingProcess>,
}

/// Test-only after-success observation; it does not replace the actual operation.
///
/// The caller retains the same borrowed Sandbox while awaiting this future.
/// A fixture may hold separate owned IO to exercise late delivery; this is not
/// evidence that Guest transport or storage is stalled.
pub type GuestPreparationCheckpoint = Arc<
    dyn Fn(GuestPreparationObservation) -> BoxFuture<'static, sandbox::Result<()>> + Send + Sync,
>;

pub(crate) fn attach(
    mut sandbox: FirecrackerSandbox,
    checkpoint: Option<GuestPreparationCheckpoint>,
) -> FirecrackerSandbox {
    sandbox.preparation_checkpoint = checkpoint;
    sandbox
}

impl FirecrackerSandbox {
    pub(crate) async fn run_preparation_checkpoint(
        &self,
        stage: GuestPreparationStage,
    ) -> sandbox::Result<()> {
        let Some(checkpoint) = self.preparation_checkpoint.clone() else {
            return Ok(());
        };
        let backing = self
            .backing_process()
            .ok_or_else(|| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: "successful Guest preparation checkpoint has no actual backing".into(),
            })?;
        checkpoint(GuestPreparationObservation {
            stage,
            sandbox_id: self.id.clone(),
            backing,
        })
        .await
    }
}
