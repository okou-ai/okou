//! Descriptor-pinned, independent rootfs/home observations. Missing is not zero.
use serde::Serialize;
use std::ffi::CStr;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub(crate) struct FilesystemObservation {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_inodes: u64,
    pub total_inodes: u64,
    pub available_inodes: u64,
}

pub(crate) fn observe() -> (Option<FilesystemObservation>, Option<FilesystemObservation>) {
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
    nix::fcntl::openat(
        parent,
        name,
        nix::fcntl::OFlag::from_bits_retain(
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        ),
        nix::sys::stat::Mode::empty(),
    )
    .ok()
    .map(File::from)
}

fn sample(directory: &File) -> Option<FilesystemObservation> {
    from_stat(&rustix::fs::fstatvfs(directory).ok()?)
}

fn from_stat(stat: &rustix::fs::StatVfs) -> Option<FilesystemObservation> {
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
mod tests;
