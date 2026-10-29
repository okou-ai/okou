use super::*;

fn value(raw: &str) -> HostEnvValue {
    HostEnvValue {
        value: raw.to_string(),
    }
}

fn profiles(items: &[(&str, u32, u32)]) -> BTreeMap<String, ProfileConfig> {
    items
        .iter()
        .map(|(name, vcpu, memory_mb)| {
            (
                (*name).to_string(),
                ProfileConfig {
                    rootfs_hash: format!("{name}-rootfs"),
                    snapshot_hash: format!("{name}-snapshot"),
                    vcpu: *vcpu,
                    memory_mb: *memory_mb,
                    rootfs_disk_mb: 8192,
                    home_disk_mb: 16_384,
                },
            )
        })
        .collect()
}

fn full_values() -> RunnerIoEnvValues {
    RunnerIoEnvValues {
        disk_bandwidth_mib_per_sec: Some(value("2000")),
        disk_iops: Some(value("200000")),
        net_rx_mib_per_sec: Some(value("1250")),
        net_tx_mib_per_sec: Some(value("1000")),
    }
}

#[test]
fn absent_env_disables_limits() {
    let profiles = profiles(&[("vm0/default", 2, 4096)]);
    let budget = ResourceBudget::new(8, 16_384, 1.0, 4);

    let resolution =
        resolve_io_limits_from_values(&RunnerIoEnvValues::default(), &profiles, &budget);

    assert_eq!(resolution, IoLimitResolution::Disabled);
    assert_eq!(resolution.device_rate_limits(), None);
}

#[test]
fn partial_env_disables_limits_as_misconfigured() {
    let profiles = profiles(&[("vm0/default", 2, 4096)]);
    let budget = ResourceBudget::new(8, 16_384, 1.0, 4);
    let values = RunnerIoEnvValues {
        disk_bandwidth_mib_per_sec: Some(value("2000")),
        ..RunnerIoEnvValues::default()
    };

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Misconfigured { reason } = resolution else {
        panic!("expected misconfigured resolution");
    };
    assert!(reason.contains("missing"));
    assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
    assert!(reason.contains(host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV));
    assert!(reason.contains(host_env::RUNNER_NET_TX_MIB_PER_SEC_ENV));
}

#[test]
fn invalid_env_disables_limits_as_misconfigured() {
    let profiles = profiles(&[("vm0/default", 2, 4096)]);
    let budget = ResourceBudget::new(8, 16_384, 1.0, 4);
    let mut values = full_values();
    values.disk_iops = Some(value("NaN"));

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Misconfigured { reason } = resolution else {
        panic!("expected misconfigured resolution");
    };
    assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
}

#[test]
fn fractional_iops_disables_limits_as_misconfigured() {
    let profiles = profiles(&[("vm0/default", 2, 4096)]);
    let budget = ResourceBudget::new(8, 16_384, 1.0, 4);
    let mut values = full_values();
    values.disk_iops = Some(value("100.5"));

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Misconfigured { reason } = resolution else {
        panic!("expected misconfigured resolution");
    };
    assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
    assert!(reason.contains("positive integer"));
}

#[test]
fn sub_byte_bandwidth_disables_limits_as_misconfigured() {
    let profiles = profiles(&[("vm0/default", 2, 4096)]);
    let budget = ResourceBudget::new(8, 16_384, 1.0, 4);
    let mut values = full_values();
    values.net_rx_mib_per_sec = Some(value("0.0000001"));

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Misconfigured { reason } = resolution else {
        panic!("expected misconfigured resolution");
    };
    assert!(reason.contains(host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV));
    assert!(reason.contains("positive finite number"));
}

#[test]
fn capacity_too_small_for_denominator_disables_limits_as_misconfigured() {
    let profiles = profiles(&[("vm0/default", 1, 1024)]);
    let budget = ResourceBudget::new(64, 65_536, 1.0, 64);
    let mut values = full_values();
    values.disk_iops = Some(value("1"));

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Misconfigured { reason } = resolution else {
        panic!("expected misconfigured resolution");
    };
    assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
    assert!(reason.contains("too small"));
    assert!(reason.contains("denominator: 63"));
}

#[test]
fn block_iops_too_small_for_drive_split_disables_limits_as_misconfigured() {
    let profiles = profiles(&[("vm0/default", 1, 1024)]);
    let budget = ResourceBudget::new(1, 1024, 1.0, 1);
    let mut values = full_values();
    values.disk_iops = Some(value("2"));

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Misconfigured { reason } = resolution else {
        panic!("expected misconfigured resolution");
    };
    assert!(reason.contains(host_env::RUNNER_DISK_IOPS_ENV));
    assert!(reason.contains("too small"));
    assert!(reason.contains("denominator: 1"));
}

