use std::path::Path;
use std::time::{Duration, SystemTime};

use nix::sys::resource::{Resource, getrlimit, rlim_t, setrlimit};

use crate::paths::HomePaths;

mod removal;

pub use removal::cancel_queued_removal;

/// Immutable counts for testing a caller's workspace report projection.
pub fn workspace_gc_report(
    workspaces_cleaned: u32,
    bytes_freed: u64,
    base_dir_locks_removed: u64,
) -> super::workspaces::WorkspaceGcReport {
    super::workspaces::report_for_test(workspaces_cleaned, bytes_freed, base_dir_locks_removed)
}

/// Inject a single directory iteration error after the selected number of entries.
pub fn dir_entry_reader_failing_after(successful_entries: usize) -> super::GcDirEntryReader {
    super::filesystem::GcDirEntryReader::failing_after(successful_entries)
}

pub fn test_home(root: &Path) -> HomePaths {
    HomePaths::with_root(root.to_path_buf())
}

pub fn old_gc_time() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)
}

pub fn set_mtime(path: &Path, mtime: SystemTime) -> crate::HostResult<()> {
    std::fs::File::open(path)?.set_times(std::fs::FileTimes::new().set_modified(mtime))?;
    Ok(())
}

pub struct SoftNofileLimitGuard {
    original: (rlim_t, rlim_t),
}

impl Drop for SoftNofileLimitGuard {
    fn drop(&mut self) {
        let result = setrlimit(Resource::RLIMIT_NOFILE, self.original.0, self.original.1);
        if let Err(error) = result {
            let message = format!(
                "restore RLIMIT_NOFILE failed: {}",
                std::io::Error::from(error)
            );
            if std::thread::panicking() {
                eprintln!("{message}");
            } else {
                assert!(result.is_ok(), "{message}");
            }
        }
    }
}

pub fn set_soft_nofile_limit_for_child(limit: u64) -> SoftNofileLimitGuard {
    let mut current = (0, 0);
    let result = getrlimit(Resource::RLIMIT_NOFILE).inspect(|limits| current = *limits);
    if let Err(error) = result {
        assert!(
            result.is_ok(),
            "getrlimit(RLIMIT_NOFILE) failed: {}",
            std::io::Error::from(error)
        );
    }
    let target = std::cmp::min(limit as nix::libc::rlim_t, current.1);
    assert!(
        target >= 64,
        "RLIMIT_NOFILE hard limit {target} is too low for this regression test"
    );

    let result = setrlimit(Resource::RLIMIT_NOFILE, target, current.1);
    if let Err(error) = result {
        assert!(
            result.is_ok(),
            "setrlimit(RLIMIT_NOFILE) failed: {}",
            std::io::Error::from(error)
        );
    }
    SoftNofileLimitGuard { original: current }
}

#[cfg(unix)]
pub fn assert_is_symlink(path: &Path, message: &str) {
    let metadata = std::fs::symlink_metadata(path);
    assert!(
        metadata
            .as_ref()
            .is_ok_and(|meta| meta.file_type().is_symlink()),
        "{message}: {metadata:?}"
    );
}
