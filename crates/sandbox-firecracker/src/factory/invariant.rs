use sha2::{Digest, Sha256};

use crate::boot_config::{BalloonConfig, BootConfigInput, FirecrackerBootConfig};
use crate::network::{GUEST_NETWORK, generate_boot_args};

const HASH_VCPU_COUNT: u32 = 1;
const HASH_MEMORY_MB: u32 = 1;
const HASH_KERNEL_PATH: &str = "/kernel";
const HASH_ROOTFS_PATH: &str = "/rootfs";
const HASH_HOME_PATH: &str = "/home-image";
const HASH_VSOCK_PATH: &str = "/vsock";

/// Shell command executed during snapshot creation to pre-warm guest state.
/// Changing this invalidates all cached snapshots (included in [`config_hash`]).
///
/// **Note:** Do NOT wrap this in another user transition — the guest-control-server exec
/// handler already applies the sandbox credentials directly (`setgroups`,
/// `setgid`, and `setuid`) before executing an explicit non-login `/bin/sh` in
/// release builds.
/// Double-wrapping creates nested sessions where inner processes escape the
/// process group, surviving SIGKILL on timeout as orphans frozen into the
/// snapshot.
///
/// - `claude --print --verbose --output-format stream-json hi`:
///   exercises the full CLI initialization path matching the real guest-agent
///   invocation (module loading, config parsing, API client setup) so all
///   relevant memory pages are captured in the snapshot. Fails with
///   "Invalid API key" but still loads the complete module graph. The claude
///   binary is a Bun-compiled executable (not Node.js), so
///   `NODE_COMPILE_CACHE` has no effect.
/// - `codex --help`: npm `@openai/codex` uses a Node.js launcher to run the
///   native Rust CLI. The help command runs without credentials and exits
///   before the VM is paused, so no live CLI process or reusable process-local
///   V8 JIT state is preserved. It may warm the guest's file/page cache for
///   files read during startup; any startup benefit requires measurement.
///   Each warmup is wrapped in its own
///   `(... || true)` sub-shell so a failure on one framework does not block
///   the other from warming.
pub const PREWARM_SCRIPT: &str = "\
    (claude --print --verbose --output-format stream-json hi 2>/dev/null || true); \
    (codex --help >/dev/null 2>&1 || true)";

/// Invariant configuration shared by all sandboxes.
///
/// These parameters affect snapshot output and are used by:
/// - [`config_hash`] — deterministic fingerprint for snapshot cache invalidation
/// - [`crate::sandbox::FirecrackerSandbox::build_config`] — fresh boot JSON configuration
/// - Snapshot creation API calls in `snapshot.rs`
///
/// Topology-owned values are serialized through the shared boot configuration
/// in [`config_hash`]. The remaining snapshot-affecting values are included
/// alongside that topology.
pub struct InvariantConfig {
    pub boot_args: String,
    pub guest_mac: &'static str,
    pub tap_name: &'static str,
    /// TAP MAC used in netns setup for ARP. Not in the Firecracker config JSON,
    /// but affects snapshot behavior (guest ARP cache is baked into the snapshot).
    pub tap_mac: &'static str,
    pub iface_id: &'static str,
    pub guest_cid: u32,
    pub balloon: BalloonConfig,
    pub prewarm_script: &'static str,
}

#[derive(serde::Serialize)]
struct ConfigHashInput<'a> {
    home_layout: &'a str,
    boot_config: &'a FirecrackerBootConfig,
    tap_mac: &'a str,
    prewarm_script: &'a str,
}

impl InvariantConfig {
    pub fn new() -> Self {
        Self {
            boot_args: generate_boot_args(),
            guest_mac: GUEST_NETWORK.guest_mac,
            tap_name: GUEST_NETWORK.tap_name,
            tap_mac: GUEST_NETWORK.tap_mac,
            iface_id: "eth0",
            guest_cid: 3,
            balloon: BalloonConfig {
                amount_mib: 0,
                deflate_on_oom: true,
                free_page_reporting: true,
                stats_polling_interval_s: 5,
            },
            prewarm_script: PREWARM_SCRIPT,
        }
    }
}

