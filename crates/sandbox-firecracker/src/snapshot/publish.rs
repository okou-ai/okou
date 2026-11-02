use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use async_trait::async_trait;
use nbd_cow::{KeptCow, PooledNbdCowDevice};
use sandbox::{PendingSnapshotPublish, SnapshotOutput};

use crate::config::SnapshotConfig;
use crate::cow_cleanup::cow_destroy_retry_policy;
use crate::paths::SnapshotOutputPaths;

use super::SnapshotError;
use super::cow::{
    cleanup_snapshot_attempt_dir_for_cow, cleanup_snapshot_attempt_dir_for_cow_sync,
    destroy_snapshot_cow_and_cleanup_attempt_dir,
};
use super::output::{
    cleanup_remove_file_result, publish_snapshot_complete_marker, remove_dir_all_if_exists_sync,
    remove_file_if_exists_sync, run_snapshot_blocking_fs, sync_snapshot_output_dir,
};

type KeepCowFinalizer =
    Pin<Box<dyn Future<Output = nbd_cow::error::Result<KeptCow>> + Send + 'static>>;

enum SnapshotPublishState {
    HoldingDevice(PooledNbdCowDevice),
    KeepingCow(KeepCowFinalizer),
    KeptCow(KeptCow),
    Empty,
}

pub(super) struct SnapshotPublishAttempt {
    state: SnapshotPublishState,
}

impl SnapshotPublishAttempt {
    pub(super) fn new(cow_device: PooledNbdCowDevice) -> Self {
        Self {
            state: SnapshotPublishState::HoldingDevice(cow_device),
        }
    }

    #[cfg(test)]
    pub(super) fn new_with_kept_cow_for_test(kept_cow: KeptCow) -> Self {
        Self {
            state: SnapshotPublishState::KeptCow(kept_cow),
        }
    }

    #[cfg(test)]
    pub(super) fn new_with_keep_future_for_test(
        future: impl Future<Output = nbd_cow::error::Result<KeptCow>> + Send + 'static,
    ) -> Self {
        Self {
            state: SnapshotPublishState::KeepingCow(Box::pin(future)),
        }
    }

    pub(super) fn has_cleanup_work(&self) -> bool {
        !matches!(self.state, SnapshotPublishState::Empty)
    }

    fn start_keep_cow(&mut self) -> Result<(), SnapshotError> {
        let state = std::mem::replace(&mut self.state, SnapshotPublishState::Empty);
        match state {
            SnapshotPublishState::HoldingDevice(cow_device) => {
                self.state = SnapshotPublishState::KeepingCow(Box::pin(
                    cow_device.destroy_keep_cow_with_retries(cow_destroy_retry_policy()),
                ));
                Ok(())
            }
            SnapshotPublishState::KeepingCow(finalizer) => {
                self.state = SnapshotPublishState::KeepingCow(finalizer);
                Ok(())
            }
            SnapshotPublishState::KeptCow(kept_cow) => {
                self.state = SnapshotPublishState::KeptCow(kept_cow);
                Ok(())
            }
            SnapshotPublishState::Empty => Err(SnapshotError::Teardown(
                "snapshot publish attempt missing COW ownership".into(),
            )),
        }
    }

    async fn resolve_keep_cow(&mut self) -> Result<(), SnapshotError> {
        self.start_keep_cow()?;
        let result = match &mut self.state {
            SnapshotPublishState::KeepingCow(finalizer) => finalizer.as_mut().await,
            SnapshotPublishState::KeptCow(_) => return Ok(()),
            SnapshotPublishState::HoldingDevice(_) | SnapshotPublishState::Empty => {
                return Err(SnapshotError::Teardown(
                    "snapshot publish attempt did not start keep-COW finalizer".into(),
                ));
            }
        };

        match result {
            Ok(kept_cow) => {
                self.state = SnapshotPublishState::KeptCow(kept_cow);
                Ok(())
            }
            Err(e) => {
                self.state = SnapshotPublishState::Empty;
                Err(SnapshotError::Teardown(format!(
                    "destroy_keep_cow exhausted retries; device abandoned, snapshot aborted (last error: {e})"
                )))
            }
        }
    }

