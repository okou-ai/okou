//! Cooperative NBD device index locks.
//!
//! These locks coordinate `/dev/nbdN` ownership across runner processes that
//! resolve their lock files through the same host-visible lock directory.
//! Dropping the returned claim closes the lock file descriptor and releases the
//! corresponding kernel `flock`.
//!
//! Claims are represented by per-index lock files named
//! `vm0-nbd-{index}.lock`. When this API creates a missing lock file, it uses
//! private mode bits. The default directory is [`default_lock_dir`],
//! currently `/var/lock`; callers using [`try_acquire_device_claim_in`] may
//! provide another operator-approved lock-file directory. The directory must
//! already exist, but this API does not require the directory itself to be owned
//! by the current effective uid or private to the process.
//! Cooperating processes must use the same resolved lock directory for their
//! claims to coordinate with each other.
//!
//! The security-sensitive object is the final per-index lock file. Existing
//! lock files must be regular files openable for read and write by the current
//! process, must be owned by the current effective uid, must not have multiple
//! hard links, and must not have group/other-writable mode bits. Unsafe or
//! invalid final lock-file paths are reported as I/O errors instead of ordinary
//! lock contention.
//!
//! The per-index lock file path must remain stable while claims may be held:
//! kernel `flock` locks the opened inode, so deleting or replacing the path can
//! create a separate lock domain for later callers.
//!
//! A claim only represents cooperative ownership of the lock file. It does not
//! validate that `/dev/nbdN` exists or is currently free; callers that need a
//! usable device must check device state while holding the claim.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

const LOCK_FILE_PREFIX: &str = "vm0-nbd";
const MAX_STALE_INODE_RETRIES: usize = 16;
const PRIVATE_FILE_MODE: u32 = 0o600;
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;

/// Owned cooperative claim for one NBD device index.
///
/// Dropping this value releases the corresponding per-index `flock`.
#[derive(Debug)]
pub struct NbdDeviceClaim {
    index: u32,
    _lock: Flock<File>,
}

impl NbdDeviceClaim {
    /// NBD device index (N in `/dev/nbdN`).
    pub fn index(&self) -> u32 {
        self.index
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(index: u32, lock_dir: &Path) -> Self {
        try_acquire_device_claim_in(index, lock_dir)
            .expect("test lock acquisition should not fail")
            .expect("test lock should be free")
    }
}

/// Default NBD lock directory.
pub fn default_lock_dir() -> PathBuf {
    PathBuf::from("/var/lock")
}

/// Lock file path for a device index under the default lock directory.
pub fn device_lock_path(index: u32) -> PathBuf {
    device_lock_path_in(index, &default_lock_dir())
}

fn device_lock_path_in(index: u32, lock_dir: &Path) -> PathBuf {
    lock_dir.join(format!("{LOCK_FILE_PREFIX}-{index}.lock"))
}

/// Try to acquire a cooperative claim for an NBD device index.
///
/// This uses [`default_lock_dir`] for the lock file directory. Returns
/// `Ok(Some(_))` when the caller owns the claim until the returned
/// [`NbdDeviceClaim`] is dropped.
///
/// Returns `Ok(None)` only when the flock is already held on the current
/// per-index lock inode. Unsafe or invalid lock-file state is reported as an
/// [`std::io::Error`] rather than as `Ok(None)`.
pub fn try_acquire_device_claim(index: u32) -> io::Result<Option<NbdDeviceClaim>> {
    try_acquire_device_claim_in(index, &default_lock_dir())
}

/// Try to acquire a cooperative claim in a custom lock directory.
///
/// `lock_dir` must already exist. The per-index lock path is
/// `lock_dir/vm0-nbd-{index}.lock`. Missing per-index lock files are created
/// with private mode bits and then validated before locking.
/// Processes using different lock directories do not coordinate with each
/// other. Relative lock directories are resolved by each caller's current
/// working directory, so cooperating processes should use paths that resolve to
/// the same directory inode.
///
/// Existing final lock files must be regular files openable for read and write
/// by the current process, must be owned by the current effective uid, must not
/// have multiple hard links, and must not have group/other-writable mode bits.
/// Unsafe final lock-file paths, including a symlink at the per-index lock path
/// and non-regular files, are reported as [`std::io::Error`]. Existing lock
/// files with otherwise acceptable legacy mode bits may be tightened to `0600`.
///
/// Returns `Ok(Some(_))` when the caller owns the claim until the returned
/// [`NbdDeviceClaim`] is dropped. Returns `Ok(None)` only when the flock is
/// already held on the current per-index lock inode; unsafe lock-file state and
/// repeated path replacement during acquisition are reported as I/O errors.
pub fn try_acquire_device_claim_in(
    index: u32,
    lock_dir: &Path,
) -> io::Result<Option<NbdDeviceClaim>> {
    try_acquire_device_claim_in_with(index, lock_dir, |_| {})
}

fn try_acquire_device_claim_in_with(
    index: u32,
    lock_dir: &Path,
    mut before_current_inode_check: impl FnMut(&Path),
) -> io::Result<Option<NbdDeviceClaim>> {
    let path = device_lock_path_in(index, lock_dir);
    for _ in 0..MAX_STALE_INODE_RETRIES {
        let file = open_lock_file(&path)?;
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => {
                before_current_inode_check(&path);
                if lock_inode_is_current(&lock, &path)? {
                    return Ok(Some(NbdDeviceClaim { index, _lock: lock }));
                }
            }
            Err((file, errno)) if errno == nix::errno::Errno::EWOULDBLOCK => {
                before_current_inode_check(&path);
                if file_inode_is_current(&file, &path)? {
                    return Ok(None);
                }
            }
            Err((_file, errno)) => return Err(io::Error::from_raw_os_error(errno as i32)),
        }
    }

