use std::net::Ipv4Addr;
use std::path::Path;

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
/// and host-local CA material.
const ROOTFS_CACHE_VERSION: u32 = 3;

/// Bump to invalidate all cached snapshots (local only; R2 stores only the template).
const SNAPSHOT_CACHE_VERSION: u32 = 3;

/// Rootfs-hash inputs contributed by an installed Okou CLI artifact.
pub(super) struct OkouCliHashInput<'a> {
    /// SHA-256 calculated from the verified package, whose identity is bound to it.
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
/// fields are ordered as version, template hash, customization script, rootfs disk
/// size, CA fingerprint, DNS resolver, then one destination/content pair per guest
/// binary in inventory order, then, only when an Okou CLI artifact is installed,
/// its verified package SHA-256. Packed identity determines the installed manifest;
/// metadata and byte integrity are validated before cache selection, not hashed twice.
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
///   - `rootfs_hash` — the rootfs this snapshot is built from
///   - `vcpu`, `memory_mb`, `workspace_disk_mb` — VM resource config
///   - `fc_version`, `kernel_version` — Firecracker and guest kernel versions
///   - `provider_config_hash` — sandbox-firecracker internal config (boot args, prewarm, etc.)
pub(super) fn compute_snapshot_hash(
    rootfs_hash: &str,
    vcpu: u32,
    memory_mb: u32,
    workspace_disk_mb: u32,
    fc_version: &str,
    kernel_version: &str,
    provider_config_hash: &str,
) -> String {
    let mut hasher = Sha256::new();

    hasher.update(b"snapshot_version:");
    hasher.update(SNAPSHOT_CACHE_VERSION.to_le_bytes());
    hasher.update(b"rootfs:");
    hasher.update(rootfs_hash.as_bytes());
    hasher.update(b"vcpu:");
    hasher.update(vcpu.to_le_bytes());
    hasher.update(b"memory_mb:");
    hasher.update(memory_mb.to_le_bytes());
    hasher.update(b"workspace_disk_mb:");
    hasher.update(workspace_disk_mb.to_le_bytes());
    hasher.update(b"fc_version:");
    hasher.update(fc_version.as_bytes());
    hasher.update(b"kernel_version:");
    hasher.update(kernel_version.as_bytes());
    hasher.update(b"provider_config:");
    hasher.update(provider_config_hash.as_bytes());

    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_guest_hash_input(guest_bins: &[(&str, &[u8])]) -> Vec<u8> {
        let mut input = Vec::new();
        for (dest, content) in guest_bins {
            input.extend_from_slice(format!("bin:{dest}:").as_bytes());
            input.extend_from_slice(content);
        }
        input
    }

    #[test]
    fn compute_template_hash_deterministic() {
        let h1 = compute_template_hash(16384);
        let h2 = compute_template_hash(16384);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[test]
    fn compute_template_hash_sensitive_to_disk_size() {
        assert_ne!(
            compute_template_hash(16384),
            compute_template_hash(32768),
            "template hash must change when the ext4 disk size changes"
        );
    }

    #[tokio::test]
    async fn compute_rootfs_hash_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent");
        tokio::fs::write(&bin, b"binary-content").await.unwrap();
        let bins: &[(&Path, &str)] = &[(&bin, "/usr/local/bin/guest-agent")];

        let h1 = compute_rootfs_hash(
            "template-hash",
            bins,
            "ca-fingerprint",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();
        let h2 = compute_rootfs_hash(
            "template-hash",
            bins,
            "ca-fingerprint",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[tokio::test]
    async fn compute_rootfs_hash_separates_legacy_guest_boundary_collision() {
        const AGENT_DESTINATION: &str = "/usr/local/bin/guest-agent";
        const DOWNLOAD_DESTINATION: &str = "/usr/local/bin/guest-storage-apply";

        let dir = tempfile::tempdir().unwrap();
        let tuple_a_agent = dir.path().join("tuple-a-agent");
        let tuple_a_download = dir.path().join("tuple-a-download");
        let tuple_b_agent = dir.path().join("tuple-b-agent");
        let tuple_b_download = dir.path().join("tuple-b-download");

        let prefix: &[u8] = b"agent-content";
        let suffix: &[u8] = b"download-content";
        let legacy_boundary = format!("bin:{DOWNLOAD_DESTINATION}:").into_bytes();
        let tuple_a_download_content = [legacy_boundary.as_slice(), suffix].concat();
        let tuple_b_agent_content = [prefix, legacy_boundary.as_slice()].concat();

        tokio::fs::write(&tuple_a_agent, prefix).await.unwrap();
        tokio::fs::write(&tuple_a_download, &tuple_a_download_content)
            .await
            .unwrap();
        tokio::fs::write(&tuple_b_agent, &tuple_b_agent_content)
            .await
            .unwrap();
        tokio::fs::write(&tuple_b_download, suffix).await.unwrap();

        let legacy_a = legacy_guest_hash_input(&[
            (AGENT_DESTINATION, prefix),
            (DOWNLOAD_DESTINATION, &tuple_a_download_content),
        ]);
        let legacy_b = legacy_guest_hash_input(&[
            (AGENT_DESTINATION, &tuple_b_agent_content),
            (DOWNLOAD_DESTINATION, suffix),
        ]);
        assert_eq!(
            legacy_a, legacy_b,
            "the distinct tuples must reproduce the legacy boundary collision"
        );

        let hash_a = compute_rootfs_hash(
            "template-hash",
            &[
                (&tuple_a_agent, AGENT_DESTINATION),
                (&tuple_a_download, DOWNLOAD_DESTINATION),
            ],
            "ca-fingerprint",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();
        let hash_b = compute_rootfs_hash(
            "template-hash",
            &[
                (&tuple_b_agent, AGENT_DESTINATION),
                (&tuple_b_download, DOWNLOAD_DESTINATION),
            ],
            "ca-fingerprint",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();

        assert_ne!(
            hash_a, hash_b,
            "length framing must distinguish the legacy-colliding tuples"
        );
    }

    #[tokio::test]
    async fn rootfs_build_hashes_keep_template_shared_across_guest_content() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("agent-a");
        let bin_b = dir.path().join("agent-b");
        tokio::fs::write(&bin_a, b"content-a").await.unwrap();
        tokio::fs::write(&bin_b, b"content-b").await.unwrap();

        let hashes_a = compute_rootfs_build_hashes(
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-fingerprint",
            16384,
            None,
        )
        .await
        .unwrap();
        let hashes_b = compute_rootfs_build_hashes(
            &[(&bin_b, "/usr/local/bin/guest-agent")],
            "ca-fingerprint",
            16384,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            hashes_a.template_hash, hashes_b.template_hash,
            "template hash must not depend on guest binary content"
        );
        assert_ne!(
            hashes_a.rootfs_hash, hashes_b.rootfs_hash,
            "rootfs hash must depend on guest binary content"
        );
    }

    #[tokio::test]
    async fn compute_rootfs_hash_sensitive_to_rootfs_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("agent-a");
        let bin_b = dir.path().join("agent-b");
        tokio::fs::write(&bin_a, b"content-a").await.unwrap();
        tokio::fs::write(&bin_b, b"content-b").await.unwrap();

        let base = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();

        let different_content = compute_rootfs_hash(
            "template-a",
            &[(&bin_b, "/usr/local/bin/guest-agent")],
            "ca-a",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();
        assert_ne!(
            base, different_content,
            "hash must change with binary content"
        );

        let different_disk = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            DNS_PROBE_RESOLVER_IPV4,
            32768,
            None,
        )
        .await
        .unwrap();
        assert_ne!(base, different_disk, "hash must change with rootfs_disk_mb");

        let different_dest = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-storage-apply")],
            "ca-a",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();
        assert_ne!(base, different_dest, "hash must change with dest path");

        let different_ca = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-b",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();
        assert_ne!(base, different_ca, "hash must change with CA fingerprint");

        let different_template = compute_rootfs_hash(
            "template-b",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            DNS_PROBE_RESOLVER_IPV4,
            16384,
            None,
        )
        .await
        .unwrap();
        assert_ne!(base, different_template, "hash must change with template");

        let different_dns = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            Ipv4Addr::new(1, 1, 1, 1),
            16384,
            None,
        )
        .await
        .unwrap();
        assert_ne!(base, different_dns, "hash must change with DNS nameserver");
    }

    #[tokio::test]
    async fn compute_rootfs_hash_sensitive_to_verified_cli_package_sha() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent");
        tokio::fs::write(&bin, b"binary-content").await.unwrap();
        let bins: &[(&Path, &str)] = &[(&bin, "/usr/local/bin/guest-agent")];
        let sha_a = hex::encode(Sha256::digest(b"bundle-a"));
        let sha_b = hex::encode(Sha256::digest(b"bundle-b"));
        let a = OkouCliHashInput {
            package_sha256: &sha_a,
        };
        let b = OkouCliHashInput {
            package_sha256: &sha_b,
        };

        let hash = async |cli: Option<&OkouCliHashInput<'_>>| {
            compute_rootfs_hash(
                "template-a",
                bins,
                "ca-a",
                DNS_PROBE_RESOLVER_IPV4,
                16384,
                cli,
            )
            .await
            .unwrap()
        };
        let with_a = hash(Some(&a)).await;
        assert_ne!(hash(None).await, with_a, "CLI and no-CLI are distinct");
        assert_eq!(
            with_a,
            hash(Some(&a)).await,
            "same verified SHA is deterministic"
        );
        assert_ne!(
            with_a,
            hash(Some(&b)).await,
            "changed package SHA invalidates rootfs"
        );
    }

    #[tokio::test]
    async fn rootfs_cli_identity_is_determined_by_the_verified_package() {
        use super::super::okou_cli::{OkouCliArtifact, test_support::write_artifact_dir};
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        let changed = dir.path().join("changed");
        for path in [&a, &b, &changed] {
            std::fs::create_dir(path).unwrap();
        }
        write_artifact_dir(&a, b"same-program", "9.353.0", "1.36.0");
        write_artifact_dir(&b, b"same-program", "9.353.0", "1.36.0");
        write_artifact_dir(&changed, b"same-program", "9.353.0", "1.36.1");
        let manifest = b.join("manifest.json");
        let mut provenance: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        provenance["commitSha"] = serde_json::json!("e".repeat(40));
        std::fs::write(manifest, serde_json::to_vec(&provenance).unwrap()).unwrap();
        let artifact_a = OkouCliArtifact::resolve(&a).await.unwrap();
        let artifact_b = OkouCliArtifact::resolve(&b).await.unwrap();
        let artifact_changed = OkouCliArtifact::resolve(&changed).await.unwrap();
        assert_eq!(
            artifact_a.installed_manifest_bytes(),
            artifact_b.installed_manifest_bytes()
        );
        assert_ne!(
            artifact_a.installed_manifest_bytes(),
            artifact_changed.installed_manifest_bytes()
        );
        let hash = async |cli: &OkouCliArtifact| {
            compute_rootfs_build_hashes(&[], "ca-a", 16384, Some(&cli.hash_input()))
                .await
                .unwrap()
                .rootfs_hash
        };
        assert_eq!(
            hash(&artifact_a).await,
            hash(&artifact_b).await,
            "provenance is not installation identity"
        );
        assert_ne!(
            hash(&artifact_a).await,
            hash(&artifact_changed).await,
            "packed metadata changes rotate package SHA and rootfs"
        );
    }

    #[test]
    fn compute_snapshot_hash_deterministic() {
        let h1 = compute_snapshot_hash(
            "rootfs_aaa",
            2,
            4096,
            16_384,
            "v1.14.1",
            "6.1.155",
            "config_xxx",
        );
        let h2 = compute_snapshot_hash(
            "rootfs_aaa",
            2,
            4096,
            16_384,
            "v1.14.1",
            "6.1.155",
            "config_xxx",
        );
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn compute_snapshot_hash_sensitive_to_each_field() {
        let base =
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.14.1", "6.1.155", "cfg");

        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_bbb", 2, 4096, 16_384, "v1.14.1", "6.1.155", "cfg"),
            "must change with rootfs_hash"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 4, 4096, 16_384, "v1.14.1", "6.1.155", "cfg"),
            "must change with vcpu"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 8192, 16_384, "v1.14.1", "6.1.155", "cfg"),
            "must change with memory_mb"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 32_768, "v1.14.1", "6.1.155", "cfg"),
            "must change with workspace_disk_mb"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.15.0", "6.1.155", "cfg"),
            "must change with fc_version"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.14.1", "6.2.0", "cfg"),
            "must change with kernel_version"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.14.1", "6.1.155", "cfg2"),
            "must change with provider_config_hash"
        );
    }
}
