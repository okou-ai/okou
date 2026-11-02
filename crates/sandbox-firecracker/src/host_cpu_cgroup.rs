//! Weighted host cgroup v2 placement for normal Firecracker processes.

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use sandbox::{
    HostCpuPlacementConfig, HostCpuPlacementMode, SandboxError, SandboxId,
    SandboxInitializationPhase,
};
use tracing::{info, warn};

const PROC_SELF_CGROUP: &str = "/proc/self/cgroup";
const CGROUP_V2_MOUNT: &str = "/sys/fs/cgroup";
const CONTROL_GROUP: &str = "control";
const GUESTS_GROUP: &str = "guests";
const CGROUP_CONTROLLERS: &str = "cgroup.controllers";
const CGROUP_SUBTREE_CONTROL: &str = "cgroup.subtree_control";
const CGROUP_PROCS: &str = "cgroup.procs";
const CPU_WEIGHT: &str = "cpu.weight";
const DELEGATE_XATTR: &[u8] = b"user.delegate\0";

#[derive(Debug, thiserror::Error)]
enum InitializationError {
    #[error("host CPU cgroup delegation unavailable: {0}")]
    Unavailable(String),
    #[error("invalid host CPU cgroup delegation: {0}")]
    Invalid(String),
}

#[derive(Debug)]
pub(crate) struct HostCpuCgroupManager {
    guests_path: PathBuf,
}

pub(crate) struct GuestCpuCgroupLease {
    // Close our placement descriptor before abandoning the leaf owner.
    placement_directory: File,
    leaf: GuestCpuCgroupLeaf,
}

struct GuestCpuCgroupLeaf {
    path: Option<PathBuf>,
}

impl HostCpuCgroupManager {
    pub(crate) fn initialize(
        config: HostCpuPlacementConfig,
    ) -> Result<Option<Arc<Self>>, SandboxError> {
        Self::initialize_with_paths(
            config,
            Path::new(PROC_SELF_CGROUP),
            Path::new(CGROUP_V2_MOUNT),
        )
    }

