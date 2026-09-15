//! Reclaims runner-owned runtime state before a completed guest enters idle reuse.
//!
//! This module is the guest-side safety boundary for idle admission. The runner invokes the helper
//! as part of the final guest exec before parking a sandbox and admits the sandbox to the idle pool
//! only after the helper report passes runner-side validation.
//!
//! Preparation proceeds in this order:
//!
//! 1. Validate the current runtime directory and the optional retained runtime directory.
//! 2. Prove that the helper is in the `workload` leaf of the sole live
//!    supervised-exec operation. The canonical cgroup v2 base and empty
//!    operation parent must distribute the required controllers, expose the
//!    exact `control`/`workload` shape, contain no stale operation, and be
//!    recursively populated only by the helper's workload leaf.
//! 3. Open the runtime parent and every protected runtime directory, require them to share a mount,
//!    and record their identities before deletion.
//! 4. Remove Okou-managed Codex authentication from the canonical Codex home without following
//!    symlinks.
//! 5. Measure rootfs capacity, recursively remove every unprotected direct child of the runtime
//!    parent, revalidate each protected identity, and measure capacity again.
//!
//! Codex startup reconciliation establishes the current Codex run's auth mode, but it cannot
//! replace this final scrub: idle sandbox reuse is not scoped to a CLI framework, so a non-Codex
//! successor would not run Codex setup before gaining workload access.
//!
//! Runtime paths are opened component by component without following symlinks, and child opens and
//! deletions are descriptor-relative. Recursive removal refuses to cross filesystem or mount
//! boundaries, and protected entries are checked by both name and identity so replacement races
//! cannot redirect deletion through protected state. Cleanup copies bounded chunks from each live
//! directory descriptor and verifies every mutating pass with a fresh pass from offset zero; one
//! shared raw buffer, bounded copied chunks, and fixed traversal depth cap aggregate memory use. A
//! symlinked stale entry is unlinked without following its target. Unsafe path, identity, mount, or
//! cleanup resource-limit changes fail closed.
//!
//! Request validation and process-containment checks finish before filesystem mutation. Cleanup
//! itself is not a rollback transaction: once deletion starts, a failure on a later entry,
//! protected-identity revalidation, or the final capacity inspection can follow successful removal
//! of earlier entries. Any helper or report failure, or insufficient capacity reported afterward,
//! rejects the sandbox from reuse without changing the already completed run's outcome.

use std::ffi::{CString, OsStr, OsString};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use guest_contracts::process_containment::{
    AGENT_MEMORY_MIN_BYTES, CGROUP_V2_MOUNT_PATH, CONTROL_CGROUP_NAME, EXEC_CGROUP_BASE_PATH,
    EXEC_CGROUP_NAME_PREFIX, REQUIRED_CGROUP_CONTROLLERS, WORKLOAD_CGROUP_NAME,
    WorkloadResourcePolicy,
};
use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
    REUSE_PREPARATION_EXIT_INSPECTION_FAILED, REUSE_PREPARATION_EXIT_INVALID_REQUEST,
    ReusePreparationReport, ReusePreparationRequest, RootFilesystemCapacity,
};

use crate::nofollow_fs::{Dir, FileIdentity};

const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const CGROUP_EVENTS_FILE: &str = "cgroup.events";
const CGROUP_CONTROLLERS_FILE: &str = "cgroup.controllers";
const CGROUP_KILL_FILE: &str = "cgroup.kill";
const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const CGROUP_SUBTREE_CONTROL_FILE: &str = "cgroup.subtree_control";
const CPU_MAX_FILE: &str = "cpu.max";
const MEMORY_HIGH_FILE: &str = "memory.high";
const MEMORY_MAX_FILE: &str = "memory.max";
const MEMORY_MIN_FILE: &str = "memory.min";
const MEMORY_OOM_GROUP_FILE: &str = "memory.oom.group";
const PIDS_MAX_FILE: &str = "pids.max";
const CODEX_AUTH_FILENAME: &str = "auth.json";
#[cfg(debug_assertions)]
const TEST_CONTAINMENT_ROOT_ENV: &str = "OKOU_TEST_PROCESS_CONTAINMENT_ROOT";
#[cfg(debug_assertions)]
const TEST_CONTAINMENT_CURRENT_GROUP_ENV: &str = "OKOU_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP";
#[cfg(debug_assertions)]
const TEST_CODEX_HOME_DIR_ENV: &str = "OKOU_TEST_CODEX_HOME_DIR";
const PROC_SELF_CGROUP: &str = "/proc/self/cgroup";

