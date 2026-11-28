//! Real CLI process boundaries continue natively in reused homes or append the
//! API-owned recovery prompt when starting fresh. Config is owned; no process
//! env is mutated.

#![cfg(target_os = "linux")]

use crate::common;
use cli_test_support::json_fixture::read_json_lines;

use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use guest_contracts::env::{NativeContinuation, RunPayload};
use serde_json::{Value, json};
use shell_quote::quote_shell_arg;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

type TestResult = Result<(), Box<dyn std::error::Error>>;
const BASE_PROMPT: &str = "Your name is Okou.";
const RECOVERY: &str =
    "Before responding, run okou chat messages --output-dir threads and read the earlier messages.";

fn executable(path: &Path, text: &str) -> TestResult {
    std::fs::write(path, text)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn native(continue_native: bool, later: bool) -> NativeContinuation {
    NativeContinuation {
        continue_native,
        expected_source_run_id: continue_native.then(|| uuid::Uuid::new_v4().to_string()),
        recovery_prompt: later.then(|| RECOVERY.to_owned()),
    }
}

fn runtime(
    home: &Path,
    server: &common::RecordingServer,
    framework: &str,
    binary: &Path,
    native: NativeContinuation,
    user_env: HashMap<String, String>,
) -> Result<GuestRuntime, Box<dyn std::error::Error>> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let paths = GuestPaths::from_home(home, &run_id)?;
    let payload = common::write_run_payload_file_for_test(
        paths.runtime_dir(),
        &RunPayload {
            prompt: "true".into(),
            append_system_prompt: BASE_PROMPT.into(),
            native_continuation: serde_json::to_string(&native)?,
            pi_launch_config: "{\"schemaVersion\":2}".into(),
            pi_model_config: "{}".into(),
            ..RunPayload::default()
        },
    )?;
    let env_dir = paths
        .runtime_dir()
        .join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&env_dir)?;
    let env_path = env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(&env_path, serde_json::to_vec(&user_env)?)?;
    let config = GuestConfig::from_raw(GuestConfigRaw {
        run_id,
        api_url: server.base_url.clone(),
        api_token: "test-token".into(),
        sandbox_id: uuid::Uuid::new_v4().to_string(),
        cli_agent_type: framework.into(),
        use_mock_claude: (framework == "claude-code").to_string(),
        mock_claude_path: Some(binary.to_string_lossy().into_owned()),
        use_mock_codex: (framework == "codex").to_string(),
        mock_codex_path: Some(binary.to_string_lossy().into_owned()),
        home: Some(home.to_string_lossy().into_owned()),
        test_claude_config_dir: Some(home.join(".claude")),
        test_codex_home_dir: Some(home.join(".codex")),
        test_pi_cli_path: Some(binary.to_string_lossy().into_owned()),
        run_payload_file: payload.to_string_lossy().into_owned(),
        user_env_file: env_path.to_string_lossy().into_owned(),
        ..GuestConfigRaw::default()
    })?;
    Ok(GuestRuntime {
        http: HttpClient::for_config(&config)?,
        config,
        paths,
        workload_containment: None,
        process_control_endpoint: None,
    })
}

async fn execute(runtime: &GuestRuntime) -> TestResult {
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(runtime, &SecretMasker::from_raw(""), None),
    )
    .await??;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    Ok(())
}

#[tokio::test]
async fn claude_uses_continue_flag_when_continuing_natively_and_recovers_otherwise() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let mock = common::build_and_locate_mock()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    for case in ["first", "continued", "framework-switch"] {
        let home = tempfile::tempdir()?;
        let argv = home.path().join("argv");
        let binary = home.path().join("claude");
        executable(
            &binary,
            &format!(
                "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$@\" > {}\nexec {} \"$@\"\n",
                quote_shell_arg(&argv.to_string_lossy()),
                quote_shell_arg(&mock.to_string_lossy()),
            ),
        )?;
        let run = runtime(
            home.path(),
            &server,
            "claude-code",
            &binary,
            native(case == "continued", case != "first"),
            HashMap::new(),
        )?;
        execute(&run).await?;
        let args = std::fs::read_to_string(argv)?;
        assert_eq!(
            args.lines().any(|arg| arg == "--continue"),
            case == "continued",
            "{case}"
        );
        assert!(
            !args.lines().any(|arg| arg == "--resume"),
            "{case}: API runs should never pass --resume"
        );
        let appended = std::fs::read_to_string(run.paths.claude_append_system_prompt_file())?;
        assert_eq!(
            appended.contains(RECOVERY),
            case == "framework-switch",
            "{case}"
        );
        assert!(appended.starts_with(BASE_PROMPT));
    }
    Ok(())
}

