use guest_agent::masker::SecretMasker;
use std::collections::HashMap;
use std::time::Duration;

use crate::{codex_app_server_startup_policy, common};

pub struct CodexAppServerStartupCase {
    pub run_id: &'static str,
    pub user_env: HashMap<String, String>,
    pub expect_fast_mode: bool,
}

pub async fn assert_codex_app_server_startup_case(
    case: CodexAppServerStartupCase,
) -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let argv_path = tmp.path().join("codex-argv");
    let recording_mock =
        codex_app_server_startup_policy::recording_codex(tmp.path(), &mock, &argv_path)?;

    unsafe {
        common::setup_codex_app_server_env(
            &recording_mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: case.run_id,
                prompt: "verify Codex app-server startup configuration",
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), case.run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        common::set_user_env_file_env_for_test(&runtime_dir, &case.user_env)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .map_err(|_| std::io::Error::other("Codex app-server execution timed out"))??;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.failure_diagnostic.is_none());
    codex_app_server_startup_policy::assert_startup_policy(&argv_path, case.expect_fast_mode)?;
    Ok(())
}