/// Failure returned by the reuse-preparation helper.
#[derive(Debug)]
pub enum ReusePreparationError {
    /// The typed request or protected runtime paths were invalid.
    InvalidRequest(io::Error),
    /// Rootfs capacity could not be inspected.
    Inspection(io::Error),
    /// Runner-owned runtime state could not be safely removed.
    Cleanup(io::Error),
    /// Exec process containment could not be proven ready for reuse.
    Containment(io::Error),
}

impl ReusePreparationError {
    /// Return the stable process exit code for this failure category.
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::InvalidRequest(_) => REUSE_PREPARATION_EXIT_INVALID_REQUEST,
            Self::Inspection(_) => REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
            Self::Cleanup(_) => REUSE_PREPARATION_EXIT_CLEANUP_FAILED,
            Self::Containment(_) => REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
        }
    }
}

impl std::fmt::Display for ReusePreparationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(error) => write!(f, "invalid reuse-preparation request: {error}"),
            Self::Inspection(error) => write!(f, "rootfs capacity inspection failed: {error}"),
            Self::Cleanup(error) => write!(f, "runtime cleanup failed: {error}"),
            Self::Containment(error) => write!(f, "process containment check failed: {error}"),
        }
    }
}

impl std::error::Error for ReusePreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidRequest(error)
            | Self::Inspection(error)
            | Self::Cleanup(error)
            | Self::Containment(error) => Some(error),
        }
    }
}

struct ProtectedRuntime {
    name: OsString,
    identity: FileIdentity,
}

/// Read a bounded JSON request from stdin and prepare the guest for reuse.
///
/// # Input
///
/// The input is a serialized [`ReusePreparationRequest`] no larger than 64 KiB. Its current runtime
/// directory must be absolute and have a non-root parent. The optional retained runtime directory
/// must meet the same requirements and share that parent. Both protected paths must name
/// directories that can be opened before cleanup and that reside on the parent's mount.
///
/// # Cleanup
///
/// After proving process containment, this function removes managed Codex authentication, protects
/// the current and optional retained runtime directories, and recursively removes every other
/// direct child of their common parent. Traversal does not follow symlinks or cross mount
/// boundaries, and the protected directory identities are revalidated after cleanup.
///
/// # Returns
///
/// On success, returns a [`ReusePreparationReport`] containing rootfs capacity observed before and
/// after cleanup and the number of unprotected direct children removed.
///
/// # Errors
///
/// Returns [`ReusePreparationError::InvalidRequest`] for stdin, size, JSON, or protected-path
/// validation failures; [`ReusePreparationError::Containment`] when the supervised-exec invariant
/// cannot be proven; [`ReusePreparationError::Cleanup`] when managed authentication or protected
/// runtime state cannot be opened, removed, or revalidated; and
/// [`ReusePreparationError::Inspection`] when rootfs capacity cannot be read.
///
/// Cleanup is not transactional. After removal begins, an error can be returned even though
/// earlier stale entries were already removed.
pub fn prepare_from_stdin() -> Result<ReusePreparationReport, ReusePreparationError> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(ReusePreparationError::InvalidRequest)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(ReusePreparationError::InvalidRequest(io::Error::new(
            io::ErrorKind::InvalidInput,
            "request exceeds size limit",
        )));
    }
    let request = serde_json::from_slice(&bytes).map_err(|error| {
        ReusePreparationError::InvalidRequest(io::Error::new(io::ErrorKind::InvalidData, error))
    })?;
    prepare(&request)
}

fn prepare(
    request: &ReusePreparationRequest,
) -> Result<ReusePreparationReport, ReusePreparationError> {
    let current_path = Path::new(&request.current_runtime_dir);
    let (runtime_parent, current_name) = split_runtime_path(current_path)?;
    let retained_name = request
        .retained_runtime_dir
        .as_deref()
        .map(Path::new)
        .map(|path| split_retained_runtime_path(path, &runtime_parent))
        .transpose()?;
    verify_process_containment().map_err(ReusePreparationError::Containment)?;

    let parent = Dir::open_absolute(&runtime_parent).map_err(ReusePreparationError::Cleanup)?;
    let parent_identity = parent.identity().map_err(ReusePreparationError::Cleanup)?;
    let mut protected = vec![open_protected(&parent, current_name, parent_identity)?];
    if let Some(retained_name) = retained_name {
        let retained = open_protected(&parent, retained_name, parent_identity)?;
        if !protected
            .iter()
            .any(|entry| entry.identity == retained.identity)
        {
            protected.push(retained);
        }
    }

    remove_managed_codex_auth().map_err(ReusePreparationError::Cleanup)?;

    let before = rootfs_capacity().map_err(ReusePreparationError::Inspection)?;
    let protected_identities = protected
        .iter()
        .map(|entry| entry.identity)
        .collect::<Vec<_>>();
    let protected_names = protected
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    let removed_entries = parent
        .remove_children_except(&protected_names, parent_identity, &protected_identities)
        .map_err(ReusePreparationError::Cleanup)?;

    for entry in &protected {
        let identity = parent
            .open_child_dir(&entry.name)
            .and_then(|directory| directory.identity())
            .map_err(ReusePreparationError::Cleanup)?;
        if identity != entry.identity {
            return Err(ReusePreparationError::Cleanup(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "protected runtime directory identity changed during cleanup",
            )));
        }
    }

    let after = rootfs_capacity().map_err(ReusePreparationError::Inspection)?;
    Ok(ReusePreparationReport {
        before,
        after,
        removed_entries,
    })
}

