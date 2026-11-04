//! Shared guest runtime path contract and private runtime file helpers.
//!
//! A guest runtime directory contains per-run files at its root plus `logs/`
//! and `telemetry/` subdirectories. Runner and guest binaries use these helpers
//! so both sides agree on the same filesystem layout.

use std::env;
use std::ffi::OsString;
use std::fs::File;
#[cfg(not(unix))]
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::path::Component;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::ffi::{CString, OsStr};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use uuid::Uuid;

/// Environment variable that overrides the complete guest runtime directory.
///
/// When set to a non-empty absolute path, this value is used as the run
/// directory directly instead of deriving one from `HOME` and a run id.
pub const CANONICAL_GUEST_RUNTIME_DIR_ENV: &str = "OKOU_GUEST_RUNTIME_DIR";
/// Fixed fallback path used when a storage manifest exceeds the stdin limit.
pub const STORAGE_MANIFEST_PATH: &str = "/tmp/storage-manifest.json";
const DEFAULT_RUNTIME_PARENT: &str = ".vm0/guest-agent/runs";
#[cfg(unix)]
const PRIVATE_DIR_MODE: libc::mode_t = 0o700;
#[cfg(unix)]
const PRIVATE_FILE_MODE: libc::mode_t = 0o600;

/// Error returned when resolving a guest runtime path contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePathError {
    /// The fallback runtime directory layout requires a non-empty run id.
    MissingRunId,
    /// The run id is not a safe single path segment.
    InvalidRunId,
    /// The fallback runtime directory layout requires a non-empty `HOME`.
    MissingHome,
    /// `OKOU_GUEST_RUNTIME_DIR` was set to a relative path.
    InvalidRuntimeDir,
}

impl std::fmt::Display for RuntimePathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingRunId => f.write_str("OKOU_RUN_ID is required for guest runtime paths"),
            Self::InvalidRunId => f.write_str("OKOU_RUN_ID must be a single safe path segment"),
            Self::MissingHome => f.write_str("HOME is required for guest runtime paths"),
            Self::InvalidRuntimeDir => {
                f.write_str("OKOU_GUEST_RUNTIME_DIR must be an absolute path")
            }
        }
    }
}

impl std::error::Error for RuntimePathError {}

fn is_safe_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id != "."
        && run_id != ".."
        && !run_id.contains('/')
        && !run_id.contains('\\')
        && !run_id.contains('\0')
}

/// Validate that a run id is safe to use as one path segment.
///
/// Safe run ids are non-empty and are not `.`, `..`, slash-separated,
/// backslash-separated, or NUL-containing.
pub fn validate_run_id(run_id: &str) -> Result<(), RuntimePathError> {
    if run_id.is_empty() {
        return Err(RuntimePathError::MissingRunId);
    }
    if !is_safe_run_id(run_id) {
        return Err(RuntimePathError::InvalidRunId);
    }
    Ok(())
}

/// Return the parent reserved for runner-owned per-Run runtime state.
#[must_use]
pub fn runtime_parent_for_home(guest_home: impl AsRef<Path>) -> PathBuf {
    guest_home.as_ref().join(DEFAULT_RUNTIME_PARENT)
}

/// Build the default runtime directory for a guest home and run id.
///
/// The returned path is `<guest_home>/.vm0/guest-agent/runs/<run_id>`.
/// The run id is validated before it is appended.
pub fn run_dir_for_home(
    guest_home: impl AsRef<Path>,
    run_id: &str,
) -> Result<PathBuf, RuntimePathError> {
    validate_run_id(run_id)?;
    Ok(runtime_parent_for_home(guest_home).join(run_id))
}

fn canonical_guest_runtime_dir(
    value: Option<OsString>,
) -> Result<Option<PathBuf>, RuntimePathError> {
    let runtime_dir = value.filter(|value| !value.is_empty()).map(PathBuf::from);
    if runtime_dir
        .as_deref()
        .is_some_and(|runtime_dir| !runtime_dir.is_absolute())
    {
        return Err(RuntimePathError::InvalidRuntimeDir);
    }
    Ok(runtime_dir)
}

/// Capture the canonical guest runtime-directory override exactly once.
pub fn guest_runtime_dir_env_from_process_env() -> Result<Option<PathBuf>, RuntimePathError> {
    canonical_guest_runtime_dir(env::var_os(CANONICAL_GUEST_RUNTIME_DIR_ENV))
}

