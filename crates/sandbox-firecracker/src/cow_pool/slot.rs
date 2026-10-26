use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use nbd_cow::PooledNbdCowDevice;
#[cfg(test)]
use tokio::sync::oneshot;
use tracing::warn;

use super::CowPoolError;
use crate::cow_cleanup::{CowCleanupOutcome, destroy_cow_device_with_retries};

struct SlotWorkspaceCleanup {
    /// Unique slot ID. Used as workspace directory name before checkout.
    id: String,
    /// Path to the workspace directory: `{workspaces_dir}/{id}/`.
    workspace: PathBuf,
    #[cfg(test)]
    teardown_gate: Option<SlotTeardownGate>,
}

impl SlotWorkspaceCleanup {
    fn new(id: String, workspace: PathBuf) -> Self {
        Self {
            id,
            workspace,
            #[cfg(test)]
            teardown_gate: None,
        }
    }

    fn remove_best_effort(self) -> PathBuf {
        let Self {
            id,
            workspace,
            #[cfg(test)]
            teardown_gate,
        } = self;
        #[cfg(test)]
        if let Some(teardown_gate) = teardown_gate {
            let _ = teardown_gate.started.send(workspace.clone());
            let _ = teardown_gate.release.recv();
        }
        match std::fs::remove_dir_all(&workspace) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                warn!(id = %id, error = %e, "failed to delete pool workspace dir");
            }
        }
        workspace
    }
}

#[cfg(test)]
struct SlotTeardownGate {
    started: oneshot::Sender<PathBuf>,
    release: std::sync::mpsc::Receiver<()>,
}

/// A file-only COW slot before its NBD device is connected.
pub(super) struct PrewarmedSlot {
    id: String,
    workspace: PathBuf,
    cleanup: Option<SlotWorkspaceCleanup>,
    #[cfg(test)]
    pub(super) drop_notify: Option<oneshot::Sender<PathBuf>>,
}

impl PrewarmedSlot {
    pub(super) fn new(id: String, workspace: PathBuf) -> Self {
        let cleanup = SlotWorkspaceCleanup::new(id.clone(), workspace.clone());
        Self {
            id,
            workspace,
            cleanup: Some(cleanup),
            #[cfg(test)]
            drop_notify: None,
        }
    }

    pub(super) fn id(&self) -> &str {
        &self.id
    }

    pub(super) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(super) fn cow_file(&self) -> PathBuf {
        self.workspace().join("cow.img")
    }

    fn into_prepared(mut self, device: PreparedCowDevice) -> PreparedCowSlot {
        debug_assert_eq!(device.cow_file(), self.cow_file());
        PreparedCowSlot {
            id: self.id.clone(),
            workspace: self.workspace.clone(),
            cleanup: self.cleanup.take(),
            device: Some(Box::new(device)),
            #[cfg(test)]
            drop_notify: self.drop_notify.take(),
        }
    }

    #[cfg(test)]
    pub(super) fn set_teardown_gate(
        &mut self,
        started: oneshot::Sender<PathBuf>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        if let Some(cleanup) = self.cleanup.as_mut() {
            cleanup.teardown_gate = Some(SlotTeardownGate { started, release });
        }
    }

    #[cfg(test)]
    fn notify_teardown(&mut self, workspace: PathBuf) {
        if let Some(drop_notify) = self.drop_notify.take() {
            let _ = drop_notify.send(workspace);
        }
    }

    #[cfg(not(test))]
    fn notify_teardown(&mut self, _workspace: PathBuf) {}
}

impl Drop for PrewarmedSlot {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            let workspace = cleanup.remove_best_effort();
            self.notify_teardown(workspace);
        }
    }
}

impl std::fmt::Debug for PrewarmedSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrewarmedSlot")
            .field("id", &self.id())
            .field("workspace", &self.workspace())
            .finish_non_exhaustive()
    }
}

pub(crate) enum PreparedCowDevice {
    Real(PooledNbdCowDevice),
    #[cfg(test)]
    Test {
        cow_file: PathBuf,
    },
}