#[tokio::test]
async fn codex_continues_a_first_turn_from_the_same_retained_home() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let mock = common::build_and_locate_mock_codex()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let home = tempfile::tempdir()?;
    let capture = home.path().join("rpc");
    let binary = home.path().join("codex");
    executable(
        &binary,
        &format!(
            "#!/bin/sh\nset -eu\ntee {} | {} \"$@\"\n",
            quote_shell_arg(&capture.to_string_lossy()),
            quote_shell_arg(&mock.to_string_lossy()),
        ),
    )?;
    let user_env = HashMap::from([(
        "MOCK_CODEX_SESSION_TIMESTAMP".to_owned(),
        "2026-10-14T00:00:00Z".to_owned(),
    )]);
    let first = runtime(
        home.path(),
        &server,
        "codex",
        &binary,
        native(false, false),
        user_env.clone(),
    )?;
    execute(&first).await?;
    let sessions = home.path().join(".codex/sessions/2026/10/14");
    let history_path = std::fs::read_dir(sessions)?
        .next()
        .ok_or("native history absent")??
        .path();
    let text = std::fs::read_to_string(history_path)?;
    let header: Value = serde_json::from_str(text.lines().next().ok_or("native header absent")?)?;
    let id = header["payload"]["id"]
        .as_str()
        .ok_or("native identity absent")?;
    let second = runtime(
        home.path(),
        &server,
        "codex",
        &binary,
        native(true, true),
        user_env,
    )?;
    execute(&second).await?;
    let messages = read_json_lines(capture)?;
    assert!(
        messages
            .iter()
            .any(|message| message["method"] == "thread/list"),
        "second turn should discover the latest thread via thread/list"
    );
    let resumed = messages
        .iter()
        .find(|message| message["method"] == "thread/resume")
        .ok_or("second turn did not resume native history")?;
    assert_eq!(resumed["params"]["threadId"], id);
    assert!(
        !resumed["params"]["developerInstructions"]
            .as_str()
            .ok_or("developer instructions absent")?
            .contains(RECOVERY)
    );
    assert!(
        !messages
            .iter()
            .any(|message| message["method"] == "thread/start")
    );
    Ok(())
}

