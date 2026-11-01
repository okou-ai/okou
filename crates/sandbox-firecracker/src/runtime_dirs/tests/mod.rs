use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

use super::*;

fn mode(path: &Path) -> u32 {
    std::fs::symlink_metadata(path)
        .unwrap()
        .permissions()
        .mode()
        & 0o7777
}

#[test]
fn ensure_private_runtime_dir_creates_missing_dir_with_private_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("runtime");

    ensure_private_runtime_dir(&path).unwrap();

    assert!(path.is_dir());
    assert_eq!(mode(&path), PRIVATE_RUNTIME_DIR_MODE);
}

#[test]
fn ensure_traversable_runtime_dir_creates_missing_dir_with_traversable_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("runtime");

    ensure_traversable_runtime_dir(&path).unwrap();

    assert!(path.is_dir());
    assert_eq!(mode(&path), TRAVERSABLE_RUNTIME_DIR_MODE);
}

#[test]
fn ensure_private_runtime_dir_normalizes_existing_trusted_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("runtime");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();

    ensure_private_runtime_dir(&path).unwrap();

    assert_eq!(mode(&path), PRIVATE_RUNTIME_DIR_MODE);
}

#[test]
fn ensure_private_runtime_dir_rejects_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("target");
    let link = tmp.path().join("runtime");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let err = ensure_private_runtime_dir(&link).unwrap_err();

    assert!(err.to_string().contains("is a symlink"));
    assert!(target.is_dir());
}

#[test]
fn ensure_private_runtime_dir_rejects_non_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("runtime");
    std::fs::write(&path, b"not a dir").unwrap();

    let err = ensure_private_runtime_dir(&path).unwrap_err();

    assert!(err.to_string().contains("is not a directory"));
}

#[test]
fn set_private_runtime_socket_mode_sets_owner_only_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let socket_path = tmp.path().join("runtime.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o666)).unwrap();

    set_private_runtime_socket_mode(&socket_path).unwrap();

    assert_eq!(mode(&socket_path), PRIVATE_RUNTIME_SOCKET_MODE);
}

#[test]
fn prepare_runtime_socket_dir_creates_traversable_sock_and_private_vsock_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_paths = SockPaths::new(tmp.path().join("sandbox"));

    prepare_runtime_socket_dir(&sock_paths).unwrap();

    assert_eq!(mode(sock_paths.dir()), TRAVERSABLE_RUNTIME_DIR_MODE);
    assert_eq!(mode(&sock_paths.vsock_dir()), PRIVATE_RUNTIME_DIR_MODE);
}

#[test]
fn checked_runtime_sock_dir_accepts_safe_id() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());

    let sock_dir = checked_runtime_sock_dir(&runtime_paths, "snapshot-test_1.2").unwrap();

    assert_eq!(sock_dir, tmp.path().join("sock").join("snapshot-test_1.2"));
}

#[test]
fn checked_runtime_sock_dir_rejects_parent_escape() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());

    let err = checked_runtime_sock_dir(&runtime_paths, "../snapshot").unwrap_err();

    assert!(err.to_string().contains("runtime socket id must be"));
}

#[test]
fn checked_runtime_sock_dir_rejects_nested_id() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());

    let err = checked_runtime_sock_dir(&runtime_paths, "root/snapshot").unwrap_err();

    assert!(err.to_string().contains("runtime socket id must be"));
}

#[test]
fn checked_runtime_sock_dir_rejects_unsafe_character() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());

    let err = checked_runtime_sock_dir(&runtime_paths, "snapshot test").unwrap_err();

    assert!(err.to_string().contains("runtime socket id must be"));
}

#[test]
fn checked_runtime_sock_dir_reserves_listener_suffix() {
    let runtime_paths = RuntimePaths::new();
    let valid_id = "a".repeat(70);
    let overlong_id = "a".repeat(71);

    assert!(checked_runtime_sock_dir(&runtime_paths, &valid_id).is_ok());
    let rpc = SockPaths::new(runtime_paths.sock_dir(&valid_id)).guest_rpc();
    assert_eq!(rpc.as_os_str().as_bytes().len(), MAX_UNIX_SOCKET_PATH_BYTES);
    let err = checked_runtime_sock_dir(&runtime_paths, &overlong_id).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(err.to_string().contains("vsock listener path too long"));
}

