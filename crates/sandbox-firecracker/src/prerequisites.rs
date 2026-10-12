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
mod tests {
    use std::fs::File;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};

    use super::*;

    struct ArtifactFixture {
        _dir: tempfile::TempDir,
        binary_path: PathBuf,
        kernel_path: PathBuf,
        rootfs_path: PathBuf,
        snapshot: SnapshotConfig,
    }

    impl ArtifactFixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let binary_path = dir.path().join("firecracker");
            let kernel_path = dir.path().join("vmlinux");
            let rootfs_path = dir.path().join("rootfs.ext4");
            let snapshot_path = dir.path().join("snapshot.bin");
            let memory_path = dir.path().join("memory.bin");
            let cow_path = dir.path().join("cow.img");
            let bitmap_path = nbd_cow::cow::bitmap_path_for(&cow_path);

            write_sized_file(&binary_path, 1);
            std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod binary");
            write_sized_file(&kernel_path, 1);
            write_sized_file(&rootfs_path, nbd_cow::BLOCK_SIZE as u64);
            write_sized_file(&snapshot_path, 1);
            write_sized_file(&memory_path, 1);
            write_sized_file(&cow_path, nbd_cow::BLOCK_SIZE as u64);
            write_bitmap_file(&bitmap_path, 1, 0);

            Self {
                _dir: dir,
                binary_path,
                kernel_path,
                rootfs_path,
                snapshot: SnapshotConfig {
                    snapshot_path,
                    memory_path,
                    cow_path,
                    drive_bind_path: PathBuf::from("/tmp/cow-device-bind"),
                    home_drive_bind_path: PathBuf::from("/tmp/home-device-bind"),
                    vsock_bind_dir: PathBuf::from("/tmp/vsock"),
                },
            }
        }

        fn bitmap_path(&self) -> PathBuf {
            nbd_cow::cow::bitmap_path_for(&self.snapshot.cow_path)
        }

        fn fresh_config(&self) -> PrerequisiteConfig {
            PrerequisiteConfig {
                binary_path: self.binary_path.clone(),
                kernel_path: self.kernel_path.clone(),
                rootfs_path: self.rootfs_path.clone(),
                mode: PrerequisiteMode::FactoryFresh,
            }
        }

        fn snapshot_create_config(&self) -> PrerequisiteConfig {
            PrerequisiteConfig {
                binary_path: self.binary_path.clone(),
                kernel_path: self.kernel_path.clone(),
                rootfs_path: self.rootfs_path.clone(),
                mode: PrerequisiteMode::SnapshotCreate,
            }
        }

        fn restore_config(&self) -> PrerequisiteConfig {
            PrerequisiteConfig {
                binary_path: self.binary_path.clone(),
                kernel_path: self.kernel_path.clone(),
                rootfs_path: self.rootfs_path.clone(),
                mode: PrerequisiteMode::FactorySnapshotRestore {
                    snapshot: self.snapshot.clone(),
                },
            }
        }
    }

    fn write_sized_file(path: &Path, size: u64) {
        let file = File::create(path).unwrap_or_else(|e| panic!("create {}: {e}", path.display()));
        file.set_len(size)
            .unwrap_or_else(|e| panic!("set size {}: {e}", path.display()));
    }

    fn write_bitmap_file(path: &Path, blocks: u64, word: u64) {
        let mut data = blocks.to_le_bytes().to_vec();
        data.extend_from_slice(&word.to_le_bytes());
        std::fs::write(path, data)
            .unwrap_or_else(|e| panic!("write bitmap {}: {e}", path.display()));
    }

    fn replace_file_with_dir(path: &Path) {
        std::fs::remove_file(path).unwrap_or_else(|e| panic!("remove {}: {e}", path.display()));
        std::fs::create_dir(path).unwrap_or_else(|e| panic!("create dir {}: {e}", path.display()));
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|e| panic!("chmod dir {}: {e}", path.display()));
    }

    fn artifact_errors(config: PrerequisiteConfig) -> Vec<String> {
        let mut errors = Vec::new();
        check_artifact_prerequisites(&config, &mut errors);
        errors
    }

    fn assert_no_errors(errors: &[String]) {
        assert!(errors.is_empty(), "unexpected errors: {errors:#?}");
    }

    fn assert_error_contains(errors: &[String], expected: &str) {
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "expected error containing {expected:?}, got {errors:#?}"
        );
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o7777
    }

    fn snapshot_config() -> SnapshotConfig {
        SnapshotConfig {
            snapshot_path: PathBuf::from("/tmp/snapshot.bin"),
            memory_path: PathBuf::from("/tmp/memory.bin"),
            cow_path: PathBuf::from("/tmp/cow.img"),
            drive_bind_path: PathBuf::from("/tmp/cow-device-bind"),
            home_drive_bind_path: PathBuf::from("/tmp/home-device-bind"),
            vsock_bind_dir: PathBuf::from("/tmp/vsock"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_check_runs_off_current_thread_runtime() {
        let caller_thread = std::thread::current().id();
        let (thread_tx, thread_rx) = std::sync::mpsc::channel();

        run_prerequisite_check(move || {
            thread_tx.send(std::thread::current().id()).unwrap();
            Ok(())
        })
        .await
        .unwrap();

        assert_ne!(thread_rx.recv().unwrap(), caller_thread);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn blocking_check_runs_off_multi_thread_runtime_worker() {
        let caller_thread = std::thread::current().id();
        let (thread_tx, thread_rx) = std::sync::mpsc::channel();

        run_prerequisite_check(move || {
            thread_tx.send(std::thread::current().id()).unwrap();
            Ok(())
        })
        .await
        .unwrap();

        assert_ne!(thread_rx.recv().unwrap(), caller_thread);
    }

    #[tokio::test]
    async fn blocking_check_preserves_aggregated_backend_unavailable() {
        let error = run_prerequisite_check(|| {
            prerequisite_result(vec!["first failure".into(), "second failure".into()])
        })
        .await
        .unwrap_err();

        match error {
            SandboxError::BackendUnavailable { message } => {
                assert_eq!(message, "first failure; second failure");
            }
            other => panic!("expected BackendUnavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    #[should_panic(expected = "prerequisite task panic")]
    async fn blocking_check_resumes_task_panic() {
        let _ = run_prerequisite_check(|| panic!("prerequisite task panic")).await;
    }

    #[test]
    fn factory_fresh_commands_include_network_and_home_image_create() {
        let mode = PrerequisiteMode::FactoryFresh;
        assert_eq!(
            required_commands(&mode),
            vec![
                "ip",
                "iptables",
                "iptables-save",
                "iptables-restore",
                "conntrack",
                "sysctl",
                "mkfs.ext4"
            ]
        );
    }

    #[test]
    fn snapshot_restore_commands_include_cp_mkfs_and_private_mount_restore() {
        let snapshot = snapshot_config();
        let mode = PrerequisiteMode::FactorySnapshotRestore { snapshot };

        assert_eq!(
            required_commands(&mode),
            vec![
                "ip",
                "iptables",
                "iptables-save",
                "iptables-restore",
                "conntrack",
                "sysctl",
                "cp",
                "mkfs.ext4",
                "unshare",
                "bash",
                "mount",
                "umount",
            ]
        );
    }

    #[test]
    fn snapshot_create_commands_include_private_mount_create_without_sparse_copy() {
        let mode = PrerequisiteMode::SnapshotCreate;
        let commands = required_commands(&mode);

        assert_eq!(
            commands,
            vec![
                "ip",
                "iptables",
                "iptables-save",
                "iptables-restore",
                "conntrack",
                "sysctl",
                "mkfs.ext4",
                "unshare",
                "bash",
                "mount",
            ]
        );
    }

    #[test]
    fn required_commands_do_not_include_pgrep_without_dependency() {
        let snapshot = snapshot_config();
        let modes = [
            PrerequisiteMode::FactoryFresh,
            PrerequisiteMode::FactorySnapshotRestore {
                snapshot: snapshot.clone(),
            },
            PrerequisiteMode::SnapshotCreate,
        ];

        for mode in modes {
            let commands = required_commands(&mode);
            assert!(!commands.contains(&"pgrep"), "mode: {mode:?}");
        }
    }

    #[test]
    fn conntrack_is_required_for_network_modes() {
        let snapshot = snapshot_config();
        let modes = [
            PrerequisiteMode::FactoryFresh,
            PrerequisiteMode::FactorySnapshotRestore { snapshot },
            PrerequisiteMode::SnapshotCreate,
        ];

        for mode in modes {
            let commands = required_commands(&mode);
            assert!(commands.contains(&"conntrack"), "mode: {mode:?}");
        }
    }

    #[test]
    fn runtime_commands_cover_factory_modes_and_dns_networking() {
        let runtime_commands = runtime_required_commands();
        let snapshot = snapshot_config();
        let modes = [
            PrerequisiteMode::FactoryFresh,
            PrerequisiteMode::FactorySnapshotRestore { snapshot },
        ];

        for mode in modes {
            for command in required_commands(&mode) {
                assert!(runtime_commands.contains(&command), "mode: {mode:?}");
            }
        }
        for command in network_commands(true) {
            assert!(runtime_commands.contains(&command));
        }
    }

    #[test]
    fn network_prerequisites_only_require_ipv6_tools_for_dns_filter() {
        assert_eq!(
            network_commands(false),
            vec![
                "ip",
                "iptables",
                "iptables-save",
                "iptables-restore",
                "conntrack",
                "sysctl"
            ]
        );
        assert_eq!(
            network_commands(true),
            vec![
                "ip",
                "iptables",
                "iptables-save",
                "iptables-restore",
                "conntrack",
                "sysctl",
                "ip6tables",
                "ip6tables-save",
                "ip6tables-restore",
            ]
        );
    }

    #[test]
    fn runtime_namespace_creates_traversable_runtime_and_sock_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("vm0");
        let sock_base = runtime_dir.join("sock");
        let mut errors = Vec::new();

        ensure_runtime_namespace_at(&runtime_dir, &sock_base, &mut errors);

        assert_no_errors(&errors);
        assert_eq!(mode(&runtime_dir), 0o711);
        assert_eq!(mode(&sock_base), 0o711);
    }

    #[test]
    fn runtime_namespace_reports_unsafe_sock_root() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("vm0");
        let sock_base = runtime_dir.join("sock");
        let target = tmp.path().join("target");
        std::fs::create_dir(&runtime_dir).unwrap();
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &sock_base).unwrap();
        let mut errors = Vec::new();

        ensure_runtime_namespace_at(&runtime_dir, &sock_base, &mut errors);

        assert_error_contains(&errors, "failed to prepare runtime sock dir");
        assert_error_contains(&errors, "is a symlink");
    }

    #[test]
    fn snapshot_artifacts_are_present_only_for_restore_mode() {
        let snapshot = snapshot_config();
        assert!(PrerequisiteMode::FactoryFresh.snapshot().is_none());
        assert!(PrerequisiteMode::SnapshotCreate.snapshot().is_none());
        let restore_mode = PrerequisiteMode::FactorySnapshotRestore {
            snapshot: snapshot.clone(),
        };
        let restore_snapshot = restore_mode.snapshot().unwrap();
        assert_eq!(restore_snapshot.snapshot_path, snapshot.snapshot_path);
        assert_eq!(restore_snapshot.memory_path, snapshot.memory_path);
        assert_eq!(restore_snapshot.cow_path, snapshot.cow_path);
    }

    #[test]
    fn valid_fresh_artifacts_pass() {
        let fixture = ArtifactFixture::new();

        let errors = artifact_errors(fixture.fresh_config());

        assert_no_errors(&errors);
    }

    #[test]
    fn valid_restore_artifacts_pass() {
        let fixture = ArtifactFixture::new();

        let errors = artifact_errors(fixture.restore_config());

        assert_no_errors(&errors);
    }

    #[test]
    fn artifact_prerequisites_reject_directory_artifacts() {
        let fixture = ArtifactFixture::new();
        let bitmap_path = fixture.bitmap_path();
        for path in [
            &fixture.binary_path,
            &fixture.kernel_path,
            &fixture.rootfs_path,
            &fixture.snapshot.snapshot_path,
            &fixture.snapshot.memory_path,
            &fixture.snapshot.cow_path,
            &bitmap_path,
        ] {
            replace_file_with_dir(path);
        }

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "firecracker binary is not a regular file");
        assert_error_contains(&errors, "kernel is not a regular file");
        assert_error_contains(&errors, "rootfs is not a regular file");
        assert_error_contains(&errors, "snapshot state is not a regular file");
        assert_error_contains(&errors, "snapshot memory is not a regular file");
        assert_error_contains(&errors, "snapshot cow is not a regular file");
        assert_error_contains(&errors, "snapshot cow bitmap is not a regular file");
    }

    #[test]
    fn artifact_prerequisites_report_missing_paths() {
        let fixture = ArtifactFixture::new();
        std::fs::remove_file(&fixture.kernel_path).expect("remove kernel");

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "kernel not found");
    }

    #[test]
    fn artifact_prerequisites_accept_symlink_to_file() {
        let fixture = ArtifactFixture::new();
        let kernel_target = fixture.kernel_path.with_file_name("linked-vmlinux");
        write_sized_file(&kernel_target, 1);
        std::fs::remove_file(&fixture.kernel_path).expect("remove kernel");
        symlink(&kernel_target, &fixture.kernel_path).expect("symlink kernel");

        let errors = artifact_errors(fixture.fresh_config());

        assert_no_errors(&errors);
    }

    #[test]
    fn artifact_prerequisites_reject_symlink_to_directory() {
        let fixture = ArtifactFixture::new();
        let kernel_target = fixture.kernel_path.with_file_name("kernel-dir");
        std::fs::create_dir(&kernel_target).expect("create kernel dir");
        std::fs::remove_file(&fixture.kernel_path).expect("remove kernel");
        symlink(&kernel_target, &fixture.kernel_path).expect("symlink kernel");

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "kernel is not a regular file");
    }

    #[test]
    fn artifact_prerequisites_reject_non_executable_binary() {
        let fixture = ArtifactFixture::new();
        std::fs::set_permissions(&fixture.binary_path, std::fs::Permissions::from_mode(0o644))
            .expect("chmod binary");

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "firecracker binary is not executable");
    }

    #[test]
    fn artifact_prerequisites_reject_binary_without_current_user_execute_access() {
        if nix::unistd::geteuid().as_raw() == 0 {
            return;
        }

        let fixture = ArtifactFixture::new();
        std::fs::set_permissions(&fixture.binary_path, std::fs::Permissions::from_mode(0o001))
            .expect("chmod binary");

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "firecracker binary is not executable");
    }

    #[test]
    fn artifact_prerequisites_reject_empty_rootfs() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.rootfs_path, 0);

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "rootfs is empty");
    }

    #[test]
    fn artifact_prerequisites_reject_empty_boot_and_snapshot_artifacts() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.binary_path, 0);
        write_sized_file(&fixture.kernel_path, 0);
        write_sized_file(&fixture.snapshot.snapshot_path, 0);
        write_sized_file(&fixture.snapshot.memory_path, 0);

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "firecracker binary is empty");
        assert_error_contains(&errors, "kernel is empty");
        assert_error_contains(&errors, "snapshot state is empty");
        assert_error_contains(&errors, "snapshot memory is empty");
    }

    #[test]
    fn artifact_prerequisites_reject_unaligned_rootfs() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.rootfs_path, nbd_cow::BLOCK_SIZE as u64 + 1);

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "rootfs size");
        assert_error_contains(&errors, "not a multiple");
    }

    #[test]
    fn restore_mode_requires_snapshot_cow_bitmap() {
        let fixture = ArtifactFixture::new();
        std::fs::remove_file(fixture.bitmap_path()).expect("remove bitmap");

        let fresh_errors = artifact_errors(fixture.fresh_config());
        let snapshot_create_errors = artifact_errors(fixture.snapshot_create_config());
        let restore_errors = artifact_errors(fixture.restore_config());

        assert_no_errors(&fresh_errors);
        assert_no_errors(&snapshot_create_errors);
        assert_error_contains(&restore_errors, "snapshot cow bitmap not found");
    }

    #[test]
    fn restore_mode_rejects_mismatched_snapshot_cow_bitmap() {
        let fixture = ArtifactFixture::new();
        write_bitmap_file(&fixture.bitmap_path(), 2, 0);

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "snapshot cow bitmap is invalid");
        assert_error_contains(&errors, "bitmap block count mismatch");
    }

    #[test]
    fn restore_mode_rejects_truncated_snapshot_cow_bitmap() {
        let fixture = ArtifactFixture::new();
        std::fs::write(fixture.bitmap_path(), 1u64.to_le_bytes()).expect("write bitmap");

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "snapshot cow bitmap is invalid");
        assert_error_contains(&errors, "bitmap data truncated");
    }

    #[test]
    fn restore_mode_rejects_snapshot_cow_too_short_for_dirty_bitmap() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.snapshot.cow_path, 0);
        write_bitmap_file(&fixture.bitmap_path(), 1, 1);

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "snapshot cow bitmap is invalid");
        assert_error_contains(&errors, "dirty bitmap references COW data");
    }

    #[test]
    fn restore_mode_accepts_short_snapshot_cow_for_clean_bitmap() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.snapshot.cow_path, 0);
        write_bitmap_file(&fixture.bitmap_path(), 1, 0);

        let errors = artifact_errors(fixture.restore_config());

        assert_no_errors(&errors);
    }
}