/// Resolve a complete run directory from already captured values.
pub fn run_dir_from_captured_env(
    run_id: &str,
    runtime_dir: Option<&Path>,
    process_home: Option<&Path>,
) -> Result<PathBuf, RuntimePathError> {
    if let Some(runtime_dir) = runtime_dir {
        if !runtime_dir.is_absolute() {
            return Err(RuntimePathError::InvalidRuntimeDir);
        }
        return Ok(runtime_dir.to_path_buf());
    }

    let home = process_home
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or(RuntimePathError::MissingHome)?;
    run_dir_for_home(home, run_id)
}

/// Resolve the runtime directory from process environment.
///
/// A non-empty absolute canonical override wins and is returned as the complete
/// runtime directory. In that override branch, `run_id` is not validated and
/// is not appended. An empty override is ignored, a relative override returns
/// [`RuntimePathError::InvalidRuntimeDir`], and fallback resolution uses `HOME`
/// plus [`run_dir_for_home`].
pub fn run_dir_from_env(run_id: &str) -> Result<PathBuf, RuntimePathError> {
    let runtime_dir = guest_runtime_dir_env_from_process_env()?;
    let home = env::var_os("HOME").map(PathBuf::from);
    run_dir_from_captured_env(run_id, runtime_dir.as_deref(), home.as_deref())
}

fn file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join(name)
}

fn log_file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join("logs").join(name)
}

fn telemetry_file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join("telemetry").join(name)
}

/// Return the run-root `session-id` file.
pub fn session_id_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "session-id")
}

/// Return the run-root Guest error file.
///
/// Runner and Guest share this private path within their coupled artifact.
pub fn finalization_error_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "finalization-error")
}

/// Return the run-root `final-session-history-identity.json` file.
pub fn final_session_history_identity_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "final-session-history-identity.json")
}

/// Return the run-root `failure-diagnostic.json` file.
pub fn failure_diagnostic_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "failure-diagnostic.json")
}

/// Return the private Pi launch payload file written for the Pi CLI child.
pub fn pi_launch_payload_file(run_dir: impl AsRef<Path>) -> PathBuf {
    run_dir
        .as_ref()
        .join(crate::env::PI_LAUNCH_PAYLOAD_PRIVATE_DIR_NAME)
        .join(crate::env::PI_LAUNCH_PAYLOAD_FILENAME)
}

/// Return the private Claude appended-system-prompt file.
pub fn claude_append_system_prompt_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "claude-append-system-prompt")
}

/// Return the `logs/system.log` file.
pub fn system_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "system.log")
}

/// Return the `logs/agent.jsonl` file.
pub fn agent_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "agent.jsonl")
}

/// Return the `logs/metrics.jsonl` file.
pub fn metrics_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "metrics.jsonl")
}

/// Return the `logs/sandbox-ops.jsonl` file.
pub fn sandbox_ops_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "sandbox-ops.jsonl")
}

/// Return the `telemetry/system-log.pos` offset file.
pub fn telemetry_system_log_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "system-log.pos")
}

/// Return the `telemetry/metrics.pos` offset file.
pub fn telemetry_metrics_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "metrics.pos")
}

/// Return the `telemetry/sandbox-ops.pos` offset file.
pub fn telemetry_sandbox_ops_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "sandbox-ops.pos")
}

#[cfg(unix)]
fn permission_denied(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

#[cfg(unix)]
fn wrap_last_os_error(context: String) -> io::Error {
    let error = io::Error::last_os_error();
    io::Error::new(error.kind(), format!("{context}: {error}"))
}

#[cfg(unix)]
fn wrap_io_error(error: io::Error, context: String) -> io::Error {
    io::Error::new(error.kind(), format!("{context}: {error}"))
}

#[cfg(unix)]
fn component_cstring(name: &OsStr, path: &Path) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} contains a NUL byte in component {}",
                path.display(),
                name.to_string_lossy()
            ),
        )
    })
}

#[cfg(unix)]
fn open_dir_root(path: &Path) -> io::Result<OwnedFd> {
    let root = if path.is_absolute() { "/" } else { "." };
    let root = CString::new(root).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid runtime directory root: {error}"),
        )
    })?;
    // SAFETY: `root` is NUL-terminated and points to a static path string.
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(wrap_last_os_error(format!(
            "open runtime directory root for {}",
            path.display()
        )));
    }
    // SAFETY: `fd` is a fresh descriptor returned by `open`.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[cfg(unix)]