impl PreparedCowDevice {
    pub(super) fn cow_file(&self) -> PathBuf {
        match self {
            Self::Real(device) => device.cow_file().to_path_buf(),
            #[cfg(test)]
            Self::Test { cow_file } => cow_file.clone(),
        }
    }

    fn relocate_cow_file_after_rename(&mut self, cow_file: PathBuf) -> std::io::Result<()> {
        match self {
            Self::Real(device) => device
                .relocate_cow_file_after_rename(cow_file)
                .map_err(std::io::Error::other),
            #[cfg(test)]
            Self::Test {
                cow_file: test_cow_file,
            } => {
                *test_cow_file = cow_file;
                Ok(())
            }
        }
    }

    pub(crate) fn into_real(self) -> Result<PooledNbdCowDevice, CowPoolError> {
        match self {
            Self::Real(device) => Ok(device),
            #[cfg(test)]
            Self::Test { .. } => Err(CowPoolError::CowDeviceCreation(
                "test prepared COW device cannot enter a sandbox".into(),
            )),
        }
    }
}

/// A clean one-shot COW file and the NBD device connected to that exact file.
pub(crate) struct PreparedCowSlot {
    id: String,
    workspace: PathBuf,
    cleanup: Option<SlotWorkspaceCleanup>,
    device: Option<Box<PreparedCowDevice>>,
    #[cfg(test)]
    drop_notify: Option<oneshot::Sender<PathBuf>>,
}

struct PreparedCowSlotCleanup {
    id: String,
    workspace: PathBuf,
    cleanup: Option<SlotWorkspaceCleanup>,
    device: Option<Box<PreparedCowDevice>>,
    #[cfg(test)]
    drop_notify: Option<oneshot::Sender<PathBuf>>,
}

impl PreparedCowSlot {
    pub(super) fn new(slot: PrewarmedSlot, device: PooledNbdCowDevice) -> Self {
        slot.into_prepared(PreparedCowDevice::Real(device))
    }

    #[cfg(test)]
    pub(super) fn new_for_test(slot: PrewarmedSlot) -> Self {
        let cow_file = slot.cow_file();
        slot.into_prepared(PreparedCowDevice::Test { cow_file })
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }

