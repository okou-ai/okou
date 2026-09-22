//! Host-local runner environment access.
//!
//! Keep this module at the raw process/file environment boundary. Runtime
//! parsing and validation live in higher-level modules.

use std::collections::BTreeMap;

use crate::error::{HostError, HostResult};

pub const RUNNER_HOST_ENV_FILE: &str = "/etc/vm0-runner/host.env";
pub const RUNNER_CONCURRENCY_FACTOR_ENV: &str = "OKOU_RUNNER_CONCURRENCY_FACTOR";
pub const RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV: &str = "OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC";
pub const RUNNER_DISK_IOPS_ENV: &str = "OKOU_RUNNER_DISK_IOPS";
pub const RUNNER_NET_RX_MIB_PER_SEC_ENV: &str = "OKOU_RUNNER_NET_RX_MIB_PER_SEC";
pub const RUNNER_NET_TX_MIB_PER_SEC_ENV: &str = "OKOU_RUNNER_NET_TX_MIB_PER_SEC";
const HOST_ENV_KEYS: [&str; 5] = [
    RUNNER_CONCURRENCY_FACTOR_ENV,
    RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
    RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV,
    RUNNER_NET_TX_MIB_PER_SEC_ENV,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEnvValue {
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunnerIoEnvValues {
    pub disk_bandwidth_mib_per_sec: Option<HostEnvValue>,
    pub disk_iops: Option<HostEnvValue>,
    pub net_rx_mib_per_sec: Option<HostEnvValue>,
    pub net_tx_mib_per_sec: Option<HostEnvValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunnerHostEnv {
    values: BTreeMap<&'static str, HostEnvValue>,
}

impl RunnerHostEnv {
    pub fn concurrency_factor(&self) -> Option<&HostEnvValue> {
        self.values.get(RUNNER_CONCURRENCY_FACTOR_ENV)
    }

    pub fn io_values(&self) -> RunnerIoEnvValues {
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

pub fn read_runner_host_env() -> HostResult<RunnerHostEnv> {
    read_host_env_file()
}

fn read_host_env_file() -> HostResult<RunnerHostEnv> {
    let content = match std::fs::read_to_string(RUNNER_HOST_ENV_FILE) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(RunnerHostEnv::default()),
        Err(e) => {
            return Err(HostError::Config(format!(
                "failed to read {RUNNER_HOST_ENV_FILE}: {e}"
            )));
        }
    };

    parse_host_env_file(&content)
}

fn parse_host_env_file(content: &str) -> HostResult<RunnerHostEnv> {
    let mut values = BTreeMap::new();

    for (line_number, line) in content.lines().enumerate() {
        let line_number = line_number + 1;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            return Err(HostError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: expected KEY=VALUE"
            )));
        };
        let key = key.trim();
        let Some(&allowed_key) = HOST_ENV_KEYS
            .iter()
            .find(|&&allowed_key| allowed_key == key)
        else {
            let allowed_keys = HOST_ENV_KEYS.join(", ");
            return Err(HostError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: unsupported host env key {key:?}; allowed keys: {}",
                allowed_keys
            )));
        };
        if values.contains_key(allowed_key) {
            return Err(HostError::Config(format!(
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

#[cfg(test)]
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
}