    Err(io::Error::other(format!(
        "lock path {} changed during NBD claim",
        path.display()
    )))
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    open_existing_lock_file(path).or_else(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            create_lock_file(path)
        } else {
            Err(e)
        }
    })
}

fn base_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    options
}

fn open_existing_lock_file(path: &Path) -> io::Result<File> {
    let file = base_open_options().open(path)?;
    validate_lock_file(&file, path)?;
    Ok(file)
}

fn create_lock_file(path: &Path) -> io::Result<File> {
    let mut options = base_open_options();
    let file = options
        .create(true)
        .truncate(false)
        .mode(PRIVATE_FILE_MODE)
        .open(path)?;
    validate_lock_file(&file, path)?;
    Ok(file)
}

fn validate_lock_file(file: &File, path: &Path) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(permission_denied(format!(
            "{} is not a regular lock file",
            path.display()
        )));
    }

    // SAFETY: `geteuid` has no preconditions and does not mutate Rust-owned memory.
    let expected_uid = unsafe { libc::geteuid() };
    if metadata.uid() != expected_uid {
        return Err(permission_denied(format!(
            "{} is owned by uid {}, but current euid is {expected_uid}",
            path.display(),
            metadata.uid()
        )));
    }

    if metadata.nlink() > 1 {
        return Err(permission_denied(format!(
            "{} has multiple hard links",
            path.display()
        )));
    }

    let mode = metadata.mode() & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Err(permission_denied(format!(
            "{} is group/other writable",
            path.display()
        )));
    }
    if mode != PRIVATE_FILE_MODE {
        chmod_lock_file(file, path)?;
    }
    Ok(())
}

fn chmod_lock_file(file: &File, path: &Path) -> io::Result<()> {
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result = unsafe { libc::fchmod(file.as_raw_fd(), PRIVATE_FILE_MODE as libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "chmod lock file {}: {}",
            path.display(),
            io::Error::last_os_error()
        )))
    }
}

fn permission_denied(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn metadata_inode_is_current(lock_meta: std::fs::Metadata, path: &Path) -> io::Result<bool> {
    let path_meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    Ok(lock_meta.dev() == path_meta.dev() && lock_meta.ino() == path_meta.ino())
}

fn lock_inode_is_current(lock: &Flock<File>, path: &Path) -> io::Result<bool> {
    metadata_inode_is_current(lock.metadata()?, path)
}

fn file_inode_is_current(file: &File, path: &Path) -> io::Result<bool> {
    metadata_inode_is_current(file.metadata()?, path)
}

#[cfg(test)]
mod tests;
