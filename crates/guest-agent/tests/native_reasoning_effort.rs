//! Native effort must reach the actual child argv or app-server request.

mod common;

use guest_agent::active_input::ActiveInputRuntime;
use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[tokio::test]
async fn selected_effort_reaches_new_and_resumed_native_runs() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let root = tempfile::tempdir()?;
    let claude_mock = common::build_and_locate_mock()?;
    let codex_mock = common::build_and_locate_mock_codex()?;
    for (framework, real_mock, model, effort, expected) in [
        (
            "codex",
            &codex_mock,
            "openai/gpt-6-astra",
            Some("low"),
            Some("low"),
        ),
        (
            "codex",
            &codex_mock,
            "gpt-5.6-sol",
            Some("medium"),
            Some("medium"),
        ),
        (
            "codex",
            &codex_mock,
            "gpt-5.6-terra",
            Some("high"),
            Some("high"),
        ),
        (
            "codex",
            &codex_mock,
            "gpt-5.6-luna",
            Some("xhigh"),
            Some("xhigh"),
        ),
        (
            "codex",
            &codex_mock,
            "gpt-6-astra",
            Some("max"),
            Some("max"),
        ),
        (
            "codex",
            &codex_mock,
            "openai/gpt-6-astra",
            Some("ultra"),
            Some("ultra"),
        ),
        ("codex", &codex_mock, "gpt-6-sol", Some("max"), Some("max")),
        (
            "codex",
            &codex_mock,
            "openai/gpt-6-sol",
            Some("ultra"),
            Some("ultra"),
        ),
        ("codex", &codex_mock, "gpt-6-sol", None, Some("max")),
        (
            "codex",
            &codex_mock,
            "gpt-5.6-sol",
            Some("ultra"),
            Some("ultra"),
        ),
        (
            "codex",
            &codex_mock,
            "gpt-5.6-terra",
            Some("ultra"),
            Some("ultra"),
        ),
        ("codex", &codex_mock, "gpt-5.6-sol", None, Some("max")),
        ("codex", &codex_mock, "openai/gpt-5.5", None, Some("xhigh")),
        ("codex", &codex_mock, "custom-model", None, None),
        (
            "claude-code",
            &claude_mock,
            "anthropic/claude-fable-5.1",
            Some("low"),
            Some("low"),
        ),
        (
            "claude-code",
            &claude_mock,
            "claude-opus-5",
            Some("medium"),
            Some("medium"),
        ),
        (
            "claude-code",
            &claude_mock,
            "claude-opus-4-8",
            Some("high"),
            Some("high"),
        ),
        (
            "claude-code",
            &claude_mock,
            "anthropic/claude-sonnet-5",
            Some("extra"),
            Some("xhigh"),
        ),
        (
            "claude-code",
            &claude_mock,
            "claude-sonnet-4.6",
            Some("max"),
            Some("max"),
        ),
        // Preserve the CLI mode while chat admission stays closed for rollout.
        // Ultracode also needs actual workflow availability verified before use.
        (
            "claude-code",
            &claude_mock,
            "claude-opus-5",
            Some("ultracode"),
            Some("ultracode"),
        ),
        ("claude-code", &claude_mock, "fable", None, Some("max")),
        ("claude-code", &claude_mock, "claude-sonnet-5", None, None),
    ] {
        for resume in [false, true] {
            for fast in [false, true] {
                let case_root = root.path().join(format!(
                    "{framework}-{}-{resume}-{fast}-{}",
                    model.replace('/', "_"),
                    effort.unwrap_or("default")
                ));
                std::fs::create_dir_all(&case_root)?;
                let args_path = case_root.join("args.txt");
                let wrapper = write_recording_wrapper(&case_root)?;
                let mut runtime =
                    build_runtime(&case_root, framework, &wrapper, real_mock, &args_path)?;
                let model_key = if framework == "codex" {
                    "OPENAI_MODEL"
                } else {
                    "ANTHROPIC_MODEL"
                };
                runtime
                    .config
                    .user_env
                    .insert(model_key.to_string(), model.to_string());
                if let Some(effort) = effort {
                    runtime
                        .config
                        .user_env
                        .insert("OKOU_REASONING_EFFORT".to_string(), effort.to_string());
                }
                if fast {
                    runtime
                        .config
                        .user_env
                        .insert("OKOU_CODEX_SERVICE_TIER".to_string(), "fast".to_string());
                }
                if resume {
                    runtime.config.resume_session_id =
                        "0193abcd-ef01-7234-89ab-cdef01234567".to_string();
                }
                let result = execute(&runtime).await?;
                assert_eq!(
                    result.exit_code,
                    common::CLEAN_EXIT,
                    "{framework} {model} {effort:?}"
                );
                let args = read_args(&args_path)?;
                if framework == "codex" {
                    let events = common::read_codex_session_history_events_for_runtime(&runtime)?;
                    let input = events
                        .iter()
                        .find(|event| event["type"] == "mock.app_server.input")
                        .ok_or("missing Codex input event")?;
                    assert_eq!(input["turn_request_effort"].as_str(), expected);
                    assert_eq!(
                        input["thread_request_excludes_turns"].as_bool(),
                        Some(resume)
                    );
                    assert_eq!(
                        args.windows(2)
                            .any(|args| args == ["-c", "service_tier=\"fast\""]),
                        fast
                    );
                } else {
                    let effort_arg = args
                        .windows(2)
                        .find(|args| args[0] == "--effort")
                        .map(|args| args[1].as_str());
                    assert_eq!(effort_arg, expected);
                    assert_eq!(args.iter().any(|arg| arg == "--resume"), resume);
                }
            }
        }
    }
    Ok(())
}

