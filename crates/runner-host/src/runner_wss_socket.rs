//! Runner-ID WSS endpoint. The host owns directory provisioning; the Runner
//! does not create it. A locked durable inode record permits crash recovery
//! only of a proven owned, dead endpoint; unknown or live endpoints are preserved.

use std::fs::{File, Metadata};
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;

use crate::host_file::{DirMode, open_dir};

mod owner;

pub const HOST_SOCKET_DIR: &str = "/run/okou-ws";

pub struct RunnerWssSocket {
    listener: UnixListener,
    path: PathBuf,
    inode: u64,
    device: u64,
    anchor_path: PathBuf,
    owner: owner::Owner,
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
        let owner = owner::Owner::acquire(&parent, dir, runner_id)?;
        owner.recover(&name, group)?;
        // Publish only after durable ownership evidence exists. A crash before
        // this point cannot strand an unrecorded runner-ID endpoint. The global
        // per-ID flock fences owners even when they use different base dirs.
        let temporary_name = format!(".wss-{}", Uuid::new_v4().simple());
        let temporary = dir.join(&temporary_name);
        let listener = UnixListener::bind(&temporary)?;
        let metadata = std::fs::symlink_metadata(&temporary)?;
        let mut socket = Self {
            listener,
            path: temporary.clone(),
            inode: metadata.ino(),
            device: metadata.dev(),
            anchor_path: temporary,
            owner,
        };
        // #38073 provisions root:okou-wss-caddy 0710 without setgid.
        // Linux's listener FD refers to a different inode from the pathname
        // socket. Set permissions on the filesystem inode, not that FD.
        socket.set_pathname_permissions(&parent, &temporary_name, group)?;
        let current = std::fs::symlink_metadata(&socket.path)?;
        if !socket.matches_pathname_inode(&current)
            || current.uid() != nix::unistd::geteuid().as_raw()
            || current.gid() != group.as_raw()
            || current.mode() & 0o7777 != 0o660
        {
            return Err(io::Error::other("runner WSS socket changed during bind"));
        }
        socket.owner.record(&current, &temporary_name)?;
        socket.publish(&parent, &temporary_name, &name)?;
        socket.path = dir.join(&name);
        let published = std::fs::symlink_metadata(&socket.path)?;
        if !socket.matches_pathname_inode(&published)
            || published.gid() != group.as_raw()
            || published.mode() & 0o7777 != 0o660
        {
            return Err(io::Error::other(
                "runner WSS socket changed during publication",
            ));
        }
        if !socket.matches_pathname_inode(&std::fs::symlink_metadata(&socket.anchor_path)?) {
            return Err(io::Error::other(
                "runner WSS temporary socket changed during publication",
            ));
        }
        // Retain this private inode anchor until teardown. After SIGKILL it
        // prevents inode reuse from making a replacement look like our socket;
        // recovery requires it as well as the journal and exclusive flock.
        Ok(socket)
    }

    fn matches_pathname_inode(&self, metadata: &Metadata) -> bool {
        metadata.file_type().is_socket()
            && metadata.ino() == self.inode
            && metadata.dev() == self.device
    }

    fn publish(&self, parent: &File, anchor: &str, name: &str) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            use nix::fcntl::{AtFlags, OFlag, openat};
            use nix::sys::stat::Mode;
            use std::os::fd::AsRawFd;
            let inode = File::from(openat(
                parent,
                anchor,
                OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )?);
            if !self.matches_pathname_inode(&inode.metadata()?) {
                return Err(io::Error::other(
                    "runner WSS inode changed before publication",
                ));
            }
            // Follow only our pinned kernel FD, never a replacement pathname
            // symlink. Hard-link publication atomically refuses any existing target.
            let source = format!("/proc/self/fd/{}", inode.as_raw_fd());
            nix::unistd::linkat(
                parent,
                source.as_str(),
                parent,
                name,
                AtFlags::AT_SYMLINK_FOLLOW,
            )?;
        }
        #[cfg(not(target_os = "linux"))]
        nix::unistd::linkat(parent, anchor, parent, name, nix::fcntl::AtFlags::empty())?;
        Ok(())
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
        for path in [&self.path, &self.anchor_path] {
            if let Some(name) = path.file_name()
                && let Err(error) = self.owner.remove_if_owned(name, self.device, self.inode)
            {
                tracing::warn!(%error, "failed to remove owned runner WSS endpoint");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    const CRASH_CHILD: &str = "runner_wss_socket::tests::crash_owned_socket_child";

    async fn crash_fixture(window: &str) {
        use std::process::Stdio;
        use std::time::Duration;
        use tokio::io::{AsyncBufReadExt, BufReader};
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let id = Uuid::new_v4();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                CRASH_CHILD,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("VM0_WSS_CRASH_CHILD", "1")
            .env("VM0_WSS_CRASH_DIRECTORY", &dir)
            .env("VM0_WSS_CRASH_ID", id.to_string())
            .env("VM0_WSS_CRASH_WINDOW", window)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let line = lines
                    .next_line()
                    .await
                    .unwrap()
                    .expect("child must reach bound ownership evidence");
                if line.contains("WSS_CRASH_READY") {
                    break;
                }
            }
        })
        .await
        .expect("child must publish ownership evidence promptly");
        // A live owner, including an unpublished one, must not be displaced.
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        child.start_kill().unwrap();
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
        let socket = RunnerWssSocket::bind(&dir, id)
            .expect("proven owned dead inode must recover after SIGKILL");
        assert_eq!(socket.path, dir.join(format!("{id}.sock")));
        let mut peer = UnixStream::connect(&socket.path).await.unwrap();
        let mut accepted = socket.accept().await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        peer.write_all(b"ok").await.unwrap();
        let mut bytes = [0; 2];
        accepted.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"ok");
        drop(socket);
        assert!(!dir.join(format!("{id}.sock")).exists());
        assert!(!std::fs::read_dir(&dir).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".wss-")
        }));
    }

    #[tokio::test]
    async fn sigkill_recovers_published_owned_socket() {
        crash_fixture("published").await;
    }

    #[tokio::test]
    async fn sigkill_recovers_recorded_anchor_before_publication() {
        crash_fixture("anchor").await;
    }

    #[tokio::test]
    #[ignore = "subprocess fixture; both SIGKILL parent tests invoke it explicitly"]
    async fn crash_owned_socket_child() {
        use std::io::Write;
        assert!(
            crate::test_support::ignored_child_test_env_guard_enabled(("VM0_WSS_CRASH_CHILD", "1")),
            "this child requires its owning SIGKILL regression"
        );
        let directory = PathBuf::from(std::env::var_os("VM0_WSS_CRASH_DIRECTORY").unwrap());
        let id = Uuid::parse_str(&std::env::var("VM0_WSS_CRASH_ID").unwrap()).unwrap();
        if std::env::var("VM0_WSS_CRASH_WINDOW").unwrap() == "anchor" {
            let parent = open_dir(&directory, DirMode::TrustedParent, "WSS crash fixture").unwrap();
            let mut owner = owner::Owner::acquire(&parent, &directory, id).unwrap();
            let name = format!(".wss-{}", Uuid::new_v4().simple());
            let path = directory.join(&name);
            let _listener = UnixListener::bind(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
            owner
                .record(&std::fs::symlink_metadata(&path).unwrap(), &name)
                .unwrap();
            println!("WSS_CRASH_READY");
            std::io::stdout().flush().unwrap();
            std::future::pending::<()>().await;
        } else {
            let _socket = RunnerWssSocket::bind(&directory, id).unwrap();
            println!("WSS_CRASH_READY");
            std::io::stdout().flush().unwrap();
            std::future::pending::<()>().await;
        }
    }

    #[tokio::test]
    async fn special_owner_files_fail_closed_without_blocking() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        for suffix in ["lock", "owner"] {
            let id = Uuid::new_v4();
            let path = dir.join(format!("{id}.{suffix}"));
            nix::unistd::mkfifo(&path, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
            assert!(RunnerWssSocket::bind(&dir, id).is_err());
            assert!(
                std::fs::symlink_metadata(path)
                    .unwrap()
                    .file_type()
                    .is_fifo()
            );
        }
    }

    #[tokio::test]
    async fn replaced_parent_symlink_is_not_followed_during_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let id = Uuid::new_v4();
        let socket = RunnerWssSocket::bind(&dir, id).unwrap();
        let original = root.path().join("original");
        std::fs::rename(&dir, &original).unwrap();
        let replacement = root.path().join("replacement");
        std::fs::create_dir(&replacement).unwrap();
        let replacement_path = replacement.join(format!("{id}.sock"));
        let _foreign = UnixListener::bind(&replacement_path).unwrap();
        let before = std::fs::symlink_metadata(&replacement_path).unwrap();
        std::os::unix::fs::symlink(&replacement, &dir).unwrap();
        drop(socket);
        assert!(!original.join(format!("{id}.sock")).exists());
        assert_eq!(
            std::fs::symlink_metadata(replacement_path).unwrap().ino(),
            before.ino()
        );
    }

    #[tokio::test]
    async fn unrecorded_dead_socket_and_symlink_owner_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let id = Uuid::new_v4();
        let path = dir.join(format!("{id}.sock"));
        let foreign = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
        let before = std::fs::symlink_metadata(&path).unwrap();
        drop(foreign);
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        assert_eq!(
            std::fs::symlink_metadata(&path).unwrap().ino(),
            before.ino()
        );
        let other = Uuid::new_v4();
        let target = root.path().join("private-state");
        std::fs::write(&target, b"unchanged").unwrap();
        std::os::unix::fs::symlink(&target, dir.join(format!("{other}.owner"))).unwrap();
        assert!(RunnerWssSocket::bind(&dir, other).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");
    }

    #[tokio::test]
    async fn missing_anchor_never_authorizes_recovery_of_a_remaining_path() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("wss");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o710)).unwrap();
        let id = Uuid::new_v4();
        let socket = RunnerWssSocket::bind(&dir, id).unwrap();
        let held = root.path().join("held-socket");
        std::fs::hard_link(&socket.path, &held).unwrap();
        let path = socket.path.clone();
        let before = std::fs::symlink_metadata(&path).unwrap();
        drop(socket);
        std::fs::rename(held, &path).unwrap();
        assert!(RunnerWssSocket::bind(&dir, id).is_err());
        assert_eq!(std::fs::symlink_metadata(path).unwrap().ino(), before.ino());
    }

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
