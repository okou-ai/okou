use std::time::Duration;

use super::*;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use clap::CommandFactory;

const HELP_OPERATOR_ENV_CHILD_SCENARIO_ENV: &str = "RUNNER_HELP_OPERATOR_ENV_CHILD_SCENARIO";
const HELP_OPERATOR_ENV_CHILD_TEST: &str =
    "tests::runner_help_hides_operator_environment_values_child";
const OPERATOR_ENV_CHILD_SCENARIO_ENV: &str = "RUNNER_OPERATOR_ENV_CHILD_SCENARIO";
const OPERATOR_ENV_CHILD_TEST: &str = "tests::runner_operator_environment_child";
const API_URL_NORMALIZATION_CHILD_SCENARIO_ENV: &str =
    "RUNNER_API_URL_NORMALIZATION_CHILD_SCENARIO";
const API_URL_NORMALIZATION_CHILD_TEST: &str =
    "tests::runner_api_url_environment_normalization_child";
const API_URL_ENV: &str = "OKOU_API_BACKEND_URL";
const TOKEN_ENV: &str = "OKOU_RUNNER_TOKEN";
const CANONICAL_TOKEN_SENTINEL: &str = "  canonical-sentinel-runner-token  ";
const FLAG_TOKEN_SENTINEL: &str = "  flag-sentinel-runner-token  ";
const CANONICAL_API_URL_SENTINEL: &str =
    "https://canonical-api-url-sentinel.example.test/canonical/";
const FLAG_API_URL_SENTINEL: &str = "https://flag-api-url-sentinel.example.test/flag/";

fn operator_child_env(case: &str) -> Vec<(&'static str, Option<&'static str>)> {
    match case {
        "canonical" | "flags-with-canonical" => vec![
            (API_URL_ENV, Some(CANONICAL_API_URL_SENTINEL)),
            (TOKEN_ENV, Some(CANONICAL_TOKEN_SENTINEL)),
        ],
        "none" => vec![(API_URL_ENV, None), (TOKEN_ENV, None)],
        unexpected => panic!("unexpected Runner operator environment case: {unexpected}"),
    }
}

fn api_url_normalization_child_env(
    value: &'static str,
) -> Vec<(&'static str, Option<&'static str>)> {
    vec![
        (API_URL_ENV, Some(value)),
        (TOKEN_ENV, Some(CANONICAL_TOKEN_SENTINEL)),
    ]
}

fn api_url_normalization_input(case: &str) -> &'static str {
    match case {
        "invalid-scheme" => "ftp://scheme-api-url-sentinel.example.test",
        "missing-host" => "https://",
        "userinfo" => "https://api-user:api-password@userinfo-api-url-sentinel.example.test",
        "query" => "https://query-api-url-sentinel.example.test/path?token=query-secret",
        "fragment" => "https://fragment-api-url-sentinel.example.test/path#fragment-secret",
        "trailing-slash" => "https://Trailing-API-URL-Sentinel.Example.Test/base/",
        unexpected => panic!("unexpected Runner API URL normalization case: {unexpected}"),
    }
}

fn assert_operator_values_hidden(output: &str) {
    for sentinel in [
        CANONICAL_API_URL_SENTINEL,
        FLAG_API_URL_SENTINEL,
        CANONICAL_TOKEN_SENTINEL,
        FLAG_TOKEN_SENTINEL,
    ] {
        assert!(
            !output.contains(sentinel),
            "Runner operator diagnostics must not expose {sentinel}: {output}"
        );
    }
}

fn runner_operator_cli_args(subcommand: &str, with_flags: bool) -> Vec<&'static str> {
    let mut args = match subcommand {
        "config" => vec![
            "runner",
            "config",
            "--profile",
            "vm0/default",
            "--rootfs-hash",
            "rootfs-hash",
            "--snapshot-hash",
            "snapshot-hash",
            "--group",
            "vm0/test",
            "--runner-dirname",
            "runner-test",
        ],
        "start" => vec!["runner", "start", "--config", "/tmp/runner.yaml"],
        unexpected => panic!("unexpected Runner operator subcommand: {unexpected}"),
    };
    if with_flags {
        args.extend([
            "--api-url",
            FLAG_API_URL_SENTINEL,
            "--token",
            FLAG_TOKEN_SENTINEL,
        ]);
    }
    args
}

