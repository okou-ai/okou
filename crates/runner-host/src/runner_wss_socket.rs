//! Runner-ID WSS endpoint. The host owns directory provisioning; the Runner
//! neither creates it nor unlinks a pre-existing socket on startup.

use std::fs::{File, Metadata};
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;

use crate::host_file::{DirMode, open_dir};

pub const HOST_SOCKET_DIR: &str = "/run/okou-ws";

pub struct RunnerWssSocket {
    listener: UnixListener,
    path: PathBuf,
    inode: u64,
    device: u64,
}

impl RunnerWssSocket {
    /// `dir` must already exist with a trusted owner and no writable parent.
    /// The caller holds the exclusive runner base-dir lock while binding.
    pub fn bind(dir: &Path, runner_id: Uuid) -> io::Result<Self> {
        let parent = open_dir(dir, DirMode::TrustedParent, "runner WSS socket directory")?;
        let directory = parent.metadata()?;
        // Caddy may traverse this directory but must not list the socket names;
        // other users must have no access. Do not silently accept a looser
        // host configuration just because it is not group/other writable.
        if directory.mode() & 0o7777 != 0o710 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "runner WSS socket directory must have mode 0710",
            ));
        }
        let group = nix::unistd::Gid::from_raw(directory.gid());
        if dir == Path::new(HOST_SOCKET_DIR) {
            let expected = nix::unistd::Group::from_name("okou-wss-caddy")?.ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "WSS Caddy group missing")
            })?;
            if directory.uid() != 0 || expected.gid != group {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "WSS socket directory owner/group mismatch",
                ));
            }
        }
        let name = format!("{runner_id}.sock");
        let path = dir.join(&name);
        // Never remove a pre-existing endpoint: it may belong to a live Runner
        // (including a previous generation with the same ID).
        let listener = UnixListener::bind(&path)?;
        let metadata = std::fs::symlink_metadata(&path)?;
        let socket = Self {
            listener,
            path,
            inode: metadata.ino(),
            device: metadata.dev(),
        };
        // #38073 provisions root:okou-wss-caddy 0710 without setgid.
        // Linux's listener FD refers to a different inode from the pathname
        // socket. Set permissions on the filesystem inode, not that FD.
        socket.set_pathname_permissions(&parent, &name, group)?;
        let current = std::fs::symlink_metadata(&socket.path)?;
        if !socket.matches_pathname_inode(&current)
            || current.uid() != nix::unistd::geteuid().as_raw()
            || current.gid() != group.as_raw()
            || current.mode() & 0o7777 != 0o660
        {
            return Err(io::Error::other("runner WSS socket changed during bind"));
        }
        Ok(socket)
    }

    fn matches_pathname_inode(&self, metadata: &Metadata) -> bool {
        metadata.file_type().is_socket()
            && metadata.ino() == self.inode
            && metadata.dev() == self.device
    }

    fn set_pathname_permissions(
        &self,
        parent: &File,
        name: &str,
        group: nix::unistd::Gid,
    ) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::PermissionsExt;

            use nix::fcntl::{AtFlags, OFlag, openat};
            use nix::sys::stat::Mode;

            // O_PATH pins the pathname inode; O_NOFOLLOW lets us reject a
            // replacement symlink before either ownership or mode changes.
            let inode = File::from(openat(
                parent,
                name,
                OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )?);
            if !self.matches_pathname_inode(&inode.metadata()?) {
                return Err(io::Error::other("runner WSS socket changed during bind"));
            }
            nix::unistd::fchownat(&inode, "", None, Some(group), AtFlags::AT_EMPTY_PATH)?;
            // fchmod cannot operate on O_PATH descriptors. The kernel-owned
            // procfs link resolves this pinned inode, even after a rename;
            // this also works on hosts predating fchmodat2 (Linux 6.5).
            let fd_path = PathBuf::from(format!("/proc/self/fd/{}", inode.as_raw_fd()));
            std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(0o660))?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            use nix::fcntl::AtFlags;
            use nix::sys::stat::{FchmodatFlags, Mode, fchmodat};

            if !self.matches_pathname_inode(&std::fs::symlink_metadata(&self.path)?) {
                return Err(io::Error::other("runner WSS socket changed during bind"));
            }
            nix::unistd::fchownat(
                parent,
                name,
                None,
                Some(group),
                AtFlags::AT_SYMLINK_NOFOLLOW,
            )?;
            fchmodat(
                parent,
                name,
                Mode::from_bits_truncate(0o660),
                FchmodatFlags::NoFollowSymlink,
            )?;
        }
        Ok(())
    }

    pub async fn accept(&self) -> io::Result<UnixStream> {
        self.listener.accept().await.map(|(stream, _)| stream)
    }
}