fn dir_open_flags() -> libc::c_int {
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
}

#[cfg(unix)]
fn validate_dir_fd(fd: &OwnedFd, path: &Path) -> io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `fd` owns a live descriptor.
    let result = unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(wrap_last_os_error(format!(
            "stat runtime directory {}",
            path.display()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(permission_denied(format!(
            "{} is not a runtime directory",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn chmod_dir_fd(fd: &OwnedFd, path: &Path) -> io::Result<()> {
    // SAFETY: `fd` owns a live directory descriptor.
    let result = unsafe { libc::fchmod(fd.as_raw_fd(), PRIVATE_DIR_MODE) };
    if result == 0 {
        Ok(())
    } else {
        Err(wrap_last_os_error(format!(
            "chmod runtime directory {}",
            path.display()
        )))
    }
}

#[cfg(target_os = "linux")]
fn chmod_proc_fd_path(fd: &OwnedFd, name: &OsStr, full_path: &Path) -> io::Result<()> {
    let proc_fd_path =
        CString::new(format!("/proc/self/fd/{}", fd.as_raw_fd())).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid proc fd path while chmodding runtime directory: {error}"),
            )
        })?;
    // SAFETY: `proc_fd_path` is NUL-terminated and points to this process's
    // still-open O_PATH fd, so chmod applies to the pinned directory.
    let result = unsafe { libc::chmod(proc_fd_path.as_ptr(), PRIVATE_DIR_MODE) };
    if result == 0 {
        Ok(())
    } else {
        Err(wrap_last_os_error(format!(
            "chmod newly-created runtime directory component {} for {} through proc fd",
            name.to_string_lossy(),
            full_path.display()
        )))
    }
}

#[cfg(target_os = "linux")]
fn chmod_created_dir_component(
    parent: &OwnedFd,
    name: &OsStr,
    name_c: &CString,
    full_path: &Path,
) -> io::Result<()> {
    // `mkdirat` applies the process umask. Open the directory with O_PATH first
    // so a restrictive umask cannot prevent us from correcting the mode.
    // SAFETY: `name_c` is NUL-terminated and `parent` owns a live directory fd.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name_c.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(dir_component_error(
            "open newly-created",
            parent,
            name,
            name_c,
            full_path,
        ));
    }
    // SAFETY: `fd` is a fresh descriptor returned by `openat`.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let empty_path = b"\0";
    // SAFETY: `fd` owns a live O_PATH directory descriptor and empty_path is
    // NUL-terminated for AT_EMPTY_PATH.
    let result = unsafe {
        libc::fchmodat(
            fd.as_raw_fd(),
            empty_path.as_ptr().cast(),
            PRIVATE_DIR_MODE,
            libc::AT_EMPTY_PATH,
        )
    };
    if result == 0 {
        return Ok(());
    }

    let error = io::Error::last_os_error();
    if matches!(
        error.raw_os_error(),
        Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP)
    ) {
        // Older kernels may not support fchmodat(AT_EMPTY_PATH). The O_PATH fd
        // still pins the directory, so chmod through /proc/self/fd instead of
        // falling back to the original path.
        return chmod_proc_fd_path(&fd, name, full_path);
    }

    Err(io::Error::new(
        error.kind(),
        format!(
            "chmod newly-created runtime directory component {} for {}: {error}",
            name.to_string_lossy(),
            full_path.display()
        ),
    ))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn chmod_created_dir_component(
    _parent: &OwnedFd,
    _name: &OsStr,
    _name_c: &CString,
    _full_path: &Path,
) -> io::Result<()> {
    // Non-Linux Unix targets do not have Linux's O_PATH + AT_EMPTY_PATH fd-only
    // chmod flow. Keep the secure fd validation path below instead of adding a
    // path-based chmod race for non-guest development targets.
    Ok(())
}

#[cfg(unix)]
fn component_is_symlink(parent: &OwnedFd, name_c: &CString) -> io::Result<bool> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `name_c` is NUL-terminated, `parent` owns a live directory fd,
    // and `stat` points to writable memory.
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name_c.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful `fstatat` initialized the full struct.
    let stat = unsafe { stat.assume_init() };
    Ok(stat.st_mode & libc::S_IFMT == libc::S_IFLNK)
}

