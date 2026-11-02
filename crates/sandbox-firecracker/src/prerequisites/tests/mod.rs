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
    std::fs::write(path, data).unwrap_or_else(|e| panic!("write bitmap {}: {e}", path.display()));
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
