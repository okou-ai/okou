use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Provider-neutral identity of a sandbox lifecycle. A newly created sandbox
/// receives this ID, and subsequent reuse jobs retain it. Providers use it to
/// identify the same sandbox instance across lifecycle operations.
///
/// Distinct from `RunId` (a per-job server identifier defined in the
/// `runner` crate). A new sandbox receives its ID independently of the current
/// job's `RunId`. A reused sandbox keeps its existing `SandboxId` while the
/// new job has its own `RunId`; the two identifiers are not interchangeable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SandboxId(uuid::Uuid);

impl SandboxId {
    /// Allocate a fresh lifecycle identity for a newly created sandbox.
    ///
    /// This identifies the sandbox instance itself, not an individual runner
    /// run or job. Reused sandboxes keep their original identity.
    pub fn new_v4() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    /// Extract the inner `Uuid` for interop with APIs that require a raw
    /// UUID (snapshot hashing, format strings, etc.).
    pub fn as_uuid(self) -> uuid::Uuid {
        self.0
    }
}

impl fmt::Display for SandboxId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl FromStr for SandboxId {
    type Err = uuid::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        uuid::Uuid::parse_str(s).map(Self)
    }
}

impl From<uuid::Uuid> for SandboxId {
    fn from(u: uuid::Uuid) -> Self {
        Self(u)
    }
}

/// Requested resource limits for one sandbox instance.
///
/// Providers use these values when creating a sandbox. The exact enforcement
/// mechanism is provider-specific, but the units are shared across providers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceLimits {
    /// Requested number of guest vCPUs.
    pub cpu_count: u32,
    /// Requested guest memory in MiB.
    pub memory_mb: u32,
}

/// Provider-neutral block device I/O limits for one sandbox instance.
///
/// Rates are positive when a limiter is enabled. Use `None` at the sandbox
/// config level to disable device limiting; do not encode disabled limiters as
/// zeros.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockRateLimits {
    /// Sustained block-device bandwidth in bytes per second.
    pub bandwidth_bytes_per_sec: u64,
    /// Sustained block-device operations per second.
    pub ops_per_sec: u64,
}

/// Provider-neutral network I/O limits for one sandbox instance.
///
/// Rates are positive when a limiter is enabled. Use `None` at the sandbox
/// config level to disable device limiting; do not encode disabled limiters as
/// zeros.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkRateLimits {
    /// Sustained receive bandwidth in bytes per second.
    pub rx_bytes_per_sec: u64,
    /// Sustained transmit bandwidth in bytes per second.
    pub tx_bytes_per_sec: u64,
}

/// Provider-neutral device I/O limits for one sandbox instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceRateLimits {
    /// Block-device rate limits.
    pub block: BlockRateLimits,
    /// Network-interface rate limits.
    pub network: NetworkRateLimits,
}

/// Host-local ext4 image seeding behavior for one sandbox workspace image.
///
/// A supplied seed image must have the logical size described by
/// [`WorkspaceDriveConfig::size_mb`]. The Firecracker provider requires the
/// seed to be a regular file whose length is exactly
/// `size_mb * 1024 * 1024` bytes and does not resize it; a size mismatch fails
/// sandbox creation before the copy or move consumes the source. Other
/// providers may prepare seed images differently.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceDriveSeedImage {
    /// Copy the host-local ext4 image into this sandbox's active workspace
    /// image. The caller retains ownership, and the source must remain intact
    /// and must never be mounted read-write by the provider.
    Copy(PathBuf),
    /// Move the host-local ext4 image into this sandbox's active workspace
    /// image. The caller retains ownership until the provider completes the
    /// transfer and consumes the source from its original path. If the
    /// transfer fails before that boundary, the source remains caller-owned.
    /// After that boundary, a later sandbox-creation failure does not return
    /// ownership or require the provider to restore the original path.
    Move(PathBuf),
}

/// Provider-neutral workspace block image configuration for one sandbox.
///
/// The image is mounted by runner-controlled guest setup at the canonical
/// execution workspace. Providers only need to expose it as a writable non-root
/// block device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceDriveConfig {
    /// Logical size in MiB for the workspace image.
    ///
    /// This size applies both when a provider initializes a fresh image and
    /// when it prepares a supplied [`WorkspaceDriveSeedImage`]. A supplied seed
    /// image must have this logical size; see [`WorkspaceDriveSeedImage`] for
    /// the provider-specific preparation contract.
    pub size_mb: u32,
    /// Optional host-local ext4 image used to seed this sandbox's active
    /// workspace image. The seed variant determines whether providers must
    /// preserve the source image or consume it with a move.
    pub seed_image: Option<WorkspaceDriveSeedImage>,
}

/// Per-sandbox creation configuration passed to [`crate::SandboxFactory::create`].
///
/// Factory-wide configuration belongs in [`FactoryConfig`]; these values are
/// chosen for each individual sandbox lifecycle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxConfig {
    /// Sandbox lifecycle identity.
    ///
    /// This is distinct from runner-level run or job identifiers and can remain
    /// stable across multiple jobs when a sandbox is reused.
    pub id: SandboxId,
    /// Requested resource limits for this sandbox.
    pub resources: ResourceLimits,
    /// Optional provider-neutral I/O limits to apply to this sandbox.
    pub device_rate_limits: Option<DeviceRateLimits>,
    /// Optional writable workspace block image.
    pub workspace_drive: Option<WorkspaceDriveConfig>,
}

