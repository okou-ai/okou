use crate::*;
use std::path::PathBuf;
use std::time::Duration;

use ::sandbox::*;

fn test_snapshot_config(output_dir: PathBuf) -> SnapshotCreateConfig {
    SnapshotCreateConfig {
        id: "test-snapshot".into(),
        binary_path: "/tmp/firecracker".into(),
        kernel_path: "/tmp/kernel".into(),
        rootfs_path: "/tmp/rootfs.ext4".into(),
        output_dir,
        vcpu_count: 2,
        memory_mb: 1024,
        home_disk_mb: 16,
    }
}

fn test_sandbox_config() -> SandboxConfig {
    SandboxConfig {
        id: SandboxId::new_v4(),
        resources: ResourceLimits {
            cpu_count: 2,
            memory_mb: 1024,
        },
        device_rate_limits: None,
        home_drive: None,
    }
}

fn test_factory_config() -> FactoryConfig {
    FactoryConfig {
        profile: "test".into(),
        binary_path: "/bin/test".into(),
        kernel_path: "/boot/test".into(),
        rootfs_path: "/rootfs/test".into(),
        base_dir: "/tmp/test".into(),
        snapshot: None,
    }
}

fn assert_operation_error(
    error: SandboxError,
    expected_operation: SandboxOperation,
    expected_reason: SandboxOperationReason,
    expected_message: &str,
) {
    match error {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, expected_operation);
            assert_eq!(reason, expected_reason);
            assert!(message.contains(expected_message), "got: {message}");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

fn test_timeout() -> Duration {
    Duration::from_secs(5)
}

fn lifecycle_gate_released_count(gate: &MockLifecycleGate) -> u64 {
    gate.released_count()
}

mod backing_process;
mod control;
mod exec;
mod factory_runtime;
mod files;
mod lifecycle;
mod process;
mod snapshot;
