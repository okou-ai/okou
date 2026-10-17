//! Claude appended prompts stay out of process arguments.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and the broad same-UID `pkill -f` regression scenario.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

const CLEANUP_MARKER: &str = "vm0-pkill-collision-4f83c597e45b";

fn scenario_prompt(expected_prompt: &str, capture_path: &std::path::Path) -> String {
    format!(
        "@append-prompt-transport:{}",
        serde_json::json!({
            "capturePath": capture_path,
            "expectedPrompt": expected_prompt,
        })
    )
}

#[tokio::test]
async fn claude_append_prompt_uses_private_file_and_survives_broad_pkill()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let populated_argv_path = tmp.path().join("populated-argv.json");
    let initial_prompt = scenario_prompt(CLEANUP_MARKER, &populated_argv_path);
    unsafe {
        common::setup_env(&mock, tmp.path(), &initial_prompt, 3, 1)?;
    }

    let mut runtime = common::guest_runtime_from_process_env()?;
    runtime.config.append_system_prompt = CLEANUP_MARKER.to_string();
    let masker = SecretMasker::from_raw("");
    let populated_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("file-backed append prompt scenario should return promptly")?;
    assert_eq!(populated_result.exit_code, common::CLEAN_EXIT);

    let populated_argv: Vec<String> =
        serde_json::from_slice(&std::fs::read(&populated_argv_path)?)?;
    assert!(
        !populated_argv
            .iter()
            .any(|arg| arg == "--append-system-prompt" || arg.contains(CLEANUP_MARKER)),
        "raw appended prompt must be absent from Claude argv: {populated_argv:?}"
    );
    let file_flag_index = populated_argv
        .iter()
        .position(|arg| arg == "--append-system-prompt-file")
        .ok_or("Claude argv omitted --append-system-prompt-file")?;
    let prompt_file_arg = populated_argv
        .get(file_flag_index + 1)
        .ok_or("Claude append prompt file flag omitted its path")?;
    assert_eq!(
        prompt_file_arg,
        runtime.paths.claude_append_system_prompt_file()
    );

    let prompt_path = std::path::Path::new(runtime.paths.claude_append_system_prompt_file());
    assert_eq!(std::fs::read(prompt_path)?, CLEANUP_MARKER.as_bytes());
    assert_eq!(
        std::fs::metadata(prompt_path)?.permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(runtime.paths.runtime_dir())?
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    let empty_argv_path = tmp.path().join("empty-argv.json");
    runtime.config.prompt = scenario_prompt("", &empty_argv_path);
    runtime.config.append_system_prompt.clear();
    let empty_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("empty append prompt scenario should return promptly")?;
    assert_eq!(empty_result.exit_code, common::CLEAN_EXIT);

    let empty_argv: Vec<String> = serde_json::from_slice(&std::fs::read(empty_argv_path)?)?;
    assert!(
        !empty_argv
            .iter()
            .any(|arg| { arg == "--append-system-prompt" || arg == "--append-system-prompt-file" }),
        "empty appended prompt must omit both append flags: {empty_argv:?}"
    );

    Ok(())
}
