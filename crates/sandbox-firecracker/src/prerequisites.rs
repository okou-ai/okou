use std::fs::Metadata;
use std::io::{self, ErrorKind};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use nix::unistd::{AccessFlags, eaccess};
use sandbox::SandboxError;

use crate::config::SnapshotConfig;
use crate::paths::{RUNTIME_DIR, RuntimePaths};
use crate::runtime_dirs::ensure_traversable_runtime_dir;

/// Common inputs needed for prerequisite checks.
///
/// Both [`crate::factory::FirecrackerFactory`] and [`crate::snapshot::create_snapshot`]
/// construct this from their respective config types.
pub(crate) struct PrerequisiteConfig {
    pub binary_path: PathBuf,
    pub kernel_path: PathBuf,
    pub rootfs_path: PathBuf,
    pub mode: PrerequisiteMode,
}

/// Operation-specific prerequisite mode.
#[derive(Debug)]
pub(crate) enum PrerequisiteMode {
    FactoryFresh,
    FactorySnapshotRestore { snapshot: SnapshotConfig },
    SnapshotCreate,
}

impl PrerequisiteMode {
    fn snapshot(&self) -> Option<&SnapshotConfig> {
        match self {
            Self::FactorySnapshotRestore { snapshot } => Some(snapshot),
            Self::FactoryFresh | Self::SnapshotCreate => None,
        }
    }

    fn command_groups(&self) -> &'static [&'static [&'static str]] {
        match self {
            Self::FactoryFresh => FACTORY_FRESH_COMMAND_GROUPS,
            Self::FactorySnapshotRestore { .. } => FACTORY_SNAPSHOT_RESTORE_COMMAND_GROUPS,
            Self::SnapshotCreate => SNAPSHOT_CREATE_COMMAND_GROUPS,
        }
    }
}

const FACTORY_FRESH_COMMAND_GROUPS: &[&[&str]] = &[NETWORK_COMMANDS, HOME_IMAGE_CREATE_COMMANDS];
const FACTORY_SNAPSHOT_RESTORE_COMMAND_GROUPS: &[&[&str]] = &[
    NETWORK_COMMANDS,
    COW_POOL_SNAPSHOT_RESTORE_COMMANDS,
    HOME_IMAGE_CREATE_COMMANDS,
    SNAPSHOT_PRIVATE_MOUNT_RESTORE_COMMANDS,
];
const SNAPSHOT_CREATE_COMMAND_GROUPS: &[&[&str]] = &[
    NETWORK_COMMANDS,
    HOME_IMAGE_CREATE_COMMANDS,
    SNAPSHOT_PRIVATE_MOUNT_CREATE_COMMANDS,
];

const NETWORK_COMMANDS: &[&str] = &[
    "ip",
    "iptables",
    "iptables-save",
    "iptables-restore",
    "conntrack",
    "sysctl",
];
const DNS_INPUT_FILTER_COMMANDS: &[&str] = &["ip6tables", "ip6tables-save", "ip6tables-restore"];
const SNAPSHOT_PRIVATE_MOUNT_CREATE_COMMANDS: &[&str] = &["unshare", "bash", "mount"];
const SNAPSHOT_PRIVATE_MOUNT_RESTORE_COMMANDS: &[&str] = &["unshare", "bash", "mount", "umount"];
const COW_POOL_SNAPSHOT_RESTORE_COMMANDS: &[&str] = &["cp"];
const HOME_IMAGE_CREATE_COMMANDS: &[&str] = &["mkfs.ext4"];

/// Return host commands required across Firecracker runtime modes.
///
/// This conservative aggregate covers fresh and snapshot-restoring factories
/// plus DNS-filtered networking. Runtime entry points still validate their
/// narrower, mode-specific command sets.
pub fn runtime_required_commands() -> Vec<&'static str> {
    let mut command_groups = FACTORY_FRESH_COMMAND_GROUPS.to_vec();
    command_groups.extend_from_slice(FACTORY_SNAPSHOT_RESTORE_COMMAND_GROUPS);
    command_groups.push(DNS_INPUT_FILTER_COMMANDS);
    required_commands_for_groups(&command_groups)
}

/// Verify that all required system prerequisites are present.
///
/// Checks firecracker binary, kernel, rootfs, `/dev/kvm`, runtime directory,
/// snapshot artifacts when restoring, and host commands required by the mode.
/// Collects all failures and returns them in a single `BackendUnavailable` error.
pub(crate) async fn check_prerequisites(config: PrerequisiteConfig) -> Result<(), SandboxError> {
    run_prerequisite_check(move || check_prerequisites_sync(&config)).await
}

