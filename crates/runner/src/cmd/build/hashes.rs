use std::net::Ipv4Addr;
use std::path::Path;

use guest_contracts::home_mount::HOME_DRIVE_LAYOUT;
use sandbox_firecracker::DNS_PROBE_RESOLVER_IPV4;
use sha2::{Digest, Sha256};

use crate::ca;
use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;

use super::scripts::{CUSTOMIZE_SCRIPT, TEMPLATE_BUILD_SCRIPT};

/// Bump to invalidate all shared template images in R2.
///
/// Bumping orphans previous R2 objects; the bucket lifecycle expires them after
/// the configured retention window.
const TEMPLATE_CACHE_VERSION: u32 = 1;

/// Bump to invalidate all local rootfs images.
///
/// Rootfs images are not shared through R2 because they include guest binaries
/// and host-local CA material. Rotate this version when installed CLI metadata
/// serialization or fixed installation rules change.
const ROOTFS_CACHE_VERSION: u32 = 4;

/// Bump to invalidate all cached snapshots (local only; R2 stores only the template).
const SNAPSHOT_CACHE_VERSION: u32 = 3;

/// Rootfs-hash inputs contributed by an installed Okou CLI artifact.
pub(super) struct OkouCliHashInput<'a> {
    /// Build-time SHA-256 of the verified package, whose identity is bound to it.
    pub(super) package_sha256: &'a str,
}

/// Shared template and local rootfs identities for a full image build.
pub(super) struct RootfsBuildHashes {
    pub(super) template_hash: String,
    pub(super) rootfs_hash: String,
}

/// Compute a template hash for shared R2 image caching.
///
/// Inputs:
///   - `TEMPLATE_CACHE_VERSION` — bump to force invalidation
///   - `TEMPLATE_BUILD_SCRIPT` — template build script content
///   - `std::env::consts::ARCH` — runner binary target architecture
///   - `rootfs_disk_mb` — rootfs disk size from profile
///
/// Guest binaries and host-local CA are deliberately excluded; those belong
/// to the local rootfs hash.
///
/// **Changing this function invalidates all shared template images.**
pub(super) fn compute_template_hash(rootfs_disk_mb: u32) -> String {
    let mut hasher = Sha256::new();

    hasher.update(b"template_version:");
    hasher.update(TEMPLATE_CACHE_VERSION.to_le_bytes());
    hasher.update(b"template_script:");
    hasher.update(TEMPLATE_BUILD_SCRIPT.as_bytes());
    hasher.update(b"arch:");
    hasher.update(std::env::consts::ARCH.as_bytes());
    hasher.update(b"rootfs_disk_mb:");
    hasher.update(rootfs_disk_mb.to_le_bytes());

    hex::encode(hasher.finalize())
}

fn update_rootfs_hash_field(hasher: &mut Sha256, label: &[u8], value: &[u8]) -> RunnerResult<()> {
    let value_len = u64::try_from(value.len())
        .map_err(|_| RunnerError::Internal("rootfs hash field exceeds u64 length".into()))?;
    hasher.update(label);
    hasher.update(value_len.to_be_bytes());
    hasher.update(value);
    Ok(())
}