    /// Transfers this one-shot COW slot into the caller-owned `target_workspace`.
    ///
    /// `target_workspace` must already exist and remain exclusively owned by
    /// the caller throughout transfer and rollback.
    ///
    /// Checkout performs these synchronous mutations in order:
    ///
    /// 1. Moves `cow.img` into `target_workspace`.
    /// 2. Moves the optional bitmap beside the target COW file when it exists.
    /// 3. Removes the now-empty source workspace.
    /// 4. Updates the connected device's recorded COW path.
    /// 5. Disarms source-workspace cleanup and returns the prepared device.
    ///
    /// On success, the prepared device transfers to the caller while
    /// `target_workspace` remains under the caller's cleanup ownership.
    ///
    /// # Errors
    ///
    /// Checkout is not transactional: an error does not undo earlier steps.
    /// The returned [`PreparedCowCheckoutError`] owns the partially checked-out
    /// slot, while zero, one, or both backing files may already be in
    /// `target_workspace`.
    ///
    /// Before target-workspace rollback can run, the caller must preserve that
    /// workspace and consume the error with
    /// [`PreparedCowCheckoutError::start_cleanup`]. Target files may be deleted
    /// only when the returned cleanup outcome reports that backing files are
    /// safe to delete.
    pub(crate) fn checkout_to(
        mut self,
        target_workspace: &Path,
    ) -> Result<PreparedCowDevice, PreparedCowCheckoutError> {
        let source_cow = self.workspace.join("cow.img");
        let target_cow = target_workspace.join("cow.img");
        if let Err(source) = std::fs::rename(&source_cow, &target_cow) {
            return Err(PreparedCowCheckoutError::new(
                "move prepared COW file",
                source,
                self,
            ));
        }

        let source_bitmap = nbd_cow::cow::bitmap_path_for(&source_cow);
        let target_bitmap = nbd_cow::cow::bitmap_path_for(&target_cow);
        match std::fs::symlink_metadata(&source_bitmap) {
            Ok(_) => {
                if let Err(source) = std::fs::rename(&source_bitmap, &target_bitmap) {
                    return Err(PreparedCowCheckoutError::new(
                        "move prepared COW bitmap",
                        source,
                        self,
                    ));
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(source) => {
                return Err(PreparedCowCheckoutError::new(
                    "inspect prepared COW bitmap",
                    source,
                    self,
                ));
            }
        }

        if let Err(source) = std::fs::remove_dir(&self.workspace) {
            return Err(PreparedCowCheckoutError::new(
                "remove prepared COW source workspace",
                source,
                self,
            ));
        }

        let Some(device) = self.device.as_mut() else {
            return Err(PreparedCowCheckoutError::new(
                "retarget prepared COW device",
                std::io::Error::other("prepared COW slot missing device"),
                self,
            ));
        };
        let relocation = device.relocate_cow_file_after_rename(target_cow);
        if let Err(source) = relocation {
            return Err(PreparedCowCheckoutError::new(
                "retarget prepared COW device",
                source,
                self,
            ));
        }

        self.cleanup.take();
        match self.device.take() {
            Some(device) => Ok(*device),
            None => Err(PreparedCowCheckoutError::new(
                "finish prepared COW checkout",
                std::io::Error::other("prepared COW slot missing device"),
                self,
            )),
        }
    }

    fn take_cleanup(&mut self) -> PreparedCowSlotCleanup {
        PreparedCowSlotCleanup {
            id: self.id.clone(),
            workspace: self.workspace.clone(),
            cleanup: self.cleanup.take(),
            device: self.device.take(),
            #[cfg(test)]
            drop_notify: self.drop_notify.take(),
        }
    }
}

impl Drop for PreparedCowSlot {
    fn drop(&mut self) {
        if self.device.is_none() && self.cleanup.is_none() {
            return;
        }

        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            warn!(
                id = %self.id,
                path = %self.workspace.display(),
                "prepared COW slot dropped outside a Tokio runtime; preserving workspace"
            );
            return;
        };

        warn!(
            id = %self.id,
            path = %self.workspace.display(),
            "prepared COW slot dropped without explicit checkout or cleanup; starting cleanup"
        );
        drop(runtime.spawn(run_prepared_slot_cleanup(self.take_cleanup(), None)));
    }
}

impl std::fmt::Debug for PreparedCowSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedCowSlot")
            .field("id", &self.id())
            .field("workspace", &self.workspace())
            .finish_non_exhaustive()
    }
}

/// A checkout failure that retains ownership of the prepared slot.
///
/// Because checkout is non-transactional, the slot may be partially moved into
/// the caller's target workspace. It is retained for explicit cleanup through
/// [`Self::start_cleanup`], without exposing the slot for reuse.
#[derive(Debug)]
pub(crate) struct PreparedCowCheckoutError {
    operation: &'static str,
    source: std::io::Error,
    slot: Box<PreparedCowSlot>,
}

impl PreparedCowCheckoutError {
    fn new(operation: &'static str, source: std::io::Error, slot: PreparedCowSlot) -> Self {
        Self {
            operation,
            source,
            slot: Box::new(slot),
        }
    }

    /// Starts cleanup of the partially checked-out slot.
    ///
    /// The cleanup task starts before this returns. Creation rollback custody
    /// belongs to that physical producer, including accepted blocking removal,
    /// rather than to the returned completion observer.
    ///
    /// This does not take ownership of the caller's target workspace. Keep
    /// target-workspace cleanup disabled until the returned outcome reports
    /// that backing files are safe to delete.
    pub(crate) fn start_cleanup(
        self,
        custody: Option<sandbox::SandboxCreateCustody>,
    ) -> impl std::future::Future<Output = CowCleanupOutcome> {
        start_prepared_slot_cleanup(*self.slot, custody)
    }
}