fn check_prerequisites_sync(config: &PrerequisiteConfig) -> Result<(), SandboxError> {
    let mut errors = Vec::new();

    check_artifact_prerequisites(config, &mut errors);
    check_kvm(&mut errors);
    let commands = required_commands(&config.mode);
    check_required_commands(&commands, &mut errors);
    ensure_runtime_namespace(&mut errors);

    prerequisite_result(errors)
}

/// Verify host network tools before creating network namespaces.
pub(crate) async fn check_network_prerequisites(
    require_dns_input_filter: bool,
) -> Result<(), SandboxError> {
    run_prerequisite_check(move || check_network_prerequisites_sync(require_dns_input_filter)).await
}

fn check_network_prerequisites_sync(require_dns_input_filter: bool) -> Result<(), SandboxError> {
    let mut errors = Vec::new();
    let commands = network_commands(require_dns_input_filter);
    check_required_commands(&commands, &mut errors);
    prerequisite_result(errors)
}

async fn run_prerequisite_check(
    check: impl FnOnce() -> Result<(), SandboxError> + Send + 'static,
) -> Result<(), SandboxError> {
    match tokio::task::spawn_blocking(check).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => Err(SandboxError::Io(io::Error::other(format!(
            "prerequisite check task was cancelled: {error}"
        )))),
    }
}

fn prerequisite_result(errors: Vec<String>) -> Result<(), SandboxError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(SandboxError::BackendUnavailable {
            message: errors.join("; "),
        })
    }
}

fn check_artifact_prerequisites(config: &PrerequisiteConfig, errors: &mut Vec<String>) {
    let binary_metadata = check_executable_file(&config.binary_path, "firecracker binary", errors);
    check_non_empty_file_size(
        &config.binary_path,
        "firecracker binary",
        binary_metadata,
        errors,
    );
    check_non_empty_readable_file(&config.kernel_path, "kernel", errors);
    let rootfs_blocks = check_readable_file(&config.rootfs_path, "rootfs", errors)
        .and_then(|metadata| check_rootfs_size(&config.rootfs_path, metadata.len(), errors));

    if let Some(snapshot) = config.mode.snapshot() {
        check_non_empty_readable_file(&snapshot.snapshot_path, "snapshot state", errors);
        check_non_empty_readable_file(&snapshot.memory_path, "snapshot memory", errors);
        let snapshot_cow_len =
            check_readable_file(&snapshot.cow_path, "snapshot cow", errors).map(|m| m.len());
        let bitmap_path = nbd_cow::cow::bitmap_path_for(&snapshot.cow_path);
        check_bitmap_file(
            &bitmap_path,
            "snapshot cow bitmap",
            rootfs_blocks,
            snapshot_cow_len,
            errors,
        );
    }
}

fn check_regular_file(path: &Path, label: &str, errors: &mut Vec<String>) -> Option<Metadata> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Some(metadata),
        Ok(_) => {
            errors.push(format!("{label} is not a regular file: {}", path.display()));
            None
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            errors.push(format!("{label} not found: {}", path.display()));
            None
        }
        Err(e) => {
            errors.push(format!("failed to stat {label}: {}: {e}", path.display()));
            None
        }
    }
}

fn check_readable_file(path: &Path, label: &str, errors: &mut Vec<String>) -> Option<Metadata> {
    let metadata = check_regular_file(path, label, errors)?;
    if let Err(e) = std::fs::File::open(path) {
        errors.push(format!("{label} is not readable: {}: {e}", path.display()));
        return None;
    }
    Some(metadata)
}

fn check_non_empty_readable_file(
    path: &Path,
    label: &str,
    errors: &mut Vec<String>,
) -> Option<Metadata> {
    let metadata = check_readable_file(path, label, errors);
    check_non_empty_file_size(path, label, metadata, errors)
}

fn check_non_empty_file_size(
    path: &Path,
    label: &str,
    metadata: Option<Metadata>,
    errors: &mut Vec<String>,
) -> Option<Metadata> {
    let metadata = metadata?;
    if metadata.len() == 0 {
        errors.push(format!("{label} is empty: {}", path.display()));
        return None;
    }
    Some(metadata)
}

