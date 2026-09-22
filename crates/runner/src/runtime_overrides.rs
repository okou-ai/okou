//! Runtime-only config overrides.
//!
//! `runner.yaml` remains the base config. This module applies whitelisted
//! host-local values after YAML loading and before runtime objects are built.

use crate::config;
use crate::error::{RunnerError, RunnerResult};
use runner_host::host_env::{self, HostEnvValue, RunnerHostEnv};

const RUNNER_YAML_SOURCE: &str = "runner.yaml";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConcurrencyFactorSource {
    RunnerYaml,
    HostEnvFile,
}

impl ConcurrencyFactorSource {
    pub(crate) fn is_override(self) -> bool {
        matches!(self, Self::HostEnvFile)
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::RunnerYaml => RUNNER_YAML_SOURCE,
            Self::HostEnvFile => host_env::RUNNER_HOST_ENV_FILE,
        }
    }
}

pub(crate) fn resolve_concurrency_factor(
    yaml_value: f64,
    host_env: &RunnerHostEnv,
) -> RunnerResult<(f64, ConcurrencyFactorSource)> {
    resolve_concurrency_factor_from_env_value(yaml_value, host_env.concurrency_factor())
}

fn resolve_concurrency_factor_from_env_value(
    yaml_value: f64,
    env_value: Option<&HostEnvValue>,
) -> RunnerResult<(f64, ConcurrencyFactorSource)> {
    let Some(env_value) = env_value else {
        return Ok((yaml_value, ConcurrencyFactorSource::RunnerYaml));
    };
    let error_source = concurrency_factor_error_source();

    let value = env_value.value.parse::<f64>().map_err(|e| {
        RunnerError::Config(format!(
            "{error_source} must be a positive finite number: {e}"
        ))
    })?;
    config::validate_concurrency_factor(value).map_err(|_| {
        RunnerError::Config(format!("{error_source} must be a positive finite number"))
    })?;

    Ok((value, ConcurrencyFactorSource::HostEnvFile))
}

fn concurrency_factor_error_source() -> String {
    format!(
        "{} in {}",
        host_env::RUNNER_CONCURRENCY_FACTOR_ENV,
        host_env::RUNNER_HOST_ENV_FILE
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_env_uses_yaml_value() {
        let (value, source) = resolve_concurrency_factor_from_env_value(1.25, None).unwrap();

        assert_eq!(value, 1.25);
        assert_eq!(source, ConcurrencyFactorSource::RunnerYaml);
        assert!(!source.is_override());
        assert_eq!(source.label(), "runner.yaml");
    }

    #[test]
    fn valid_host_env_file_value_overrides_yaml_value() {
        let env_value = HostEnvValue {
            value: "1.5".to_string(),
        };
        let (value, source) =
            resolve_concurrency_factor_from_env_value(1.0, Some(&env_value)).unwrap();

        assert_eq!(value, 1.5);
        assert_eq!(source, ConcurrencyFactorSource::HostEnvFile);
        assert!(source.is_override());
        assert_eq!(source.label(), host_env::RUNNER_HOST_ENV_FILE);
    }

    #[test]
    fn invalid_host_env_file_values_fail_and_name_var() {
        for raw in ["0", "-1", "NaN", "inf", "-inf", "not-a-number"] {
            let env_value = HostEnvValue {
                value: raw.to_string(),
            };
            let err = resolve_concurrency_factor_from_env_value(1.0, Some(&env_value))
                .unwrap_err()
                .to_string();

            assert!(
                err.contains(host_env::RUNNER_CONCURRENCY_FACTOR_ENV),
                "expected error for {raw:?} to name env var, got: {err}"
            );
        }
    }

    #[test]
    fn invalid_file_values_fail_and_name_source_file() {
        let env_value = HostEnvValue {
            value: "0".to_string(),
        };
        let err = resolve_concurrency_factor_from_env_value(1.0, Some(&env_value))
            .unwrap_err()
            .to_string();

        assert!(err.contains(host_env::RUNNER_HOST_ENV_FILE));
    }
}
