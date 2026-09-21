//! Host-local runner environment access.
//!
//! Keep this module at the raw process/file environment boundary. Runtime
//! parsing and validation live in higher-level modules.

use std::collections::BTreeMap;

use crate::error::{RunnerError, RunnerResult};

pub(crate) const RUNNER_HOST_ENV_FILE: &str = "/etc/vm0-runner/host.env";
pub(crate) const RUNNER_CONCURRENCY_FACTOR_ENV: &str = "OKOU_RUNNER_CONCURRENCY_FACTOR";
pub(crate) const RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV: &str =
    "OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC";
pub(crate) const RUNNER_DISK_IOPS_ENV: &str = "OKOU_RUNNER_DISK_IOPS";
pub(crate) const RUNNER_NET_RX_MIB_PER_SEC_ENV: &str = "OKOU_RUNNER_NET_RX_MIB_PER_SEC";
pub(crate) const RUNNER_NET_TX_MIB_PER_SEC_ENV: &str = "OKOU_RUNNER_NET_TX_MIB_PER_SEC";
const HOST_ENV_KEYS: [&str; 5] = [
    RUNNER_CONCURRENCY_FACTOR_ENV,
    RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
    RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV,
    RUNNER_NET_TX_MIB_PER_SEC_ENV,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostEnvValue {
    pub(crate) value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct RunnerIoEnvValues {
    pub(crate) disk_bandwidth_mib_per_sec: Option<HostEnvValue>,
    pub(crate) disk_iops: Option<HostEnvValue>,
    pub(crate) net_rx_mib_per_sec: Option<HostEnvValue>,
    pub(crate) net_tx_mib_per_sec: Option<HostEnvValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct RunnerHostEnv {
    values: BTreeMap<&'static str, HostEnvValue>,
}

impl RunnerHostEnv {
    pub(crate) fn concurrency_factor(&self) -> Option<&HostEnvValue> {
        self.values.get(RUNNER_CONCURRENCY_FACTOR_ENV)
    }

    pub(crate) fn io_values(&self) -> RunnerIoEnvValues {
        RunnerIoEnvValues {
            disk_bandwidth_mib_per_sec: self
                .values
                .get(RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV)
                .cloned(),
            disk_iops: self.values.get(RUNNER_DISK_IOPS_ENV).cloned(),
            net_rx_mib_per_sec: self.values.get(RUNNER_NET_RX_MIB_PER_SEC_ENV).cloned(),
            net_tx_mib_per_sec: self.values.get(RUNNER_NET_TX_MIB_PER_SEC_ENV).cloned(),
        }
    }
}

pub(crate) fn read_runner_host_env() -> RunnerResult<RunnerHostEnv> {
    read_host_env_file()
}

fn read_host_env_file() -> RunnerResult<RunnerHostEnv> {
    let content = match std::fs::read_to_string(RUNNER_HOST_ENV_FILE) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(RunnerHostEnv::default()),
        Err(e) => {
            return Err(RunnerError::Config(format!(
                "failed to read {RUNNER_HOST_ENV_FILE}: {e}"
            )));
        }
    };

    parse_host_env_file(&content)
}

fn parse_host_env_file(content: &str) -> RunnerResult<RunnerHostEnv> {
    let mut values = BTreeMap::new();

    for (line_number, line) in content.lines().enumerate() {
        let line_number = line_number + 1;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: expected KEY=VALUE"
            )));
        };
        let key = key.trim();
        let Some(&allowed_key) = HOST_ENV_KEYS
            .iter()
            .find(|&&allowed_key| allowed_key == key)
        else {
            let allowed_keys = HOST_ENV_KEYS.join(", ");
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: unsupported host env key {key:?}; allowed keys: {}",
                allowed_keys
            )));
        };
        if values.contains_key(allowed_key) {
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: duplicate host env key {allowed_key}"
            )));
        }

        values.insert(
            allowed_key,
            HostEnvValue {
                value: raw_value.trim().to_string(),
            },
        );
    }

    Ok(RunnerHostEnv { values })
}

runner_test_group!(platform_support; #[cfg(test)]
mod tests {
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
    fn partial_io_group_remains_all_or_none() {
        let host_env = parse_host_env_file(
            "\
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
OKOU_RUNNER_DISK_IOPS=50000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=250
",
        )
        .unwrap();
        let profiles = BTreeMap::from([(
            "vm0/default".to_string(),
            crate::config::ProfileConfig {
                rootfs_hash: "rootfs".to_string(),
                snapshot_hash: "snapshot".to_string(),
                vcpu: 2,
                memory_mb: 4096,
                rootfs_disk_mb: 8192,
                workspace_disk_mb: 16_384,
            },
        )]);
        let budget = crate::resource_budget::ResourceBudget::new(2, 4096, 1.0, 1);

        let resolution = crate::io_limits::resolve_io_limits(&profiles, &budget, &host_env);

        let crate::io_limits::IoLimitResolution::Misconfigured { reason } = &resolution else {
            panic!("expected misconfigured resolution");
        };
        assert!(reason.contains(RUNNER_NET_TX_MIB_PER_SEC_ENV));
        assert_eq!(resolution.device_rate_limits(), None);
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
});
