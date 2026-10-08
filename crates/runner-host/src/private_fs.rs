//! Private filesystem boundary for runner-owned configuration, identity, and
//! status state.
//!
//! On Unix, [`ensure_private_dir`] establishes the directory trust boundary.
//! It rejects parent-directory and symlink components, refuses targets
//! reserved for system or shared runner state, validates component ownership
//! and replaceability, and enforces mode `0700` on the final directory.
//! Acceptable existing intermediate directory modes are preserved; newly
//! created components are private.
//!
//! File reads and writes are separate path-based operations. They neither call
//! [`ensure_private_dir`] nor validate or retain the parent directory chain,
//! so callers must establish the required parent-directory trust first. Unix
//! reads protect and validate the final opened file, reject unsafe ownership
//! or write permissions, and may tighten acceptable permissions to `0600`.
//! Unix writes use a private sibling staging file and rename it over the
//! target. That prevents readers from observing partial target contents, but
//! it does not fsync the file or parent directory, serialize writers, or
//! provide crash durability. Cleanup of a staging file after failure is best
//! effort.
//!
//! Non-Unix fallbacks keep the read size and UTF-8 checks, but otherwise use
//! ordinary directory creation, file open, and file write operations. They do
//! not provide the Unix path, ownership, mode, file-type, no-follow,
//! nonblocking, staging, or atomic-replacement guarantees.

use std::ffi::OsStr;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

use crate::error::{HostError, HostResult};
use crate::paths::{HomePaths, RUNNER_HOME_ROOT};

const PRIVATE_DIR_MODE: u32 = 0o700;
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
const ROOT_UID: u32 = 0;
const STICKY_BIT: u32 = 0o1000;
const PRIVATE_FILE_READ_MAX_BYTES: u64 = 64 * 1024;
/// Maximum number of bytes accepted for a private runner status snapshot.
pub const PRIVATE_STATUS_FILE_READ_MAX_BYTES: u64 = 1024 * 1024;
const RESERVED_PRIVATE_DIR_PATHS: &[&str] = &[
    "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt", "/proc", "/root",
    "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var", "/var/lib",
];

/// Ensure `path` is private runtime state for the current runner process.
///
/// This rejects parent-directory and existing symlink components, exact
/// reserved targets, and recursively reserved shared-runner subtrees. The
/// component walk refuses to create missing reserved paths and requires each
/// opened parent to be owned by root or the effective uid and not be
/// group/other writable unless it is sticky. Existing non-reserved components
/// must be owned by the effective uid.
///
/// Acceptable existing intermediate modes are preserved. Newly created
/// components and the final directory are set to `0700`, and the final
/// directory must be owned by the effective uid. The runner normally runs as
/// root; state is intentionally not chowned back to `SUDO_USER`.
#[cfg(unix)]
pub async fn ensure_private_dir(path: &Path) -> HostResult<()> {
    reject_reserved_private_dir_path(path)?;
    reject_parent_dir_components(path)?;
    reject_existing_symlink_components(path).await?;
    let expected_uid = nix::unistd::geteuid().as_raw();
    let fd = ensure_private_dir_exists_without_symlinks(path, expected_uid)?;
    ensure_private_dir_fd_owned_by(path, &fd, expected_uid)
}

/// Create `path` and any missing parents using the platform filesystem API.
///
/// This fallback does not apply the Unix reserved-path, parent-component,
/// symlink, ownership, replaceability, or `0700` mode guarantees.
#[cfg(not(unix))]
pub async fn ensure_private_dir(path: &Path) -> HostResult<()> {
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|e| HostError::Config(format!("create private dir {}: {e}", path.display())))
}

