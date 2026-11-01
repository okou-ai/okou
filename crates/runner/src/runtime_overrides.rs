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
mod tests;
