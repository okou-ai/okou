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
    let (value, source) = resolve_concurrency_factor_from_env_value(1.0, Some(&env_value)).unwrap();

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
