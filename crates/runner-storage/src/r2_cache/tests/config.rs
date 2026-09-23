use std::time::Duration;

use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

use super::super::{R2Error, R2ImageCache, config::ENV_VARS, keys::key_for_template_hash};

const R2_ENV_CHILD_SCENARIO: &str = "OKOU_RUNNER_R2_ENV_TEST_SCENARIO";
const R2_ENV_CHILD_TEST: &str = "r2_cache::tests::config::from_env_child";
const R2_ENV_CHILD_TIMEOUT: Duration = Duration::from_secs(10);
const ALL_MISSING_SCENARIO: &str = "all-missing";
const ALL_PRESENT_SCENARIO: &str = "all-present";
const ALL_EMPTY_SCENARIO: &str = "all-empty";
const PARTIAL_SCENARIO: &str = "partial";
const PARTIAL_EMPTY_SCENARIO: &str = "partial-empty";
const DEBUG_REDACTION_SCENARIO: &str = "debug-redaction";

#[test]
fn key_format() {
    assert_eq!(
        key_for_template_hash("abc123"),
        "runner-templates/abc123.tar.zst"
    );
}

#[tokio::test]
async fn from_env_returns_none_when_all_missing() {
    run_from_env_child(ALL_MISSING_SCENARIO, [None, None, None, None]).await;
}

#[tokio::test]
async fn from_env_returns_some_when_all_present() {
    run_from_env_child(
        ALL_PRESENT_SCENARIO,
        [
            Some("test-account"),
            Some("test-key"),
            Some("test-secret"),
            Some("test-bucket"),
        ],
    )
    .await;
}

#[tokio::test]
async fn from_env_treats_empty_string_as_unset() {
    run_from_env_child(ALL_EMPTY_SCENARIO, [Some(""), Some(""), Some(""), Some("")]).await;
}

#[tokio::test]
async fn from_env_errors_on_partial_config() {
    run_from_env_child(PARTIAL_SCENARIO, [Some("test"), None, None, Some("test")]).await;
}

#[tokio::test]
async fn from_env_errors_on_partial_with_some_empty_strings() {
    run_from_env_child(
        PARTIAL_EMPTY_SCENARIO,
        [Some("real-value"), Some(""), Some(""), Some("real-value")],
    )
    .await;
}

#[tokio::test]
async fn debug_format_does_not_leak_credentials() {
    run_from_env_child(
        DEBUG_REDACTION_SCENARIO,
        [
            Some("secret-account-id-do-not-leak"),
            Some("AKIAEXAMPLEDONOTLEAK"),
            Some("secret-key-MUST-NOT-appear-in-logs"),
            Some("test-bucket"),
        ],
    )
    .await;
}

async fn run_from_env_child(scenario: &'static str, values: [Option<&'static str>; 4]) {
    let child_env = [
        (ENV_VARS[0], values[0]),
        (ENV_VARS[1], values[1]),
        (ENV_VARS[2], values[2]),
        (ENV_VARS[3], values[3]),
    ];
    run_ignored_child_test(
        R2_ENV_CHILD_TEST,
        (R2_ENV_CHILD_SCENARIO, scenario),
        &child_env,
        R2_ENV_CHILD_TIMEOUT,
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by R2 environment scenario tests"]
async fn from_env_child() {
    let Ok(scenario) = std::env::var(R2_ENV_CHILD_SCENARIO) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((R2_ENV_CHILD_SCENARIO, &scenario)) {
        return;
    }

    match scenario.as_str() {
        ALL_MISSING_SCENARIO => {
            let result = R2ImageCache::from_env().await.unwrap();
            assert!(result.is_none(), "all four missing → None");
        }
        ALL_PRESENT_SCENARIO => {
            let result = R2ImageCache::from_env().await.unwrap();
            assert!(result.is_some(), "all four set → Some");
            let cache = result.unwrap();
            assert_eq!(cache.bucket, "test-bucket");
            let timeouts = cache.client.config().timeout_config().unwrap();
            assert_eq!(timeouts.connect_timeout(), Some(Duration::from_secs(10)));
            assert_eq!(timeouts.read_timeout(), Some(Duration::from_secs(60)));
            assert_eq!(timeouts.operation_timeout(), None);
            assert_eq!(timeouts.operation_attempt_timeout(), None);
        }
        ALL_EMPTY_SCENARIO => {
            let result = R2ImageCache::from_env().await.unwrap();
            assert!(result.is_none(), "all four empty → None, not Some");
        }
        PARTIAL_SCENARIO => {
            let error = R2ImageCache::from_env().await.unwrap_err();
            match error {
                R2Error::PartialConfig { present, missing } => {
                    assert_eq!(present.len(), 2);
                    assert_eq!(missing.len(), 2);
                    assert!(present.contains(&"R2_ACCOUNT_ID".to_string()));
                    assert!(present.contains(&"R2_USER_STORAGES_BUCKET_NAME".to_string()));
                    assert!(missing.contains(&"R2_ACCESS_KEY_ID".to_string()));
                    assert!(missing.contains(&"R2_SECRET_ACCESS_KEY".to_string()));
                }
                other => panic!("expected PartialConfig, got {other:?}"),
            }
        }
        PARTIAL_EMPTY_SCENARIO => {
            let error = R2ImageCache::from_env().await.unwrap_err();
            match error {
                R2Error::PartialConfig { present, missing } => {
                    assert_eq!(present.len(), 2, "two non-empty present");
                    assert_eq!(missing.len(), 2, "two empty treated as missing");
                    assert!(missing.contains(&"R2_ACCESS_KEY_ID".to_string()));
                    assert!(missing.contains(&"R2_SECRET_ACCESS_KEY".to_string()));
                }
                other => panic!("expected PartialConfig, got {other:?}"),
            }
        }
        DEBUG_REDACTION_SCENARIO => {
            let cache = R2ImageCache::from_env().await.unwrap().unwrap();
            let debug = format!("{cache:?}");
            assert!(
                !debug.contains("secret-account-id-do-not-leak"),
                "Debug leaked account_id: {debug}"
            );
            assert!(
                !debug.contains("AKIAEXAMPLEDONOTLEAK"),
                "Debug leaked access_key_id: {debug}"
            );
            assert!(
                !debug.contains("secret-key-MUST-NOT-appear-in-logs"),
                "Debug leaked secret_key: {debug}"
            );
            assert!(
                debug.contains("test-bucket"),
                "Debug should still expose bucket for diagnostic value: {debug}"
            );
        }
        other => panic!("unknown R2 environment test scenario: {other}"),
    }
}
