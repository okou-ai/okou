//! Runtime socket namespace helpers for Firecracker sandboxes.
//!
//! Runtime sockets are arranged below [`RuntimePaths::sock_base`] by socket
//! ID:
//!
//! ```text
//! <sock-base>/                 0711
//! └── <sock-id>/               0711
//!     ├── api.sock             0600 when normalized
//!     ├── control.sock         0600 when normalized
//!     └── vsock/               0700
//!         └── vsock.sock       (guest vsock bind target)
//! ```
//!
//! The runtime socket base and per-ID directory are traversable (`0711`) so
//! host tools can reach known socket paths without being able to list their
//! contents. The `vsock` directory is owner-only (`0700`) because it contains
//! guest vsock bind targets. Socket nodes created under a traversable directory
//! are explicitly normalized to owner-only (`0600`) with
//! [`set_private_runtime_socket_mode`]; sockets under the private `vsock`
//! directory are protected by that directory boundary.
//!
//! Directory helpers accept only an existing directory owned by root or the
//! effective UID, reject symlinks, and require effective write and traverse
//! access. They may create a missing directory or change the mode of an
//! existing trusted directory. Root ownership passes the owner check but does
//! not guarantee that the current process can perform a required mode change;
//! such a failure is returned to the caller.

use std::fs::DirBuilder;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Component, Path};

use nix::unistd::{AccessFlags, eaccess, geteuid};

use crate::paths::{RuntimePaths, SockPaths};

/// Owner-only runtime directory, used for guest vsock bind targets.
pub(crate) const PRIVATE_RUNTIME_DIR_MODE: u32 = 0o700;
/// Owner-writable directory that lets host tools stat known socket paths.
pub(crate) const TRAVERSABLE_RUNTIME_DIR_MODE: u32 = 0o711;
/// Owner-only runtime socket mode, used under traversable runtime dirs.
pub(crate) const PRIVATE_RUNTIME_SOCKET_MODE: u32 = 0o600;
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 107;

/// Validate a socket ID and return its per-ID runtime socket directory.
///
/// `sock_id` must be one non-empty ASCII path segment containing only ASCII
/// letters, digits, `.`, `-`, or `_`. The returned path is
/// `runtime_paths.sock_base()/<sock_id>`, where [`RuntimePaths::sock_base`]
/// supplies the base. This helper only derives and validates the path; it does
/// not create, inspect, or modify filesystem entries. It also checks that the
/// port-suffixed Guest control and Guest-to-Runner RPC listeners derived from
/// [`SockPaths::vsock`] fit within the 107-byte usable Unix socket pathname
/// limit. Because it does not inspect filesystem entries, it does not apply
/// the directory ownership or access checks used by the preparation helpers.
///
/// # Errors
///
/// Returns [`io::ErrorKind::InvalidInput`] for an empty, nested, or otherwise
/// invalid ID, or when a derived vsock listener path is too long.
pub(crate) fn checked_runtime_sock_dir(
    runtime_paths: &RuntimePaths,
    sock_id: &str,
) -> io::Result<std::path::PathBuf> {
    validate_runtime_sock_id(sock_id)?;
    let sock_dir = runtime_paths.sock_dir(sock_id);
    let sock_paths = SockPaths::new(sock_dir.clone());
    validate_runtime_vsock_listener_path_len(sock_id, &sock_paths.vsock())?;
    Ok(sock_dir)
}

/// Ensure that `path` is a trusted private runtime directory with mode `0700`.
///
/// A missing directory is created with this mode; the parent directory is not
/// created by this helper. An existing path must be a non-symlink directory
/// owned by root or the effective UID. If its mode differs, the helper changes
/// it to exactly `0700`, then verifies effective write and traverse access.
/// Therefore, this is a mutating operation even when `path` already exists.
/// Root ownership satisfies the owner check but does not guarantee that the
/// current process can perform the mode change.
///
/// # Errors
///
/// Returns the underlying filesystem error, with operation context, when the
/// directory cannot be created, inspected, normalized, or accessed. It also
/// returns an error for symlinks, non-directories, or owners other than root
/// and the effective UID.
pub(crate) fn ensure_private_runtime_dir(path: &Path) -> io::Result<()> {
    ensure_runtime_dir_with_mode(path, PRIVATE_RUNTIME_DIR_MODE)
}