fn remove_managed_codex_auth() -> io::Result<()> {
    let codex_home_path = managed_codex_home_path();
    let codex_home = match Dir::open_absolute(&codex_home_path) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(io::Error::new(
                error.kind(),
                format!("canonical Codex home is unsafe: {error}"),
            ));
        }
    };
    let auth_name = OsStr::new(CODEX_AUTH_FILENAME);
    let auth_file = match codex_home.open_child_file(auth_name) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(io::Error::new(
                error.kind(),
                format!("managed Codex auth entry is unsafe: {error}"),
            ));
        }
    };
    if !auth_file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "managed Codex auth entry is not a regular file",
        ));
    }
    codex_home.unlink_child_file(auth_name)
}

fn managed_codex_home_path() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os(TEST_CODEX_HOME_DIR_ENV).filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }

    PathBuf::from(api_contracts::generated::constants::runners::paths::CANONICAL_CODEX_HOME_DIR)
}

struct ProcessContainmentPaths {
    mount: PathBuf,
    base: PathBuf,
    require_cgroup2_filesystem: bool,
}

fn verify_process_containment() -> io::Result<()> {
    let paths = process_containment_paths();
    let current_operation = current_process_cgroup_name()?;
    if paths.require_cgroup2_filesystem && !is_cgroup2_filesystem(&paths.mount)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "canonical cgroup mount is not cgroup v2",
        ));
    }

    let base_metadata = std::fs::symlink_metadata(&paths.base)?;
    if !base_metadata.is_dir() || base_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "exec cgroup base is not a directory",
        ));
    }
    if paths.require_cgroup2_filesystem && !is_cgroup2_filesystem(&paths.base)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "exec cgroup base is not on cgroup v2",
        ));
    }
    for filename in [
        CGROUP_CONTROLLERS_FILE,
        CGROUP_PROCS_FILE,
        CGROUP_EVENTS_FILE,
        CGROUP_KILL_FILE,
        CGROUP_SUBTREE_CONTROL_FILE,
        MEMORY_MIN_FILE,
    ] {
        if !std::fs::metadata(paths.base.join(filename))?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("exec cgroup core file is invalid: {filename}"),
            ));
        }
    }

    verify_required_controllers(
        &std::fs::read_to_string(paths.base.join(CGROUP_SUBTREE_CONTROL_FILE))?,
        "exec cgroup base",
    )?;
    if std::fs::read_to_string(paths.base.join(MEMORY_MIN_FILE))?.trim()
        != AGENT_MEMORY_MIN_BYTES.to_string()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "exec cgroup base does not preserve control and runtime memory",
        ));
    }

    let base_procs = std::fs::read_to_string(paths.base.join(CGROUP_PROCS_FILE))?;
    if !base_procs.trim().is_empty() {
        return Err(io::Error::other(
            "exec cgroup base contains direct processes",
        ));
    }

    let mut current_group_found = false;
    for entry in std::fs::read_dir(&paths.base)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if entry.file_name() == current_operation {
            if !file_type.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "current exec operation cgroup is not a directory",
                ));
            }
            current_group_found = true;
        } else if file_type.is_dir() {
            return Err(io::Error::other("stale exec operation cgroup remains"));
        }
    }
    if !current_group_found {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "current exec operation cgroup is missing",
        ));
    }

    let operation_path = paths.base.join(&current_operation);
    for filename in [
        CGROUP_CONTROLLERS_FILE,
        CGROUP_PROCS_FILE,
        CGROUP_EVENTS_FILE,
        CGROUP_KILL_FILE,
        CGROUP_SUBTREE_CONTROL_FILE,
    ] {
        if !std::fs::metadata(operation_path.join(filename))?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("operation cgroup core file is invalid: {filename}"),
            ));
        }
    }
    verify_required_controllers(
        &std::fs::read_to_string(operation_path.join(CGROUP_SUBTREE_CONTROL_FILE))?,
        "operation cgroup",
    )?;
    if !std::fs::read_to_string(operation_path.join(CGROUP_PROCS_FILE))?
        .trim()
        .is_empty()
    {
        return Err(io::Error::other(
            "operation cgroup contains direct processes",
        ));
    }

    let control_path = operation_path.join(CONTROL_CGROUP_NAME);
    let workload_path = operation_path.join(WORKLOAD_CGROUP_NAME);
    let mut leaf_names = std::fs::read_dir(&operation_path)?
        .filter_map(|entry| match entry {
            Ok(entry) => match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => Some(Ok(entry.file_name())),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            },
            Err(error) => Some(Err(error)),
        })
        .collect::<io::Result<Vec<_>>>()?;
    leaf_names.sort();
    let mut expected_leaf_names = vec![
        OsString::from(CONTROL_CGROUP_NAME),
        OsString::from(WORKLOAD_CGROUP_NAME),
    ];
    expected_leaf_names.sort();
    if leaf_names != expected_leaf_names {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "operation cgroup does not contain exactly control and workload leaves",
        ));
    }
    verify_leaf_core_files(&control_path)?;
    verify_leaf_core_files(&workload_path)?;
    verify_workload_policy(&workload_path)?;
    if parse_populated(&std::fs::read_to_string(
        control_path.join(CGROUP_EVENTS_FILE),
    )?) != Some(false)
    {
        return Err(io::Error::other(
            "reuse helper operation control leaf is populated",
        ));
    }
    if parse_populated(&std::fs::read_to_string(
        workload_path.join(CGROUP_EVENTS_FILE),
    )?) != Some(true)
    {
        return Err(io::Error::other(
            "reuse helper is not contained in its workload leaf",
        ));
    }

    let events = std::fs::read_to_string(paths.base.join(CGROUP_EVENTS_FILE))?;
    match parse_populated(&events) {
        Some(true) => Ok(()),
        Some(false) => Err(io::Error::other(
            "exec cgroup does not contain the current operation",
        )),
        None => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "cgroup.events is missing valid populated state",
        )),
    }
}