#[cfg(unix)]
fn reject_parent_dir_components(path: &Path) -> HostResult<()> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(HostError::Config(format!(
            "{} contains a parent directory segment; refusing to use it as private runner state",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
async fn reject_existing_symlink_components(path: &Path) -> HostResult<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => {
                return Err(HostError::Config(format!(
                    "{} is not a directory; refusing to use it as private runner state",
                    path.display()
                )));
            }
            Err(e) => {
                return Err(HostError::Config(format!(
                    "stat private dir component {}: {e}",
                    current.display()
                )));
            }
        };
        if metadata.file_type().is_symlink() {
            return Err(HostError::Config(format!(
                "{} contains symlink component {}; refusing to use it as private runner state",
                path.display(),
                current.display()
            )));
        }
    }
    Ok(())
}

/// Read an optional private UTF-8 file with the default 64 KiB limit.
///
/// Missing paths return `Ok(None)`. The Unix validation, permission mutation,
/// and trusted-parent requirements are described by
/// [`read_private_file_to_string_with_max`].
#[cfg(unix)]
pub async fn read_private_file_to_string(path: &Path) -> HostResult<Option<String>> {
    read_private_file_to_string_with_max(path, PRIVATE_FILE_READ_MAX_BYTES).await
}

/// Read an optional private UTF-8 file with a caller-supplied byte limit.
///
/// Missing paths return `Ok(None)`. The final component is opened with
/// `O_NOFOLLOW`, `O_CLOEXEC`, and `O_NONBLOCK`, then must be a regular file
/// owned by the effective uid and not group/other writable. An otherwise
/// acceptable mode other than `0600` is tightened through the opened
/// descriptor before reading, so a successful call may change permissions.
///
/// Parent components are not validated; callers must establish the required
/// parent-directory trust separately. Content longer than `max_bytes`,
/// invalid UTF-8, and a limit for which `max_bytes + 1` overflows are rejected.
#[cfg(unix)]
pub async fn read_private_file_to_string_with_max(
    path: &Path,
    max_bytes: u64,
) -> HostResult<Option<String>> {
    let mut options = tokio::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(crate::host_file::private_file_open_flags());
    let file = match options.open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(HostError::Config(format!(
                "open private file {}: {e}",
                path.display()
            )));
        }
    };
    crate::host_file::secure_regular_private_file(&file, path, "private file")
        .map_err(|e| HostError::Config(e.to_string()))?;
    read_private_file_contents(file, path, max_bytes)
        .await
        .map(Some)
}

async fn read_private_file_contents(
    file: tokio::fs::File,
    path: &Path,
    max_bytes: u64,
) -> HostResult<String> {
    use tokio::io::AsyncReadExt;

    let read_limit = max_bytes.checked_add(1).ok_or_else(|| {
        HostError::Config(format!(
            "private file {} read limit is too large",
            path.display()
        ))
    })?;
    let mut limited = file.take(read_limit);
    let mut contents = Vec::new();
    limited
        .read_to_end(&mut contents)
        .await
        .map_err(|e| HostError::Config(format!("read private file {}: {e}", path.display())))?;
    if contents.len() as u64 > max_bytes {
        return Err(HostError::Config(format!(
            "private file {} exceeds {} bytes",
            path.display(),
            max_bytes
        )));
    }
    String::from_utf8(contents).map_err(|e| {
        HostError::Config(format!(
            "read private file {} as UTF-8: {e}",
            path.display()
        ))
    })
}

/// Read an optional UTF-8 file with the default 64 KiB limit on non-Unix.
///
/// Missing paths return `Ok(None)`. This fallback does not apply the Unix
/// no-follow, nonblocking, file-type, ownership, or permission checks.
#[cfg(not(unix))]
pub async fn read_private_file_to_string(path: &Path) -> HostResult<Option<String>> {
    read_private_file_to_string_with_max(path, PRIVATE_FILE_READ_MAX_BYTES).await
}

/// Read an optional UTF-8 file with a caller-supplied limit on non-Unix.
///
/// Missing paths return `Ok(None)`. Content longer than `max_bytes`, invalid
/// UTF-8, and a limit for which `max_bytes + 1` overflows are rejected. The
/// path is otherwise opened with ordinary platform behavior, so callers remain
/// responsible for its trust and privacy.
#[cfg(not(unix))]
pub async fn read_private_file_to_string_with_max(
    path: &Path,
    max_bytes: u64,
) -> HostResult<Option<String>> {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(HostError::Config(format!(
                "open private file {}: {e}",
                path.display()
            )));
        }
    };
    read_private_file_contents(file, path, max_bytes)
        .await
        .map(Some)
}