#[test]
fn block_bandwidth_too_small_for_drive_split_disables_limits_as_misconfigured() {
    let profiles = profiles(&[("vm0/default", 1, 1024)]);
    let budget = ResourceBudget::new(1, 1024, 1.0, 1);
    let mut values = full_values();
    values.disk_bandwidth_mib_per_sec = Some(value("0.000002"));

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Misconfigured { reason } = resolution else {
        panic!("expected misconfigured resolution");
    };
    assert!(reason.contains(host_env::RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV));
    assert!(reason.contains("too small"));
    assert!(reason.contains("denominator: 1"));
}

#[test]
fn block_capacity_equal_to_drive_split_minimum_stays_configured() {
    let profiles = profiles(&[("vm0/default", 1, 1024)]);
    let budget = ResourceBudget::new(1, 1024, 1.0, 1);
    let mut values = full_values();
    values.disk_bandwidth_mib_per_sec = Some(value("0.000003"));
    values.disk_iops = Some(value("3"));

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Configured {
        limits,
        denominator,
    } = resolution
    else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 1);
    assert_eq!(limits.block.bandwidth_bytes_per_sec, 2);
    assert_eq!(limits.block.ops_per_sec, 2);
}

#[test]
fn network_capacity_equal_to_positive_minimum_stays_configured() {
    let profiles = profiles(&[("vm0/default", 1, 1024)]);
    let budget = ResourceBudget::new(1, 1024, 1.0, 1);
    let mut values = full_values();
    values.net_rx_mib_per_sec = Some(value("0.000002"));
    values.net_tx_mib_per_sec = Some(value("0.000002"));

    let resolution = resolve_io_limits_from_values(&values, &profiles, &budget);

    let IoLimitResolution::Configured {
        limits,
        denominator,
    } = resolution
    else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 1);
    assert_eq!(limits.network.rx_bytes_per_sec, 1);
    assert_eq!(limits.network.tx_bytes_per_sec, 1);
}

#[test]
fn complete_env_computes_reserved_per_sandbox_limits() {
    let profiles = profiles(&[("vm0/default", 2, 4096)]);
    let budget = ResourceBudget::new(8, 16_384, 1.0, 4);

    let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

    let IoLimitResolution::Configured {
        limits,
        denominator,
    } = resolution
    else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 3);
    assert_eq!(limits.block.bandwidth_bytes_per_sec, 559_240_533);
    assert_eq!(limits.block.ops_per_sec, 53_333);
    assert_eq!(limits.network.rx_bytes_per_sec, 349_525_333);
    assert_eq!(limits.network.tx_bytes_per_sec, 279_620_266);
}

#[test]
fn denominator_falls_back_to_resource_slots_without_max_concurrent() {
    let profiles = profiles(&[("vm0/default", 2, 4096)]);
    let budget = ResourceBudget::new(12, 32_768, 1.0, 0);

    let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

    let IoLimitResolution::Configured { denominator, .. } = resolution else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 5);
}

#[test]
fn denominator_uses_smallest_profile_shape_for_heterogeneous_profiles() {
    let profiles = profiles(&[("vm0/default", 2, 4096), ("vm0/large", 8, 16_384)]);
    let budget = ResourceBudget::new(16, 32_768, 1.0, 0);

    let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

    let IoLimitResolution::Configured { denominator, .. } = resolution else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 7);
}

#[test]
fn denominator_does_not_combine_minimum_resources_from_different_profiles() {
    let profiles = profiles(&[("vm0/cpu-heavy", 5, 1024), ("vm0/mem-heavy", 1, 5120)]);
    let budget = ResourceBudget::new(8, 8192, 1.0, 0);

    let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

    let IoLimitResolution::Configured { denominator, .. } = resolution else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 2);
}

#[test]
fn denominator_uses_safe_upper_bound_when_exact_calculation_would_be_too_large() {
    let profiles = profiles(&[("vm0/default", 1, 1)]);
    let budget = ResourceBudget::new(10_000, 10_000, 1.0, 0);

    let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

    let IoLimitResolution::Configured { denominator, .. } = resolution else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 9_974);
}

#[test]
fn denominator_uses_safe_upper_bound_when_exact_calculation_has_too_many_profile_steps() {
    let mut profile_items = Vec::new();
    for index in 0..100 {
        profile_items.push((format!("vm0/profile-{index}"), 1, index + 1));
    }
    let profile_refs = profile_items
        .iter()
        .map(|(name, vcpu, memory_mb)| (name.as_str(), *vcpu, *memory_mb))
        .collect::<Vec<_>>();
    let profiles = profiles(&profile_refs);
    let budget = ResourceBudget::new(500, 500, 1.0, 0);

    let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

    let IoLimitResolution::Configured { denominator, .. } = resolution else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 498);
}

#[test]
fn denominator_clamps_to_one() {
    let profiles = profiles(&[("vm0/default", 8, 16_384)]);
    let budget = ResourceBudget::new(1, 1024, 1.0, 0);

    let resolution = resolve_io_limits_from_values(&full_values(), &profiles, &budget);

    let IoLimitResolution::Configured { denominator, .. } = resolution else {
        panic!("expected configured resolution");
    };
    assert_eq!(denominator, 1);
}
