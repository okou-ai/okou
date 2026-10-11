//! The directory inode is a stable lock: it is never retired with per-ID state.

use std::fs::File;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use nix::fcntl::{Flock, FlockArg};
use nix::unistd::{Gid, Group};

use crate::host_file::{DirMode, open_dir};
use crate::paths::HomePaths;

pub(super) fn open(directory: &Path) -> io::Result<(File, Gid)> {
    let parent = open_dir(
        directory,
        DirMode::TrustedParent,
        "runner WSS socket directory",
    )?;
    let metadata = parent.metadata()?;
    reject_acl(&parent, true)?;
    if metadata.mode() & 0o7777 != 0o710 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runner WSS socket directory must have mode 0710",
        ));
    }
    let group = Gid::from_raw(metadata.gid());
    if directory == HomePaths::new().map_err(io::Error::other)?.wss_dir() {
        let expected = Group::from_name("okou-wss-caddy")?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "WSS Caddy group missing"))?;
        if metadata.uid() != 0 || expected.gid != group || group.as_raw() == 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "WSS socket directory owner/group mismatch",
            ));
        }
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
    Ok((parent, group))
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::runner_wss_socket::RunnerWssSocket;

    #[tokio::test]
    async fn named_user_acl_is_rejected_even_when_mode_remains_0710() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("wss");
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o710)).unwrap();
        let descriptor = File::open(&directory).unwrap();
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, permissions, qualifier) in [
            (1u16, 7u16, u32::MAX),
            (2, 1, nix::unistd::geteuid().as_raw() + 1),
            (4, 1, u32::MAX),
            (16, 1, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            acl.extend(tag.to_le_bytes());
            acl.extend(permissions.to_le_bytes());
            acl.extend(qualifier.to_le_bytes());
        }
        // The descriptor and static name are valid; the buffer is a Linux
        // POSIX ACL encoding and remains alive for this synchronous syscall.
        let result = unsafe {
            libc::fsetxattr(
                descriptor.as_raw_fd(),
                c"system.posix_acl_access".as_ptr(),
                acl.as_ptr().cast(),
                acl.len(),
                0,
            )
        };
        assert_eq!(result, 0, "{}", io::Error::last_os_error());
        assert_eq!(descriptor.metadata().unwrap().mode() & 0o7777, 0o710);
        assert!(RunnerWssSocket::bind(&directory, uuid::Uuid::new_v4()).is_err());
        assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
    }
}
