//! Runner-ID WSS endpoint. The host owns directory provisioning; the Runner
//! neither creates it nor unlinks a pre-existing socket on startup.

use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;

use crate::host_file::{DirMode, validate_dir};

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
        validate_dir(dir, DirMode::TrustedParent, "runner WSS socket directory")?;
        let directory = std::fs::symlink_metadata(dir)?;
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
        let path = dir.join(format!("{runner_id}.sock"));
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
        // #37028 stages root:okou-wss-caddy 0710 (without setgid). Assign
        // the trusted parent group to the bound inode, then grant only the
        // owner/group access to the socket. No other user may connect.
        nix::unistd::fchown(&socket.listener, None, Some(group))?;
        std::fs::set_permissions(&socket.path, std::fs::Permissions::from_mode(0o660))?;
        let current = std::fs::symlink_metadata(&socket.path)?;
        if !current.file_type().is_socket()
            || current.ino() != socket.inode
            || current.dev() != socket.device
            || current.gid() != group.as_raw()
        {
            return Err(io::Error::other("runner WSS socket changed during bind"));
        }
        Ok(socket)
    }

    pub async fn accept(&self) -> io::Result<UnixStream> {
        self.listener.accept().await.map(|(stream, _)| stream)
    }
}

impl Drop for RunnerWssSocket {
    fn drop(&mut self) {
        if let Ok(metadata) = std::fs::symlink_metadata(&self.path)
            && metadata.file_type().is_socket()
            && metadata.ino() == self.inode
            && metadata.dev() == self.device
            && let Err(error) = std::fs::remove_file(&self.path)
        {
            tracing::warn!(%error, "failed to remove owned runner WSS endpoint");
        }
    }
}

#[cfg(test)]
mod tests {
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
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).unwrap();
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

    #[tokio::test]
    async fn rejects_symlinks_and_does_not_remove_replacement_endpoint() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(RunnerWssSocket::bind(&link, Uuid::new_v4()).is_err());
        let id = Uuid::new_v4();
        let first = RunnerWssSocket::bind(&dir, id).unwrap();
        std::fs::remove_file(&first.path).unwrap();
        let replacement = UnixListener::bind(&first.path).unwrap();
        drop(first);
        assert!(dir.join(format!("{id}.sock")).exists());
        drop(replacement);
    }

    #[tokio::test]
    async fn unsafe_existing_endpoint_is_never_unlinked() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
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