/// SHA-256 fingerprint of all sandbox-firecracker internal configuration that affects
/// snapshot output.
///
/// Derived from a canonical snapshot boot topology plus snapshot-affecting
/// invariants that are not part of the Firecracker configuration document.
///
/// This is the backing implementation for [`sandbox::SandboxFactory::config_hash`].
/// It is also available as a free function so callers that don't have a
/// factory instance (e.g. the snapshot subcommand) can compute the hash.
/// # Panics
/// Cannot panic — the hash input contains only serializable primitives,
/// strings, vectors, and structs.
#[allow(clippy::expect_used)]
pub fn config_hash() -> String {
    let invariant = InvariantConfig::new();
    let boot_config = canonical_snapshot_boot_config(&invariant);
    config_hash_for(&boot_config, invariant.tap_mac, invariant.prewarm_script)
        .expect("serialize Firecracker config hash input")
}

fn canonical_snapshot_boot_config(invariant: &InvariantConfig) -> FirecrackerBootConfig {
    FirecrackerBootConfig::new(BootConfigInput {
        invariant,
        vcpu_count: HASH_VCPU_COUNT,
        memory_mb: HASH_MEMORY_MB,
        kernel_path: HASH_KERNEL_PATH.to_owned(),
        rootfs_path: HASH_ROOTFS_PATH.to_owned(),
        home_path: Some(HASH_HOME_PATH.to_owned()),
        vsock_path: HASH_VSOCK_PATH.to_owned(),
    })
}

fn config_hash_for(
    boot_config: &FirecrackerBootConfig,
    tap_mac: &str,
    prewarm_script: &str,
) -> Result<String, serde_json::Error> {
    let input = ConfigHashInput {
        home_layout: guest_contracts::home_mount::HOME_DRIVE_LAYOUT,
        boot_config,
        tap_mac,
        prewarm_script,
    };
    let json = serde_json::to_string(&input)?;
    Ok(hex::encode(Sha256::digest(json.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_hash_is_deterministic() {
        let h1 = config_hash();
        let h2 = config_hash();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[test]
    fn prewarm_script_warms_both_frameworks() {
        assert!(
            PREWARM_SCRIPT.contains("claude"),
            "PREWARM_SCRIPT must warm the claude CLI"
        );
        assert!(
            PREWARM_SCRIPT.contains("codex"),
            "PREWARM_SCRIPT must warm the codex CLI"
        );
    }

    #[test]
    fn canonical_snapshot_topology_has_all_shared_sections_and_ordered_drives() {
        let invariant = InvariantConfig::new();
        let config = canonical_snapshot_boot_config(&invariant);
        assert_eq!(
            config
                .drives
                .iter()
                .map(|drive| drive.drive_id.as_str())
                .collect::<Vec<_>>(),
            ["rootfs", "home"]
        );

        let json = serde_json::to_value(config).unwrap();
        let obj = json.as_object().unwrap();
        let expected_fields = [
            "boot-source",
            "drives",
            "machine-config",
            "network-interfaces",
            "vsock",
            "balloon",
        ];
        for field in &expected_fields {
            assert!(obj.contains_key(*field), "missing field: {field}");
        }
        assert_eq!(
            obj.len(),
            expected_fields.len(),
            "unexpected Firecracker boot config section"
        );
        assert_eq!(obj["balloon"]["free_page_reporting"], true);
        assert!(obj["balloon"].get("free_page_hinting").is_none());
    }

    #[test]
    fn balloon_reporting_change_changes_config_hash() {
        let invariant = InvariantConfig::new();
        let config = canonical_snapshot_boot_config(&invariant);
        let original =
            config_hash_for(&config, invariant.tap_mac, invariant.prewarm_script).unwrap();
        let mut reporting_disabled = config.clone();
        reporting_disabled.balloon.free_page_reporting = false;
        let changed = config_hash_for(
            &reporting_disabled,
            invariant.tap_mac,
            invariant.prewarm_script,
        )
        .unwrap();

        assert_ne!(original, changed);
    }

    #[test]
    fn topology_change_changes_config_hash() {
        let invariant = InvariantConfig::new();
        let config = canonical_snapshot_boot_config(&invariant);
        let original =
            config_hash_for(&config, invariant.tap_mac, invariant.prewarm_script).unwrap();
        let mut reordered = config.clone();
        reordered.drives.reverse();
        let changed =
            config_hash_for(&reordered, invariant.tap_mac, invariant.prewarm_script).unwrap();

        assert_ne!(original, changed);
    }

    #[test]
    fn config_hash_matches_snapshot_provider_trait() {
        let provider = crate::FirecrackerSnapshotProvider;
        let trait_hash = sandbox::SnapshotProvider::config_hash(&provider);
        let direct_hash = config_hash();
        assert_eq!(trait_hash, direct_hash);
    }
}
