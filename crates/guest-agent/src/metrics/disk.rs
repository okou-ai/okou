//! Descriptor-pinned, independent rootfs/home observations. Missing is not zero.
use serde::Serialize;
use std::ffi::CStr;
use std::fs::{File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub(super) struct FilesystemObservation {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_inodes: u64,
    pub total_inodes: u64,
    pub available_inodes: u64,
}

pub(super) fn observe() -> (Option<FilesystemObservation>, Option<FilesystemObservation>) {
    observe_at(Path::new("/"))
}

fn observe_at(root: &Path) -> (Option<FilesystemObservation>, Option<FilesystemObservation>) {
    let Ok(root) = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
    else {
        return (None, None);
    };
    let rootfs = sample(&root);
    let home = (|| {
        let parent = open_child(&root, c"home")?;
        let home = open_child(&parent, c"user")?;
        let device = home.metadata().ok()?.dev();
        // Do not report a missing home mount as the enclosing filesystem.
        if device == parent.metadata().ok()?.dev() || device == root.metadata().ok()?.dev() {
            return None;
        }
        sample(&home)
    })();
    (rootfs, home)
}

fn open_child(parent: &File, name: &CStr) -> Option<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    (fd >= 0).then(|| unsafe { File::from_raw_fd(fd) })
}

fn sample(directory: &File) -> Option<FilesystemObservation> {
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::fstatvfs(directory.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return None;
    }
    from_stat(&unsafe { stat.assume_init() })
}

fn from_stat(stat: &libc::statvfs) -> Option<FilesystemObservation> {
    if stat.f_frsize == 0
        || stat.f_bfree > stat.f_blocks
        || stat.f_bavail > stat.f_bfree
        || stat.f_ffree > stat.f_files
        || stat.f_favail > stat.f_ffree
    {
        return None;
    }
    Some(FilesystemObservation {
        total_bytes: stat.f_blocks.checked_mul(stat.f_frsize)?,
        used_bytes: (stat.f_blocks - stat.f_bfree).checked_mul(stat.f_frsize)?,
        available_bytes: stat.f_bavail.checked_mul(stat.f_frsize)?,
        total_inodes: stat.f_files,
        used_inodes: stat.f_files - stat.f_ffree,
        available_inodes: stat.f_favail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn counters() -> libc::statvfs {
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        stat.f_frsize = 1024;
        stat.f_blocks = 100;
        stat.f_bfree = 40;
        stat.f_bavail = 30;
        stat.f_files = 80;
        stat.f_ffree = 20;
        stat.f_favail = 10;
        stat
    }

    #[test]
    fn independent_available_and_used_counters() {
        let observed = from_stat(&counters()).unwrap();
        assert_eq!(
            observed,
            FilesystemObservation {
                total_bytes: 102400,
                used_bytes: 61440,
                available_bytes: 30720,
                total_inodes: 80,
                used_inodes: 60,
                available_inodes: 10
            }
        );
        assert_eq!(
            serde_json::to_value(observed).unwrap()["available_inodes"],
            10
        );
    }

    #[test]
    fn impossible_and_overflow_counters_are_unavailable() {
        let mut stat = counters();
        stat.f_bfree = 101;
        assert!(from_stat(&stat).is_none());
        let mut stat = counters();
        stat.f_bavail = 41;
        assert!(from_stat(&stat).is_none());
        let mut stat = counters();
        stat.f_ffree = 81;
        assert!(from_stat(&stat).is_none());
        let mut stat = counters();
        stat.f_favail = 21;
        assert!(from_stat(&stat).is_none());
        let mut stat = counters();
        stat.f_blocks = u64::MAX;
        assert!(from_stat(&stat).is_none());
        let mut stat = counters();
        stat.f_bfree = u64::MAX;
        assert!(from_stat(&stat).is_none());
        let mut stat = counters();
        stat.f_frsize = 0;
        assert!(from_stat(&stat).is_none());
    }

    #[test]
    fn measured_zero_is_a_real_observation() {
        let mut stat = counters();
        stat.f_bfree = stat.f_blocks;
        stat.f_ffree = stat.f_files;
        let observed = from_stat(&stat).unwrap();
        assert_eq!(observed.used_bytes, 0);
        assert_eq!(observed.used_inodes, 0);
    }

    #[test]
    fn missing_unmounted_and_symlink_home_are_not_rootfs() {
        let dir = tempfile::tempdir().unwrap();
        assert!(observe_at(dir.path()).0.is_some());
        assert!(observe_at(dir.path()).1.is_none());
        std::fs::create_dir_all(dir.path().join("home/user")).unwrap();
        assert!(observe_at(dir.path()).1.is_none());
        std::fs::remove_dir(dir.path().join("home/user")).unwrap();
        symlink("/", dir.path().join("home/user")).unwrap();
        assert!(observe_at(dir.path()).1.is_none());
        std::fs::remove_file(dir.path().join("home/user")).unwrap();
        std::fs::remove_dir(dir.path().join("home")).unwrap();
        symlink("/", dir.path().join("home")).unwrap();
        assert!(observe_at(dir.path()).1.is_none());
    }

    #[test]
    fn descriptor_sample_survives_directory_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample");
        std::fs::create_dir(&path).unwrap();
        let file = File::open(&path).unwrap();
        std::fs::rename(&path, dir.path().join("retained")).unwrap();
        symlink("/", &path).unwrap();
        assert!(sample(&file).is_some());
    }
}
