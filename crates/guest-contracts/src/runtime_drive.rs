//! Immutable runtime backing shared by Firecracker and Guest boot.

/// Firecracker API ID of the independently read-only base image.
///
/// This is not a Guest virtio serial: Firecracker derives that from Host file
/// metadata. Guest discovery verifies the sole readonly non-root device in the
/// paired topology and its independent filesystem identity.
pub const RUNTIME_DRIVE_ID: &str = "runtime";
/// Fixed mount of the complete immutable runtime filesystem.
pub const RUNTIME_MOUNT_PATH: &str = "/run/okou/runtime";
/// Runtime build-input identity installed in both paired image views.
pub const RUNTIME_IDENTITY_PATH: &str = "/etc/okou/runtime-build-id";
/// Fixed native Agent supervisor in the verified runtime.
pub const RUNTIME_GUEST_AGENT: &str = "/run/okou/runtime/usr/local/bin/guest-agent";
/// Official Claude Code executable in the verified runtime.
pub const RUNTIME_CLAUDE: &str = "/run/okou/runtime/usr/local/bin/claude";
/// Official native Codex executable in the verified runtime.
pub const RUNTIME_CODEX: &str = "/run/okou/runtime/usr/local/bin/codex";
/// Official npm package root used by the fixed native Codex launcher.
pub const RUNTIME_CODEX_PACKAGE_ROOT: &str = "/run/okou/runtime/usr/local/lib/okou-codex";
/// Private Node interpreter with immutable ELF dependencies.
pub const RUNTIME_NODE: &str = "/run/okou/runtime/usr/bin/node";
/// Private Pi entry from the paired CLI package.
pub const RUNTIME_PI_ENTRY: &str = "/run/okou/runtime/usr/local/lib/okou-agent/agent.js";