/// Write a private file through same-directory atomic replacement on Unix.
///
/// `path` must have a file name and be below a parent directory whose trust
/// the caller has already established, normally with [`ensure_private_dir`].
/// This function does not validate or retain the parent chain.
///
/// The content is written to a hidden UUID-named sibling created exclusively
/// with exact mode `0600`. After the writer is flushed and closed, the sibling
/// is renamed over the target so readers do not observe partial target
/// contents. Neither the file nor parent directory is fsynced, so this is not
/// a crash-durability guarantee. The function also provides no locking or
/// concurrent-writer ordering guarantee. After an error, staging-file removal
/// is attempted as best-effort cleanup.
pub async fn write_private_file(path: &Path, content: &[u8]) -> HostResult<()> {
    crate::host_file::write_private_atomic(path, content, "private file")
        .await
        .map_err(|e| HostError::Config(e.to_string()))
}

#[cfg(unix)]
fn ensure_private_dir_exists_without_symlinks(
    path: &Path,
    expected_uid: u32,
) -> HostResult<OwnedFd> {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;

    if path.as_os_str().is_empty() {
        return Err(HostError::Config(format!(
            "{} does not name a directory; refusing to use it as private runner state",
            path.display()
        )));
    }

    let start = if path.is_absolute() {
        Path::new("/")
    } else {
        Path::new(".")
    };
    let mut current = open(start, private_dir_open_flags(), Mode::empty()).map_err(|e| {
        HostError::Config(format!("open private dir root for {}: {e}", path.display()))
    })?;
    let mut current_path = start.to_path_buf();
    let mut components = path.components().peekable();
    while let Some(component) = components.next() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                return Err(HostError::Config(format!(
                    "{} contains a parent directory segment; refusing to use it as private runner state",
                    path.display()
                )));
            }
            Component::Normal(name) => {
                let is_final = components.peek().is_none();
                current = open_or_create_private_dir_component(
                    &current,
                    name,
                    &current_path,
                    path,
                    expected_uid,
                    is_final,
                )?;
                current_path = private_dir_component_path(&current_path, name);
            }
            Component::Prefix(prefix) => {
                return Err(HostError::Config(format!(
                    "{} contains unsupported path prefix {}; refusing to use it as private runner state",
                    path.display(),
                    prefix.as_os_str().to_string_lossy()
                )));
            }
        }
    }

    Ok(current)
}

#[cfg(unix)]
fn open_or_create_private_dir_component(
    parent: &(impl AsFd + AsRawFd),
    name: &OsStr,
    parent_path: &Path,
    full_path: &Path,
    expected_uid: u32,
    is_final: bool,
) -> HostResult<OwnedFd> {
    use nix::errno::Errno;
    use nix::fcntl::openat;
    use nix::sys::stat::Mode;

    let component_path = private_dir_component_path(parent_path, name);
    ensure_private_dir_parent_not_replaceable(parent, parent_path, full_path, expected_uid)?;
    match openat(parent, name, private_dir_open_flags(), Mode::empty()) {
        Ok(fd) => {
            secure_existing_private_dir_component(
                &fd,
                &component_path,
                full_path,
                expected_uid,
                is_final,
            )?;
            Ok(fd)
        }
        Err(Errno::ENOENT) => create_and_open_private_dir_component(
            parent,
            name,
            parent_path,
            full_path,
            expected_uid,
            is_final,
        ),
        Err(e) => Err(private_dir_component_error("open", name, full_path, e)),
    }
}

