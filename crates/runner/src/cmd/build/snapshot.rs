use std::fs::File;
use std::path::{Path, PathBuf};

use nix::fcntl::Flock;
use sandbox::SnapshotProvider;

use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::profile;
use runner_host::paths::{HomePaths, RootfsPaths};

use super::sizes::file_sizes;

pub(super) async fn build_snapshot(
    paths: &HomePaths,
    rootfs_paths: &RootfsPaths,
    snapshot_hash: &str,
    snapshot_dir: &Path,
    def: &profile::ProfileDef,
    provider: &dyn SnapshotProvider,
    snapshot_lock: Flock<File>,
) -> RunnerResult<()> {
    // Snapshot dir is nested under the rootfs dir:
    // <images>/<rootfs_hash>/snapshots/<snapshot_hash>/
    tokio::fs::create_dir_all(snapshot_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", snapshot_dir.display())))?;

    let create_config = sandbox::SnapshotCreateConfig {
        id: snapshot_hash.to_string(),
        binary_path: paths.firecracker_bin(FIRECRACKER_VERSION),
        kernel_path: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        rootfs_path: rootfs_paths.rootfs(),
        output_dir: snapshot_dir.to_path_buf(),
        vcpu_count: def.vcpu,
        memory_mb: def.memory_mb,
        home_disk_mb: def.home_disk_mb,
    };

    let pending = provider.create_uncommitted_snapshot(create_config).await?;
    let output = shielded_snapshot_publish(
        pending,
        snapshot_lock,
        snapshot_hash.to_string(),
        snapshot_dir.to_path_buf(),
    )
    .await?;

    let (snapshot_sz, memory_sz, cow_sz) = tokio::join!(
        file_sizes(&output.snapshot_path),
        file_sizes(&output.memory_path),
        file_sizes(&output.cow_path),
    );
    tracing::info!(
        snapshot_logical = %snapshot_sz.0,
        snapshot_disk = %snapshot_sz.1,
        memory_logical = %memory_sz.0,
        memory_disk = %memory_sz.1,
        cow_logical = %cow_sz.0,
        cow_disk = %cow_sz.1,
        "snapshot creation complete"
    );

    Ok(())
}

async fn shielded_snapshot_publish(
    pending: Box<dyn sandbox::PendingSnapshotPublish>,
    snapshot_lock: Flock<File>,
    snapshot_hash: String,
    snapshot_dir: PathBuf,
) -> RunnerResult<sandbox::SnapshotOutput> {
    let (result_tx, result_rx) =
        tokio::sync::oneshot::channel::<Result<sandbox::SnapshotOutput, sandbox::SnapshotError>>();

    // Once the provider returns an uncommitted snapshot, publish must reach
    // either commit or discard even if the caller waiting on this result is
    // cancelled. Move the snapshot lock into the detached task so other
    // builders and GC cannot acquire the lock and act on this output directory
    // until commit succeeds or discard finishes. This shields waiter
    // cancellation only; it is not a process-exit or runtime-shutdown
    // guarantee. The cancellation tests below cover the lock lifetime through
    // both commit and discard.
    tokio::spawn(async move {
        let result =
            commit_or_discard_pending_snapshot(pending, &snapshot_hash, &snapshot_dir).await;
        drop(snapshot_lock);

        if let Err(result) = result_tx.send(result) {
            match result {
                Ok(_) => {
                    tracing::info!(
                        snapshot_hash,
                        snapshot_dir = %snapshot_dir.display(),
                        "detached snapshot publish committed after caller cancellation"
                    );
                }
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        snapshot_hash,
                        snapshot_dir = %snapshot_dir.display(),
                        "detached snapshot publish failed after caller cancellation"
                    );
                }
            }
        }
    });

    match result_rx.await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(err)) => Err(err.into()),
        Err(err) => Err(RunnerError::Internal(format!(
            "snapshot publish task ended before reporting completion: {err}"
        ))),
    }
}

async fn commit_or_discard_pending_snapshot(
    mut pending: Box<dyn sandbox::PendingSnapshotPublish>,
    snapshot_hash: &str,
    snapshot_dir: &Path,
) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
    match pending.commit().await {
        Ok(output) => Ok(output),
        Err(err) => {
            // Discard is best-effort cleanup after a failed publish. Preserve
            // the original commit error so callers see the failure that made
            // the snapshot unusable.
            if let Err(discard_err) = pending.discard().await {
                tracing::warn!(
                    error = %discard_err,
                    snapshot_hash,
                    snapshot_dir = %snapshot_dir.display(),
                    "failed to discard uncommitted snapshot after publish failure"
                );
            }
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests;