#[cfg(unix)]
fn dir_component_error(
    operation: &str,
    parent: &OwnedFd,
    name: &OsStr,
    name_c: &CString,
    full_path: &Path,
) -> io::Error {
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(code) if code == libc::ELOOP => permission_denied(format!(
            "{} contains symlink component {}; refusing to use it as runtime directory",
            full_path.display(),
            name.to_string_lossy()
        )),
        Some(code) if code == libc::ENOTDIR => match component_is_symlink(parent, name_c) {
            Ok(true) => permission_denied(format!(
                "{} contains symlink component {}; refusing to use it as runtime directory",
                full_path.display(),
                name.to_string_lossy()
            )),
            Ok(false) => io::Error::new(
                io::ErrorKind::NotADirectory,
                format!(
                    "{} is not a directory; refusing to use it as runtime directory",
                    full_path.display()
                ),
            ),
            Err(stat_error) => io::Error::new(
                error.kind(),
                format!(
                    "{operation} runtime directory component {} for {}: {error}; failed to inspect component after ENOTDIR: {stat_error}",
                    name.to_string_lossy(),
                    full_path.display()
                ),
            ),
        },
        _ => io::Error::new(
            error.kind(),
            format!(
                "{operation} runtime directory component {} for {}: {error}",
                name.to_string_lossy(),
                full_path.display()
            ),
        ),
    }
}

#[cfg(unix)]
fn component_path(parent_path: &Path, name: &OsStr) -> PathBuf {
    let mut path = parent_path.to_path_buf();
    path.push(Path::new(name));
    path
}

#[cfg(unix)]
fn open_or_create_dir_component(
    parent: &OwnedFd,
    parent_path: &Path,
    name: &OsStr,
    full_path: &Path,
    is_final: bool,
) -> io::Result<OwnedFd> {
    let name_c = component_cstring(name, full_path)?;
    let path = component_path(parent_path, name);
    // SAFETY: `name_c` is NUL-terminated and `parent` owns a live directory fd.
    let mut fd = unsafe { libc::openat(parent.as_raw_fd(), name_c.as_ptr(), dir_open_flags()) };
    let mut created = false;
    if fd < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        // SAFETY: `name_c` is NUL-terminated and `parent` owns a live directory fd.
        let mkdir_result =
            unsafe { libc::mkdirat(parent.as_raw_fd(), name_c.as_ptr(), PRIVATE_DIR_MODE) };
        if mkdir_result != 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(wrap_last_os_error(format!(
                "create runtime directory component {} for {}",
                name.to_string_lossy(),
                full_path.display()
            )));
        }
        if mkdir_result == 0 {
            created = true;
            chmod_created_dir_component(parent, name, &name_c, full_path)?;
        }
        // SAFETY: `name_c` is NUL-terminated and `parent` owns a live directory fd.
        fd = unsafe { libc::openat(parent.as_raw_fd(), name_c.as_ptr(), dir_open_flags()) };
    }
    if fd < 0 {
        return Err(dir_component_error(
            "open", parent, name, &name_c, full_path,
        ));
    }

    // SAFETY: `fd` is a fresh descriptor returned by `openat`.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    validate_dir_fd(&fd, &path)?;
    if is_final || created {
        chmod_dir_fd(&fd, &path)?;
    }
    Ok(fd)
}

#[cfg(unix)]
fn open_or_create_private_dir(path: &Path) -> io::Result<OwnedFd> {
    if path.as_os_str().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime directory path is empty",
        ));
    }
    validate_dir_path_components(path)?;

    let mut current = open_dir_root(path)?;
    let mut current_path = if path.is_absolute() {
        PathBuf::from("/")
    } else {
        PathBuf::from(".")
    };
    let mut components = path.components().peekable();
    let mut saw_normal_component = false;

    while let Some(component) = components.next() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                return Err(permission_denied(format!(
                    "{} contains a parent directory segment",
                    path.display()
                )));
            }
            Component::Normal(name) => {
                saw_normal_component = true;
                let is_final = components.peek().is_none();
                current =
                    open_or_create_dir_component(&current, &current_path, name, path, is_final)?;
                current_path = component_path(&current_path, name);
            }
            Component::Prefix(prefix) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{} contains unsupported path prefix {}",
                        path.display(),
                        prefix.as_os_str().to_string_lossy()
                    ),
                ));
            }
        }
    }

    if !saw_normal_component {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime directory path has no components: {}",
                path.display()
            ),
        ));
    }

    Ok(current)
}