fn parsed_operator_sources(cli: &Cli) -> (Option<&str>, Option<&str>) {
    match &cli.command {
        Command::Config(args) => (Some(args.api_url_for_test()), Some(args.token_for_test())),
        Command::Start(args) => (args.api_url_for_test(), args.token_for_test()),
        _ => panic!("Runner operator scenario parsed an unexpected subcommand"),
    }
}

#[test]
fn runner_log_prefix_uses_explicit_release_identity() {
    assert_eq!(runner_log_prefix("v1.2.3"), "runner-v1.2.3");
    assert_ne!(runner_log_prefix("v1.2.3"), runner_log_prefix("v1.2.4"));
}

#[test]
fn runner_hostname_partial_read_preserves_valid_value() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("runner.yaml");
    std::fs::write(&config_path, "hostname: prod-1.aws.vm3.ai\n").unwrap();

    assert_eq!(
        runner_hostname_from_config(&config_path).as_deref(),
        Some("prod-1.aws.vm3.ai")
    );
}

#[test]
fn runner_hostname_partial_read_omits_missing_or_invalid_value() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("runner.yaml");
    std::fs::write(&config_path, "group: vm0/test\n").unwrap();
    assert_eq!(runner_hostname_from_config(&config_path), None);

    std::fs::write(&config_path, "hostname: ''\n").unwrap();
    assert_eq!(runner_hostname_from_config(&config_path), None);
}

#[test]
fn runner_gc_help_describes_full_cleanup_scope() {
    let help = Cli::command().render_help().to_string();
    let normalized_help = help.split_whitespace().collect::<Vec<_>>().join(" ");

    assert!(
        normalized_help
            .contains("gc Clean up unused runner resources, artifacts, logs, and caches")
    );
}

#[test]
fn service_drain_help_describes_bounded_coordination() {
    let error = Cli::try_parse_from(["runner", "service", "--help"])
        .err()
        .expect("service --help should exit through clap");
    assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
    let normalized_help = error
        .to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    assert!(normalized_help.contains(
            "drain Drain without waiting for active jobs (waits for bounded same-process acknowledgement)"
        ));
}

#[test]
fn service_wait_running_help_describes_stdout_contract() {
    let error = Cli::try_parse_from(["runner", "service", "wait-running", "--help"])
        .err()
        .expect("service wait-running --help should exit through clap");
    assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
    let normalized_help = error
        .to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    assert!(
            normalized_help.contains(
                "Wait until a runner service is active and job-admitting. On success, emit the resolved max_concurrent as one machine-readable integer line on stdout for scripts; diagnostics go to stderr"
            ),
            "unexpected help output: {normalized_help}"
        );
}

#[tokio::test]
async fn runner_help_advertises_canonical_operator_environment() {
    for subcommand in ["config", "start"] {
        let child_env = operator_child_env("canonical");
        run_ignored_child_test(
            HELP_OPERATOR_ENV_CHILD_TEST,
            (HELP_OPERATOR_ENV_CHILD_SCENARIO_ENV, subcommand),
            &child_env,
            Duration::from_secs(5),
        )
        .await;
    }
}