/// Ensure that `path` is a trusted traversable runtime directory with mode `0711`.
///
/// A missing directory is created with this mode; the parent directory is not
/// created by this helper. An existing path must be a non-symlink directory
/// owned by root or the effective UID. If its mode differs, the helper changes
/// it to exactly `0711`, then verifies effective write and traverse access.
/// Therefore, this is a mutating operation even when `path` already exists.
/// Root ownership satisfies the owner check but does not guarantee that the
/// current process can perform the mode change.
///
/// # Errors
///
/// Returns the underlying filesystem error, with operation context, when the
/// directory cannot be created, inspected, normalized, or accessed. It also
/// returns an error for symlinks, non-directories, or owners other than root
/// and the effective UID.
pub(crate) fn ensure_traversable_runtime_dir(path: &Path) -> io::Result<()> {
    ensure_runtime_dir_with_mode(path, TRAVERSABLE_RUNTIME_DIR_MODE)
}

/// Prepare a per-sandbox socket directory and its private vsock subdirectory.
///
/// `sock_paths.dir()` is created or normalized as a trusted `0711` directory,
/// and `sock_paths.vsock_dir()` is created or normalized as a trusted `0700`
/// directory. Both directories must be owned by root or the effective UID and
/// must be writable and traversable by the effective user. Existing trusted
/// directories may therefore be chmodded. This helper prepares directories
/// only; it does not create socket nodes or set their modes. Callers must
/// normalize an existing socket node separately with
/// [`set_private_runtime_socket_mode`].
///
/// # Errors
///
/// Returns an error from either directory operation, including for a missing
/// parent, symlink, non-directory, untrusted owner, failed mode change, or
/// missing effective write/traverse access.
pub(crate) fn prepare_runtime_socket_dir(sock_paths: &SockPaths) -> io::Result<()> {
    ensure_traversable_runtime_dir(sock_paths.dir())?;
    ensure_private_runtime_dir(&sock_paths.vsock_dir())
}

/// Validate and prepare a private snapshot vsock directory under the default
/// runtime socket base.
///
/// `vsock_bind_dir` must have the lexical shape
/// `<sock-base>/<sock-id>/vsock`, where `<sock-base>` is supplied by
/// [`RuntimePaths::sock_base`] and `sock-id` follows the same single-segment
/// ASCII rule as [`checked_runtime_sock_dir`]. The port-suffixed Guest control
/// and RPC listener paths must fit within the 107-byte usable Unix socket
/// pathname limit. The socket base and per-ID directory are created or
/// normalized to `0711`; the `vsock` directory is created or normalized to
/// `0700`. Each checked directory must be a non-symlink directory owned by
/// root or the effective UID and must be writable and traversable by the
/// effective user.
///
/// This helper uses [`RuntimePaths::new`] and therefore validates against the
/// default runtime socket base rather than an arbitrary base supplied by the
/// caller. Existing trusted directories may be chmodded, and root ownership
/// does not guarantee that a required chmod will succeed.
///
/// # Errors
///
/// Returns [`io::ErrorKind::InvalidInput`] when the path is outside the socket
/// base, does not have the required shape, contains an invalid ID, or produces
/// an overlong vsock listener path. Filesystem, ownership, mode, or access
/// failures are returned for the directory preparation steps.
pub(crate) fn prepare_private_runtime_vsock_dir(vsock_bind_dir: &Path) -> io::Result<()> {
    prepare_private_vsock_dir_under(&RuntimePaths::new().sock_base(), vsock_bind_dir)
}

/// Set an existing runtime socket node to the owner-only mode `0600`.
///
/// This helper performs only a permission update. It does not create the path,
/// check that it is a socket, validate its parent directory, validate its
/// socket ID, or apply the trusted-owner rule used by the directory helpers.
/// Callers are responsible for supplying a path that has already been created
/// in the appropriate runtime socket directory.
///
/// # Errors
///
/// Returns the underlying permission-update error, with path and target mode
/// context, when the path is missing or the current process cannot change its
/// permissions.
pub(crate) fn set_private_runtime_socket_mode(path: &Path) -> io::Result<()> {
    std::fs::set_permissions(
        path,
        std::fs::Permissions::from_mode(PRIVATE_RUNTIME_SOCKET_MODE),
    )
    .map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "chmod runtime socket {} to {:04o}: {e}",
                path.display(),
                PRIVATE_RUNTIME_SOCKET_MODE
            ),
        )
    })
}