#[tokio::test]
async fn codex_lists_and_resumes_latest_thread_or_recovers_on_missing_rollout() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let mock = common::build_and_locate_mock_codex()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    for case in [
        "first",
        "continued",
        "empty-list",
        "framework-switch",
        "rpc-missing",
        "rpc-error",
    ] {
        let home = tempfile::tempdir()?;
        let id = uuid::Uuid::new_v4().to_string();
        let sessions = home.path().join(".codex/sessions/2026/10/14");
        std::fs::create_dir_all(&sessions)?;
        if matches!(case, "continued" | "rpc-missing" | "rpc-error") {
            let header = format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":&id,"cwd":"/home/user/workspace"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Earlier context"}]}}),
            );
            std::fs::write(
                sessions.join(format!("rollout-2026-10-14T00-00-00-{id}.jsonl")),
                &header,
            )?;
        }
        let capture = home.path().join("rpc");
        let binary = home.path().join("codex");
        let scenario = match case {
            "rpc-missing" => "MOCK_CODEX_APP_SERVER_SCENARIO=resume-rollout-missing ",
            "rpc-error" => "MOCK_CODEX_APP_SERVER_SCENARIO=resume-rpc-error-with-thread-id ",
            _ => "",
        };
        executable(
            &binary,
            &format!(
                "#!/bin/sh\nset -eu\ntee {} | {scenario}{} \"$@\"\n",
                quote_shell_arg(&capture.to_string_lossy()),
                quote_shell_arg(&mock.to_string_lossy()),
            ),
        )?;
        let continue_native = !matches!(case, "first" | "framework-switch");
        let run = runtime(
            home.path(),
            &server,
            "codex",
            &binary,
            native(continue_native, case != "first"),
            HashMap::new(),
        )?;
        if case == "rpc-error" {
            let result = tokio::time::timeout(
                Duration::from_secs(10),
                common::execute_cli_for_runtime(&run, &SecretMasker::from_raw(""), None),
            )
            .await?;
            assert!(
                match result {
                    Ok(result) => result.exit_code != 0,
                    Err(_) => true,
                },
                "an unrelated resume RPC failure must remain visible"
            );
            let requests = read_json_lines(&capture)?;
            assert!(
                !requests
                    .iter()
                    .any(|message| message["method"] == "thread/start")
            );
            continue;
        }
        execute(&run).await?;
        let messages = read_json_lines(capture)?;
        let thread_request = messages
            .iter()
            .rev()
            .find(|message| {
                matches!(
                    message["method"].as_str(),
                    Some("thread/start" | "thread/resume")
                )
            })
            .ok_or("thread request absent")?;
        assert_eq!(
            thread_request["method"],
            if case == "continued" {
                "thread/resume"
            } else {
                "thread/start"
            },
            "{case}"
        );
        let prompt = thread_request["params"]["developerInstructions"]
            .as_str()
            .ok_or("developer instructions absent")?;
        assert_eq!(
            prompt.contains(RECOVERY),
            !matches!(case, "first" | "continued"),
            "{case}"
        );
        assert!(prompt.starts_with(BASE_PROMPT));
    }
    Ok(())
}

#[tokio::test]
async fn pi_forwards_continue_native_and_recovers_when_starting_fresh() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    for case in ["first", "continued", "framework-switch"] {
        let home = tempfile::tempdir()?;
        let dynamic_session_id = uuid::Uuid::new_v4().to_string();
        let bin = home.path().join("bin");
        std::fs::create_dir(&bin)?;
        let capture = home.path().join("pi-launch.json");
        executable(
            &bin.join("okou"),
            &format!(
                "#!/bin/sh\nset -eu\ncat \"$OKOU_PI_LAUNCH_PAYLOAD_FILE\" > {}\nIFS= read -r state\nprintf '%s\\n' '{}' | sed \"s/__RUN__/$OKOU_RUN_ID/g\"\nIFS= read -r prompt\nprintf '{{\"id\":\"%s:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}}\\n' \"$OKOU_RUN_ID\"\nprintf '%s\\n' '{{\"type\":\"agent_settled\"}}'\ncat >/dev/null\n",
                quote_shell_arg(&capture.to_string_lossy()),
                json!({"id":"__RUN__:pi:get-state","type":"response","command":"get_state","success":true,"data":{"sessionId":dynamic_session_id}}),
            ),
        )?;
        let run = runtime(
            home.path(),
            &server,
            "pi",
            &bin.join("okou"),
            native(case == "continued", case != "first"),
            HashMap::from([("PATH".into(), format!("{}:/usr/bin:/bin", bin.display()))]),
        )?;
        execute(&run).await?;
        let payload: Value = serde_json::from_slice(&std::fs::read(capture)?)?;
        assert_eq!(payload["continueNative"], case == "continued", "{case}");
        let prompt = payload["appendSystemPrompt"]
            .as_str()
            .ok_or("Pi appended prompt absent")?;
        assert_eq!(
            prompt.contains(RECOVERY),
            case == "framework-switch",
            "{case}"
        );
        assert_eq!(
            std::fs::read_to_string(run.paths.session_id_file())?,
            dynamic_session_id,
            "{case}: guest should capture Pi sessionId dynamically from get_state"
        );
    }
    Ok(())
}