impl Drop for RunnerWssSocket {
    fn drop(&mut self) {
        if let Ok(metadata) = std::fs::symlink_metadata(&self.path)
            && self.matches_pathname_inode(&metadata)
            && let Err(error) = std::fs::remove_file(&self.path)
        {
            tracing::warn!(%error, "failed to remove owned runner WSS endpoint");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[tokio::test]
    async fn rejects_missing_unsafe_and_colliding_endpoints() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        let id = Uuid::new_v4();
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o711)).unwrap();
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let first = RunnerWssSocket::bind(&dir, id).unwrap();
        let socket_metadata = std::fs::symlink_metadata(&first.path).unwrap();
        assert_eq!(socket_metadata.mode() & 0o777, 0o660);
        assert_eq!(
            socket_metadata.gid(),
            std::fs::metadata(&dir).unwrap().gid()
        );
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        let other = RunnerWssSocket::bind(&dir, Uuid::new_v4()).unwrap();
        drop(other);
        let path = first.path.clone();
        drop(first);
        let replacement = RunnerWssSocket::bind(&dir, id).unwrap();
        assert!(path.exists());
        drop(replacement);
        assert!(!path.exists());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn non_setgid_directory_assigns_its_group_to_the_pathname_socket() {
        use nix::unistd::{Gid, chown, getegid, geteuid, getgroups};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let process_group = getegid();
        let directory_group = if geteuid().is_root() {
            Gid::from_raw(if process_group.as_raw() == 0 { 1 } else { 0 })
        } else {
            getgroups()
                .unwrap()
                .into_iter()
                .find(|group| *group != process_group)
                .expect("the different-GID regression requires root or a supplementary group")
        };
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        chown(&dir, None, Some(directory_group)).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let parent_before = std::fs::symlink_metadata(&dir).unwrap();
        assert_ne!(parent_before.gid(), process_group.as_raw());
        assert_eq!(parent_before.mode() & 0o7777, 0o710);

        let id = Uuid::new_v4();
        let socket = RunnerWssSocket::bind(&dir, id).unwrap();
        let path = dir.join(format!("{id}.sock"));
        let bound = std::fs::symlink_metadata(&path).unwrap();
        assert!(bound.file_type().is_socket());
        assert_eq!(bound.uid(), geteuid().as_raw());
        assert_eq!(bound.gid(), directory_group.as_raw());
        assert_eq!(bound.mode() & 0o7777, 0o660);
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        let preserved = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!(preserved.ino(), bound.ino());
        assert_eq!(preserved.dev(), bound.dev());
        assert_eq!(preserved.gid(), bound.gid());
        assert_eq!(preserved.mode(), bound.mode());

        let mut client = UnixStream::connect(&path).await.unwrap();
        let mut accepted = socket.accept().await.unwrap();
        client.write_all(b"wss").await.unwrap();
        let mut received = [0; 3];
        accepted.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"wss");

        let parent_after = std::fs::symlink_metadata(&dir).unwrap();
        assert_eq!(parent_after.uid(), parent_before.uid());
        assert_eq!(parent_after.gid(), parent_before.gid());
        assert_eq!(parent_after.mode(), parent_before.mode());
        assert_eq!(parent_after.ino(), parent_before.ino());
        drop(socket);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn rejects_symlinks_and_does_not_remove_replacement_endpoint() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(RunnerWssSocket::bind(&link, Uuid::new_v4()).is_err());
        let id = Uuid::new_v4();
        let first = RunnerWssSocket::bind(&dir, id).unwrap();
        std::fs::remove_file(&first.path).unwrap();
        let replacement = UnixListener::bind(&first.path).unwrap();
        std::fs::set_permissions(&first.path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let before = std::fs::symlink_metadata(&first.path).unwrap();
        let parent = open_dir(&dir, DirMode::TrustedParent, "test WSS directory").unwrap();
        assert!(
            first
                .set_pathname_permissions(
                    &parent,
                    &format!("{id}.sock"),
                    nix::unistd::Gid::from_raw(before.gid()),
                )
                .is_err()
        );
        let after = std::fs::symlink_metadata(&first.path).unwrap();
        assert_eq!(after.ino(), before.ino());
        assert_eq!(after.uid(), before.uid());
        assert_eq!(after.gid(), before.gid());
        assert_eq!(after.mode(), before.mode());
        drop(first);
        assert!(dir.join(format!("{id}.sock")).exists());
        drop(replacement);
    }

    #[tokio::test]
    async fn replacement_symlink_never_changes_its_target() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let id = Uuid::new_v4();
        let first = RunnerWssSocket::bind(&dir, id).unwrap();
        let target = root.path().join("target");
        std::fs::write(&target, b"untouched").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        let before = std::fs::symlink_metadata(&target).unwrap();
        std::fs::remove_file(&first.path).unwrap();
        std::os::unix::fs::symlink(&target, &first.path).unwrap();
        let parent = open_dir(&dir, DirMode::TrustedParent, "test WSS directory").unwrap();
        assert!(
            first
                .set_pathname_permissions(
                    &parent,
                    &format!("{id}.sock"),
                    nix::unistd::Gid::from_raw(before.gid()),
                )
                .is_err()
        );
        let after = std::fs::symlink_metadata(&target).unwrap();
        assert_eq!(after.ino(), before.ino());
        assert_eq!(after.uid(), before.uid());
        assert_eq!(after.gid(), before.gid());
        assert_eq!(after.mode(), before.mode());
        assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
        drop(first);
        assert!(
            std::fs::symlink_metadata(dir.join(format!("{id}.sock")))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[tokio::test]
    async fn unsafe_existing_endpoint_is_never_unlinked() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let id = Uuid::new_v4();
        let path = dir.join(format!("{id}.sock"));
        std::os::unix::fs::symlink("target", &path).unwrap();
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        assert!(
            std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