#[cfg(unix)]
fn validate_dir_path_components(path: &Path) -> io::Result<()> {
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => {
                component_cstring(name, path)?;
            }
            Component::ParentDir => {
                return Err(permission_denied(format!(
                    "{} contains a parent directory segment",
                    path.display()
                )));
            }
            Component::Prefix(prefix) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{} contains unsupported path prefix {}",
                        path.display(),
                        prefix.as_os_str().to_string_lossy()
                    ),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_dir_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Ensure a runtime-private directory exists.
///
/// On Unix, missing directories are created with `0700` permissions, the final
/// directory is tightened to `0700` when it already exists, parent-directory
/// components are rejected, and symlinked parent components are rejected. On
/// non-Unix targets, this creates the directory path without claiming
/// equivalent permission or symlink guarantees.
pub fn ensure_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    #[cfg(unix)]
    {
        open_or_create_private_dir(path)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)?;
        set_dir_private(path)
    }
}

/// Ensure the parent directory for a runtime path exists.
///
/// This applies [`ensure_dir`] to the path's parent and returns
/// [`io::ErrorKind::InvalidInput`] when the path has no parent.
///
/// On Unix, missing directory components are created with `0700` permissions,
/// an existing final parent directory is tightened to `0700`, and `..` or
/// symlinked components are rejected. On non-Unix targets, this creates the
/// parent path without claiming equivalent permission or symlink guarantees.
pub fn ensure_parent_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("runtime path has no parent: {}", path.display()),
        )
    })?;
    ensure_dir(parent)
}

#[cfg(not(unix))]
fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    options
}

#[cfg(unix)]
fn set_file_private(file: &File) -> io::Result<()> {
    // SAFETY: `file` owns a live descriptor.
    let result = unsafe { libc::fchmod(file.as_raw_fd(), PRIVATE_FILE_MODE) };
    if result == 0 {
        Ok(())
    } else {
        Err(wrap_last_os_error("chmod runtime file".to_string()))
    }
}

#[cfg(not(unix))]
fn set_file_private(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn file_name(path: &Path) -> io::Result<&OsStr> {
    let bytes = path.as_os_str().as_bytes();
    if bytes.last() == Some(&b'/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime path must not end with a directory separator: {}",
                path.display()
            ),
        ));
    }

    let last_raw_component = bytes.rsplit(|byte| *byte == b'/').next().unwrap_or(bytes);
    if matches!(last_raw_component, b"." | b"..") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("runtime path has no file name: {}", path.display()),
        ));
    }

    path.file_name()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("runtime path has no file name: {}", path.display()),
            )
        })
}

#[cfg(unix)]
fn parent_dir(path: &Path) -> io::Result<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("runtime path has no parent: {}", path.display()),
            )
        })
}

#[cfg(unix)]
fn open_private_file(path: &Path, append: bool, create_new: bool) -> io::Result<File> {
    let name = file_name(path)?;
    let name_c = component_cstring(name, path)?;
    let parent = parent_dir(path)?;
    let parent = open_or_create_private_dir(parent)?;
    let mut flags =
        libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    if append {
        flags |= libc::O_APPEND;
    } else {
        flags |= libc::O_TRUNC;
    }
    if create_new {
        flags |= libc::O_EXCL;
    }

    // SAFETY: `name_c` is NUL-terminated and `parent` owns a verified directory fd.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name_c.as_ptr(),
            flags,
            PRIVATE_FILE_MODE,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        let error = if error.raw_os_error() == Some(libc::ELOOP) {
            permission_denied(format!(
                "{} is a symlink; refusing to use it as runtime file",
                path.display()
            ))
        } else {
            wrap_io_error(error, format!("open runtime file {}", path.display()))
        };
        return Err(error);
    }
    // SAFETY: `fd` is a fresh descriptor returned by `openat`.
    let file = unsafe { File::from_raw_fd(fd) };
    secure_regular_private_file(&file, path)?;
    Ok(file)
}