fn verify_required_controllers(content: &str, location: &str) -> io::Result<()> {
    let controllers = content.split_ascii_whitespace().collect::<Vec<_>>();
    let missing = REQUIRED_CGROUP_CONTROLLERS
        .into_iter()
        .filter(|controller| !controllers.contains(controller))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "{location} is missing required controllers: {}",
            missing.join(",")
        ),
    ))
}

fn verify_leaf_core_files(leaf_path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(leaf_path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "operation cgroup leaf is not a directory",
        ));
    }
    for filename in [
        CGROUP_PROCS_FILE,
        CGROUP_EVENTS_FILE,
        CGROUP_KILL_FILE,
        CGROUP_SUBTREE_CONTROL_FILE,
    ] {
        if !std::fs::metadata(leaf_path.join(filename))?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("operation cgroup leaf file is invalid: {filename}"),
            ));
        }
    }
    if !std::fs::read_to_string(leaf_path.join(CGROUP_SUBTREE_CONTROL_FILE))?
        .trim()
        .is_empty()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "operation cgroup leaf distributes controllers",
        ));
    }
    for entry in std::fs::read_dir(leaf_path)? {
        if entry?.file_type()?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "operation cgroup leaf contains a nested cgroup",
            ));
        }
    }
    Ok(())
}

fn verify_workload_policy(workload_path: &Path) -> io::Result<()> {
    let policy = WorkloadResourcePolicy::for_current_guest_capacity().map_err(io::Error::other)?;
    for (filename, expected) in [
        (
            CPU_MAX_FILE,
            format!("{} {}", policy.cpu_quota_us, policy.cpu_period_us),
        ),
        (MEMORY_HIGH_FILE, policy.memory_high.to_string()),
        (MEMORY_MAX_FILE, policy.memory_max_bytes.to_string()),
        (MEMORY_OOM_GROUP_FILE, policy.memory_oom_group.to_string()),
        (PIDS_MAX_FILE, policy.pids_max.to_string()),
    ] {
        let actual = std::fs::read_to_string(workload_path.join(filename))?;
        if actual.trim() != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("workload cgroup policy mismatch for {filename}"),
            ));
        }
    }
    Ok(())
}