    fn initialize_with_paths(
        config: HostCpuPlacementConfig,
        proc_self_cgroup: &Path,
        cgroup_mount: &Path,
    ) -> Result<Option<Arc<Self>>, SandboxError> {
        match Self::initialize_at(config, proc_self_cgroup, cgroup_mount) {
            Ok(manager) => Ok(Some(Arc::new(manager))),
            Err(InitializationError::Unavailable(message))
                if config.mode() == HostCpuPlacementMode::PreferManaged =>
            {
                warn!(%message, "host CPU placement unavailable; continuing unmanaged in local mode");
                Ok(None)
            }
            Err(error) => Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::Runtime,
                message: error.to_string(),
            }),
        }
    }

    fn initialize_at(
        config: HostCpuPlacementConfig,
        proc_self_cgroup: &Path,
        cgroup_mount: &Path,
    ) -> Result<Self, InitializationError> {
        let membership = match fs::read_to_string(proc_self_cgroup) {
            Ok(membership) => membership,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(InitializationError::Unavailable(format!(
                    "{} does not exist",
                    proc_self_cgroup.display()
                )));
            }
            Err(error) => {
                return Err(InitializationError::Invalid(format!(
                    "read {}: {error}",
                    proc_self_cgroup.display()
                )));
            }
        };
        let membership_path = parse_unified_membership(&membership)?;
        let relative_membership = membership_path.strip_prefix("/").map_err(|_| {
            InitializationError::Invalid(format!(
                "unified membership is not absolute: {}",
                membership_path.display()
            ))
        })?;
        let current_path = cgroup_mount.join(relative_membership);
        if membership_path.file_name().and_then(|name| name.to_str()) != Some(CONTROL_GROUP) {
            let parent_path = current_path.parent();
            let delegation_present = read_delegate_marker(&current_path)?.is_some()
                || parent_path
                    .map(read_delegate_marker)
                    .transpose()?
                    .flatten()
                    .is_some();
            if delegation_present {
                return Err(InitializationError::Invalid(format!(
                    "delegated cgroup does not use the required {CONTROL_GROUP} subgroup: {}",
                    membership_path.display()
                )));
            }
            return Err(InitializationError::Unavailable(format!(
                "current cgroup is not the systemd {CONTROL_GROUP} subgroup: {}",
                membership_path.display()
            )));
        }
        let control_path = current_path;
        let root_path = control_path.parent().ok_or_else(|| {
            InitializationError::Invalid("control subgroup has no delegated parent".into())
        })?;

        validate_preflight(root_path, &control_path)?;
        enable_cpu_controller(root_path)?;

        let guests_path = root_path.join(GUESTS_GROUP);
        match fs::create_dir(&guests_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                require_plain_directory(&guests_path, "guests subgroup")?;
            }
            Err(error) => {
                return Err(InitializationError::Invalid(format!(
                    "create guests subgroup {}: {error}",
                    guests_path.display()
                )));
            }
        }

        require_empty_membership(&guests_path.join(CGROUP_PROCS), "guests subgroup")?;
        write_weight(&control_path, config.control_weight())?;
        write_weight(&guests_path, config.guests_weight())?;
        enable_cpu_controller(&guests_path)?;
        reconcile_guest_leaves(&guests_path)?;

        info!(
            root = %root_path.display(),
            control_cpu_weight = config.control_weight(),
            guests_cpu_weight = config.guests_weight(),
            mode = ?config.mode(),
            "host CPU placement initialized"
        );
        Ok(Self { guests_path })
    }

    pub(crate) fn acquire(
        &self,
        sandbox_id: SandboxId,
        vcpu: u32,
    ) -> Result<GuestCpuCgroupLease, SandboxError> {
        if !(HostCpuPlacementConfig::MIN_WEIGHT..=HostCpuPlacementConfig::MAX_WEIGHT)
            .contains(&vcpu)
        {
            return Err(SandboxError::Start {
                message: format!("declared vCPU {vcpu} is outside the cgroup CPU weight range"),
            });
        }

        let leaf_path = self.guests_path.join(sandbox_id.to_string());
        fs::create_dir(&leaf_path).map_err(|error| SandboxError::Start {
            message: format!("create Guest CPU cgroup {}: {error}", leaf_path.display()),
        })?;
        match configure_guest_leaf(&leaf_path, vcpu) {
            Ok(placement_directory) => Ok(GuestCpuCgroupLease {
                placement_directory,
                leaf: GuestCpuCgroupLeaf {
                    path: Some(leaf_path),
                },
            }),
            Err(error) => {
                if let Err(cleanup_error) = fs::remove_dir(&leaf_path) {
                    warn!(
                        path = %leaf_path.display(),
                        %cleanup_error,
                        "failed to roll back empty Guest CPU cgroup"
                    );
                }
                Err(SandboxError::Start {
                    message: format!(
                        "configure Guest CPU cgroup {}: {error}",
                        leaf_path.display()
                    ),
                })
            }
        }
    }
}

impl GuestCpuCgroupLease {
    pub(crate) fn clone_placement_directory(&self) -> io::Result<File> {
        self.placement_directory.try_clone()
    }

    pub(crate) fn release(self) -> io::Result<()> {
        let Self {
            placement_directory,
            leaf,
        } = self;
        drop(placement_directory);
        leaf.release()
    }

    #[cfg(test)]
    pub(crate) fn from_test_file(leaf_path: PathBuf, placement_directory: File) -> Self {
        Self {
            placement_directory,
            leaf: GuestCpuCgroupLeaf {
                path: Some(leaf_path),
            },
        }
    }
}

impl GuestCpuCgroupLeaf {
    fn release(mut self) -> io::Result<()> {
        // Disarm before attempting removal, including when it returns an error.
        self.path.take().map_or(Ok(()), fs::remove_dir)
    }
}

impl Drop for GuestCpuCgroupLeaf {
    fn drop(&mut self) {
        if let Some(leaf_path) = &self.path
            && let Err(error) = fs::remove_dir(leaf_path)
            && error.kind() != io::ErrorKind::NotFound
        {
            warn!(
                path = %leaf_path.display(),
                %error,
                "failed to remove Guest CPU cgroup during drop"
            );
        }
    }
}

fn parse_unified_membership(membership: &str) -> Result<PathBuf, InitializationError> {
    let mut unified = membership.lines().filter_map(|line| {
        let mut fields = line.splitn(3, ':');
        match (fields.next(), fields.next(), fields.next()) {
            (Some("0"), Some(""), Some(path)) => Some(path),
            _ => None,
        }
    });
    let Some(path) = unified.next() else {
        return Err(InitializationError::Unavailable(
            "no unified cgroup v2 membership entry".into(),
        ));
    };
    if unified.next().is_some() {
        return Err(InitializationError::Invalid(
            "multiple unified cgroup v2 membership entries".into(),
        ));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::RootDir | Component::Normal(_)))
    {
        return Err(InitializationError::Invalid(format!(
            "unified membership contains an unsafe path: {}",
            path.display()
        )));
    }
    Ok(path)
}