fn check_executable_file(path: &Path, label: &str, errors: &mut Vec<String>) -> Option<Metadata> {
    let metadata = check_regular_file(path, label, errors)?;
    check_executable(path, label, &metadata, errors);
    Some(metadata)
}

fn check_executable(path: &Path, label: &str, metadata: &Metadata, errors: &mut Vec<String>) {
    if metadata.permissions().mode() & 0o111 == 0 {
        errors.push(format!("{label} is not executable: {}", path.display()));
        return;
    }
    if let Err(e) = eaccess(path, AccessFlags::X_OK) {
        errors.push(format!(
            "{label} is not executable: {}: {e}",
            path.display()
        ));
    }
}

fn check_rootfs_size(path: &Path, size: u64, errors: &mut Vec<String>) -> Option<usize> {
    if size == 0 {
        errors.push(format!("rootfs is empty: {}", path.display()));
        return None;
    }

    let block_size = nbd_cow::BLOCK_SIZE as u64;
    if !size.is_multiple_of(block_size) {
        errors.push(format!(
            "rootfs size {size} is not a multiple of {block_size} bytes: {}",
            path.display()
        ));
        return None;
    }

    match usize::try_from(size / block_size) {
        Ok(blocks) => Some(blocks),
        Err(_) => {
            errors.push(format!(
                "rootfs block count is too large: {}",
                path.display()
            ));
            None
        }
    }
}

fn check_bitmap_file(
    path: &Path,
    label: &str,
    expected_blocks: Option<usize>,
    cow_file_len: Option<u64>,
    errors: &mut Vec<String>,
) {
    if check_readable_file(path, label, errors).is_none() {
        return;
    }

    let Some(expected_blocks) = expected_blocks else {
        return;
    };

    let result = match cow_file_len {
        Some(cow_file_len) => nbd_cow::cow::validate_bitmap_cow_coverage(
            path,
            cow_file_len,
            nbd_cow::BLOCK_SIZE,
            expected_blocks,
        ),
        None => nbd_cow::cow::validate_bitmap(path, expected_blocks),
    };
    if let Err(e) = result {
        errors.push(format!("{label} is invalid: {}: {e}", path.display()));
    }
}

fn check_kvm(errors: &mut Vec<String>) {
    let kvm = Path::new("/dev/kvm");
    if !kvm.exists() {
        errors.push("/dev/kvm not found (KVM not available)".to_string());
    } else if let Err(e) = std::fs::File::options().read(true).write(true).open(kvm) {
        errors.push(format!("/dev/kvm not accessible: {e}"));
    }
}

fn check_required_commands(commands: &[&str], errors: &mut Vec<String>) {
    for cmd in commands {
        if which::which(cmd).is_err() {
            errors.push(format!("required command not found: {cmd}"));
        }
    }
}

fn required_commands(mode: &PrerequisiteMode) -> Vec<&'static str> {
    required_commands_for_groups(mode.command_groups())
}

fn network_commands(require_dns_input_filter: bool) -> Vec<&'static str> {
    if require_dns_input_filter {
        required_commands_for_groups(&[NETWORK_COMMANDS, DNS_INPUT_FILTER_COMMANDS])
    } else {
        required_commands_for_groups(&[NETWORK_COMMANDS])
    }
}

fn required_commands_for_groups<'a>(command_groups: &[&'a [&'a str]]) -> Vec<&'a str> {
    let mut commands = Vec::new();
    for group in command_groups {
        for &cmd in *group {
            if !commands.contains(&cmd) {
                commands.push(cmd);
            }
        }
    }
    commands
}

/// Create and validate the owner-writable runtime socket namespace.
fn ensure_runtime_namespace(errors: &mut Vec<String>) {
    let runtime = RuntimePaths::new();
    ensure_runtime_namespace_at(Path::new(RUNTIME_DIR), &runtime.sock_base(), errors);
}

fn ensure_runtime_namespace_at(runtime_dir: &Path, sock_base: &Path, errors: &mut Vec<String>) {
    if let Err(e) = ensure_traversable_runtime_dir(runtime_dir) {
        errors.push(format!(
            "failed to prepare runtime dir {}: {e}",
            runtime_dir.display()
        ));
        return;
    }
    if let Err(e) = ensure_traversable_runtime_dir(sock_base) {
        errors.push(format!(
            "failed to prepare runtime sock dir {}: {e}",
            sock_base.display()
        ));
    }
}

#[cfg(test)]
mod tests;
