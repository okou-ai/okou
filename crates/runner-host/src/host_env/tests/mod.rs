use super::*;

#[test]
fn parse_host_env_file_accepts_allowed_keys_with_comments() {
    let host_env = parse_host_env_file(
            "\n# host-local runner overrides\nOKOU_RUNNER_CONCURRENCY_FACTOR = 1.5\nOKOU_RUNNER_DISK_IOPS = 200000\n",
        )
        .unwrap();

    assert_eq!(
        host_env.values.get(RUNNER_CONCURRENCY_FACTOR_ENV),
        Some(&HostEnvValue {
            value: "1.5".to_string(),
        })
    );
    assert_eq!(
        host_env.values.get(RUNNER_DISK_IOPS_ENV),
        Some(&HostEnvValue {
            value: "200000".to_string(),
        })
    );
}

#[test]
fn parse_host_env_file_returns_empty_map_for_empty_file() {
    let host_env = parse_host_env_file("\n# nothing enabled\n").unwrap();

    assert!(host_env.values.is_empty());
}

#[test]
fn parse_host_env_file_accepts_canonical_only_configuration() {
    let host_env = parse_host_env_file(
        "\
OKOU_RUNNER_CONCURRENCY_FACTOR=1.5
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
OKOU_RUNNER_DISK_IOPS=50000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=250
OKOU_RUNNER_NET_TX_MIB_PER_SEC=125
",
    )
    .unwrap();

    assert_eq!(
        host_env.concurrency_factor(),
        Some(&HostEnvValue {
            value: "1.5".to_string(),
        })
    );
    assert_eq!(
        host_env.io_values(),
        RunnerIoEnvValues {
            disk_bandwidth_mib_per_sec: Some(HostEnvValue {
                value: "1000".to_string(),
            }),
            disk_iops: Some(HostEnvValue {
                value: "50000".to_string(),
            }),
            net_rx_mib_per_sec: Some(HostEnvValue {
                value: "250".to_string(),
            }),
            net_tx_mib_per_sec: Some(HostEnvValue {
                value: "125".to_string(),
            }),
        }
    );
}

#[test]
fn partial_io_group_preserves_missing_key() {
    let host_env = parse_host_env_file(
        "\
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
OKOU_RUNNER_DISK_IOPS=50000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=250
",
    )
    .unwrap();

    let values = host_env.io_values();
    assert!(values.disk_bandwidth_mib_per_sec.is_some());
    assert!(values.disk_iops.is_some());
    assert!(values.net_rx_mib_per_sec.is_some());
    assert!(values.net_tx_mib_per_sec.is_none());
}

#[test]
fn parse_host_env_file_rejects_unknown_keys() {
    let err = parse_host_env_file("UNSUPPORTED_HOST_KEY=example-value\n")
        .unwrap_err()
        .to_string();

    assert!(err.contains("unsupported host env key"));
    assert!(err.contains("UNSUPPORTED_HOST_KEY"));
    assert!(err.contains(RUNNER_CONCURRENCY_FACTOR_ENV));
    assert!(err.contains(RUNNER_DISK_IOPS_ENV));
}

#[test]
fn parse_host_env_file_rejects_exact_duplicate_keys() {
    for key in HOST_ENV_KEYS {
        let first_value = "first-value-should-not-leak";
        let second_value = "second-value-should-not-leak";
        let content = format!("{key}={first_value}\n{key}={second_value}\n");
        let err = parse_host_env_file(&content).unwrap_err().to_string();

        assert!(err.contains("duplicate host env key"));
        assert!(err.contains(key));
        assert!(!err.contains(first_value));
        assert!(!err.contains(second_value));
    }
}

#[test]
fn parse_host_env_file_rejects_malformed_lines() {
    let err = parse_host_env_file("OKOU_RUNNER_CONCURRENCY_FACTOR\n")
        .unwrap_err()
        .to_string();

    assert!(err.contains("expected KEY=VALUE"));
}
