use std::sync::Arc;

use sandbox::{BackingProcessIdentity, SandboxBackingProcess};
use tokio::sync::oneshot;
use tokio_util::task::task_tracker::TaskTrackerToken;

use super::accounting::{CapturedBacking, CapturedPlan, Purpose, Stage};
use super::{MemoryOperationError as Error, MemoryOperationId, Result, Shared};

/// Receiver-only completion of accepted work. Caller cancellation/outer panic
/// drops this receiver, not the real task, producer or its memory guard.
#[must_use]
pub struct MemoryOperationTask<T> {
    pub(super) completion: oneshot::Receiver<T>,
}

impl<T> MemoryOperationTask<T> {
    /// A work result is not automatically phase settlement or saved-data proof.
    pub async fn join(self) -> Result<T> {
        self.completion.await.map_err(|_| Error::ProducerLost)
    }
}

/// The real started phase owner. Drop/panic retains uncertainty, not capacity
/// credit. Tracking follows the guard into accepted physical work independently
/// of its async producer. No key can mutate another owner's record.
#[must_use]
pub struct MemoryOperation {
    pub(super) shared: Arc<Shared>,
    pub(super) id: Option<MemoryOperationId>,
    // Retained across row removal so provider Drop cannot run under accounting.
    pub(super) plan: CapturedPlan,
    // Shared with the callback: one owner count, retained through real I/O even
    // when the callback panics or a blocking JoinHandle is dropped.
    pub(super) _tracking: Arc<TaskTrackerToken>,
}

impl MemoryOperation {
    pub fn id(&self) -> Option<MemoryOperationId> {
        self.id
    }

    /// Capture the exact fresh generation once, after actual launch. Existing
    /// bindings cannot be substituted; a replacement needs separate coverage.
    pub fn bind_backing(&mut self, backing: Arc<dyn SandboxBackingProcess>) -> Result<()> {
        let id = self.id.ok_or(Error::Consumed)?;
        let backing = CapturedBacking::capture(backing);
        self.shared.lock()?.bind(id, backing.clone())?;
        self.plan.purpose = Purpose::Preparation(Some(backing));
        Ok(())
    }

    /// Metadata only; absent fresh/host-I/O backing is never positive exit proof.
    pub fn backing_identity(&self) -> Result<Option<BackingProcessIdentity>> {
        let id = self.id.ok_or(Error::Consumed)?;
        let plan = self.shared.lock()?.plan(id, Stage::Started)?;
        Ok(match plan.purpose {
            Purpose::Preparation(backing) => backing.map(|backing| backing.identity),
            Purpose::Retirement(backing) => Some(backing.identity),
            Purpose::HostIo => None,
        })
    }

    /// Called by the real owner only after positive relevant phase completion:
    /// prepared/Agent-ready for preparation, accepted I/O joined for host I/O,
    /// and pre-exit export/preparation finished for retirement. It is not a
    /// cancellation, generic-kill, lease-transfer, PID or timeout shortcut.
    ///
    /// Retirement also requires exact provider wait proof. All observation is
    /// independent of accounting/producer locks. Then read fresh host input,
    /// fenced against concurrent accounting changes. A low but valid sample
    /// may settle completed growth; later grants still protect floor/reserve.
    /// Nothing adds predicted freed bytes. Failures preserve the owned guard
    /// for retry; losing that owner leaves its row uncertain without a TTL.
    ///
    /// Required post-exit work must remain joined by the tracked task. If it can
    /// still grow, keep its separate measured I/O allowance through that phase.
    pub async fn complete_phase(&mut self) -> Result<()> {
        let id = self.id.ok_or(Error::Consumed)?;
        let plan = self.shared.lock()?.plan(id, Stage::Started)?;
        match plan.purpose {
            Purpose::Preparation(None) => return Err(Error::MissingBacking),
            Purpose::Preparation(Some(backing)) => {
                if backing.process.identity() != backing.identity {
                    return Err(Error::OwnershipInvariant);
                }
            }
            Purpose::Retirement(backing) => {
                if backing.process.identity() != backing.identity
                    || !backing.process.exit_confirmed().await
                    || backing.process.identity() != backing.identity
                {
                    return Err(Error::UnconfirmedBacking);
                }
            }
            Purpose::HostIo => {}
        }
        let sample = self.shared.sample().await?;
        self.shared.lock()?.settle(id, sample, self.shared.policy)?;
        self.id = None;
        Ok(())
    }
}

impl Drop for MemoryOperation {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.shared.abandon(id);
        }
    }
}
