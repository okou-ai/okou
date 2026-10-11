use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener as StdListener, UnixStream as StdStream};
use std::sync::{Arc, Barrier};
use std::time::Duration;

use super::*;
use crate::runner_wss_socket::RunnerWssSocket;
use crate::test_support::{ignored_child_test_env_guard_enabled, run_ignored_child_test};

const CHILD_ENV: &str = "OKOU_RUNNER_WSS_NAMESPACE_CHILD";

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let root = tempfile::tempdir().expect("create WSS namespace fixture root");
    let directory = root.path().join("wss");
    (root, directory)
}

// The known group identity is the external host prerequisite; every directory,
// permission, lock and socket operation below runs through the real native code.
fn ensure_fixture(directory: &Path) -> io::Result<(File, Gid)> {
    open_namespace(directory, true, Some(nix::unistd::getegid()))
}

#[test]
fn startup_creates_exact_namespace_and_repeat_preserves_identity() {
    let (_root, directory) = fixture();
    let (file, group) = ensure_fixture(&directory).unwrap();
    let before = file.metadata().unwrap();
    assert_eq!(before.uid(), geteuid().as_raw());
    assert_eq!(before.gid(), group.as_raw());
    assert_eq!(before.mode() & 0o7777, 0o710);
    let (again, _) = ensure_fixture(&directory).unwrap();
    assert_eq!(again.metadata().unwrap().ino(), before.ino());
    assert_eq!(again.metadata().unwrap().mode(), before.mode());
}

#[test]
fn missing_parent_is_not_reconstructed() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("missing-home/wss");
    assert_eq!(
        ensure_fixture(&directory).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    assert!(!directory.parent().unwrap().exists());
}

#[test]
fn existing_unsafe_modes_and_group_are_preserved() {
    let (_root, directory) = fixture();
    ensure_fixture(&directory).unwrap();
    let before = directory.metadata().unwrap();
    for mode in [0o755, 0o711, 0o770, 0o1710, 0o2710] {
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(ensure_fixture(&directory).is_err());
        assert_eq!(directory.metadata().unwrap().mode() & 0o7777, mode);
        assert_eq!(directory.metadata().unwrap().ino(), before.ino());
    }
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o710)).unwrap();
    let wrong_group = Gid::from_raw(before.gid().wrapping_add(1));
    assert!(open_namespace(&directory, true, Some(wrong_group)).is_err());
    assert_eq!(directory.metadata().unwrap().gid(), before.gid());
}

