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
    assert!(HostCpuPlacementConfig::new(1, 10_001, HostCpuPlacementMode::PreferManaged).is_err());
}