impl std::fmt::Display for PreparedCowCheckoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.operation, self.source)
    }
}

impl std::error::Error for PreparedCowCheckoutError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// Best-effort synchronous teardown of a file-only slot.
pub(super) fn destroy_slot_sync(mut slot: PrewarmedSlot) {
    if let Some(cleanup) = slot.cleanup.take() {
        let workspace = cleanup.remove_best_effort();
        slot.notify_teardown(workspace);
    }
}

/// Best-effort teardown of a file-only slot on Tokio's blocking pool.
pub(super) fn destroy_slot_async(slot: PrewarmedSlot) -> impl std::future::Future<Output = ()> {
    let teardown = tokio::task::spawn_blocking(move || destroy_slot_sync(slot));
    async move {
        if let Err(e) = teardown.await {
            warn!(error = %e, "COW slot teardown task failed");
        }
    }
}

/// Finalize a prepared device before deleting its slot-owned source workspace.
///
/// The cleanup task is spawned before this returns, so dropping the returned
/// waiter cannot cancel device finalization or move directory deletion into
/// [`PreparedCowSlot::drop`].
///
/// Like [`PreparedCowCheckoutError::start_cleanup`], this does not take ownership
/// of the caller's target workspace. The returned outcome tells that owner
/// whether the device lifecycle makes target files safe to delete.
pub(crate) fn destroy_prepared_slot_async(
    slot: PreparedCowSlot,
) -> impl std::future::Future<Output = CowCleanupOutcome> {
    start_prepared_slot_cleanup(slot, None)
}

fn start_prepared_slot_cleanup(
    mut slot: PreparedCowSlot,
    custody: Option<sandbox::SandboxCreateCustody>,
) -> impl std::future::Future<Output = CowCleanupOutcome> {
    let teardown = tokio::spawn(run_prepared_slot_cleanup(slot.take_cleanup(), custody));

    async move {
        match teardown.await {
            Ok(outcome) => outcome,
            Err(error) => {
                warn!(error = %error, "prepared COW slot cleanup task failed");
                CowCleanupOutcome::DeviceMayStillReferenceBackingFiles
            }
        }
    }
}

async fn run_prepared_slot_cleanup(
    slot: PreparedCowSlotCleanup,
    custody: Option<sandbox::SandboxCreateCustody>,
) -> CowCleanupOutcome {
    let _custody = custody.clone();
    let PreparedCowSlotCleanup {
        id,
        workspace,
        cleanup,
        device,
        #[cfg(test)]
        drop_notify,
    } = slot;
    let outcome = match device.map(|device| *device) {
        Some(PreparedCowDevice::Real(device)) => destroy_cow_device_with_retries(&id, device).await,
        #[cfg(test)]
        Some(PreparedCowDevice::Test { .. }) => CowCleanupOutcome::BackingFilesSafeToDelete,
        None => CowCleanupOutcome::BackingFilesSafeToDelete,
    };

    if outcome.backing_files_safe_to_delete() {
        if let Some(cleanup) = cleanup {
            let removed = tokio::task::spawn_blocking(move || {
                let _custody = custody;
                cleanup.remove_best_effort()
            })
            .await;
            match removed {
                Ok(removed_workspace) => {
                    #[cfg(test)]
                    if let Some(drop_notify) = drop_notify {
                        let _ = drop_notify.send(removed_workspace);
                    }
                    #[cfg(not(test))]
                    drop(removed_workspace);
                }
                Err(error) => {
                    warn!(
                        id = %id,
                        error = %error,
                        "prepared COW slot teardown task failed"
                    );
                }
            }
        }
    } else {
        warn!(
            id = %id,
            path = %workspace.display(),
            "preserving prepared COW workspace after device cleanup failure"
        );
    }
    outcome
}