    pub(super) async fn resolve_into_kept_cow(&mut self) -> Result<KeptCow, SnapshotError> {
        self.resolve_keep_cow().await?;

        let state = std::mem::replace(&mut self.state, SnapshotPublishState::Empty);
        match state {
            SnapshotPublishState::KeptCow(kept_cow) => Ok(kept_cow),
            other => {
                self.state = other;
                Err(SnapshotError::Teardown(
                    "snapshot publish attempt resolved without kept COW".into(),
                ))
            }
        }
    }

    pub(super) async fn cleanup_after_cancellation(&mut self) -> bool {
        if !self.has_cleanup_work() {
            return true;
        }

        if matches!(self.state, SnapshotPublishState::HoldingDevice(_)) {
            let SnapshotPublishState::HoldingDevice(cow_device) =
                std::mem::replace(&mut self.state, SnapshotPublishState::Empty)
            else {
                return true;
            };
            return destroy_snapshot_cow_and_cleanup_attempt_dir(cow_device)
                .await
                .map_or_else(
                    |e| {
                        tracing::warn!(
                            error = %e,
                            "failed to destroy COW device during snapshot publish cleanup"
                        );
                        false
                    },
                    |()| true,
                );
        }

        if let Err(e) = self.resolve_keep_cow().await {
            tracing::warn!(
                error = %e,
                "failed to resolve keep-COW finalizer during snapshot publish cleanup"
            );
            return false;
        }

        self.cleanup_resolved_kept_cow().await
    }

    async fn cleanup_resolved_kept_cow(&mut self) -> bool {
        let cleanup_paths = match &self.state {
            SnapshotPublishState::KeptCow(kept_cow) => KeptCowCleanupPaths::from_kept_cow(kept_cow),
            SnapshotPublishState::Empty => return true,
            SnapshotPublishState::HoldingDevice(_) | SnapshotPublishState::KeepingCow(_) => {
                return false;
            }
        };

        let cleaned = cleanup_kept_cow_paths_after_publish_cancellation(&cleanup_paths).await;
        if cleaned {
            self.state = SnapshotPublishState::Empty;
        }
        cleaned
    }
}

enum FirecrackerPendingSnapshotPublishState {
    Pending(KeptCow),
    Committed,
    Discarded,
}

struct KeptCowCleanupPaths {
    cow_file: PathBuf,
    bitmap_file: PathBuf,
}

impl KeptCowCleanupPaths {
    fn from_kept_cow(kept_cow: &KeptCow) -> Self {
        Self {
            cow_file: kept_cow.cow_file.clone(),
            bitmap_file: kept_cow.bitmap_file.clone(),
        }
    }
}

pub(super) struct FirecrackerPendingSnapshotPublish {
    snapshot_config: SnapshotConfig,
    output: SnapshotOutputPaths,
    state: FirecrackerPendingSnapshotPublishState,
}

impl FirecrackerPendingSnapshotPublish {
    pub(super) fn new(
        snapshot_config: SnapshotConfig,
        output: SnapshotOutputPaths,
        kept_cow: KeptCow,
    ) -> Self {
        Self {
            snapshot_config,
            output,
            state: FirecrackerPendingSnapshotPublishState::Pending(kept_cow),
        }
    }