#[cfg(unix)]
fn ensure_private_dir_parent_not_replaceable(
    parent: &(impl AsFd + AsRawFd),
    parent_path: &Path,
    full_path: &Path,
    expected_uid: u32,
) -> HostResult<()> {
    use nix::sys::stat::fstat;

    let stat = fstat(parent).map_err(|e| {
        HostError::Config(format!(
            "stat private dir parent {} for {}: {e}",
            parent_path.display(),
            full_path.display()
        ))
    })?;
    let mode = (stat.st_mode as u32) & 0o7777;
    if stat.st_uid != ROOT_UID && stat.st_uid != expected_uid {
        return Err(HostError::Config(format!(
            "private dir parent {} is owned by untrusted uid {}; fix parent ownership before starting the runner",
            parent_path.display(),
            stat.st_uid
        )));
    }
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 && mode & STICKY_BIT == 0 {
        return Err(HostError::Config(format!(
            "private dir parent {} is group/other writable without the sticky bit; fix parent permissions before starting the runner",
            parent_path.display()
        )));
    }
    Ok(())
}

fn create_and_open_private_dir_component(
    parent: &(impl AsFd + AsRawFd),
    name: &OsStr,
    parent_path: &Path,
    full_path: &Path,
    expected_uid: u32,
    is_final: bool,
) -> HostResult<OwnedFd> {
    use nix::errno::Errno;
    use nix::fcntl::openat;
    use nix::sys::stat::{Mode, mkdirat};

    let component_path = private_dir_component_path(parent_path, name);
    let normalized_component = normalize_private_dir_policy_path(&component_path)?;
    if is_reserved_normalized_private_dir_path(&normalized_component) {
        return Err(HostError::Config(format!(
            "{} requires creating reserved system path {}; create runner home directories before starting the runner",
            full_path.display(),
            component_path.display()
        )));
    }

    let created = match mkdirat(parent, name, Mode::from_bits_truncate(PRIVATE_DIR_MODE)) {
        Ok(()) => true,
        Err(Errno::EEXIST) => false,
        Err(e) => {
            return Err(HostError::Config(format!(
                "create private dir component {} for {}: {e}",
                name.to_string_lossy(),
                full_path.display()
            )));
        }
    };
    let fd = openat(parent, name, private_dir_open_flags(), Mode::empty())
        .map_err(|e| private_dir_component_error("open", name, full_path, e))?;
    secure_existing_private_dir_component(
        &fd,
        &component_path,
        full_path,
        expected_uid,
        created || is_final,
    )?;
    Ok(fd)
}

#[cfg(unix)]
fn private_dir_component_path(parent_path: &Path, name: &OsStr) -> PathBuf {
    let mut path = parent_path.to_path_buf();
    path.push(Path::new(name));
    path
}