#[cfg(unix)]
fn secure_regular_private_file(file: &File, path: &Path) -> io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live descriptor.
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(wrap_last_os_error(format!(
            "stat runtime file {}",
            path.display()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(permission_denied(format!(
            "{} is not a regular runtime file",
            path.display()
        )));
    }
    set_file_private(file)?;
    Ok(())
}

#[cfg(unix)]
fn validate_existing_private_file(file: &File, path: &Path, max_bytes: u64) -> io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live descriptor.
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(wrap_last_os_error(format!(
            "stat private runtime file {}",
            path.display()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(permission_denied(format!(
            "{} is not a regular private runtime file",
            path.display()
        )));
    }
    // SAFETY: `geteuid` only reads the effective process credential.
    let effective_uid = unsafe { libc::geteuid() };
    if stat.st_uid != effective_uid {
        return Err(permission_denied(format!(
            "{} is not owned by the effective user",
            path.display()
        )));
    }
    if stat.st_mode & 0o077 != 0 {
        return Err(permission_denied(format!(
            "{} grants group or other permissions",
            path.display()
        )));
    }
    let size = u64::try_from(stat.st_size).unwrap_or(u64::MAX);
    if size > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} exceeds the private runtime file limit of {max_bytes} bytes",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn open_existing_private_file(path: &Path, max_bytes: u64) -> io::Result<Option<File>> {
    let name = file_name(path)?;
    let name_c = component_cstring(name, path)?;
    let parent = open_or_create_private_dir(parent_dir(path)?)?;
    // O_NONBLOCK prevents a hostile special file from blocking before fstat
    // rejects it. O_NOFOLLOW keeps the final component descriptor-bound.
    // SAFETY: `name_c` is NUL-terminated and `parent` owns a verified directory fd.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name_c.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOENT) => Ok(None),
            Some(libc::ELOOP) => Err(permission_denied(format!(
                "{} is a symlink; refusing to read it as a private runtime file",
                path.display()
            ))),
            _ => Err(wrap_io_error(
                error,
                format!("open private runtime file {}", path.display()),
            )),
        };
    }
    // SAFETY: `fd` is a fresh descriptor returned by `openat`.
    let file = unsafe { File::from_raw_fd(fd) };
    validate_existing_private_file(&file, path, max_bytes)?;
    Ok(Some(file))
}

/// Read a bounded runtime-private file without following symlinks.
///
/// A missing file returns `Ok(None)`. On Unix, every parent component and the
/// final file are opened without following symlinks. The final file must be a
/// regular file owned by the effective user with no group or other permission
/// bits. The size is checked both before and while reading.
///
/// **Side effects.** On Unix, the read first prepares the parent directory with
/// the same semantics as [`ensure_dir`]. Missing parent components are created
/// with `0700`, and an existing final parent directory is tightened to `0700`,
/// before the final file lookup and validation. These changes may remain after
/// `Ok(None)` or an error, so callers need permission to create missing
/// directory components and `chmod` the final parent. On non-Unix targets, the
/// function uses `File::open` directly and does not perform this parent
/// preparation.
pub fn read_private_bounded(
    path: impl AsRef<Path>,
    max_bytes: usize,
) -> io::Result<Option<Vec<u8>>> {
    let path = path.as_ref();
    #[cfg(unix)]
    let file = open_existing_private_file(path, u64::try_from(max_bytes).unwrap_or(u64::MAX))?;
    #[cfg(not(unix))]
    let file = match File::open(path) {
        Ok(file) => Some(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };

    let Some(file) = file else {
        return Ok(None);
    };
    let read_limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::with_capacity(max_bytes.min(8 * 1024));
    file.take(read_limit).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} exceeds the private runtime file limit of {max_bytes} bytes",
                path.display()
            ),
        ));
    }
    Ok(Some(bytes))
}

#[cfg(unix)]
fn replacement_name() -> OsString {
    // A process can be killed before rename and leave this sibling behind.
    // A random process-independent name prevents PID reuse after restart from
    // turning that stale file into a permanent O_EXCL collision.
    OsString::from_vec(format!(".vm0-private-replacement-{}", Uuid::new_v4()).into_bytes())
}

/// Policy for an existing final entry during private atomic replacement.
///
/// These target guarantees apply on Unix. Non-Unix platforms accept the
/// policy for API consistency without claiming equivalent file-type,
/// permission, ownership, or symlink validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivateFileReplacementTarget {
    /// On Unix, require a missing target or an existing private regular file.
    PrivateFileOrMissing,
    /// On Unix, replace the final entry without opening or following it.
    ReplaceFinalEntry,
}