    pub(super) async fn commit_config(&mut self) -> Result<SnapshotConfig, SnapshotError> {
        let state = std::mem::replace(
            &mut self.state,
            FirecrackerPendingSnapshotPublishState::Discarded,
        );
        match state {
            FirecrackerPendingSnapshotPublishState::Pending(kept_cow) => {
                match run_snapshot_blocking_fs(|| {
                    commit_snapshot_cow_output(&kept_cow, &self.output)
                }) {
                    Ok(()) => {
                        self.state = FirecrackerPendingSnapshotPublishState::Committed;
                        Ok(self.snapshot_config.clone())
                    }
                    Err(e) => {
                        self.state = FirecrackerPendingSnapshotPublishState::Pending(kept_cow);
                        Err(e)
                    }
                }
            }
            FirecrackerPendingSnapshotPublishState::Committed => {
                self.state = FirecrackerPendingSnapshotPublishState::Committed;
                Ok(self.snapshot_config.clone())
            }
            FirecrackerPendingSnapshotPublishState::Discarded => {
                self.state = FirecrackerPendingSnapshotPublishState::Discarded;
                Err(SnapshotError::Teardown(
                    "pending snapshot publish was already discarded".into(),
                ))
            }
        }
    }

    pub(super) async fn discard_inner(&mut self) -> Result<(), SnapshotError> {
        let cleanup_paths = match &self.state {
            FirecrackerPendingSnapshotPublishState::Pending(kept_cow) => {
                KeptCowCleanupPaths::from_kept_cow(kept_cow)
            }
            FirecrackerPendingSnapshotPublishState::Committed
            | FirecrackerPendingSnapshotPublishState::Discarded => return Ok(()),
        };

        let cleaned = run_snapshot_blocking_fs(|| {
            let output_artifacts_cleaned =
                cleanup_uncommitted_snapshot_output_artifacts(&self.output);
            let cow_cleaned = cleanup_kept_cow_paths_after_publish_discard(&cleanup_paths);
            let work_cleaned = if cow_cleaned {
                cleanup_snapshot_work_dir(&self.output)
            } else {
                false
            };

            output_artifacts_cleaned && cow_cleaned && work_cleaned
        });

        if cleaned {
            self.state = FirecrackerPendingSnapshotPublishState::Discarded;
            Ok(())
        } else {
            Err(SnapshotError::Teardown(
                "failed to discard uncommitted snapshot artifacts".into(),
            ))
        }
    }
}

impl Drop for FirecrackerPendingSnapshotPublish {
    fn drop(&mut self) {
        let state = std::mem::replace(
            &mut self.state,
            FirecrackerPendingSnapshotPublishState::Discarded,
        );
        if let FirecrackerPendingSnapshotPublishState::Pending(kept_cow) = state {
            let cleaned = cleanup_kept_cow_after_publish_drop(&kept_cow);
            if !cleaned {
                self.state = FirecrackerPendingSnapshotPublishState::Pending(kept_cow);
            }
            tracing::warn!(
                cleaned,
                output_dir = %self.output.dir().display(),
                "uncommitted snapshot publish dropped without commit or discard"
            );
        } else {
            self.state = state;
        }
    }
}

#[async_trait]
impl PendingSnapshotPublish for FirecrackerPendingSnapshotPublish {
    async fn commit(&mut self) -> Result<SnapshotOutput, sandbox::SnapshotError> {
        let snapshot_config = self
            .commit_config()
            .await
            .map_err(SnapshotError::into_sandbox_error)?;
        Ok(snapshot_output_from_config(snapshot_config))
    }

    async fn discard(&mut self) -> Result<(), sandbox::SnapshotError> {
        self.discard_inner()
            .await
            .map_err(SnapshotError::into_sandbox_error)
    }
}

fn snapshot_output_from_config(config: SnapshotConfig) -> SnapshotOutput {
    SnapshotOutput {
        snapshot_path: config.snapshot_path,
        memory_path: config.memory_path,
        cow_path: config.cow_path,
    }
}

async fn cleanup_kept_cow_paths_after_publish_cancellation(paths: &KeptCowCleanupPaths) -> bool {
    let mut cleaned = true;
    for path in [&paths.bitmap_file, &paths.cow_file] {
        if !cleanup_remove_file_result(
            tokio::fs::remove_file(path).await,
            path,
            "failed to cleanup kept COW artifact after snapshot publish cancellation",
        ) {
            cleaned = false;
        }
    }
    cleanup_snapshot_attempt_dir_for_cow(&paths.cow_file).await && cleaned
}

