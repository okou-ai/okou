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
    let contents = crate::host_file::read_bounded_contents(file, path, max_bytes, "private file")
        .await
        .map_err(|error| HostError::Config(error.to_string()))?;
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
///
/// On Unix, created staging retains a cleanup owner across cancellation of
/// the opening or writing observer. Drop attempts a synchronous unlink; it
/// does not retain caller authority or cancel an already submitted rename.
/// Publication can therefore remain uncertain after cancellation.
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
mod tests;