#[test]
#[ignore = "spawned by runner_help_advertises_canonical_operator_environment"]
fn runner_help_hides_operator_environment_values_child() {
    let Ok(subcommand) = std::env::var(HELP_OPERATOR_ENV_CHILD_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((HELP_OPERATOR_ENV_CHILD_SCENARIO_ENV, &subcommand)) {
        return;
    }
    assert!(matches!(subcommand.as_str(), "config" | "start"));

    let error = Cli::try_parse_from(["runner", subcommand.as_str(), "--help"])
        .err()
        .expect("runner subcommand help should exit through Clap");
    assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
    let help = error.to_string();
    assert!(help.contains(API_URL_ENV));
    assert!(help.contains(TOKEN_ENV));
    assert_operator_values_hidden(&help);

    let normalized_help = help.split_whitespace().collect::<Vec<_>>().join(" ");
    for requirement in [
        "absolute URL without credentials, query, or fragment",
        "HTTPS is required except for HTTP hosts normalized to localhost, IPv4 loopback (127.0.0.0/8), or IPv6 loopback (::1)",
        "Private network addresses require HTTPS",
    ] {
        assert!(
            normalized_help.contains(requirement),
            "runner {subcommand} help should document {requirement}: {normalized_help}"
        );
    }
}

#[tokio::test]
async fn runner_config_and_start_use_canonical_operator_sources() {
    for subcommand in ["config", "start"] {
        for case in ["canonical", "flags-with-canonical", "none"] {
            let scenario = format!("{subcommand}:{case}");
            let child_env = operator_child_env(case);
            run_ignored_child_test(
                OPERATOR_ENV_CHILD_TEST,
                (OPERATOR_ENV_CHILD_SCENARIO_ENV, &scenario),
                &child_env,
                Duration::from_secs(5),
            )
            .await;
        }
    }
}

#[test]
#[ignore = "spawned by runner_config_and_start_use_canonical_operator_sources"]
fn runner_operator_environment_child() {
    let Ok(scenario) = std::env::var(OPERATOR_ENV_CHILD_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((OPERATOR_ENV_CHILD_SCENARIO_ENV, &scenario)) {
        return;
    }
    let (subcommand, case) = scenario
        .split_once(':')
        .expect("Runner operator scenario must contain subcommand and case");
    let parsed = Cli::try_parse_from(runner_operator_cli_args(
        subcommand,
        case.starts_with("flags-"),
    ));

    let canonical_source_missing = case == "none";
    if subcommand == "config" && canonical_source_missing {
        let error = parsed
            .err()
            .expect("runner config should require canonical operator sources");
        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );
        assert_operator_values_hidden(&error.to_string());
        return;
    }

    let cli = parsed.unwrap_or_else(|error| panic!("parse runner {scenario}: {error}"));
    let actual = parsed_operator_sources(&cli);
    let expected = match case {
        "canonical" => (
            Some(CANONICAL_API_URL_SENTINEL),
            Some(CANONICAL_TOKEN_SENTINEL),
        ),
        "flags-with-canonical" => (Some(FLAG_API_URL_SENTINEL), Some(FLAG_TOKEN_SENTINEL)),
        "none" => (None, None),
        unexpected => panic!("unexpected Runner operator case: {unexpected}"),
    };
    assert_eq!(actual, expected, "unexpected sources for {scenario}");
}

#[tokio::test]
async fn runner_canonical_api_url_environment_uses_existing_normalization() {
    for case in [
        "invalid-scheme",
        "missing-host",
        "userinfo",
        "query",
        "fragment",
        "trailing-slash",
    ] {
        let child_env = api_url_normalization_child_env(api_url_normalization_input(case));
        run_ignored_child_test(
            API_URL_NORMALIZATION_CHILD_TEST,
            (API_URL_NORMALIZATION_CHILD_SCENARIO_ENV, case),
            &child_env,
            Duration::from_secs(5),
        )
        .await;
    }
}

#[test]
#[ignore = "spawned by runner_canonical_api_url_environment_uses_existing_normalization"]
fn runner_api_url_environment_normalization_child() {
    let Ok(case) = std::env::var(API_URL_NORMALIZATION_CHILD_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((API_URL_NORMALIZATION_CHILD_SCENARIO_ENV, &case)) {
        return;
    }
    let input = api_url_normalization_input(&case);
    let cli = Cli::try_parse_from(runner_operator_cli_args("config", false))
        .unwrap_or_else(|error| panic!("parse Runner API URL normalization scenario: {error}"));
    let Command::Config(args) = cli.command else {
        panic!("Runner API URL normalization scenario parsed an unexpected subcommand");
    };
    assert_eq!(args.api_url_for_test(), input);

    let normalized = config::normalize_api_base_url(args.api_url_for_test());
    if case == "trailing-slash" {
        assert_eq!(
            normalized.unwrap(),
            "https://trailing-api-url-sentinel.example.test/base"
        );
        return;
    }

    let expected = match case.as_str() {
        "invalid-scheme" => "http or https",
        "missing-host" => "absolute http(s) URL",
        "userinfo" => "credentials",
        "query" => "query string",
        "fragment" => "fragment",
        unexpected => panic!("unexpected invalid Runner API URL case: {unexpected}"),
    };
    let error = normalized.expect_err("invalid Runner API URL should fail normalization");
    let message = error.to_string();
    assert!(message.contains(expected), "unexpected error: {message}");
    assert!(
        !message.contains(input),
        "normalization error must not expose the raw API URL: {message}"
    );
}

#[test]
fn home_image_cache_commands_are_registered() {
    assert!(
        Cli::try_parse_from(["runner", "home-image-cache", "info"]).is_ok(),
        "home-image-cache info should be registered"
    );
    assert!(
        Cli::try_parse_from(["runner", "home-image-cache", "list", "--limit", "1"]).is_ok(),
        "home-image-cache list should be registered"
    );
    assert!(
        Cli::try_parse_from(["runner", "home-image-cache", "gc", "--dry-run"]).is_ok(),
        "home-image-cache gc should be registered"
    );
}

#[test]
fn home_image_cache_help_documents_locked_entry_semantics() {
    let info_error = Cli::try_parse_from(["runner", "home-image-cache", "info", "--help"])
        .err()
        .expect("home-image-cache info --help should exit through clap");
    assert_eq!(info_error.kind(), clap::error::ErrorKind::DisplayHelp);
    let info_help = info_error
        .to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(info_help.contains("non-blocking, best-effort"));
    assert!(info_help.contains(
            "Locked entries skip metadata, image-size, temporary-path, storage, and artifact inspection."
        ));
    assert!(
        info_help.contains("status-category, temporary-path, and size values are lower bounds")
    );

    let list_error = Cli::try_parse_from(["runner", "home-image-cache", "list", "--help"])
        .err()
        .expect("home-image-cache list --help should exit through clap");
    assert_eq!(list_error.kind(), clap::error::ErrorKind::DisplayHelp);
    let list_help = list_error
        .to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(list_help.contains("non-blocking, best-effort"));
    assert!(list_help.contains(
            "zero measurements and null metadata fields on locked entries mean unavailable rather than measured zero"
        ));
    assert!(list_help.contains(
            "Status-category, temporary-path, and size summary values are lower bounds when `lockedEntries` is greater than zero."
        ));
}

#[test]
fn home_image_cache_help_documents_gc_eviction_policy() {
    let error = Cli::try_parse_from(["runner", "home-image-cache", "gc", "--help"])
        .err()
        .expect("home-image-cache gc --help should exit through clap");
    assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
    let help = error
        .to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    assert!(help.contains(
            "first phase removes stale, unusable, and temporary cache contents before evaluating capacity"
        ));
    assert!(help.contains("valid entries, oldest-first"));
    assert!(help.contains("below the filesystem low-water mark toward its high-water mark"));
    assert!(help.contains("independent 4,096-entry cap"));
    assert!(help.contains("Count-only cleanup does not activate a free-byte target"));
    assert!(help.contains("Actual free space controls recovery"));
    assert!(help.contains("deleting an open image does not imply its blocks were released"));
    assert!(help.contains("Locked entries are skipped during reusable-entry eviction"));
    assert!(help.contains("`--dry-run` to evaluate this same policy"));
    assert!(help.contains("without deleting data"));
}

#[test]
fn service_unit_state_command_is_registered() {
    assert!(
        Cli::try_parse_from([
            "runner",
            "service",
            "unit-state",
            "--name",
            "v1.2.3",
            "--name",
            "v1.2.2",
        ])
        .is_ok(),
        "service unit-state should accept one or more --name values"
    );
    assert!(
        Cli::try_parse_from(["runner", "service", "unit-state"]).is_err(),
        "service unit-state should require at least one --name"
    );
}
