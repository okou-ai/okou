use super::*;

#[test]
fn base_child_env_includes_stable_minimum() {
    let keys: Vec<&str> = base_child_env("/tmp/home")
        .into_iter()
        .map(|(key, _)| key)
        .collect();

    assert!(keys.contains(&"HOME"));
    assert!(keys.contains(&"PATH"));
    assert!(keys.contains(&"SHELL"));
}

#[test]
fn normalize_values_keeps_last_value_for_duplicate_keys() {
    let values = normalize_values(vec![
        (
            guest_contracts::env::CANONICAL_API_URL_ENV.to_string(),
            "user-value".to_string(),
        ),
        (
            guest_contracts::env::CANONICAL_API_URL_ENV.to_string(),
            "runner-value".to_string(),
        ),
    ]);

    assert_eq!(
        values
            .iter()
            .find(|(key, _)| key == guest_contracts::env::CANONICAL_API_URL_ENV)
            .map(|(_, value)| value.as_str()),
        Some("runner-value")
    );
    assert_eq!(
        values
            .iter()
            .filter(|(key, _)| key == guest_contracts::env::CANONICAL_API_URL_ENV)
            .count(),
        1
    );
}

#[test]
fn values_with_inputs_uses_captured_canonical_api_url() {
    let mut user_env = HashMap::new();
    let oversized_user_api_url =
        "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
    user_env.insert(
        guest_contracts::env::CANONICAL_API_URL_ENV.to_string(),
        oversized_user_api_url,
    );
    let captured_api_url = "https://runner.example/%2F?raw=%20#fragment/";

    let values = values_with_inputs("/tmp/home", &user_env, captured_api_url);

    assert_eq!(
        values
            .iter()
            .find(|(key, _)| key == guest_contracts::env::CANONICAL_API_URL_ENV)
            .map(|(_, value)| value.as_str()),
        Some(captured_api_url)
    );
    assert_eq!(
        values
            .iter()
            .filter(|(key, _)| key == guest_contracts::env::CANONICAL_API_URL_ENV)
            .count(),
        1
    );
}

#[test]
fn explicit_npm_settings_are_preserved_and_home_is_the_default() {
    let settings = HashMap::from([
        ("npm_config_cache".into(), "/home/user/custom-npm".into()),
        ("NPM_CONFIG_CACHE".into(), "/tmp/explicit-npm".into()),
    ]);
    let values = values_with_inputs("/home/user", &settings, "");
    for (key, value) in &settings {
        assert!(values.contains(&(key.clone(), value.clone())));
    }
    let defaults = values_with_inputs("/home/user", &HashMap::new(), "");
    assert!(defaults.contains(&("HOME".into(), "/home/user".into())));
    assert!(
        !defaults
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("npm_config_cache"))
    );
}

#[test]
fn apply_values_clears_resume_session_bootstrap_key() {
    let mut command = tokio::process::Command::new("unused");
    command.env(
        guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
        "canonical-session-id",
    );

    let values = values_with_inputs("/tmp/home", &HashMap::new(), "");
    apply_values_to_tokio_command(&mut command, &values);

    let explicit_keys = command
        .as_std()
        .get_envs()
        .map(|(key, _)| key)
        .collect::<Vec<_>>();
    let key = guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV;
    assert!(
        !explicit_keys.contains(&std::ffi::OsStr::new(key)),
        "CLI child environment retained bootstrap key {key}"
    );
}
