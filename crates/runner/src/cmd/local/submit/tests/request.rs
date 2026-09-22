use std::process::ExitCode;

use super::super::{SubmitArgs, run_submit_with_home};
use super::support::{run_submit_and_write_success, submit_args_for_test};
use runner_host::paths::HomePaths;

#[tokio::test]
async fn submit_defaults_profile_and_writes_default_partition() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";

    let (code, request) = run_submit_and_write_success(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            chat_thread_id: None,
            session_id: None,
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.prompt, "hello");
    assert_eq!(request.cli_agent_type, "claude-code");
    assert_eq!(
        request.profile.as_deref(),
        Some(crate::profile::DEFAULT_PROFILE)
    );
}

#[tokio::test]
async fn submit_writes_non_default_profile_partition() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let profile = "vm0/large";

    let (code, request) = run_submit_and_write_success(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: Some(profile.into()),
            chat_thread_id: None,
            session_id: None,
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.profile.as_deref(), Some(profile));
}

#[tokio::test]
async fn submit_serializes_feature_flags_and_identity_fields() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";

    let (code, request) = run_submit_and_write_success(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "codex".into(),
            profile: None,
            chat_thread_id: Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".parse().unwrap()),
            session_id: Some("sess-123".into()),
            feature_flags: vec!["alpha=true".into(), "beta=false".into()],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();
    let flags = request.feature_flags.as_ref().unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.prompt, "hello");
    assert_eq!(request.cli_agent_type, "codex");
    assert_eq!(
        request.reuse_key.as_deref(),
        Some("thread:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    );
    assert_eq!(request.session_id.as_deref(), Some("sess-123"));
    assert_eq!(flags.get("alpha"), Some(&true));
    assert_eq!(flags.get("beta"), Some(&false));
}

#[tokio::test]
async fn submit_keeps_session_only_job_without_reuse_key() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";

    let (code, request) = run_submit_and_write_success(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            chat_thread_id: None,
            session_id: Some("sess-123".into()),
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.session_id.as_deref(), Some("sess-123"));
    assert!(request.reuse_key.is_none());
}

#[tokio::test]
async fn submit_serializes_env_and_secret_env() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";

    let mut args = submit_args_for_test();
    args.group = group.into();
    args.timeout = 5;
    args.env = vec![
        "FOO=bar".into(),
        "URL=https://example.test/path?a=1&b=2".into(),
        "EMPTY=".into(),
        "MULTILINE=line1\nline2".into(),
        "CUSTOM_RUNNER_KEY=ordinary-user-value".into(),
    ];
    args.secret_env = vec![
        "ANTHROPIC_API_KEY=sk-ant-local-secret".into(),
        "PRIVATE_KEY=-----BEGIN KEY-----\r\nsecret\r\n-----END KEY-----".into(),
        "CUSTOM_SECRET=ordinary-user-secret".into(),
    ];

    let (code, request) = run_submit_and_write_success(args, home).await.unwrap();
    let environment = request.environment.as_ref().unwrap();
    let secret_environment = request.secret_environment.as_ref().unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(environment.get("FOO").map(String::as_str), Some("bar"));
    assert_eq!(
        environment.get("URL").map(String::as_str),
        Some("https://example.test/path?a=1&b=2")
    );
    assert_eq!(environment.get("EMPTY").map(String::as_str), Some(""));
    assert_eq!(
        environment.get("MULTILINE").map(String::as_str),
        Some("line1\nline2")
    );
    assert_eq!(
        environment.get("CUSTOM_RUNNER_KEY").map(String::as_str),
        Some("ordinary-user-value")
    );
    assert_eq!(
        secret_environment
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some("sk-ant-local-secret")
    );
    assert_eq!(
        secret_environment.get("PRIVATE_KEY").map(String::as_str),
        Some("-----BEGIN KEY-----\r\nsecret\r\n-----END KEY-----")
    );
    assert_eq!(
        secret_environment.get("CUSTOM_SECRET").map(String::as_str),
        Some("ordinary-user-secret")
    );
}