fn prepare_private_vsock_dir_under(sock_base: &Path, vsock_bind_dir: &Path) -> io::Result<()> {
    let relative = vsock_bind_dir.strip_prefix(sock_base).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime vsock dir {} is outside socket base {}",
                vsock_bind_dir.display(),
                sock_base.display()
            ),
        )
    })?;

    let mut components = relative.components();
    let Some(Component::Normal(sock_id)) = components.next() else {
        return Err(invalid_vsock_dir_shape(sock_base, vsock_bind_dir));
    };
    let Some(Component::Normal(vsock_dir)) = components.next() else {
        return Err(invalid_vsock_dir_shape(sock_base, vsock_bind_dir));
    };
    if vsock_dir != "vsock" || components.next().is_some() {
        return Err(invalid_vsock_dir_shape(sock_base, vsock_bind_dir));
    }
    let sock_id = sock_id
        .to_str()
        .ok_or_else(|| invalid_runtime_sock_id(&sock_id.to_string_lossy()))?;
    validate_runtime_sock_id(sock_id)?;
    validate_runtime_vsock_listener_path_len(sock_id, &vsock_bind_dir.join("vsock.sock"))?;

    ensure_traversable_runtime_dir(sock_base)?;
    let sock_dir = vsock_bind_dir.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime vsock dir has no parent: {}",
                vsock_bind_dir.display()
            ),
        )
    })?;
    ensure_traversable_runtime_dir(sock_dir)?;
    ensure_private_runtime_dir(vsock_bind_dir)
}

fn invalid_vsock_dir_shape(sock_base: &Path, vsock_bind_dir: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "runtime vsock dir must be {}/<id>/vsock: {}",
            sock_base.display(),
            vsock_bind_dir.display()
        ),
    )
}

fn ensure_runtime_dir_with_mode(path: &Path, mode: u32) -> io::Result<()> {
    create_runtime_dir_if_missing(path, mode)?;
    validate_runtime_dir(path, mode)
}

fn create_runtime_dir_if_missing(path: &Path, mode: u32) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.mode(mode);
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(io::Error::new(
            e.kind(),
            format!("create runtime dir {}: {e}", path.display()),
        )),
    }
}

fn validate_runtime_dir(path: &Path, expected_mode: u32) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("stat runtime dir {}: {e}", path.display()),
        )
    })?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(io::Error::other(format!(
            "runtime dir is a symlink: {}",
            path.display()
        )));
    }
    if !file_type.is_dir() {
        return Err(io::Error::other(format!(
            "runtime dir is not a directory: {}",
            path.display()
        )));
    }

    let euid = geteuid().as_raw();
    if !runtime_dir_owner_is_trusted(metadata.uid(), euid) {
        return Err(io::Error::other(format!(
            "runtime dir has untrusted owner uid {}: {}",
            metadata.uid(),
            path.display()
        )));
    }

    let mode = metadata.permissions().mode() & 0o7777;
    if mode != expected_mode {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(expected_mode)).map_err(
            |e| {
                io::Error::new(
                    e.kind(),
                    format!(
                        "chmod runtime dir {} to {:04o}: {e}",
                        path.display(),
                        expected_mode
                    ),
                )
            },
        )?;
    }

    eaccess(path, AccessFlags::W_OK | AccessFlags::X_OK).map_err(|e| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "runtime dir is not writable/traversable: {}: {e}",
                path.display()
            ),
        )
    })
}

fn runtime_dir_owner_is_trusted(owner_uid: u32, effective_uid: u32) -> bool {
    owner_uid == 0 || owner_uid == effective_uid
}

fn validate_runtime_sock_id(sock_id: &str) -> io::Result<()> {
    if sock_id.is_empty() {
        return Err(invalid_runtime_sock_id(sock_id));
    }
    if !sock_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err(invalid_runtime_sock_id(sock_id));
    }

    let mut components = Path::new(sock_id).components();
    let Some(Component::Normal(_)) = components.next() else {
        return Err(invalid_runtime_sock_id(sock_id));
    };
    if components.next().is_some() {
        return Err(invalid_runtime_sock_id(sock_id));
    }
    Ok(())
}

fn validate_runtime_vsock_listener_path_len(sock_id: &str, vsock_path: &Path) -> io::Result<()> {
    // Both listeners use the same Firecracker UDS base, suffixed by _<port>.
    let longest_port_len = guest_control_proto::VSOCK_PORT
        .to_string()
        .len()
        .max(runner_rpc_proto::VSOCK_PORT.to_string().len());
    let listener_path_len = vsock_path.as_os_str().as_bytes().len() + 1 + longest_port_len;
    if listener_path_len > MAX_UNIX_SOCKET_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime socket id {sock_id:?} makes vsock listener path too long: {} bytes (max {})",
                listener_path_len, MAX_UNIX_SOCKET_PATH_BYTES
            ),
        ));
    }
    Ok(())
}

fn invalid_runtime_sock_id(sock_id: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "runtime socket id must be a single non-empty ASCII path segment using only letters, digits, '.', '-', and '_': {sock_id:?}"
        ),
    )
}

#[cfg(test)]
mod tests {
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
}
