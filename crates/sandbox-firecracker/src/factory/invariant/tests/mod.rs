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
    let original = config_hash_for(&config, invariant.tap_mac, invariant.prewarm_script).unwrap();
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
    let original = config_hash_for(&config, invariant.tap_mac, invariant.prewarm_script).unwrap();
    let mut reordered = config.clone();
    reordered.drives.reverse();
    let changed = config_hash_for(&reordered, invariant.tap_mac, invariant.prewarm_script).unwrap();

    assert_ne!(original, changed);
}

#[test]
fn config_hash_matches_snapshot_provider_trait() {
    let provider = crate::FirecrackerSnapshotProvider;
    let trait_hash = sandbox::SnapshotProvider::config_hash(&provider);
    let direct_hash = config_hash();
    assert_eq!(trait_hash, direct_hash);
}
