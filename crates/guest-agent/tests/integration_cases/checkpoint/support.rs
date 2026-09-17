use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;
use std::io::{Seek, SeekFrom, Write};

pub(super) const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;
pub(super) const CHECKPOINT_TEST_CANDIDATE_MAX_BYTES: u64 =
    api_contracts::generated::constants::runners::SESSION_HISTORY_GZIP_MIN_BYTES;
pub(super) const CHECKPOINT_TEST_MAX_BYTES: u64 = CHECKPOINT_TEST_CANDIDATE_MAX_BYTES * 2;

pub(super) fn checkpoint_runtime() -> Result<guest_agent::run_context::GuestRuntime, String> {
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
pub(super) struct CheckpointTelemetryGuard<'a> {
    _api: &'a SharedApiMock,
}

impl<'a> CheckpointTelemetryGuard<'a> {
    pub(super) fn new(api: &'a SharedApiMock) -> Self {
        guest_telemetry::telemetry::set_sandbox_ops_log_file(
            shared_guest_paths().sandbox_ops_file(),
        );
        Self { _api: api }
    }
}

impl Drop for CheckpointTelemetryGuard<'_> {
    fn drop(&mut self) {
        guest_telemetry::telemetry::clear_sandbox_ops_log_file();
    }
}

pub(super) fn checkpoint_child_command(
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

pub(super) async fn run_checkpoint_child(
    command: &mut tokio::process::Command,
) -> std::io::Result<()> {
    let output = crate::common::command_output_with_timeout(
        command,
        std::time::Duration::from_secs(30),
        "checkpoint child did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !stdout.contains("test result: ok. 1 passed;") {
        return Err(std::io::Error::other(format!(
            "checkpoint child failed or did not execute exactly one test ({})\nstdout:\n{stdout}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
        )));
    }
    Ok(())
}

pub(super) async fn create_bounded_checkpoint(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> Result<(), guest_agent::error::AgentError> {
    let session_metadata = checkpoint_session_metadata(runtime);
    let checkpoint =
        guest_agent::checkpoint::prepare_checkpoint_for_runtime_with_history_limits_for_test(
            runtime,
            &session_metadata,
            CHECKPOINT_TEST_CANDIDATE_MAX_BYTES,
            CHECKPOINT_TEST_MAX_BYTES,
        )
        .await?;
    report_prepared_checkpoint(runtime, 0, checkpoint).await
}

pub(super) async fn create_bounded_recovery_checkpoint(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> Result<(), guest_agent::error::AgentError> {
    let session_metadata = checkpoint_session_metadata(runtime);
    let checkpoint =
        guest_agent::checkpoint::prepare_recovery_checkpoint_for_runtime_with_history_limits_for_test(
            runtime,
            &session_metadata,
            CHECKPOINT_TEST_CANDIDATE_MAX_BYTES,
            CHECKPOINT_TEST_MAX_BYTES,
        )
        .await?;
    report_prepared_checkpoint(runtime, 1, checkpoint).await
}

pub(super) async fn report_prepared_checkpoint(
    runtime: &guest_agent::run_context::GuestRuntime,
    exit_code: i32,
    checkpoint: guest_agent::checkpoint::PreparedCheckpoint,
) -> Result<(), guest_agent::error::AgentError> {
    guest_agent::complete::report_checkpoint_for_run(
        runtime,
        exit_code,
        None,
        None,
        None,
        &[],
        checkpoint,
    )
    .await
}

pub(super) fn checkpoint_session_metadata(
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

pub(super) fn write_prunable_claude_history(
    runtime: &mut guest_agent::run_context::GuestRuntime,
    session_id: &str,
) -> Result<(tempfile::TempDir, Vec<u8>), String> {
    let boundary_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let summary_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let records = [
        json!({
            "type": "system",
            "subtype": "compact_boundary",
            "sessionId": session_id,
            "uuid": boundary_id,
            "parentUuid": null,
            "logicalParentUuid": "11111111-1111-4111-8111-111111111111",
            "isSidechain": false,
            "version": "2.1.220"
        }),
        json!({
            "type": "user",
            "sessionId": session_id,
            "uuid": summary_id,
            "parentUuid": boundary_id,
            "isCompactSummary": true,
            "message": {"role": "user", "content": "retained summary"}
        }),
    ];
    let mut candidate = Vec::new();
    for record in records {
        let mut line =
            serde_json::to_vec(&record).map_err(|error| format!("encode history: {error}"))?;
        line.push(b'\n');
        candidate.extend_from_slice(&line);
    }

    let history_dir =
        tempfile::tempdir().map_err(|error| format!("create history dir: {error}"))?;
    runtime.config.claude_config_dir = history_dir.path().to_string_lossy().into_owned();
    let history_path = claude_history_path(history_dir.path(), session_id);
    let history_parent = history_path
        .parent()
        .ok_or_else(|| "Claude history has no parent".to_string())?;
    std::fs::create_dir_all(history_parent)
        .map_err(|error| format!("create history parent: {error}"))?;
    let mut history_file =
        std::fs::File::create(&history_path).map_err(|error| format!("create history: {error}"))?;
    history_file
        .set_len(CHECKPOINT_TEST_CANDIDATE_MAX_BYTES + 1)
        .map_err(|error| format!("size history: {error}"))?;
    history_file
        .seek(SeekFrom::End(0))
        .map_err(|error| format!("seek history: {error}"))?;
    history_file
        .write_all(b"\n")
        .and_then(|()| history_file.write_all(&candidate))
        .and_then(|()| history_file.flush())
        .map_err(|error| format!("write history: {error}"))?;

    let session_id_file = session_id_file();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|error| format!("write session id: {error}"))?;
    Ok((history_dir, candidate))
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

pub(super) fn write_prunable_codex_history(
    session_id: &str,
) -> Result<(tempfile::TempDir, std::path::PathBuf, Vec<u8>), String> {
    let history_dir =
        tempfile::tempdir().map_err(|error| format!("create Codex history dir: {error}"))?;
    let day_dir = history_dir
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("07")
        .join("26");
    std::fs::create_dir_all(&day_dir)
        .map_err(|error| format!("create Codex session directory: {error}"))?;
    let history_path = day_dir.join(format!("rollout-{session_id}.jsonl"));

    let line =
        |record_type: &str, payload: serde_json::Value, ordinal: u64| -> Result<Vec<u8>, String> {
            let mut bytes = serde_json::to_vec(&json!({
                "ordinal": ordinal,
                "timestamp": "2026-07-26T00:00:00Z",
                "type": record_type,
                "payload": payload,
            }))
            .map_err(|error| format!("encode Codex history: {error}"))?;
            bytes.push(b'\n');
            Ok(bytes)
        };
    let canonical = line(
        "session_meta",
        json!({
            "id": session_id,
            "session_id": session_id,
            "timestamp": "2026-07-26T00:00:00Z",
            "cwd": guest_agent::paths::CANONICAL_WORKING_DIR,
            "originator": "codex",
            "cli_version": "0.151.0",
            "source": "cli",
            "history_mode": "paginated",
        }),
        0,
    )?;
    let turn_id = "compact-turn";
    let retained_records = [
        line(
            "event_msg",
            json!({
                "type": "task_started",
                "turn_id": turn_id,
                "model_context_window": 258400,
                "collaboration_mode_kind": "default",
            }),
            10,
        )?,
        line(
            "event_msg",
            json!({
                "type": "item_completed",
                "thread_id": session_id,
                "turn_id": turn_id,
                "item": {
                    "type": "UserMessage",
                    "id": "user-message-1",
                    "content": [{
                        "type": "text",
                        "text": "compact this thread",
                        "text_elements": [],
                    }],
                },
                "completed_at_ms": 1_774_678_400_000_i64,
            }),
            11,
        )?,
        line(
            "turn_context",
            json!({
                "turn_id": turn_id,
                "cwd": guest_agent::paths::CANONICAL_WORKING_DIR,
                "approval_policy": {"granular": {"sandbox_approval": true}},
                "sandbox_policy": {"type": "read_only"},
                "model": "gpt-test",
                "summary": "auto",
            }),
            12,
        )?,
        line(
            "compacted",
            json!({
                "message": "retained summary",
                "replacement_history": [{
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": "retained summary",
                    }],
                }],
                "window_number": 1,
                "first_window_id": "019c0000-0000-7000-8000-000000000001",
                "window_id": "019c0000-0000-7000-8000-000000000002",
            }),
            13,
        )?,
        line(
            "world_state",
            json!({"full": true, "state": {"working_directory": "/workspace"}}),
            14,
        )?,
        line(
            "event_msg",
            json!({
                "type": "task_complete",
                "turn_id": turn_id,
                "last_agent_message": "retained summary",
            }),
            15,
        )?,
    ];
    let candidate = std::iter::once(canonical.clone())
        .chain(retained_records.iter().cloned())
        .flatten()
        .collect::<Vec<_>>();

    let mut history_file = std::fs::File::create(&history_path)
        .map_err(|error| format!("create Codex history: {error}"))?;
    history_file
        .write_all(&canonical)
        .map_err(|error| format!("write canonical Codex history: {error}"))?;
    history_file
        .set_len(CHECKPOINT_TEST_MAX_BYTES + 1)
        .map_err(|error| format!("size Codex history: {error}"))?;
    history_file
        .seek(SeekFrom::End(0))
        .and_then(|_| history_file.write_all(b"\n"))
        .and_then(|()| {
            for record in retained_records {
                history_file.write_all(&record)?;
            }
            history_file.flush()
        })
        .map_err(|error| format!("write retained Codex history: {error}"))?;

    let session_id_file = session_id_file();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|error| format!("write Codex session id: {error}"))?;
    Ok((history_dir, history_path, candidate))
}

pub(super) fn write_codex_history_without_compact(
    session_id: &str,
    canonical_target_size: Option<usize>,
    minimum_source_size: usize,
) -> Result<(tempfile::TempDir, std::path::PathBuf, Vec<u8>), String> {
    let history_dir =
        tempfile::tempdir().map_err(|error| format!("create Codex history dir: {error}"))?;
    let day_dir = history_dir
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("08")
        .join("12");
    std::fs::create_dir_all(&day_dir)
        .map_err(|error| format!("create Codex session directory: {error}"))?;
    let history_path = day_dir.join(format!("rollout-{session_id}.jsonl"));

    let canonical_record = |padding: &str| -> Result<Vec<u8>, String> {
        let mut bytes = serde_json::to_vec(&json!({
            "timestamp": "2026-08-12T00:00:00Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "session_id": session_id,
                "timestamp": "2026-08-12T00:00:00Z",
                "cwd": guest_agent::paths::CANONICAL_WORKING_DIR,
                "originator": "codex",
                "cli_version": "0.144.6",
                "source": "cli",
                "history_mode": "legacy",
                "padding": padding,
            },
        }))
        .map_err(|error| format!("encode Codex canonical record: {error}"))?;
        bytes.push(b'\n');
        Ok(bytes)
    };
    let empty_canonical = canonical_record("")?;
    let canonical = if let Some(target_size) = canonical_target_size {
        let padding_size = target_size
            .checked_sub(empty_canonical.len())
            .ok_or_else(|| {
                format!(
                    "canonical target {target_size} is below minimum {}",
                    empty_canonical.len()
                )
            })?;
        let canonical = canonical_record(&"x".repeat(padding_size))?;
        if canonical.len() != target_size {
            return Err(format!(
                "canonical record size mismatch: expected {target_size}, got {}",
                canonical.len()
            ));
        }
        canonical
    } else {
        empty_canonical
    };
    let mut filler = serde_json::to_vec(&json!({
        "timestamp": "2026-08-12T00:00:01Z",
        "type": "world_state",
        "payload": {"full": true, "state": {"working_directory": "/workspace"}},
    }))
    .map_err(|error| format!("encode Codex filler record: {error}"))?;
    filler.push(b'\n');

    let mut history = canonical;
    while history.len() <= minimum_source_size {
        history.extend_from_slice(&filler);
    }
    std::fs::write(&history_path, &history)
        .map_err(|error| format!("write Codex history: {error}"))?;
    let session_id_file = session_id_file();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|error| format!("write Codex session id: {error}"))?;
    Ok((history_dir, history_path, history))
}

pub(super) fn zstd_session_history_for_test(history: &[u8]) -> std::io::Result<Vec<u8>> {
    zstd::stream::encode_all(history, 3)
}

pub(super) fn large_session_history() -> Vec<u8> {
    let line =
        b"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"history\"}}\n";
    let mut history = Vec::with_capacity(LARGE_SESSION_HISTORY_SIZE_BYTES + line.len());
    while history.len() <= LARGE_SESSION_HISTORY_SIZE_BYTES {
        history.extend_from_slice(line);
    }
    history
}

pub(super) fn upload_zstd_validation_response(
    req: &HttpMockRequest,
    expected_body: &[u8],
) -> HttpMockResponse {
    if request_header_absent(req, "authorization")
        && request_header_absent(req, "x-vercel-protection-bypass")
        && req.body_ref() != expected_body
        && zstd::stream::decode_all(req.body_ref()).is_ok_and(|decoded| decoded == expected_body)
    {
        http_status(200)
    } else {
        http_status(400)
    }
}
