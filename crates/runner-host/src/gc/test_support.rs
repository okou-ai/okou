use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::paths::HomePaths;

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
    original: nix::libc::rlimit,
}

impl Drop for SoftNofileLimitGuard {
    fn drop(&mut self) {
        unsafe {
            let rc = nix::libc::setrlimit(nix::libc::RLIMIT_NOFILE, &self.original);
            if rc != 0 {
                let message = format!(
                    "restore RLIMIT_NOFILE failed: {}",
                    std::io::Error::last_os_error()
                );
                if std::thread::panicking() {
                    eprintln!("{message}");
                } else {
                    assert!(rc == 0, "{message}");
                }
            }
        }
    }
}

pub fn set_soft_nofile_limit_for_child(limit: u64) -> SoftNofileLimitGuard {
    unsafe {
        let mut current = std::mem::MaybeUninit::<nix::libc::rlimit>::uninit();
        let rc = nix::libc::getrlimit(nix::libc::RLIMIT_NOFILE, current.as_mut_ptr());
        assert_eq!(
            rc,
            0,
            "getrlimit(RLIMIT_NOFILE) failed: {}",
            std::io::Error::last_os_error()
        );
        let current = current.assume_init();
        let target = std::cmp::min(limit as nix::libc::rlim_t, current.rlim_max);
        assert!(
            target >= 64,
            "RLIMIT_NOFILE hard limit {target} is too low for this regression test"
        );

        let next = nix::libc::rlimit {
            rlim_cur: target,
            rlim_max: current.rlim_max,
        };
        let rc = nix::libc::setrlimit(nix::libc::RLIMIT_NOFILE, &next);
        assert_eq!(
            rc,
            0,
            "setrlimit(RLIMIT_NOFILE) failed: {}",
            std::io::Error::last_os_error()
        );
        SoftNofileLimitGuard { original: current }
    }
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