#[test]
fn symlink_and_non_directory_collisions_are_preserved() {
    let (root, directory) = fixture();
    let target = root.path().join("private");
    std::fs::create_dir(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::symlink(&target, &directory).unwrap();
    assert!(ensure_fixture(&directory).is_err());
    assert!(
        directory
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(target.metadata().unwrap().mode() & 0o7777, 0o700);
    std::fs::remove_file(&directory).unwrap();
    std::fs::write(&directory, b"foreign").unwrap();
    assert!(ensure_fixture(&directory).is_err());
    assert_eq!(std::fs::read(&directory).unwrap(), b"foreign");
    std::fs::remove_file(&directory).unwrap();
    let linked_parent = root.path().join("linked-home");
    std::os::unix::fs::symlink(&target, &linked_parent).unwrap();
    assert!(ensure_fixture(&linked_parent.join("wss")).is_err());
    assert!(!target.join("wss").exists());
}

#[test]
fn unsafe_parent_is_rejected_before_creation() {
    let (root, directory) = fixture();
    for mode in [0o777, 0o770] {
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(ensure_fixture(&directory).is_err());
        assert!(!directory.exists());
        assert_eq!(root.path().metadata().unwrap().mode() & 0o7777, mode);
    }
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn set_acl(file: &File, name: &std::ffi::CStr) {
    let mut acl = 2u32.to_le_bytes().to_vec();
    for (tag, permissions, qualifier) in [
        (1u16, 7u16, u32::MAX),
        (2, 1, geteuid().as_raw() + 1),
        (4, 1, u32::MAX),
        (16, 1, u32::MAX),
        (32, 0, u32::MAX),
    ] {
        acl.extend(tag.to_le_bytes());
        acl.extend(permissions.to_le_bytes());
        acl.extend(qualifier.to_le_bytes());
    }
    // The descriptor/name and Linux POSIX ACL buffer remain valid for the syscall.
    let result = unsafe {
        libc::fsetxattr(
            file.as_raw_fd(),
            name.as_ptr(),
            acl.as_ptr().cast(),
            acl.len(),
            0,
        )
    };
    assert_eq!(result, 0, "{}", io::Error::last_os_error());
}

#[test]
fn inherited_default_acl_is_preserved_and_blocks_creation() {
    let (root, directory) = fixture();
    let parent = File::open(root.path()).unwrap();
    set_acl(&parent, c"system.posix_acl_default");
    assert!(ensure_fixture(&directory).is_err());
    assert!(!directory.exists());
    assert!(xattr_size(&parent, c"system.posix_acl_default") > 0);
}

fn xattr_size(file: &File, name: &std::ffi::CStr) -> libc::ssize_t {
    // The descriptor and static name are valid; no output buffer is accessed.
    unsafe { libc::fgetxattr(file.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0) }
}

#[tokio::test]
async fn named_user_acl_is_rejected_even_when_mode_remains_0710() {
    let (_root, directory) = fixture();
    ensure_fixture(&directory).unwrap();
    let descriptor = File::open(&directory).unwrap();
    set_acl(&descriptor, c"system.posix_acl_access");
    assert_eq!(descriptor.metadata().unwrap().mode() & 0o7777, 0o710);
    assert!(RunnerWssSocket::bind(&directory, uuid::Uuid::new_v4()).is_err());
    assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
}

#[tokio::test]
async fn concurrent_creation_preserves_connected_socket_and_private_state() {
    run_ignored_child_test(
        "runner_wss_socket::namespace::tests::concurrent_creation_child",
        (CHILD_ENV, "concurrent"),
        &[],
        Duration::from_secs(60),
    )
    .await;
}

#[test]
#[ignore = "guarded parent bounds native creator threads and checks their socket effects"]
fn concurrent_creation_child() {
    if !ignored_child_test_env_guard_enabled((CHILD_ENV, "concurrent")) {
        return;
    }
    let (root, directory) = fixture();
    let create_concurrently = || {
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let directory = directory.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let (file, _) = ensure_fixture(&directory).unwrap();
                    file.metadata().unwrap().ino()
                })
            })
            .collect();
        let inodes: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(inodes.iter().all(|inode| *inode == inodes[0]));
    };
    create_concurrently();
    assert_eq!(directory.metadata().unwrap().mode() & 0o7777, 0o710);
    let private = root.path().join("control");
    std::fs::create_dir(&private).unwrap();
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
    let private_before = private.metadata().unwrap();
    let path = directory.join("live.sock");
    let server = StdListener::bind(&path).unwrap();
    let mut client = StdStream::connect(&path).unwrap();
    let (mut accepted, _) = server.accept().unwrap();
    let socket_before = path.metadata().unwrap();
    let descriptors_before = std::fs::read_dir("/proc/self/fd").unwrap().count();
    create_concurrently();
    assert_eq!(
        std::fs::read_dir("/proc/self/fd").unwrap().count(),
        descriptors_before
    );
    client.write_all(b"healthy").unwrap();
    let mut bytes = [0; 7];
    accepted.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"healthy");
    assert_eq!(path.metadata().unwrap().ino(), socket_before.ino());
    assert_eq!(path.metadata().unwrap().mode(), socket_before.mode());
    assert_eq!(private.metadata().unwrap().ino(), private_before.ino());
    assert_eq!(private.metadata().unwrap().mode(), private_before.mode());
}

#[tokio::test]
async fn first_creation_handles_restrictive_umask_without_changing_process_mask() {
    run_ignored_child_test(
        "runner_wss_socket::namespace::tests::restrictive_umask_child",
        (CHILD_ENV, "umask"),
        &[],
        Duration::from_secs(60),
    )
    .await;
}

#[test]
#[ignore = "guarded child owns its process umask"]
fn restrictive_umask_child() {
    if !ignored_child_test_env_guard_enabled((CHILD_ENV, "umask")) {
        return;
    }
    let (_root, directory) = fixture();
    let previous = nix::sys::stat::umask(Mode::from_bits_truncate(0o777));
    let result = ensure_fixture(&directory);
    let still = nix::sys::stat::umask(previous);
    assert_eq!(still, Mode::from_bits_truncate(0o777));
    let (file, group) = result.unwrap();
    assert_eq!(file.metadata().unwrap().mode() & 0o7777, 0o710);
    assert_eq!(file.metadata().unwrap().gid(), group.as_raw());
}
