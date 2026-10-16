use crate::support::*;

pub(super) fn finalization_runtime() -> Result<guest_agent::run_context::GuestRuntime, String> {
    Ok(guest_agent::run_context::GuestRuntime {
        config: shared_guest_config()?,
        paths: shared_guest_paths(),
        http: http_client!(),
        workload_containment: None,
        process_control_endpoint: None,
    })
}

// The shared API fixture owns both these files and the producer lock. Clear
// the process-global sink before that fixture cleans its files or unlocks.
pub(super) struct FinalizationTelemetryGuard<'a> {
    _api: &'a SharedApiMock,
}

impl<'a> FinalizationTelemetryGuard<'a> {
    pub(super) fn new(api: &'a SharedApiMock) -> Self {
        guest_telemetry::telemetry::set_sandbox_ops_log_file(
            shared_guest_paths().sandbox_ops_file(),
        );
        Self { _api: api }
    }
}

impl Drop for FinalizationTelemetryGuard<'_> {
    fn drop(&mut self) {
        guest_telemetry::telemetry::clear_sandbox_ops_log_file();
    }
}

pub(super) fn finalization_child_command(
    test_name: &str,
) -> std::io::Result<tokio::process::Command> {
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    command
        .args(["--exact", test_name, "--ignored", "--nocapture"])
        .env_clear();
    if let Some(profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", profile_file);
    }
    Ok(command)
}

pub(super) async fn run_finalization_child(
    command: &mut tokio::process::Command,
) -> std::io::Result<()> {
    let output = crate::common::command_output_with_timeout(
        command,
        std::time::Duration::from_secs(30),
        "finalization child did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !stdout.contains("test result: ok. 1 passed;") {
        return Err(std::io::Error::other(format!(
            "finalization child failed or did not execute exactly one test ({})\nstdout:\n{stdout}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
        )));
    }
    Ok(())
}

pub(super) async fn create_native_finalization(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> Result<(), guest_agent::error::AgentError> {
    let metadata = finalization_session_metadata(runtime);
    let prepared =
        guest_agent::finalization::prepare_finalization_for_runtime(runtime, &metadata).await?;
    report_prepared_finalization(runtime, 0, prepared).await
}

pub(super) async fn create_native_recovery_finalization(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> Result<(), guest_agent::error::AgentError> {
    let metadata = finalization_session_metadata(runtime);
    let prepared =
        guest_agent::finalization::prepare_recovery_finalization_for_runtime(runtime, &metadata)
            .await?;
    report_prepared_finalization(runtime, 1, prepared).await
}

pub(super) async fn report_prepared_finalization(
    runtime: &guest_agent::run_context::GuestRuntime,
    exit_code: i32,
    finalization: guest_agent::finalization::PreparedFinalization,
) -> Result<(), guest_agent::error::AgentError> {
    guest_agent::complete::report_finalization_for_run(
        runtime,
        exit_code,
        None,
        None,
        None,
        finalization,
    )
    .await
}

pub(super) fn finalization_session_metadata(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> guest_agent::session_metadata::CapturedSessionMetadata {
    let session_id = std::fs::read_to_string(runtime.paths.session_id_file())
        .unwrap_or_default()
        .trim()
        .to_string();
    let source = match runtime.config.framework {
        guest_agent::env::Framework::ClaudeCode => Some(
            guest_contracts::session_history_identity::SessionHistorySourceRef::ClaudeCode {
                config_dir: runtime.config.claude_config_dir.clone(),
                working_dir: guest_agent::paths::CANONICAL_WORKING_DIR.to_string(),
                session_id: session_id.clone(),
            },
        ),
        guest_agent::env::Framework::Codex => Some(
            guest_contracts::session_history_identity::SessionHistorySourceRef::Codex {
                sessions_dir: std::path::Path::new(&runtime.config.codex_home_dir)
                    .join("sessions")
                    .to_string_lossy()
                    .into_owned(),
                thread_id: session_id.clone(),
            },
        ),
        guest_agent::env::Framework::Pi => Some(
            guest_contracts::session_history_identity::SessionHistorySourceRef::Pi {
                session_path: format!(
                    "{}/restored-{session_id}.jsonl",
                    api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
                ),
                session_id: session_id.clone(),
            },
        ),
    };
    guest_agent::session_metadata::CapturedSessionMetadata::for_test(session_id, source)
}

pub(super) fn use_test_codex_home(
    runtime: &mut guest_agent::run_context::GuestRuntime,
    parent: &std::path::Path,
) {
    runtime.config.codex_home_dir = parent.join(".codex").to_string_lossy().into_owned();
}

pub(super) fn session_id_file() -> String {
    shared_guest_paths().session_id_file().to_string()
}

pub(super) fn write_literal_session_history(
    runtime: &mut guest_agent::run_context::GuestRuntime,
    session_id: &str,
    history: &[u8],
) -> Result<tempfile::TempDir, String> {
    let session_id_file = session_id_file();
    let dir = tempfile::tempdir().map_err(|e| format!("create temp history dir: {e}"))?;
    runtime.config.claude_config_dir = dir.path().to_string_lossy().into_owned();
    let history_path = claude_history_path(dir.path(), session_id);
    let history_parent = history_path
        .parent()
        .ok_or_else(|| "Claude history has no parent".to_string())?;
    std::fs::create_dir_all(history_parent)
        .map_err(|e| format!("create history directory: {e}"))?;
    std::fs::write(&history_path, history)
        .map_err(|e| format!("write history {}: {e}", history_path.display()))?;
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|e| format!("write session id: {e}"))?;
    Ok(dir)
}

pub(super) fn claude_history_path(
    config_dir: &std::path::Path,
    session_id: &str,
) -> std::path::PathBuf {
    config_dir
        .join("projects")
        .join("-home-user-workspace")
        .join(format!("{session_id}.jsonl"))
}