fn validate_preflight(root_path: &Path, control_path: &Path) -> Result<(), InitializationError> {
    require_plain_directory(root_path, "delegated service root")?;
    require_plain_directory(control_path, "control subgroup")?;
    require_delegate_xattr(root_path)?;
    require_controller(&root_path.join(CGROUP_CONTROLLERS), "cpu")?;
    require_empty_membership(&root_path.join(CGROUP_PROCS), "delegated service root")?;

    let subtree_control = root_path.join(CGROUP_SUBTREE_CONTROL);
    OpenOptions::new()
        .write(true)
        .open(&subtree_control)
        .map_err(|error| {
            InitializationError::Invalid(format!(
                "required cgroup file is not writable {}: {error}",
                subtree_control.display()
            ))
        })?;

    for entry in fs::read_dir(root_path).map_err(|error| {
        InitializationError::Invalid(format!(
            "read delegated service root {}: {error}",
            root_path.display()
        ))
    })? {
        let entry = entry.map_err(|error| {
            InitializationError::Invalid(format!("read delegated service root entry: {error}"))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            InitializationError::Invalid(format!(
                "inspect delegated service root entry {}: {error}",
                entry.path().display()
            ))
        })?;
        if file_type.is_symlink() {
            return Err(InitializationError::Invalid(format!(
                "symlink in delegated service root: {}",
                entry.path().display()
            )));
        }
        if file_type.is_dir()
            && entry.file_name() != CONTROL_GROUP
            && entry.file_name() != GUESTS_GROUP
        {
            return Err(InitializationError::Invalid(format!(
                "unexpected subgroup in delegated service root: {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn require_plain_directory(path: &Path, label: &str) -> Result<(), InitializationError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        InitializationError::Invalid(format!("inspect {label} {}: {error}", path.display()))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(InitializationError::Invalid(format!(
            "{label} is not a plain directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn require_delegate_xattr(path: &Path) -> Result<(), InitializationError> {
    if read_delegate_marker(path)?.is_none() {
        return Err(InitializationError::Invalid(format!(
            "delegated service root {} lacks systemd user.delegate marker",
            path.display()
        )));
    }
    Ok(())
}

fn read_delegate_marker(path: &Path) -> Result<Option<()>, InitializationError> {
    let path_c = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        InitializationError::Invalid(format!("delegated root contains NUL: {}", path.display()))
    })?;
    // SAFETY: both pointers are valid NUL-terminated strings and the value
    // buffer is valid for the supplied length.
    let mut value = [0_u8; 8];
    let size = unsafe {
        libc::getxattr(
            path_c.as_ptr(),
            DELEGATE_XATTR.as_ptr().cast(),
            value.as_mut_ptr().cast(),
            value.len(),
        )
    };
    if size < 0 {
        let error = io::Error::last_os_error();
        if matches!(
            error.raw_os_error(),
            Some(code)
                if code == libc::ENOENT || code == libc::ENODATA || code == libc::ENOTSUP
        ) {
            return Ok(None);
        }
        return Err(InitializationError::Invalid(format!(
            "read systemd user.delegate marker from {}: {error}",
            path.display(),
        )));
    }
    let size = usize::try_from(size)
        .map_err(|_| InitializationError::Invalid("invalid user.delegate marker length".into()))?;
    if value.get(..size) != Some(b"1") {
        return Err(InitializationError::Invalid(format!(
            "delegated service root {} has invalid user.delegate marker",
            path.display()
        )));
    }
    Ok(Some(()))
}

fn require_controller(path: &Path, controller: &str) -> Result<(), InitializationError> {
    let value = fs::read_to_string(path).map_err(|error| {
        InitializationError::Invalid(format!("read {}: {error}", path.display()))
    })?;
    if !contains_controller(&value, controller) {
        return Err(InitializationError::Invalid(format!(
            "{} does not expose {controller}",
            path.display()
        )));
    }
    Ok(())
}

fn contains_controller(value: &str, controller: &str) -> bool {
    value
        .split_ascii_whitespace()
        .any(|token| token.trim_start_matches(['+', '-']) == controller)
}

fn require_empty_membership(path: &Path, label: &str) -> Result<(), InitializationError> {
    let membership = fs::read_to_string(path).map_err(|error| {
        InitializationError::Invalid(format!(
            "read {label} membership {}: {error}",
            path.display()
        ))
    })?;
    if !membership.trim().is_empty() {
        return Err(InitializationError::Invalid(format!(
            "{label} has processes in {}",
            path.display()
        )));
    }
    Ok(())
}

fn enable_cpu_controller(path: &Path) -> Result<(), InitializationError> {
    let subtree_control = path.join(CGROUP_SUBTREE_CONTROL);
    fs::write(&subtree_control, "+cpu").map_err(|error| {
        InitializationError::Invalid(format!(
            "enable cpu in {}: {error}",
            subtree_control.display()
        ))
    })?;
    require_controller(&subtree_control, "cpu")
}

fn write_weight(path: &Path, weight: u32) -> Result<(), InitializationError> {
    let weight_path = path.join(CPU_WEIGHT);
    fs::write(&weight_path, weight.to_string()).map_err(|error| {
        InitializationError::Invalid(format!("write {}: {error}", weight_path.display()))
    })?;
    let actual = fs::read_to_string(&weight_path).map_err(|error| {
        InitializationError::Invalid(format!("read {}: {error}", weight_path.display()))
    })?;
    if actual.trim() != weight.to_string() {
        return Err(InitializationError::Invalid(format!(
            "{} did not retain weight {weight}: {actual:?}",
            weight_path.display()
        )));
    }
    Ok(())
}

fn reconcile_guest_leaves(guests_path: &Path) -> Result<(), InitializationError> {
    for entry in fs::read_dir(guests_path).map_err(|error| {
        InitializationError::Invalid(format!(
            "read guests subgroup {}: {error}",
            guests_path.display()
        ))
    })? {
        let entry = entry.map_err(|error| {
            InitializationError::Invalid(format!("read guests subgroup entry: {error}"))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            InitializationError::Invalid(format!(
                "inspect guests subgroup entry {}: {error}",
                entry.path().display()
            ))
        })?;
        if file_type.is_symlink() {
            return Err(InitializationError::Invalid(format!(
                "symlink in guests subgroup: {}",
                entry.path().display()
            )));
        }
        if !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name().into_string().map_err(|_| {
            InitializationError::Invalid(format!(
                "non-UTF-8 Guest subgroup: {}",
                entry.path().display()
            ))
        })?;
        let sandbox_id = name.parse::<SandboxId>().map_err(|_| {
            InitializationError::Invalid(format!("unexpected Guest subgroup name: {name}"))
        })?;
        if sandbox_id.to_string() != name {
            return Err(InitializationError::Invalid(format!(
                "non-canonical Guest subgroup name: {name}"
            )));
        }
        require_empty_membership(&entry.path().join(CGROUP_PROCS), "stale Guest subgroup")?;
        for child in fs::read_dir(entry.path()).map_err(|error| {
            InitializationError::Invalid(format!(
                "read stale Guest subgroup {}: {error}",
                entry.path().display()
            ))
        })? {
            let child = child.map_err(|error| {
                InitializationError::Invalid(format!("read stale Guest subgroup entry: {error}"))
            })?;
            if child
                .file_type()
                .map_err(|error| {
                    InitializationError::Invalid(format!(
                        "inspect stale Guest subgroup entry {}: {error}",
                        child.path().display()
                    ))
                })?
                .is_dir()
            {
                return Err(InitializationError::Invalid(format!(
                    "nested subgroup under stale Guest {}: {}",
                    name,
                    child.path().display()
                )));
            }
        }
        fs::remove_dir(entry.path()).map_err(|error| {
            InitializationError::Invalid(format!(
                "remove empty stale Guest subgroup {}: {error}",
                entry.path().display()
            ))
        })?;
    }
    Ok(())
}

fn configure_guest_leaf(leaf_path: &Path, vcpu: u32) -> io::Result<File> {
    let weight_path = leaf_path.join(CPU_WEIGHT);
    fs::write(&weight_path, vcpu.to_string())?;
    let actual = fs::read_to_string(&weight_path)?;
    if actual.trim() != vcpu.to_string() {
        return Err(io::Error::other(format!(
            "{} did not retain weight {vcpu}: {actual:?}",
            weight_path.display()
        )));
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(leaf_path)?;
    process_launch::private_descriptor(directory.into()).map(File::from)
}

#[cfg(test)]
mod tests;