fn cleanup_uncommitted_snapshot_output_artifacts(output: &SnapshotOutputPaths) -> bool {
    let mut cleaned = true;
    for path in std::iter::once(output.complete_marker()).chain(output.required_artifacts()) {
        match remove_file_if_exists_sync(&path) {
            Ok(()) => {}
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %path.display(),
                    "failed to cleanup uncommitted snapshot output artifact"
                );
                cleaned = false;
            }
        }
    }
    cleaned
}

fn cleanup_snapshot_work_dir(output: &SnapshotOutputPaths) -> bool {
    let work_dir = output.work_dir();
    match remove_dir_all_if_exists_sync(&work_dir) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(
                error = %e,
                path = %work_dir.display(),
                "failed to cleanup uncommitted snapshot work dir"
            );
            false
        }
    }
}

fn cleanup_kept_cow_after_publish_drop(kept_cow: &KeptCow) -> bool {
    cleanup_kept_cow_paths_after_publish_drop(&KeptCowCleanupPaths::from_kept_cow(kept_cow))
}

fn cleanup_kept_cow_paths_after_publish_discard(paths: &KeptCowCleanupPaths) -> bool {
    cleanup_kept_cow_paths_sync(
        paths,
        "failed to cleanup kept COW artifact after pending snapshot publish discard",
    )
}

fn cleanup_kept_cow_paths_after_publish_drop(paths: &KeptCowCleanupPaths) -> bool {
    cleanup_kept_cow_paths_sync(
        paths,
        "failed to cleanup kept COW artifact after pending snapshot publish drop",
    )
}

fn cleanup_kept_cow_paths_sync(paths: &KeptCowCleanupPaths, warning: &'static str) -> bool {
    let mut cleaned = true;
    for path in [&paths.bitmap_file, &paths.cow_file] {
        if !cleanup_remove_file_result(std::fs::remove_file(path), path, warning) {
            cleaned = false;
        }
    }
    cleanup_snapshot_attempt_dir_for_cow_sync(&paths.cow_file) && cleaned
}

fn commit_snapshot_cow_output(
    kept_cow: &KeptCow,
    output: &SnapshotOutputPaths,
) -> Result<(), SnapshotError> {
    // destroy_keep_cow succeeded, so save_bitmap succeeded — the bitmap
    // sidecar is on disk. Rename is unconditional: if the sidecar is
    // missing we want to fail loudly, not silently produce a
    // bitmap-less snapshot.
    std::fs::rename(&kept_cow.bitmap_file, output.cow_bitmap())?;
    std::fs::rename(&kept_cow.cow_file, output.cow())?;
    cleanup_snapshot_attempt_dir_for_cow_sync(&kept_cow.cow_file);
    // Persist the output directory so all four artifact dir entries
    // (snapshot.bin and memory.bin written by Firecracker via the API,
    // cow.img and cow.img.bitmap just renamed in) are durable. Without
    // this fsync, rename(2) and Firecracker's creates return once the
    // update is journaled but the entry may not hit disk until the FS's
    // next commit (~5s on ext4 data=ordered). A crash in that window can
    // leave is_complete() returning true while one or more files are
    // missing or rolled back — worst case, cow.img present but
    // cow.img.bitmap absent, which silently corrupts restore reads
    // (same failure class as #9794, one layer up).
    sync_snapshot_output_dir(output)?;

    // Commit point: the marker is written only after all artifacts are present
    // and the output directory has been synced. Marker publication uses a
    // synchronous no-await section so async cancellation cannot stop between
    // marker visibility and the marker directory fsync.
    publish_snapshot_complete_marker(output)?;
    Ok(())
}

#[cfg(test)]
mod tests;