#[test]
fn checked_runtime_sock_dir_rejects_overlong_vsock_listener_path() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());
    let sock_id = "a".repeat(200);

    let err = checked_runtime_sock_dir(&runtime_paths, &sock_id).unwrap_err();

    assert!(err.to_string().contains("vsock listener path too long"));
}

#[test]
fn prepare_runtime_socket_dir_normalizes_existing_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_paths = SockPaths::new(tmp.path().join("sandbox"));
    std::fs::create_dir(sock_paths.dir()).unwrap();
    std::fs::create_dir(sock_paths.vsock_dir()).unwrap();
    std::fs::set_permissions(sock_paths.dir(), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(
        sock_paths.vsock_dir(),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();

    prepare_runtime_socket_dir(&sock_paths).unwrap();

    assert_eq!(mode(sock_paths.dir()), TRAVERSABLE_RUNTIME_DIR_MODE);
    assert_eq!(mode(&sock_paths.vsock_dir()), PRIVATE_RUNTIME_DIR_MODE);
}

#[test]
fn prepare_private_vsock_dir_under_creates_private_runtime_vsock_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_base = tmp.path().join("sock");
    let vsock_dir = sock_base.join("snapshot").join("vsock");

    prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap();

    assert_eq!(mode(&sock_base), TRAVERSABLE_RUNTIME_DIR_MODE);
    assert_eq!(
        mode(&sock_base.join("snapshot")),
        TRAVERSABLE_RUNTIME_DIR_MODE
    );
    assert_eq!(mode(&vsock_dir), PRIVATE_RUNTIME_DIR_MODE);
}

#[test]
fn prepare_private_vsock_dir_under_rejects_symlinked_runtime_sock_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_base = tmp.path().join("sock");
    let target = tmp.path().join("target");
    let snapshot_dir = sock_base.join("snapshot");
    let vsock_dir = snapshot_dir.join("vsock");
    std::fs::create_dir(&sock_base).unwrap();
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &snapshot_dir).unwrap();

    let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

    assert!(err.to_string().contains("is a symlink"));
    assert!(target.is_dir());
}

#[test]
fn prepare_private_vsock_dir_under_rejects_path_outside_sock_base() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_base = tmp.path().join("sock");
    let vsock_dir = tmp.path().join("other").join("snapshot").join("vsock");

    let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

    assert!(err.to_string().contains("is outside socket base"));
}

#[test]
fn prepare_private_vsock_dir_under_rejects_unsafe_socket_id() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_base = tmp.path().join("sock");
    let vsock_dir = sock_base.join("snapshot test").join("vsock");

    let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

    assert!(err.to_string().contains("runtime socket id must be"));
}

#[test]
fn prepare_private_vsock_dir_under_rejects_overlong_vsock_listener_path() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_base = tmp.path().join("sock");
    let vsock_dir = sock_base.join("a".repeat(200)).join("vsock");

    let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

    assert!(err.to_string().contains("vsock listener path too long"));
}

#[test]
fn prepare_private_vsock_dir_under_reserves_listener_suffix_before_creating_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_base = tmp.path().join("sock");
    let id_len = MAX_UNIX_SOCKET_PATH_BYTES
        - sock_base.as_os_str().as_bytes().len()
        - 1
        - "/vsock/vsock.sock".len();
    let vsock_dir = sock_base.join("a".repeat(id_len)).join("vsock");
    assert_eq!(
        vsock_dir.join("vsock.sock").as_os_str().as_bytes().len(),
        MAX_UNIX_SOCKET_PATH_BYTES
    );

    let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(err.to_string().contains("vsock listener path too long"));
    assert!(!sock_base.exists());
}

#[test]
fn prepare_private_vsock_dir_under_rejects_parent_escape() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_base = tmp.path().join("sock");
    let vsock_dir = sock_base.join("snapshot").join("..").join("vsock");

    let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

    assert!(err.to_string().contains("must be"));
}

#[test]
fn prepare_private_vsock_dir_under_rejects_wrong_leaf() {
    let tmp = tempfile::tempdir().unwrap();
    let sock_base = tmp.path().join("sock");
    let vsock_dir = sock_base.join("snapshot").join("api");

    let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

    assert!(err.to_string().contains("must be"));
}

#[test]
fn owner_trust_accepts_root_and_effective_uid() {
    assert!(runtime_dir_owner_is_trusted(0, 1000));
    assert!(runtime_dir_owner_is_trusted(1000, 1000));
}

#[test]
fn owner_trust_rejects_unrelated_uid() {
    assert!(!runtime_dir_owner_is_trusted(1001, 1000));
}