/// Reference to a pre-built snapshot for fast VM boot.
/// The backend resolves individual artifact paths from the output directory.
#[derive(Clone)]
pub struct SnapshotRef {
    /// Directory containing backend-specific snapshot artifacts.
    pub output_dir: PathBuf,
    /// Content hash of the snapshot, used as an identifier for path derivation.
    pub hash: String,
}

/// Configuration for creating a sandbox factory for a specific profile.
/// This is clonable path/data input, not ownership of a running factory.
#[derive(Clone)]
pub struct FactoryConfig {
    /// Profile name (e.g., "vm0/default").
    pub profile: String,
    /// Path to the sandbox backend binary (e.g., firecracker).
    pub binary_path: PathBuf,
    /// Path to the guest kernel image.
    pub kernel_path: PathBuf,
    /// Path to the root filesystem image.
    pub rootfs_path: PathBuf,
    /// Base directory for runtime data (workspaces, COW devices, etc.).
    pub base_dir: PathBuf,
    /// Snapshot to restore from. When set, VMs boot via snapshot restore.
    pub snapshot: Option<SnapshotRef>,
}

/// Whether a sandbox runtime must establish managed host CPU placement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostCpuPlacementMode {
    /// Runtime initialization fails when the delegated host CPU boundary is unavailable.
    Required,
    /// Runtime initialization may continue unmanaged only when delegation is unavailable.
    PreferManaged,
}

/// Runner-wide policy for weighted host CPU placement.
///
/// The concrete sandbox provider discovers and owns its host resource boundary;
/// callers only choose the sibling weights and whether delegation is required.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostCpuPlacementConfig {
    control_weight: u32,
    guests_weight: u32,
    mode: HostCpuPlacementMode,
}

impl HostCpuPlacementConfig {
    /// Smallest CPU weight accepted by cgroup v2.
    pub const MIN_WEIGHT: u32 = 1;
    /// Largest CPU weight accepted by cgroup v2.
    pub const MAX_WEIGHT: u32 = 10_000;

    /// Build a validated placement policy.
    pub fn new(
        control_weight: u32,
        guests_weight: u32,
        mode: HostCpuPlacementMode,
    ) -> Result<Self, String> {
        for (name, weight) in [
            ("control_weight", control_weight),
            ("guests_weight", guests_weight),
        ] {
            if !(Self::MIN_WEIGHT..=Self::MAX_WEIGHT).contains(&weight) {
                return Err(format!(
                    "{name} must be between {} and {}",
                    Self::MIN_WEIGHT,
                    Self::MAX_WEIGHT
                ));
            }
        }
        Ok(Self {
            control_weight,
            guests_weight,
            mode,
        })
    }

    /// Weight assigned to Runner control work.
    pub fn control_weight(self) -> u32 {
        self.control_weight
    }

    /// Aggregate weight assigned to all Firecracker Guests.
    pub fn guests_weight(self) -> u32 {
        self.guests_weight
    }

    /// Startup behavior when host cgroup delegation is unavailable.
    pub fn mode(self) -> HostCpuPlacementMode {
        self.mode
    }
}

/// Runtime-wide configuration used to initialize shared backend resources.
///
/// These values are discovered before a runtime is created and apply to every
/// factory produced by that runtime. Per-profile and per-sandbox settings
/// belong in [`FactoryConfig`] and [`SandboxConfig`].
pub struct RuntimeConfig {
    /// Proxy port for network traffic interception. Shared across all factories.
    pub proxy_port: Option<u16>,
    /// DNS proxy port for DNS query interception. Shared across all factories.
    pub dns_port: Option<u16>,
    /// Optional host CPU placement policy for normal sandboxes.
    ///
    /// `None` is reserved for direct developer utilities that do not enter the
    /// Runner worker admission loop.
    pub host_cpu_placement: Option<HostCpuPlacementConfig>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_id_serde_transparent_roundtrip() {
        let id = SandboxId::new_v4();
        let json = serde_json::to_string(&id).unwrap();
        assert!(json.starts_with('"'), "expected bare UUID string: {json}");
        let parsed: SandboxId = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn sandbox_id_as_uuid_roundtrip() {
        let id = SandboxId::new_v4();
        let uuid = id.as_uuid();
        let back = SandboxId::from(uuid);
        assert_eq!(back, id);
    }

    #[test]
    fn sandbox_id_from_str() {
        let id = SandboxId::new_v4();
        let parsed: SandboxId = id.to_string().parse().unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn host_cpu_placement_config_validates_kernel_weight_range() {
        let config = HostCpuPlacementConfig::new(
            HostCpuPlacementConfig::MIN_WEIGHT,
            HostCpuPlacementConfig::MAX_WEIGHT,
            HostCpuPlacementMode::Required,
        )
        .unwrap();
        assert_eq!(config.control_weight(), 1);
        assert_eq!(config.guests_weight(), 10_000);
        assert_eq!(config.mode(), HostCpuPlacementMode::Required);

        assert!(HostCpuPlacementConfig::new(0, 1, HostCpuPlacementMode::Required).is_err());
        assert!(
            HostCpuPlacementConfig::new(1, 10_001, HostCpuPlacementMode::PreferManaged).is_err()
        );
    }
}
