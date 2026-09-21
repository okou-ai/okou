use crate::cmd::service::RunnerServiceUnit;
use crate::error::RunnerResult;
use crate::paths::HomePaths;

use super::filesystem::{next_entry_warn_or_stop, read_dir_or_missing};
use super::lock_file::{LockProbe, probe_lock, remove_unused_lock_after_probe};
use super::report::GcReport;
use super::workspaces::is_base_dir_lock_name;

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
                if remove_unused_lock_after_probe(&lock_path, &lock, name, dry_run).await {
                    removed += 1;
                }
            }
            LockProbe::Held | LockProbe::Error(_) => {}
        }
    }

    Ok(GcReport::cleanup(removed, 0))
}

runner_test_group!(cmd_gc_build; #[cfg(test)]
mod tests {
    use nix::fcntl::{Flock, FlockArg};

    use super::*;
    use crate::cmd::gc::test_support::test_home;
    use crate::lock;

    #[tokio::test]
    async fn gc_orphaned_locks_preserves_only_current_service_locks() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();
        let version_service_lock = RunnerServiceUnit::from_suffix("v1.0.0")
            .unwrap()
            .lock_path(&home);
        let staging_service_lock = RunnerServiceUnit::from_suffix("staging")
            .unwrap()
            .lock_path(&home);
        let historical_service_lock = locks_dir.join("service-vm0-runner-OLD_NAME.lock");
        let stale_lock = locks_dir.join("workspace-image-cache-test.lock");
        std::fs::write(&version_service_lock, "").unwrap();
        std::fs::write(&staging_service_lock, "").unwrap();
        std::fs::write(&historical_service_lock, "").unwrap();
        std::fs::write(&stale_lock, "").unwrap();

        let report = gc_orphaned_locks(&home, false).await.unwrap();

        assert_eq!(report.activity_count, 2);
        assert_eq!(report.freed_bytes, 0);
        assert!(
            version_service_lock.exists(),
            "canonical version service locks must survive orphaned lock cleanup"
        );
        assert!(
            staging_service_lock.exists(),
            "canonical non-semver service locks must survive orphaned lock cleanup"
        );
        assert!(
            !historical_service_lock.exists(),
            "free historical service lock names should be cleaned as ordinary locks"
        );
        assert!(
            !stale_lock.exists(),
            "ordinary free locks should still be cleaned"
        );
    }

    #[tokio::test]
    async fn gc_orphaned_locks_preserves_held_historical_service_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let historical_service_lock = home.locks_dir().join("service-vm0-runner-OLD_NAME.lock");
        let lock_file = lock::open_lock_file(&historical_service_lock).unwrap();
        let _held_lock = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

        let report = gc_orphaned_locks(&home, false).await.unwrap();

        assert_eq!(report.activity_count, 0);
        assert_eq!(report.freed_bytes, 0);
        assert!(
            historical_service_lock.exists(),
            "held historical service locks must survive orphaned lock cleanup"
        );
    }

    #[tokio::test]
    async fn gc_orphaned_locks_preserves_host_global_locks() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();
        let reload_lock = home.systemd_daemon_reload_lock();
        let gc_lock = home.gc_lock();
        let stale_lock = locks_dir.join("workspace-image-cache-test.lock");
        std::fs::write(&reload_lock, "").unwrap();
        std::fs::write(&gc_lock, "").unwrap();
        std::fs::write(&stale_lock, "").unwrap();

        let report = gc_orphaned_locks(&home, false).await.unwrap();

        assert_eq!(report.activity_count, 1);
        assert_eq!(report.freed_bytes, 0);
        assert!(
            reload_lock.exists(),
            "the shared systemd reload lock must keep a stable inode"
        );
        assert!(
            gc_lock.exists(),
            "the global GC lock must keep a stable inode"
        );
        assert!(
            !stale_lock.exists(),
            "ordinary free locks should still be cleaned"
        );
    }

    #[tokio::test]
    async fn gc_orphaned_locks_preserves_base_dir_locks() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();
        let base_dir_lock = locks_dir.join("base-dir-dead.lock");
        let stale_lock = locks_dir.join("workspace-image-cache-test.lock");
        std::fs::write(&base_dir_lock, "/data/dead-runner").unwrap();
        std::fs::write(&stale_lock, "").unwrap();

        let report = gc_orphaned_locks(&home, false).await.unwrap();

        assert_eq!(report.activity_count, 1);
        assert_eq!(report.freed_bytes, 0);
        assert!(
            base_dir_lock.exists(),
            "base-dir locks must remain available for workspace GC retry"
        );
        assert!(
            !stale_lock.exists(),
            "ordinary free locks should still be cleaned"
        );
    }
});