fn build_runtime(
    root: &Path,
    framework: &str,
    wrapper_path: &Path,
    real_mock: &Path,
    args_path: &Path,
) -> TestResult<GuestRuntime> {
    let run_id = format!("native-effort-{framework}");
    let home = root.join("home");
    let runtime_dir = root.join("runtime");
    std::fs::create_dir_all(&home)?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "true".to_string(),
            disallowed_tools: "CronCreate".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let user_env_file = write_user_env_file(
        &runtime_dir,
        &HashMap::from([
            (
                "TEST_ARGS_PATH",
                args_path.to_str().ok_or("args path must be valid UTF-8")?,
            ),
            (
                "TEST_REAL_MOCK",
                real_mock.to_str().ok_or("mock path must be valid UTF-8")?,
            ),
        ]),
    )?;
    let is_claude = framework == "claude-code";
    let mut config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id,
        api_url: "http://127.0.0.1:1".to_string(),
        sandbox_id: "00000000-0000-4000-8000-000000000abc".to_string(),
        sandbox_reuse_result: "reused".to_string(),
        use_mock_claude: is_claude.to_string(),
        mock_claude_path: is_claude.then(|| wrapper_path.to_string_lossy().into_owned()),
        cli_agent_type: framework.to_string(),
        user_env_file: user_env_file.to_string_lossy().into_owned(),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        use_mock_codex: (!is_claude).to_string(),
        mock_codex_path: (!is_claude).then(|| wrapper_path.to_string_lossy().into_owned()),
        home: Some(home.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir.clone()),
        ..guest_agent::env::GuestConfigRaw::default()
    })
    .map_err(std::io::Error::other)?;
    config.codex_home_dir = root.join("codex-home").to_string_lossy().into_owned();
    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    let http = guest_agent::http::HttpClient::for_config(&config)?;

    Ok(GuestRuntime {
        config,
        paths,
        http,
        workload_containment: None,
        process_control_endpoint: None,
    })
}

fn write_user_env_file(runtime_dir: &Path, user_env: &HashMap<&str, &str>) -> TestResult<PathBuf> {
    let dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(&path, serde_json::to_vec(user_env)?)?;
    Ok(path)
}

fn write_recording_wrapper(root: &Path) -> TestResult<PathBuf> {
    let path = root.join("record-args");
    std::fs::write(
        &path,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TEST_ARGS_PATH\"\nexec \"$TEST_REAL_MOCK\" \"$@\"\n",
    )?;
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)?;
    Ok(path)
}

fn read_args(path: &Path) -> TestResult<Vec<String>> {
    Ok(std::fs::read_to_string(path)?
        .lines()
        .map(str::to_string)
        .collect())
}

async fn execute(runtime: &GuestRuntime) -> TestResult<guest_agent::cli::CliExecutionResult> {
    let active_input =
        ActiveInputRuntime::new_disabled(&runtime.config.run_id, &runtime.config.prompt);
    Ok(guest_agent::cli::execute_cli_with_active_input_for_config(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        active_input.into_writer(),
        &runtime.config,
        &runtime.paths,
    )
    .await?)
}
