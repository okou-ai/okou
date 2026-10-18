//! Immutable runtime backing shared by Firecracker and Guest boot.

/// Firecracker API ID of the independently read-only base image.
///
/// This is not a Guest virtio serial: Firecracker derives that from Host file
/// metadata. Guest discovery verifies the sole readonly non-root device in the
/// paired topology and its independent filesystem identity.
pub const RUNTIME_DRIVE_ID: &str = "runtime";
/// Fixed mount of the complete immutable runtime filesystem.
pub const RUNTIME_MOUNT_PATH: &str = "/run/okou/runtime";
/// Rootfs input identity installed in both the boot and immutable image views.
pub const RUNTIME_IDENTITY_PATH: &str = "/etc/okou/runtime-rootfs-id";
