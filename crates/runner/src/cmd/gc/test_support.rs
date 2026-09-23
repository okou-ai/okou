use std::path::Path;
use std::time::{Duration, SystemTime};

use runner_host::paths::HomePaths;

pub(super) fn test_home(root: &Path) -> HomePaths {
    HomePaths::with_root(root.to_path_buf())
}

pub(super) fn old_gc_time() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)
}

pub(super) fn set_mtime(path: &Path, mtime: SystemTime) {
    std::fs::File::open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime))
        .unwrap();
}

pub(super) struct SoftNofileLimitGuard {
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
                    panic!("{message}");
                }
            }
        }
    }
}

pub(super) fn set_soft_nofile_limit_for_child(limit: u64) -> SoftNofileLimitGuard {
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
pub(super) fn assert_is_symlink(path: &Path, message: &str) {
    assert!(
        std::fs::symlink_metadata(path)
            .unwrap()
            .file_type()
            .is_symlink(),
        "{message}"
    );
}
