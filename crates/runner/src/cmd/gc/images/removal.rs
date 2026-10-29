use std::fs::File;
use std::io;
use std::path::Path;

use nix::fcntl::Flock;

// Template-warm and orphan-rootfs deletion each require one actual acquired lock.
pub(super) use runner_host::gc::remove_dir_all_with_lock as remove_image_dir;

/// Snapshot removal requires both authorities, acquired rootfs before snapshot.
pub(super) struct SnapshotRemovalLocks {
    pub(super) rootfs: Flock<File>,
    pub(super) snapshot: Flock<File>,
}

/// Accepted physical deletion owns both guards even after its observer drops.
/// Return them for the caller's later snapshot/rootfs actions without reacquiring.
pub(super) async fn remove_snapshot_dir(
    path: &Path,
    locks: SnapshotRemovalLocks,
) -> (SnapshotRemovalLocks, io::Result<()>) {
    runner_host::gc::remove_dir_all_with_lock(path, locks).await
}

#[cfg(test)]
mod tests;