fn current_process_cgroup_name() -> io::Result<OsString> {
    #[cfg(debug_assertions)]
    if let Some(cgroup_path) = std::env::var_os(TEST_CONTAINMENT_CURRENT_GROUP_ENV) {
        return current_group_name_from_path(Path::new(&cgroup_path));
    }

    let content = std::fs::read_to_string(PROC_SELF_CGROUP)?;
    let cgroup_path = content
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "current unified cgroup path is missing",
            )
        })?;
    current_group_name_from_path(Path::new(cgroup_path))
}

fn current_group_name_from_path(cgroup_path: &Path) -> io::Result<OsString> {
    let relative_base = Path::new(EXEC_CGROUP_BASE_PATH)
        .strip_prefix(CGROUP_V2_MOUNT_PATH)
        .map_err(|_| io::Error::other("exec cgroup base is outside the cgroup v2 mount"))?;
    let relative_path = cgroup_path.strip_prefix(Path::new("/")).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "current unified cgroup path is not absolute",
        )
    })?;
    let group_path = relative_path.strip_prefix(relative_base).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "current process is outside the exec cgroup base",
        )
    })?;
    let mut components = group_path.components();
    let group = match (components.next(), components.next(), components.next()) {
        (Some(Component::Normal(group)), Some(Component::Normal(leaf)), None)
            if group
                .as_bytes()
                .starts_with(EXEC_CGROUP_NAME_PREFIX.as_bytes())
                && leaf == WORKLOAD_CGROUP_NAME =>
        {
            group.to_os_string()
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "current process is not in an exec operation workload leaf",
            ));
        }
    };
    Ok(group)
}

fn process_containment_paths() -> ProcessContainmentPaths {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os(TEST_CONTAINMENT_ROOT_ENV) {
        let mount = PathBuf::from(root);
        let base = mount.join("vm0-exec");
        return ProcessContainmentPaths {
            mount,
            base,
            require_cgroup2_filesystem: false,
        };
    }

    ProcessContainmentPaths {
        mount: PathBuf::from(CGROUP_V2_MOUNT_PATH),
        base: PathBuf::from(EXEC_CGROUP_BASE_PATH),
        require_cgroup2_filesystem: true,
    }
}

fn is_cgroup2_filesystem(path: &Path) -> io::Result<bool> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL byte"))?;
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `path` is NUL-terminated and `stats` points to writable memory.
    let result = unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful statfs initialized the structure.
    Ok(unsafe { stats.assume_init() }.f_type == 0x6367_7270)
}

fn parse_populated(content: &str) -> Option<bool> {
    content.lines().find_map(|line| {
        let (key, value) = line.split_once(' ')?;
        if key != "populated" {
            return None;
        }
        match value {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        }
    })
}

fn split_runtime_path(path: &Path) -> Result<(PathBuf, &OsStr), ReusePreparationError> {
    if !path.is_absolute() {
        return Err(invalid_path("current runtime directory must be absolute"));
    }
    let parent = path
        .parent()
        .filter(|parent| *parent != Path::new("/"))
        .ok_or_else(|| invalid_path("current runtime directory must have a non-root parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| invalid_path("current runtime directory must have a basename"))?;
    Ok((parent.to_path_buf(), name))
}

fn split_retained_runtime_path<'a>(
    path: &'a Path,
    expected_parent: &Path,
) -> Result<&'a OsStr, ReusePreparationError> {
    let (parent, name) = split_runtime_path(path)?;
    if parent != expected_parent {
        return Err(invalid_path(
            "retained runtime directory must share the current runtime parent",
        ));
    }
    Ok(name)
}

fn open_protected(
    parent: &Dir,
    name: &OsStr,
    parent_identity: FileIdentity,
) -> Result<ProtectedRuntime, ReusePreparationError> {
    let directory = parent
        .open_child_dir(name)
        .map_err(ReusePreparationError::Cleanup)?;
    let identity = directory
        .identity()
        .map_err(ReusePreparationError::Cleanup)?;
    identity
        .ensure_same_mount(parent_identity)
        .map_err(ReusePreparationError::Cleanup)?;
    Ok(ProtectedRuntime {
        name: name.to_os_string(),
        identity,
    })
}

fn invalid_path(message: &'static str) -> ReusePreparationError {
    ReusePreparationError::InvalidRequest(io::Error::new(io::ErrorKind::InvalidInput, message))
}

fn rootfs_capacity() -> io::Result<RootFilesystemCapacity> {
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: the path is a static NUL-terminated string and `stats` points to
    // writable memory for the duration of the call.
    let result = unsafe { libc::statvfs(c"/".as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful `statvfs` initialized the full structure.
    let stats = unsafe { stats.assume_init() };
    Ok(RootFilesystemCapacity {
        available_bytes: stats.f_bavail.saturating_mul(stats.f_frsize),
        available_inodes: stats.f_favail,
    })
}