#[cfg(unix)]
fn validate_replace_target(parent: &OwnedFd, name: &OsStr, path: &Path) -> io::Result<()> {
    let name_c = component_cstring(name, path)?;
    // SAFETY: `name_c` is NUL-terminated and `parent` owns a verified directory fd.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name_c.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOENT) => Ok(()),
            Some(libc::ELOOP) => Err(permission_denied(format!(
                "{} is a symlink; refusing to replace it as a private runtime file",
                path.display()
            ))),
            _ => Err(wrap_io_error(
                error,
                format!("open private runtime replacement target {}", path.display()),
            )),
        };
    }
    // SAFETY: `fd` is a fresh descriptor returned by `openat`.
    let file = unsafe { File::from_raw_fd(fd) };
    validate_existing_private_file(&file, path, u64::MAX)
}

#[cfg(unix)]
fn sync_private_replacement_directory(parent: &OwnedFd) -> io::Result<()> {
    // SAFETY: `parent` owns a live directory descriptor.
    if unsafe { libc::fsync(parent.as_raw_fd()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn replace_private_atomic_unix(
    path: &Path,
    bytes: &[u8],
    target: PrivateFileReplacementTarget,
    sync_file: impl FnOnce(&File) -> io::Result<()>,
    sync_directory: impl FnOnce(&OwnedFd) -> io::Result<()>,
) -> io::Result<()> {
    let name = file_name(path)?;
    let name_c = component_cstring(name, path)?;
    let parent = open_or_create_private_dir(parent_dir(path)?)?;
    match target {
        PrivateFileReplacementTarget::PrivateFileOrMissing => {
            validate_replace_target(&parent, name, path)?;
        }
        PrivateFileReplacementTarget::ReplaceFinalEntry => {}
    }

    let temp_name = replacement_name();
    let temp_name_c = component_cstring(&temp_name, path)?;
    // SAFETY: `temp_name_c` is NUL-terminated and `parent` owns a verified directory fd.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temp_name_c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            PRIVATE_FILE_MODE,
        )
    };
    if fd < 0 {
        return Err(wrap_last_os_error(format!(
            "create atomic private replacement for {}",
            path.display()
        )));
    }
    // SAFETY: `fd` is a fresh descriptor returned by `openat`.
    let mut file = unsafe { File::from_raw_fd(fd) };
    let operation = (|| {
        set_file_private(&file)?;
        file.write_all(bytes)?;
        sync_file(&file)?;
        // SAFETY: both names are NUL-terminated and `parent` pins the source
        // and destination directory for the atomic replacement.
        let result = unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                temp_name_c.as_ptr(),
                parent.as_raw_fd(),
                name_c.as_ptr(),
            )
        };
        if result != 0 {
            return Err(wrap_last_os_error(format!(
                "publish atomic private replacement for {}",
                path.display()
            )));
        }
        sync_directory(&parent).map_err(|error| {
            wrap_io_error(
                error,
                format!(
                    "sync atomic private replacement directory for {}",
                    path.display()
                ),
            )
        })?;
        Ok(())
    })();
    if operation.is_err() {
        // SAFETY: `temp_name_c` is NUL-terminated and `parent` owns the
        // directory. Failure here must not hide the original operation error.
        unsafe {
            libc::unlinkat(parent.as_raw_fd(), temp_name_c.as_ptr(), 0);
        }
    }
    operation
}

