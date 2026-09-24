use std::collections::HashMap;

use super::super::super::AGENT_ENV_KEY_DIAGNOSTIC_LIMIT;
use super::super::super::diagnostics::{
    build_agent_env_diagnostics, build_agent_env_key_diagnostics,
};

#[test]
fn agent_env_diagnostics_sort_bounds_and_never_include_values() {
    let mut bootstrap_env = HashMap::from([
        ("BASH_ENV".to_string(), "super-secret-bash-env".to_string()),
        ("NORMAL_KEY".to_string(), "normal-secret-value".to_string()),
        (
            guest_contracts::env::RUN_ID_ENV.to_string(),
            "runner-secret-value".to_string(),
        ),
        (
            "CUSTOM_SECRET_VALUES".to_string(),
            "stored-secret-value".to_string(),
        ),
    ]);
    let big_value = "largest-secret-value".repeat(20);
    let big_value_len = big_value.len();
    bootstrap_env.insert("BIG_VALUE".to_string(), big_value);
    for index in 0..AGENT_ENV_KEY_DIAGNOSTIC_LIMIT {
        bootstrap_env.insert(format!("ZZZ_{index:03}"), format!("value-{index}"));
    }
    bootstrap_env.insert(
        format!("AAA_{}", "x".repeat(512)),
        "long-secret-value".to_string(),
    );
    bootstrap_env.insert(
        "AAB\nKEY".to_string(),
        "escaped-key-secret-value".to_string(),
    );
    let user_env = HashMap::from([("BASH_ENV".to_string(), "user-secret-bash-env".to_string())]);

    let diagnostics = build_agent_env_diagnostics(&bootstrap_env, &user_env);

    assert_eq!(diagnostics.env_count, AGENT_ENV_KEY_DIAGNOSTIC_LIMIT + 7);
    assert!(diagnostics.env_bytes >= big_value_len);
    assert_eq!(diagnostics.runner_owned_count, 1);
    assert_eq!(
        diagnostics.external_count,
        AGENT_ENV_KEY_DIAGNOSTIC_LIMIT + 6
    );
    assert_eq!(diagnostics.suspicious_keys, vec!["BASH_ENV".to_string()]);
    assert_eq!(diagnostics.largest_entries[0].key, "BIG_VALUE");
    assert_eq!(diagnostics.largest_entries[0].value_len, big_value_len);
    let env_pairs: Vec<(String, String)> = bootstrap_env.into_iter().collect();
    let key_diagnostics = build_agent_env_key_diagnostics(&env_pairs);
    assert_eq!(
        key_diagnostics.logged_keys.len(),
        AGENT_ENV_KEY_DIAGNOSTIC_LIMIT
    );
    assert_eq!(key_diagnostics.omitted_key_count, 7);
    let mut sorted_logged_keys = key_diagnostics.logged_keys.clone();
    sorted_logged_keys.sort();
    assert_eq!(key_diagnostics.logged_keys, sorted_logged_keys);
    let long_key = key_diagnostics
        .logged_keys
        .iter()
        .find(|key| key.starts_with("AAA_"))
        .expect("long key should be logged before the ZZZ keys");
    assert_eq!(long_key, &format!("AAA_{}...", "x".repeat(124)));
    assert!(
        key_diagnostics
            .logged_keys
            .iter()
            .any(|key| key == r"AAB\nKEY")
    );
    let rendered = format!(
        "{} {} {}",
        diagnostics.suspicious_keys_csv(),
        key_diagnostics.logged_keys_csv(),
        diagnostics.largest_entries_csv()
    );
    assert!(rendered.contains("BASH_ENV"));
    assert!(rendered.contains("BIG_VALUE"));
    assert!(rendered.contains(guest_contracts::env::RUN_ID_ENV));
    assert!(!rendered.contains("super-secret-bash-env"));
    assert!(!rendered.contains("user-secret-bash-env"));
    assert!(!rendered.contains("largest-secret-value"));
    assert!(!rendered.contains("normal-secret-value"));
    assert!(!rendered.contains("runner-secret-value"));
    assert!(!rendered.contains("stored-secret-value"));
    assert!(!rendered.contains("long-secret-value"));
    assert!(!rendered.contains("escaped-key-secret-value"));
}

#[test]
fn agent_env_diagnostics_classifies_terminal_ownership_contract() {
    let env = HashMap::from([
        (
            "OKOU_FUTURE_PLATFORM_KEY".to_string(),
            "canonical".to_string(),
        ),
        (
            guest_contracts::env::CLI_AGENT_TYPE_ENV.to_string(),
            "explicit".to_string(),
        ),
        ("CUSTOM_SECRET_VALUES".to_string(), "ordinary".to_string()),
        ("CUSTOM_ENV".to_string(), "ordinary".to_string()),
    ]);

    let diagnostics = build_agent_env_diagnostics(&env, &HashMap::new());

    assert_eq!(diagnostics.env_count, 4);
    assert_eq!(diagnostics.runner_owned_count, 2);
    assert_eq!(diagnostics.external_count, 2);
}