#[cfg(unix)]
fn secure_existing_private_dir_component(
    fd: &(impl AsFd + AsRawFd),
    component_path: &Path,
    full_path: &Path,
    expected_uid: u32,
    enforce_private_mode: bool,
) -> HostResult<()> {
    use nix::sys::stat::{SFlag, fstat};

    let stat = fstat(fd).map_err(|e| {
        HostError::Config(format!(
            "stat private dir component {} for {}: {e}",
            component_path.display(),
            full_path.display()
        ))
    })?;
    let fd_file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if fd_file_type != SFlag::S_IFDIR {
        return Err(HostError::Config(format!(
            "{} is not a directory; refusing to use it as private runner state",
            full_path.display()
        )));
    }

    let normalized_component = normalize_private_dir_policy_path(component_path)?;
    if is_reserved_normalized_private_dir_path(&normalized_component) {
        return Ok(());
    }

    let actual_uid = stat.st_uid;
    if actual_uid != expected_uid {
        return Err(HostError::Config(format!(
            "private dir component {} for {} is owned by uid {actual_uid}, but runner euid is {expected_uid}; fix ownership before starting the runner",
            component_path.display(),
            full_path.display()
        )));
    }

    let mode = (stat.st_mode as u32) & 0o7777;
    let group_or_other_writable = mode & GROUP_OR_OTHER_WRITE_BITS != 0;
    if group_or_other_writable && (enforce_private_mode || mode & STICKY_BIT == 0) {
        return Err(HostError::Config(format!(
            "private dir component {} for {} is group/other writable; fix permissions before starting the runner",
            component_path.display(),
            full_path.display()
        )));
    }
    if enforce_private_mode && mode != PRIVATE_DIR_MODE {
        chmod_open_private_dir(fd, component_path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn private_dir_component_error(
    operation: &str,
    name: &OsStr,
    full_path: &Path,
    error: nix::errno::Errno,
) -> HostError {
    match error {
        nix::errno::Errno::ELOOP => HostError::Config(format!(
            "{} contains symlink component {}; refusing to use it as private runner state",
            full_path.display(),
            name.to_string_lossy()
        )),
        nix::errno::Errno::ENOTDIR => HostError::Config(format!(
            "{} is not a directory; refusing to use it as private runner state",
            full_path.display()
        )),
        _ => HostError::Config(format!(
            "{operation} private dir component {} for {}: {error}",
            name.to_string_lossy(),
            full_path.display()
        )),
    }
}

#[cfg(unix)]
fn ensure_private_dir_fd_owned_by(path: &Path, fd: &OwnedFd, expected_uid: u32) -> HostResult<()> {
    use nix::sys::stat::{SFlag, fstat};

    let stat = fstat(fd)
        .map_err(|e| HostError::Config(format!("stat private dir fd {}: {e}", path.display())))?;
    let fd_file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if fd_file_type != SFlag::S_IFDIR {
        return Err(HostError::Config(format!(
            "{} is not a directory; refusing to use it as private runner state",
            path.display()
        )));
    }

    let actual_uid = stat.st_uid;
    if actual_uid != expected_uid {
        return Err(HostError::Config(format!(
            "{} is owned by uid {actual_uid}, but runner euid is {expected_uid}; fix ownership before starting the runner",
            path.display()
        )));
    }

    chmod_open_private_dir(fd, path)?;
    Ok(())
}

#[cfg(all(unix, target_os = "linux"))]
fn chmod_open_private_dir<Fd: std::os::fd::AsRawFd>(fd: &Fd, path: &Path) -> HostResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let fd_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
        .map_err(|e| HostError::Config(format!("chmod private dir {}: {e}", path.display())))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn chmod_open_private_dir<Fd: std::os::fd::AsFd>(fd: &Fd, path: &Path) -> HostResult<()> {
    nix::sys::stat::fchmod(
        fd,
        nix::sys::stat::Mode::from_bits_truncate(PRIVATE_DIR_MODE),
    )
    .map_err(|e| HostError::Config(format!("chmod private dir {}: {e}", path.display())))
}

#[cfg(all(unix, target_os = "linux"))]
fn private_dir_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_PATH
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, not(target_os = "linux")))]
fn private_dir_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_RDONLY
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(unix)]
fn reject_reserved_private_dir_path(path: &Path) -> HostResult<()> {
    let normalized = normalize_private_dir_policy_path(path)?;
    reject_reserved_normalized_private_dir_path(path, &normalized)
}

#[cfg(unix)]
fn normalize_private_dir_policy_path(path: &Path) -> HostResult<PathBuf> {
    let path = if path.is_relative() {
        std::env::current_dir()
            .map_err(|e| HostError::Config(format!("resolve private dir {}: {e}", path.display())))?
            .join(path)
    } else {
        path.to_path_buf()
    };
    Ok(normalize_path_lexically(&path))
}

#[cfg(test)]
#[cfg(unix)]
fn reject_reserved_private_dir_path_with_cwd(path: &Path, cwd: &Path) -> HostResult<()> {
    let normalized = normalize_path_lexically(&if path.is_relative() {
        cwd.join(path)
    } else {
        path.to_path_buf()
    });
    reject_reserved_normalized_private_dir_path(path, &normalized)
}

