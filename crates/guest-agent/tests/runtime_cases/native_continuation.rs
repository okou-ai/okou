//! Real CLI process boundaries select retained native history before adding
//! the API-owned recovery item. Config is owned; no process env is mutated.

#![cfg(target_os = "linux")]

use crate::common;

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
use std::path::{Path, PathBuf};
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

fn native(id: Option<&str>, later: bool) -> NativeContinuation {
    NativeContinuation {
        session_id: id.map(str::to_owned),
        generation_run_id: id.map(|_| uuid::Uuid::new_v4().to_string()),
        recovery_prompt: later.then(|| RECOVERY.to_owned()),
    }
}

fn runtime(
    home: &Path,
    server: &common::RecordingServer,
    framework: &str,
    binary: &Path,
    native: NativeContinuation,
    pi_id: &str,
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
            pi_session_id: pi_id.into(),
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
async fn claude_resumes_only_matching_history_and_recovers_later_misses() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let mock = common::build_and_locate_mock()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    for case in [
        "first",
        "resumed",
        "dense",
        "corrupt-tail",
        "conflicting-tail",
        "missing",
        "foreign",
        "header-only",
        "framework-switch",
    ] {
        let home = tempfile::tempdir()?;
        let id = uuid::Uuid::new_v4().to_string();
        let history = home.path().join(".claude/projects/-home-user-workspace");
        std::fs::create_dir_all(&history)?;
        if matches!(
            case,
            "resumed" | "dense" | "corrupt-tail" | "conflicting-tail" | "foreign" | "header-only"
        ) {
            std::fs::write(
                history.join(format!("{id}.jsonl")),
                format!(
                    "{}\n",
                    json!({"sessionId": if case == "foreign" { "foreign" } else { &id }})
                ),
            )?;
        }
        if matches!(
            case,
            "resumed" | "dense" | "corrupt-tail" | "conflicting-tail"
        ) {
            let mut history_file = std::fs::OpenOptions::new()
                .append(true)
                .open(history.join(format!("{id}.jsonl")))?;
            use std::io::Write as _;
            writeln!(
                history_file,
                "{}",
                json!({"type":"user","sessionId":id,"message":{"role":"user","content":"Earlier context"}})
            )?;
            match case {
                "dense" => writeln!(
                    history_file,
                    "{{\"unused\":[{}{{\"x\":0}}]}}",
                    "{\"x\":0},".repeat(1024)
                )?,
                "corrupt-tail" => writeln!(history_file, "{{\"unused\":[0,]}}")?,
                "conflicting-tail" => writeln!(history_file, "{{\"sessionId\":\"foreign\"}}")?,
                _ => {}
            }
        }
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
        let requested = (!matches!(case, "first" | "framework-switch")).then_some(id.as_str());
        let run = runtime(
            home.path(),
            &server,
            "claude-code",
            &binary,
            native(requested, case != "first"),
            "",
            HashMap::new(),
        )?;
        execute(&run).await?;
        let args = std::fs::read_to_string(argv)?;
        assert_eq!(
            args.lines().any(|arg| arg == "--resume"),
            matches!(case, "resumed" | "dense"),
            "{case}"
        );
        let appended = std::fs::read_to_string(run.paths.claude_append_system_prompt_file())?;
        assert_eq!(
            appended.contains(RECOVERY),
            !matches!(case, "first" | "resumed" | "dense"),
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
        native(None, false),
        "",
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
        native(Some(id), true),
        "",
        user_env,
    )?;
    execute(&second).await?;
    let messages = std::fs::read_to_string(capture)?
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
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
async fn codex_resumes_exact_rollout_and_recovers_missing_or_ambiguous_history() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let mock = common::build_and_locate_mock_codex()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    for case in [
        "first",
        "resumed",
        "missing",
        "duplicate",
        "header-only",
        "foreign",
        "framework-switch",
        "rpc-missing",
        "rpc-error",
    ] {
        let home = tempfile::tempdir()?;
        let id = uuid::Uuid::new_v4().to_string();
        let sessions = home.path().join(".codex/sessions/2026/10/14");
        std::fs::create_dir_all(&sessions)?;
        if matches!(
            case,
            "resumed" | "duplicate" | "foreign" | "header-only" | "rpc-missing" | "rpc-error"
        ) {
            let mut header = format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":if case == "foreign" { "019dce97-c703-7b91-8b8b-e7a7dd145918" } else { &id }}})
            );
            if case != "header-only" {
                header.push_str(&format!("{}\n", json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Earlier context"}]}})));
            }
            std::fs::write(
                sessions.join(format!("rollout-2026-10-14T00-00-00-{id}.jsonl")),
                &header,
            )?;
            if case == "duplicate" {
                std::fs::write(
                    sessions.join(format!("rollout-2026-10-14T00-00-01-{id}.jsonl")),
                    &header,
                )?;
            }
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
        let requested = (!matches!(case, "first" | "framework-switch")).then_some(id.as_str());
        let run = runtime(
            home.path(),
            &server,
            "codex",
            &binary,
            native(requested, case != "first"),
            "",
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
            let requests = std::fs::read_to_string(&capture)?
                .lines()
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()?;
            assert!(
                !requests
                    .iter()
                    .any(|message| message["method"] == "thread/start")
            );
            continue;
        }
        execute(&run).await?;
        let messages = std::fs::read_to_string(capture)?
            .lines()
            .map(serde_json::from_str::<Value>)
            .collect::<Result<Vec<_>, _>>()?;
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
            if case == "resumed" {
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
            !matches!(case, "first" | "resumed"),
            "{case}"
        );
        assert!(prompt.starts_with(BASE_PROMPT));
    }
    Ok(())
}

struct PiFiles(Vec<PathBuf>);
impl Drop for PiFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tokio::test]
async fn pi_keeps_matching_history_and_quarantines_corrupt_history_before_fresh_launch()
-> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let root =
        Path::new(api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR);
    std::fs::create_dir_all(root)?;
    for case in [
        "first",
        "resumed",
        "missing",
        "corrupt",
        "wrong-version",
        "header-only",
        "duplicate",
        "framework-switch",
    ] {
        let home = tempfile::tempdir()?;
        let id = uuid::Uuid::new_v4().to_string();
        let path = root.join(format!("2026-10-14T00-00-00_{id}.jsonl"));
        let duplicate = root.join(format!("2026-10-14T00-00-01_{id}.jsonl"));
        let mut files = PiFiles(vec![path.clone(), duplicate.clone()]);
        if matches!(
            case,
            "resumed" | "corrupt" | "wrong-version" | "duplicate" | "header-only"
        ) {
            let mut history = if case == "corrupt" {
                "not JSON".into()
            } else {
                format!(
                    "{}\n",
                    json!({"type":"session","version":if case == "wrong-version" { 4 } else { 3 },"id":id})
                )
            };
            if matches!(case, "resumed" | "duplicate" | "wrong-version") {
                history.push_str(&format!("{}\n", json!({"type":"message","id":"00000001","parentId":null,"message":{"role":"user","content":"Earlier context"}})));
            }
            std::fs::write(&path, &history)?;
            if case == "duplicate" {
                std::fs::write(&duplicate, &history)?;
            }
        }
        let bin = home.path().join("bin");
        std::fs::create_dir(&bin)?;
        let capture = home.path().join("pi-launch.json");
        executable(
            &bin.join("okou"),
            &format!(
                "#!/bin/sh\nset -eu\ncat \"$OKOU_PI_LAUNCH_PAYLOAD_FILE\" > {}\nIFS= read -r state\nprintf '%s\\n' '{}' | sed \"s/__RUN__/$OKOU_RUN_ID/g\"\nIFS= read -r prompt\nprintf '{{\"id\":\"%s:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}}\\n' \"$OKOU_RUN_ID\"\nprintf '%s\\n' '{{\"type\":\"agent_settled\"}}'\ncat >/dev/null\n",
                quote_shell_arg(&capture.to_string_lossy()),
                json!({"id":"__RUN__:pi:get-state","type":"response","command":"get_state","success":true,"data":{"sessionId":id,"sessionFile":path}}),
            ),
        )?;
        let requested = (!matches!(case, "first" | "framework-switch")).then_some(id.as_str());
        let run = runtime(
            home.path(),
            &server,
            "pi",
            &bin.join("okou"),
            native(requested, case != "first"),
            &id,
            HashMap::from([("PATH".into(), format!("{}:/usr/bin:/bin", bin.display()))]),
        )?;
        for original in [&path, &duplicate] {
            files.0.push(original.with_file_name(format!(
                    "{}.unresumed-{}",
                    original
                        .file_name()
                        .ok_or("Pi filename absent")?
                        .to_string_lossy(),
                    run.config.run_id
                )));
        }
        execute(&run).await?;
        let payload: Value = serde_json::from_slice(&std::fs::read(capture)?)?;
        let prompt = payload["appendSystemPrompt"]
            .as_str()
            .ok_or("Pi appended prompt absent")?;
        assert_eq!(
            prompt.contains(RECOVERY),
            !matches!(case, "first" | "resumed"),
            "{case}"
        );
        assert_eq!(path.exists(), case == "resumed", "{case}");
    }
    Ok(())
}
