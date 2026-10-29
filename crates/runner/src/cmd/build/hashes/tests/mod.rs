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
async fn rootfs_identity_frames_paired_home_layout_independently_of_guest_bytes() {
    let actual = compute_rootfs_hash("template", &[], "ca", DNS_PROBE_RESOLVER_IPV4, 12288, None)
        .await
        .unwrap();
    let mut expected = Sha256::new();
    for (label, bytes) in [
        (
            b"rootfs_version:".as_slice(),
            ROOTFS_CACHE_VERSION.to_be_bytes().to_vec(),
        ),
        (b"home_layout:", HOME_DRIVE_LAYOUT.as_bytes().to_vec()),
        (b"template:", b"template".to_vec()),
        (b"customize_script:", CUSTOMIZE_SCRIPT.as_bytes().to_vec()),
        (b"rootfs_disk_mb:", 12288_u32.to_be_bytes().to_vec()),
        (b"ca_fingerprint:", b"ca".to_vec()),
        (
            b"dns_nameserver:",
            DNS_PROBE_RESOLVER_IPV4.octets().to_vec(),
        ),
    ] {
        expected.update(label);
        expected.update(u64::try_from(bytes.len()).unwrap().to_be_bytes());
        expected.update(bytes);
    }
    assert_eq!(actual, hex::encode(expected.finalize()));
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
    use super::super::okou_cli::{OkouCliArtifact, test_support::stage_fixture};
    let artifact_a = stage_fixture(b"same-program", "9.353.0", "1.36.0").await;
    let artifact_b = stage_fixture(b"same-program", "9.353.0", "1.36.0").await;
    let artifact_changed = stage_fixture(b"same-program", "9.353.0", "1.36.1").await;
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
        "same compiled resources preserve installed identity and rootfs key"
    );
    assert_ne!(
        hash(&artifact_a).await,
        hash(&artifact_changed).await,
        "packed metadata changes rotate package SHA and rootfs"
    );
}

#[test]
fn snapshot_identity_binds_paired_layout_and_default_two_disk_shape() {
    let actual = compute_snapshot_hash("rootfs", 2, 4096, 24576, "fc", "kernel", "provider");
    let mut paired = Sha256::new();
    paired.update(b"snapshot_version:");
    paired.update(SNAPSHOT_CACHE_VERSION.to_le_bytes());
    paired.update(b"home_layout:");
    paired.update(HOME_DRIVE_LAYOUT.as_bytes());
    paired.update(b"rootfs:rootfs");
    paired.update(b"vcpu:");
    paired.update(2_u32.to_le_bytes());
    paired.update(b"memory_mb:");
    paired.update(4096_u32.to_le_bytes());
    paired.update(b"home_disk_mb:");
    paired.update(24576_u32.to_le_bytes());
    paired.update(b"fc_version:fc");
    paired.update(b"kernel_version:kernel");
    paired.update(b"provider_config:provider");
    assert_eq!(actual, hex::encode(paired.finalize()));
    assert_ne!(
        actual,
        compute_snapshot_hash("other-rootfs", 2, 4096, 24576, "fc", "kernel", "provider")
    );
    assert_ne!(
        actual,
        compute_snapshot_hash("rootfs", 2, 4096, 16384, "fc", "kernel", "provider")
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
    let base = compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.14.1", "6.1.155", "cfg");

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
        "must change with home_disk_mb"
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