#[tokio::test]
async fn rejects_invalid_env_entries_before_submit() {
    let cases = vec![
        (vec!["FOO".to_string()], Vec::new(), "expected KEY=VALUE"),
        (vec!["=VALUE".to_string()], Vec::new(), "expected KEY=VALUE"),
        (
            vec!["BAD-KEY=value".to_string()],
            Vec::new(),
            "expected [_A-Za-z][_A-Za-z0-9]*",
        ),
        (
            vec!["1KEY=value".to_string()],
            Vec::new(),
            "expected [_A-Za-z][_A-Za-z0-9]*",
        ),
        (
            vec!["KEY SPACE=value".to_string()],
            Vec::new(),
            "expected [_A-Za-z][_A-Za-z0-9]*",
        ),
        (
            Vec::new(),
            vec!["ÅKEY=value".to_string()],
            "expected [_A-Za-z][_A-Za-z0-9]*",
        ),
        (
            Vec::new(),
            vec!["KEY=with\0nul".to_string()],
            "NUL characters",
        ),
        (
            vec!["USE_MOCK_CLAUDE=true".to_string()],
            Vec::new(),
            "runner-owned environment variables",
        ),
        (
            vec!["OKOU_RUN_ID=user-controlled".to_string()],
            Vec::new(),
            "platform-reserved",
        ),
        (
            Vec::new(),
            vec!["CLI_AGENT_TYPE=codex".to_string()],
            "runner-owned environment variables",
        ),
        (
            vec!["FOO=1".to_string(), "FOO=2".to_string()],
            Vec::new(),
            "duplicate --env key 'FOO'",
        ),
        (
            vec!["FOO=1".to_string()],
            vec!["FOO=2".to_string()],
            "across --env and --secret-env",
        ),
    ];
    for (env, secret_env, expected) in cases {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let mut args = submit_args_for_test();
        args.env = env;
        args.secret_env = secret_env;

        let err = run_submit_with_home(args, home).await.unwrap_err();

        assert!(err.to_string().contains(expected), "got: {err}");
    }
}

#[tokio::test]
async fn rejects_reserved_okou_env_keys_without_exposing_values() {
    let mut cases = vec![
        (
            vec!["OKOU_TOKEN=ordinary-boundary-secret".to_string()],
            Vec::new(),
            "--env",
            "OKOU_TOKEN",
            "ordinary-boundary-secret",
        ),
        (
            Vec::new(),
            vec!["OKOU_UNRELATED=secret-boundary-secret".to_string()],
            "--secret-env",
            "OKOU_UNRELATED",
            "secret-boundary-secret",
        ),
    ];

    const RESERVED_TUNING_VALUE: &str = "reserved-tuning-value-must-not-leak";
    for key in [
        guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
    ] {
        cases.push((
            vec![format!("{key}={RESERVED_TUNING_VALUE}")],
            Vec::new(),
            "--env",
            key,
            RESERVED_TUNING_VALUE,
        ));
        cases.push((
            Vec::new(),
            vec![format!("{key}={RESERVED_TUNING_VALUE}")],
            "--secret-env",
            key,
            RESERVED_TUNING_VALUE,
        ));
    }

    for (env, secret_env, flag, key, value) in cases {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let mut args = submit_args_for_test();
        args.env = env;
        args.secret_env = secret_env;

        let err = run_submit_with_home(args, home).await.unwrap_err();
        let diagnostic = err.to_string();

        assert!(
            diagnostic.contains(&format!("invalid {flag} key '{key}'")),
            "got: {diagnostic}"
        );
        assert!(
            diagnostic.contains("OKOU_ environment variable namespace is platform-reserved"),
            "got: {diagnostic}"
        );
        assert!(!diagnostic.contains(value), "got: {diagnostic}");
    }
}