#[cfg(unix)]
fn reject_reserved_normalized_private_dir_path(
    original: &Path,
    normalized: &Path,
) -> HostResult<()> {
    if is_reserved_normalized_private_dir_path(normalized) {
        return Err(HostError::Config(format!(
            "{} is a reserved system path; refusing to use it as private runner state",
            original.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn is_reserved_normalized_private_dir_path(normalized: &Path) -> bool {
    if RESERVED_PRIVATE_DIR_PATHS
        .iter()
        .any(|reserved| normalized == Path::new(reserved))
    {
        return true;
    }

    let home = HomePaths::with_root(PathBuf::from(RUNNER_HOME_ROOT));
    if !normalized.starts_with(home.root()) {
        return false;
    }

    normalized == home.root()
        || normalized == home.runners_dir()
        || home
            .shared_subtree_roots()
            .any(|shared| normalized.starts_with(shared))
}

#[cfg(unix)]
fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    if normalized.as_os_str().is_empty() {
        path.to_path_buf()
    } else {
        normalized
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::test_support::{ignored_child_test_env_guard_enabled, run_ignored_child_test};
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
    use std::time::Duration;

    const FIFO_READ_CHILD_PATH_ENV: &str = "OKOU_RUN_PRIVATE_FILE_FIFO_READ_CHILD_PATH";

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn read_private_file_rejects_fifo_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner_id");
        let fifo_path = path.to_str().expect("temporary FIFO path must be UTF-8");
        run_ignored_child_test(
            "private_fs::tests::read_private_file_rejects_fifo_without_blocking_child",
            (FIFO_READ_CHILD_PATH_ENV, fifo_path),
            &[],
            Duration::from_secs(10),
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "spawned by read_private_file_rejects_fifo_without_blocking"]
    async fn read_private_file_rejects_fifo_without_blocking_child() {
        let Ok(path) = std::env::var(FIFO_READ_CHILD_PATH_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((FIFO_READ_CHILD_PATH_ENV, &path)) {
            return;
        }

        let path = PathBuf::from(path);
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: `c_path` is a valid nul-terminated path for `mkfifo`.
        let result = unsafe { nix::libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );

        let error = read_private_file_to_string(&path).await.unwrap_err();

        assert!(
            error.to_string().contains("not a regular private file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn read_private_file_rejects_large_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner_id");
        std::fs::write(
            &path,
            vec![b'x'; (PRIVATE_FILE_READ_MAX_BYTES + 1) as usize],
        )
        .unwrap();

        let error = read_private_file_to_string(&path).await.unwrap_err();

        assert!(
            error.to_string().contains("exceeds"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn read_private_file_rejects_group_writable_file_without_chmodding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner_id");
        std::fs::write(&path, b"x").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();

        let error = read_private_file_to_string(&path).await.unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert_eq!(mode(&path), 0o660);
    }

    #[tokio::test]
    async fn read_private_file_tightens_safe_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner_id");
        std::fs::write(&path, b"runner-123").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let contents = read_private_file_to_string(&path).await.unwrap();

        assert_eq!(contents.as_deref(), Some("runner-123"));
        assert_eq!(mode(&path), crate::host_file::PRIVATE_FILE_MODE);
    }

    #[tokio::test]
    async fn read_private_file_rejects_overflowing_read_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner_id");
        std::fs::write(&path, b"x").unwrap();

        let error = read_private_file_to_string_with_max(&path, u64::MAX)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("read limit is too large"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_creates_missing_dir_with_private_mode() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_private_dir_creates_missing_nested_dir_with_private_mode() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("nested").join("runner");

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_filesystem_root() {
        let error = ensure_private_dir(Path::new("/")).await.unwrap_err();

        assert!(
            error.to_string().contains("reserved system path"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_tightens_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&private_dir).unwrap();
        std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_private_dir_preserves_existing_intermediate_dir_mode() {
        let dir = tempfile::tempdir().unwrap();
        let intermediate = dir.path().join("nested");
        let private_dir = intermediate.join("runner");
        std::fs::create_dir(&intermediate).unwrap();
        std::fs::set_permissions(&intermediate, std::fs::Permissions::from_mode(0o755)).unwrap();

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&intermediate), 0o755);
        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn ensure_private_dir_repairs_unreadable_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&private_dir).unwrap();
        std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[test]
    fn create_private_dir_component_rejects_reserved_component() {
        use nix::fcntl::open;
        use nix::sys::stat::Mode;

        let dir = tempfile::tempdir().unwrap();
        let fd = open(dir.path(), private_dir_open_flags(), Mode::empty()).unwrap();

        let error = create_and_open_private_dir_component(
            &fd,
            OsStr::new("runners"),
            Path::new("/var/lib/vm0-runner"),
            Path::new("/var/lib/vm0-runner/runners/runner-01"),
            nix::unistd::geteuid().as_raw(),
            true,
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("reserved system path"),
            "unexpected error: {error}"
        );
        assert!(
            !dir.path().join("runners").exists(),
            "reserved component should not be created"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::write(&private_dir, b"not a dir").unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("not a directory"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_intermediate_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        let private_dir = file.join("runner");
        std::fs::write(&file, b"not a dir").unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("not a directory"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &private_dir).unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("symlink"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_symlink_with_trailing_separator() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &private_dir).unwrap();
        let private_dir_with_separator = PathBuf::from(format!("{}/", private_dir.display()));

        let error = ensure_private_dir(&private_dir_with_separator)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("symlink"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_intermediate_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        let private_dir = link.join("runner");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("symlink component"),
            "unexpected error: {error}"
        );
        assert!(
            !target.join("runner").exists(),
            "private dir should not be created through an intermediate symlink"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn ensure_private_dir_rejects_symlink_under_unreadable_intermediate_dir() {
        let dir = tempfile::tempdir().unwrap();
        let intermediate = dir.path().join("nested");
        let target = dir.path().join("target");
        let link = intermediate.join("link");
        let private_dir = link.join("runner");
        std::fs::create_dir(&intermediate).unwrap();
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();
        std::fs::set_permissions(&intermediate, std::fs::Permissions::from_mode(0o000)).unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();
        let message = error.to_string();

        assert!(
            message.contains("symlink component")
                || message.contains("not a directory")
                || message.contains("EACCES")
                || message.contains("Permission denied"),
            "unexpected error: {error}"
        );
        assert!(
            !target.join("runner").exists(),
            "private dir should not be created through a symlink hidden by an unreadable parent"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_parent_segments_before_creating_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing-prefix");
        let private_dir = missing.join("..").join("runner");

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("parent directory segment"),
            "unexpected error: {error}"
        );
        assert!(
            !missing.exists(),
            "private dir validation should not create path prefixes before rejecting parent segments"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_group_writable_parent_without_sticky_bit() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("shared");
        let private_dir = parent.join("runner");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert!(
            !private_dir.exists(),
            "private dir should not be created under a replaceable parent"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_allows_sticky_group_writable_parent() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("sticky");
        let private_dir = parent.join("runner");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o1777)).unwrap();

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_sticky_group_writable_final_dir() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&private_dir).unwrap();
        std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o1777)).unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert_eq!(mode(&private_dir), 0o777);
    }

    #[test]
    fn private_dir_parent_rejects_untrusted_owner() {
        use nix::fcntl::open;
        use nix::sys::stat::Mode;
        use nix::unistd::{Uid, chown};

        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("owned-by-other-user");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o555)).unwrap();
        if nix::unistd::geteuid().is_root() {
            chown(&parent, Some(Uid::from_raw(1)), None).unwrap();
        }
        let fd = open(&parent, private_dir_open_flags(), Mode::empty()).unwrap();

        let error =
            ensure_private_dir_parent_not_replaceable(&fd, &parent, &parent.join("runner"), 0)
                .unwrap_err();

        assert!(
            error.to_string().contains("untrusted uid"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn private_dir_parent_allows_root_owned_parent_for_non_root_expected_uid() {
        use nix::fcntl::open;
        use nix::sys::stat::Mode;
        use nix::unistd::{Uid, chown};

        if !nix::unistd::geteuid().is_root() {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("root-owned");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        chown(&parent, Some(Uid::from_raw(0)), None).unwrap();
        let fd = open(&parent, private_dir_open_flags(), Mode::empty()).unwrap();

        ensure_private_dir_parent_not_replaceable(&fd, &parent, &parent.join("runner"), 1000)
            .unwrap();
    }

    #[test]
    fn reserved_private_dir_path_rejects_lexical_parent_segments() {
        for path in ["/var/lib/../lib", "/..", "/var/../.."] {
            let error = reject_reserved_private_dir_path(Path::new(path))
                .expect_err("reserved path should be rejected");

            assert!(
                error.to_string().contains("reserved system path"),
                "unexpected error for {path}: {error}"
            );
        }
    }

    #[test]
    fn reserved_private_dir_path_rejects_relative_escape_from_cwd() {
        let cwd = Path::new("/var/lib/vm0-runner/runners/runner-01");

        for path in ["..", "../../.."] {
            let error = reject_reserved_private_dir_path_with_cwd(Path::new(path), cwd)
                .expect_err("reserved path should be rejected");

            assert!(
                error.to_string().contains("reserved system path"),
                "unexpected error for {path}: {error}"
            );
        }
    }

    #[test]
    fn reserved_private_dir_path_rejects_shared_home_subtrees() {
        let home = HomePaths::new().unwrap();
        let shared_roots = [
            home.bin_dir(),
            home.ca_dir(),
            home.runner_control_dir(),
            home.debootstrap_dir(),
            home.root().join("firecracker"),
            home.firecracker_dir("v1"),
            home.groups_dir(),
            home.images_dir(),
            home.locks_dir(),
            home.live_runner_instances_dir(),
            home.logs_dir(),
            home.root().join("mitmproxy"),
            home.mitmproxy_dir("v1"),
            home.storages_dir(),
            home.workspace_image_cache_dir(),
        ];
        for root in shared_roots {
            for path in [root.clone(), root.join("runner-state")] {
                let error = reject_reserved_private_dir_path(&path)
                    .expect_err("shared home subtree should be rejected");

                assert!(
                    error.to_string().contains("reserved system path"),
                    "unexpected error for {}: {error}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn reserved_private_dir_path_rejects_runner_control_dir_and_child() {
        let control = HomePaths::new().unwrap().runner_control_dir();
        for path in [control.clone(), control.join("runner-01")] {
            reject_reserved_private_dir_path(&path)
                .expect_err("runner control must remain shared state");
        }
        reject_reserved_private_dir_path(Path::new("/var/lib/vm0-runner/control-other")).unwrap();
    }

    #[test]
    fn reserved_private_dir_path_allows_runner_child_dir() {
        let home = HomePaths::new().unwrap();
        reject_reserved_private_dir_path(home.root()).expect_err("home root must be reserved");
        reject_reserved_private_dir_path(&home.runners_dir())
            .expect_err("runners parent must be reserved");
        reject_reserved_private_dir_path(Path::new("/var/lib/vm0-runner/runners/runner-01"))
            .unwrap();
        reject_reserved_private_dir_path(Path::new("/data/runner-01")).unwrap();
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_owner_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&private_dir).unwrap();
        let actual_uid = std::fs::metadata(&private_dir).unwrap().uid();
        let mismatched_uid = if actual_uid == 0 { 1 } else { 0 };

        let fd = ensure_private_dir_exists_without_symlinks(
            &private_dir,
            nix::unistd::geteuid().as_raw(),
        )
        .unwrap();
        let error = ensure_private_dir_fd_owned_by(&private_dir, &fd, mismatched_uid).unwrap_err();

        assert!(
            error.to_string().contains("owned by uid"),
            "unexpected error: {error}"
        );
    }
}