/// Compute the local rootfs hash.
///
/// This hash is what runner configs use. It includes the shared template hash plus
/// every rootfs-only input that changes the bootable rootfs content.
///
/// The canonical encoding is a sequence of fields, each encoded as its fixed ASCII
/// label, the value's byte length as a big-endian `u64`, then the value bytes. The
/// fields are ordered as version, paired home layout, template hash, customization script, rootfs disk
/// size, CA fingerprint, DNS resolver, then one destination/content pair per guest
/// binary in inventory order, then, only when an Okou CLI artifact is installed,
/// its verified package SHA-256. Packed identity determines the installed manifest;
/// metadata and byte integrity are validated at compilation, not rechecked or hashed twice.
/// Fixed-width integers use big-endian
/// bytes and IPv4 addresses use their four network-order octets. Future inputs
/// must use `update_rootfs_hash_field` so arbitrary value bytes cannot shift field
/// boundaries.
async fn compute_rootfs_hash(
    template_hash: &str,
    guest_bins: &[(&Path, &str)],
    ca_fingerprint: &str,
    dns_nameserver: Ipv4Addr,
    rootfs_disk_mb: u32,
    okou_cli: Option<&OkouCliHashInput<'_>>,
) -> RunnerResult<String> {
    let mut hasher = Sha256::new();

    update_rootfs_hash_field(
        &mut hasher,
        b"rootfs_version:",
        &ROOTFS_CACHE_VERSION.to_be_bytes(),
    )?;
    update_rootfs_hash_field(&mut hasher, b"home_layout:", HOME_DRIVE_LAYOUT.as_bytes())?;
    update_rootfs_hash_field(&mut hasher, b"template:", template_hash.as_bytes())?;
    update_rootfs_hash_field(
        &mut hasher,
        b"customize_script:",
        CUSTOMIZE_SCRIPT.as_bytes(),
    )?;
    update_rootfs_hash_field(
        &mut hasher,
        b"rootfs_disk_mb:",
        &rootfs_disk_mb.to_be_bytes(),
    )?;
    update_rootfs_hash_field(&mut hasher, b"ca_fingerprint:", ca_fingerprint.as_bytes())?;
    update_rootfs_hash_field(&mut hasher, b"dns_nameserver:", &dns_nameserver.octets())?;

    for (src, dest) in guest_bins {
        let content = tokio::fs::read(src)
            .await
            .map_err(|e| RunnerError::Internal(format!("read {}: {e}", src.display())))?;
        update_rootfs_hash_field(&mut hasher, b"bin_destination:", dest.as_bytes())?;
        update_rootfs_hash_field(&mut hasher, b"bin_content:", &content)?;
    }

    if let Some(okou_cli) = okou_cli {
        update_rootfs_hash_field(
            &mut hasher,
            b"okou_cli_package_sha256:",
            okou_cli.package_sha256.as_bytes(),
        )?;
    }

    Ok(hex::encode(hasher.finalize()))
}

/// Compute the two-layer rootfs identity used by a full image build.
pub(super) async fn compute_rootfs_build_hashes(
    guest_bins: &[(&Path, &str)],
    ca_fingerprint: &str,
    rootfs_disk_mb: u32,
    okou_cli: Option<&OkouCliHashInput<'_>>,
) -> RunnerResult<RootfsBuildHashes> {
    let template_hash = compute_template_hash(rootfs_disk_mb);
    let rootfs_hash = compute_rootfs_hash(
        &template_hash,
        guest_bins,
        ca_fingerprint,
        DNS_PROBE_RESOLVER_IPV4,
        rootfs_disk_mb,
        okou_cli,
    )
    .await?;

    Ok(RootfsBuildHashes {
        template_hash,
        rootfs_hash,
    })
}

pub(super) async fn compute_ca_cert_fingerprint(paths: &HomePaths) -> RunnerResult<String> {
    let cert = paths.ca_dir().join(ca::CA_CERT);
    let content = tokio::fs::read(&cert)
        .await
        .map_err(|e| RunnerError::Internal(format!("read CA cert {}: {e}", cert.display())))?;
    Ok(hex::encode(Sha256::digest(content)))
}

/// Compute a snapshot hash from all inputs that affect snapshot content.
///
/// This hash is local-only (R2 stores only the shared template). It covers:
///   - `SNAPSHOT_CACHE_VERSION` — manual bump counter
///   - `HOME_DRIVE_LAYOUT` — paired Guest/Runner mount and image interpretation
///   - `rootfs_hash` — the rootfs this snapshot is built from
///   - `vcpu`, `memory_mb`, `home_disk_mb` — VM resource config
///   - `fc_version`, `kernel_version` — Firecracker and guest kernel versions
///   - `provider_config_hash` — sandbox-firecracker internal config (boot args, prewarm, etc.)
pub(super) fn compute_snapshot_hash(
    rootfs_hash: &str,
    vcpu: u32,
    memory_mb: u32,
    home_disk_mb: u32,
    fc_version: &str,
    kernel_version: &str,
    provider_config_hash: &str,
) -> String {
    let mut hasher = Sha256::new();

    hasher.update(b"snapshot_version:");
    hasher.update(SNAPSHOT_CACHE_VERSION.to_le_bytes());
    hasher.update(b"home_layout:");
    hasher.update(HOME_DRIVE_LAYOUT.as_bytes());
    hasher.update(b"rootfs:");
    hasher.update(rootfs_hash.as_bytes());
    hasher.update(b"vcpu:");
    hasher.update(vcpu.to_le_bytes());
    hasher.update(b"memory_mb:");
    hasher.update(memory_mb.to_le_bytes());
    hasher.update(b"home_disk_mb:");
    hasher.update(home_disk_mb.to_le_bytes());
    hasher.update(b"fc_version:");
    hasher.update(fc_version.as_bytes());
    hasher.update(b"kernel_version:");
    hasher.update(kernel_version.as_bytes());
    hasher.update(b"provider_config:");
    hasher.update(provider_config_hash.as_bytes());

    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests;
