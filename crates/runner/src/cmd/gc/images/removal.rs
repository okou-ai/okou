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
    let path = path.to_path_buf();
    let dispatch = tracing::dispatcher::get_default(Clone::clone);
    let span = tracing::Span::current();
    let result = tokio::task::spawn_blocking(move || {
        let _default = tracing::dispatcher::set_default(&dispatch);
        let _entered = span.enter();
        let result = std::fs::remove_dir_all(path);
        (locks, result)
    })
    .await;
    match result {
        Ok(result) => result,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

#[cfg(test)]
mod tests;
