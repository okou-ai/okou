use crate::cmd::service::RunnerServiceUnit;
use crate::error::RunnerResult;
use runner_host::paths::HomePaths;

use super::filesystem::{next_entry_warn_or_stop, read_dir_or_missing};
use super::lock_file::{LockProbe, probe_lock, remove_unused_lock_after_probe};
use super::report::GcReport;
use runner_host::gc::workspaces::is_base_dir_lock_name;

/// Remove unused lock files.
///
/// Most lock files that can be exclusively locked are safe to delete:
/// `open_lock_file` will recreate them on next use, and the inode recheck in
/// `lock.rs` prevents stale-fd races. Service locks are intentionally retained
/// because this GC pass runs before version GC, which relies on those lock paths
/// to coordinate with concurrent service install/uninstall commands. The
/// systemd reload lock is also retained because non-runner lifecycle owners use
/// the same stable path with plain `flock`. The global GC lock remains stable so
/// old external holders and runner-owned locking coordinate on the same inode.
/// Stale version service locks are cleaned by a post-version-GC pass.
pub(super) async fn gc_orphaned_locks(home: &HomePaths, dry_run: bool) -> RunnerResult<GcReport> {
    let locks_dir = home.locks_dir();
    let Some(mut entries) = read_dir_or_missing(&locks_dir).await? else {
        return Ok(GcReport::default());
    };

    let mut removed = 0u64;

    while let Some(entry) =
        next_entry_warn_or_stop(&mut entries, "gc_orphaned_locks", &locks_dir).await
    {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(".lock") {
            continue;
        }
        // Version GC later in this same command uses service locks to avoid
        // deleting a version that another process is installing or uninstalling.
        // Workspace GC owns base-dir lock lifecycle because those locks carry
        // the base_dir metadata needed to rediscover dead-runner workspaces.
        if RunnerServiceUnit::from_lock_file_name(name).is_some()
            || entry.path() == home.systemd_daemon_reload_lock()
            || entry.path() == home.gc_lock()
            || is_base_dir_lock_name(name)
        {
            continue;
        }

        let lock_path = entry.path();
        match probe_lock(&lock_path) {
            LockProbe::Free(lock) => {
                if remove_unused_lock_after_probe(&lock_path, lock, name, dry_run).await {
                    removed += 1;
                }
            }
            LockProbe::Held | LockProbe::Error(_) => {}
        }
    }

    Ok(GcReport::cleanup(removed, 0))
}

#[cfg(test)]
mod tests;
