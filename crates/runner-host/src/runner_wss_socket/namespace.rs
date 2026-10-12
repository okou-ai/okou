//! A parent-inode lock serializes namespace initialization and validation.
//! The namespace inode itself then fences per-ID lock creation and retirement.

use std::fs::File;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use nix::fcntl::{AtFlags, Flock, FlockArg, OFlag, openat};
use nix::sys::stat::{Mode, fstat, fstatat, mkdirat};
use nix::unistd::{Gid, Group, geteuid};

use crate::host_file::{DirMode, open_dir};
use crate::paths::HomePaths;

/// GC only opens an existing namespace; absence must never create host state.
pub(super) fn open(directory: &Path) -> io::Result<(File, Gid)> {
    open_namespace(directory, false, official_group(directory)?)
}

/// Binding creates a missing WSS child, preserving existing valid state.
pub(super) fn ensure(directory: &Path) -> io::Result<(File, Gid)> {
    open_namespace(directory, true, official_group(directory)?)
}

fn official_group(directory: &Path) -> io::Result<Option<Gid>> {
    if is_official(directory)? {
        dedicated_group().map(Some)
    } else {
        Ok(None)
    }
}

fn is_official(directory: &Path) -> io::Result<bool> {
    Ok(directory == HomePaths::new().map_err(io::Error::other)?.wss_dir())
}

fn dedicated_group() -> io::Result<Gid> {
    let group = Group::from_name("okou-runner-caddy")?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "WSS Caddy group missing"))?;
    if group.gid.as_raw() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "WSS Caddy group must be distinct from root",
        ));
    }
    Ok(group.gid)
}

fn open_namespace(
    directory: &Path,
    create_missing: bool,
    expected_group: Option<Gid>,
) -> io::Result<(File, Gid)> {
    let parent_path = directory.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "WSS namespace parent missing")
    })?;
    let name = directory
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "WSS namespace name missing"))?;
    let parent = open_dir(
        parent_path,
        DirMode::TrustedParent,
        "runner WSS namespace parent",
    )?;
    reject_acl(&parent, false)?;
    let official = is_official(directory)?;
    if official {
        for ancestor in directory.ancestors().skip(1) {
            let descriptor = open_dir(ancestor, DirMode::TrustedParent, "WSS trusted ancestor")?;
            let metadata = descriptor.metadata()?;
            if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 || metadata.mode() & 1 == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "WSS ancestors must be root-owned, traversable and not writable",
                ));
            }
            reject_acl(&descriptor, false)?;
        }
    }
    // Both creators and readers wait until first initialization has completed.
    // This guard is released before acquiring namespace/per-ID lifetime locks.
    let guard = NamespaceLock::acquire(&parent)?;
    let namespace = match open_child(guard.parent(), name) {
        Ok(file) => file,
        Err(error) if create_missing && error.kind() == io::ErrorKind::NotFound => {
            // Resolve the host-provisioned group before the first mutation.
            let group = match expected_group {
                Some(group) => group,
                None => dedicated_group()?,
            };
            match mkdirat(guard.parent(), name, Mode::from_bits_truncate(0o700)) {
                Ok(()) => {
                    let file = initialize_created(guard.parent(), name, group)?;
                    file.sync_all()?;
                    guard.parent().sync_all()?;
                    file
                }
                Err(nix::errno::Errno::EEXIST) => open_child(guard.parent(), name)?,
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error),
    };
    let metadata = namespace.metadata()?;
    reject_acl(&namespace, true)?;
    if metadata.mode() & 0o7777 != 0o710
        || (metadata.uid() != 0 && metadata.uid() != geteuid().as_raw())
        || (official && metadata.uid() != 0)
        || expected_group.is_some_and(|group| metadata.gid() != group.as_raw())
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "WSS namespace ownership/group/mode mismatch",
        ));
    }
    let pinned = fstat(&namespace)?;
    let pathname = fstatat(guard.parent(), name, AtFlags::AT_SYMLINK_NOFOLLOW)?;
    if (pinned.st_dev, pinned.st_ino) != (pathname.st_dev, pathname.st_ino) {
        return Err(io::Error::other(
            "WSS namespace changed during initialization",
        ));
    }
    Ok((namespace, Gid::from_raw(metadata.gid())))
}

fn open_child(parent: &File, name: &std::ffi::OsStr) -> io::Result<File> {
    openat(
        parent,
        name,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(io::Error::from)
}

/// Only the directory created by this call receives ownership/mode changes.
fn initialize_created(parent: &File, name: &std::ffi::OsStr, group: Gid) -> io::Result<File> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::PermissionsExt;
        use std::path::PathBuf;

        // O_PATH also pins a mode-0000 directory created under umask 0777.
        let inode = File::from(openat(
            parent,
            name,
            OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )?);
        nix::unistd::fchownat(&inode, "", None, Some(group), AtFlags::AT_EMPTY_PATH)?;
        // fchmod cannot use O_PATH; this kernel FD link refers to our pinned
        // inode and works on hosts predating fchmodat2 (Linux 6.5).
        let path = PathBuf::from(format!("/proc/self/fd/{}", inode.as_raw_fd()));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o710))?;
        open_child(&inode, std::ffi::OsStr::new("."))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let file = open_child(parent, name)?;
        nix::unistd::fchown(&file, None, Some(group))?;
        nix::sys::stat::fchmod(&file, Mode::from_bits_truncate(0o710))?;
        Ok(file)
    }
}

fn reject_acl(file: &File, access: bool) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        for name in [c"system.posix_acl_default", c"system.posix_acl_access"] {
            if !access && name == c"system.posix_acl_access" {
                continue;
            }
            // The names are static C strings; the kernel only reports size.
            let size = unsafe {
                libc::fgetxattr(file.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0)
            };
            if size >= 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "WSS ACLs are not allowed",
                ));
            }
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::ENODATA | libc::ENOTSUP)) {
                return Err(error);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (file, access);
    Ok(())
}

pub(super) struct NamespaceLock(Flock<File>);

impl NamespaceLock {
    pub(super) fn acquire(parent: &File) -> io::Result<Self> {
        Flock::lock(parent.try_clone()?, FlockArg::LockExclusive)
            .map(Self)
            .map_err(|(_, error)| io::Error::from_raw_os_error(error as i32))
    }

    pub(super) fn parent(&self) -> &File {
        &self.0
    }
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests;