#[cfg(not(unix))]
fn replace_private_atomic_non_unix(
    path: &Path,
    bytes: &[u8],
    _target: PrivateFileReplacementTarget,
) -> io::Result<()> {
    ensure_parent_dir(path)?;
    let temp_path = path.with_file_name(format!(".vm0-private-replacement-{}", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)?;
    let operation = (|| {
        set_file_private(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp_path, path)
    })();
    if operation.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    operation
}

/// Atomically replace a runtime-private file with complete bytes.
///
/// On Unix, the replacement is written to an exclusively created `0600`
/// sibling, synced, and published with descriptor-relative `renameat` before
/// the parent directory is synced. Parent symlinks are always rejected.
/// [`PrivateFileReplacementTarget::PrivateFileOrMissing`] also rejects final
/// symlinks, non-regular targets, foreign ownership, and group/other
/// permissions. [`PrivateFileReplacementTarget::ReplaceFinalEntry`] replaces
/// an existing non-directory final entry without opening or following it.
/// Existing readers therefore observe either the previous complete file or
/// the new complete file. On non-Unix platforms, the target policy adds no
/// guarantees beyond the platform's rename behavior.
pub fn replace_private_atomic(
    path: impl AsRef<Path>,
    bytes: impl AsRef<[u8]>,
    target: PrivateFileReplacementTarget,
) -> io::Result<()> {
    #[cfg(unix)]
    {
        replace_private_atomic_unix(
            path.as_ref(),
            bytes.as_ref(),
            target,
            File::sync_all,
            sync_private_replacement_directory,
        )
    }
    #[cfg(not(unix))]
    {
        replace_private_atomic_non_unix(path.as_ref(), bytes.as_ref(), target)
    }
}

#[cfg(unix)]
/// Create or truncate a runtime-private file.
///
/// On Unix, missing parent directories are created with `0700` permissions, an
/// existing final parent directory is tightened to `0700`, and `..` or
/// symlinked parent components are rejected. The final path must be a regular
/// file rather than a symlink, and its permissions are tightened to `0600`.
pub fn create_private(path: impl AsRef<Path>) -> io::Result<File> {
    open_private_file(path.as_ref(), false, false)
}

#[cfg(not(unix))]
/// Create or truncate a runtime-private file.
///
/// On non-Unix targets, parent directories are created and the file is created
/// or truncated without claiming equivalent permission or symlink guarantees.
pub fn create_private(path: impl AsRef<Path>) -> io::Result<File> {
    let path = path.as_ref();
    ensure_parent_dir(path)?;
    let file = private_file_options().open(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("open runtime file {}: {e}", path.display()),
        )
    })?;
    set_file_private(&file)?;
    Ok(file)
}

/// Write bytes to a runtime-private file.
///
/// This creates or truncates the file through [`create_private`], then writes
/// all provided bytes.
///
/// On Unix, missing parent directories are created with `0700` permissions, an
/// existing final parent directory is tightened to `0700`, and `..` or
/// symlinked parent components are rejected. The final path must be a regular
/// file rather than a symlink, and its permissions are tightened to `0600`. On
/// non-Unix targets, parent directories are created and the file is created or
/// truncated without claiming equivalent permission or symlink guarantees.
pub fn write_private(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    let mut file = create_private(path)?;
    std::io::Write::write_all(&mut file, bytes.as_ref())
}

/// Exclusively create and write a runtime-private file.
///
/// Returns [`io::ErrorKind::AlreadyExists`] without changing an existing final
/// entry. Parent and file safety guarantees otherwise match [`write_private`].
pub fn write_private_new(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    let path = path.as_ref();
    #[cfg(unix)]
    let mut file = open_private_file(path, false, true)?;
    #[cfg(not(unix))]
    let mut file = {
        ensure_parent_dir(path)?;
        let file = OpenOptions::new().write(true).create_new(true).open(path)?;
        set_file_private(&file)?;
        file
    };
    std::io::Write::write_all(&mut file, bytes.as_ref())
}

#[cfg(not(unix))]
fn private_append_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    options
}

#[cfg(unix)]
/// Open a runtime-private file for append, creating it if it is missing.
///
/// On Unix, missing parent directories are created with `0700` permissions, an
/// existing final parent directory is tightened to `0700`, and `..` or
/// symlinked parent components are rejected. The final path must be a regular
/// file rather than a symlink, and its permissions are tightened to `0600`.
pub fn open_private_append(path: impl AsRef<Path>) -> io::Result<File> {
    open_private_file(path.as_ref(), true, false)
}

#[cfg(not(unix))]
/// Open a runtime-private file for append, creating it if it is missing.
///
/// On non-Unix targets, missing parent directories are created without
/// claiming equivalent permission or symlink guarantees.
pub fn open_private_append(path: impl AsRef<Path>) -> io::Result<File> {
    let path = path.as_ref();
    ensure_parent_dir(path)?;
    let file = private_append_options().open(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("open runtime file {}: {e}", path.display()),
        )
    })?;
    set_file_private(&file)?;
    Ok(file)
}

#[cfg(test)]
fn path_is_under(path: &Path, parent: &Path) -> bool {
    path.starts_with(parent)
}

#[cfg(test)]
mod tests;
