//! An oversized Pi stdout record must end the run only when the projection
//! actually consumes it.
//!
//! `agent_end` carries the agent loop's messages, which the RPC wire already
//! delivered individually as `message_end`, so the Pi projection ignores it and
//! `agent_settled` owns the terminal result. An over-limit `agent_end` is
//! therefore discarded and the run still settles. Every record the projection
//! does consume stays fatal, because discarding one would silently drop a
//! structured record instead of failing loudly.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

/// Padding that pushes one record past the ordinary stdout line limit.
const OVERSIZED_PADDING_BYTES: usize = ORDINARY_CLI_STDOUT_MAX_LINE_BYTES + 1024 * 1024;

/// A settled assistant turn, so `agent_settled` has a terminal result to own.
const ASSISTANT_RECORD: &str = r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"settled"}],"model":"test-model","responseId":"response-1","usage":{},"stopReason":"stop","timestamp":1}}"#;

/// Build one over-limit record whose own `type` leads the serialization.
///
/// The bounded prefix scan that names a failing record reads the leading
/// `type`, so it must come first for both shapes here, exactly as the official
/// serializer emits them.
enum OversizedRecordType {
    AgentEnd,
    MessageEnd,
}

fn oversized_record(record_type: OversizedRecordType) -> String {
    let padding = "x".repeat(OVERSIZED_PADDING_BYTES);
    let record = match record_type {
        OversizedRecordType::AgentEnd => format!(
            r#"{{"type":"agent_end","messages":[{{"role":"assistant","content":[{{"type":"text","text":"{padding}"}}]}}],"willRetry":false}}"#
        ),
        OversizedRecordType::MessageEnd => format!(
            r#"{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"{padding}"}}],"model":"test-model","responseId":"response-oversized","usage":{{}},"stopReason":"stop","timestamp":1}}}}"#
        ),
    };
    assert!(
        record.len() > ORDINARY_CLI_STDOUT_MAX_LINE_BYTES,
        "fixture record must exceed the stdout line limit"
    );
    record
}

struct OversizedCase<'a> {
    run_id: &'a str,
    /// Records emitted before `agent_settled`, in order, one per stdout line.
    records: &'a [String],
}

async fn run_oversized_case(
    case: OversizedCase<'_>,
    base_path: &OsStr,
    original_directory: &Path,
) -> Result<guest_agent::cli::CliExecutionResult, Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let event_path = tmp.path().join("pi-events.jsonl");
    std::fs::write(
        &event_path,
        case.records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>(),
    )?;

    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":1,"ownershipTransferMode":"pending-tool-continuation"}'
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"11111111-1111-4111-8111-111111111111\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}"
cat "$PI_EVENT_PATH"
printf '%s\n' '{"type":"agent_settled"}'
if IFS= read -r unexpected; then
  exit 23
fi
"#,
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), case.run_id)?;
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, case.run_id);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        );
        std::env::set_var("HOME", tmp.path());
        let mut paths = vec![bin_dir];
        paths.extend(std::env::split_paths(base_path));
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "verify oversized Pi record handling".to_string(),
                pi_launch_config:
                    r#"{"schemaVersion":2,"apiFirstTurn":{"sandboxEventSequenceStart":1}}"#
                        .to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111111".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([
                (
                    "CLI_PKG_URL".to_string(),
                    "https://example.invalid/current-okou-cli.tgz".to_string(),
                ),
                (
                    "PI_EVENT_PATH".to_string(),
                    event_path.to_string_lossy().into_owned(),
                ),
            ]),
        )?;
    }
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(tmp.path())?;

    let runtime = common::guest_runtime_from_process_env()?;
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "Pi CLI process timed out"))??;
    std::env::set_current_dir(original_directory)?;
    Ok(result)
}

#[tokio::test]
async fn oversized_pi_records_end_the_run_only_when_the_projection_consumes_them()
-> Result<(), Box<dyn std::error::Error>> {
    let base_path = std::env::var_os("PATH").ok_or("PATH must be set")?;
    let original_directory = std::env::current_dir()?;

    // An oversized `agent_end` is discarded, so the run reaches `agent_settled`
    // and settles normally. This is the regression this file exists for: a
    // completed run must not be lost to a record the projection never reads.
    let settled = run_oversized_case(
        OversizedCase {
            run_id: "00000000-0000-4000-8000-0000000001a1",
            records: &[
                ASSISTANT_RECORD.to_string(),
                oversized_record(OversizedRecordType::AgentEnd),
            ],
        },
        &base_path,
        &original_directory,
    )
    .await?;

    assert!(
        settled.control_error.is_none(),
        "a discarded record must not fail the run: {:?}",
        settled.control_error.map(|error| error.to_string())
    );
    assert!(
        settled
            .cli_termination
            .as_ref()
            .is_none_or(|termination| termination.reason != CliTerminationReason::StdoutIngestion),
        "a discarded record must not terminate stdout ingestion: {:?}",
        settled.cli_termination
    );
    assert_eq!(settled.exit_code, 0);
    assert_eq!(
        settled.jsonl_result.as_ref().map(|summary| summary.status),
        Some(guest_agent::cli::JsonlResultStatus::Success),
        "the terminal result must still come from agent_settled"
    );

    // A record the projection does consume stays fatal, and the failure names
    // the record without exposing its content.
    let failed = run_oversized_case(
        OversizedCase {
            run_id: "00000000-0000-4000-8000-0000000001a2",
            records: &[oversized_record(OversizedRecordType::MessageEnd)],
        },
        &base_path,
        &original_directory,
    )
    .await?;

    let error = failed
        .control_error
        .expect("an oversized consumed record must fail the run")
        .to_string();
    assert!(
        error.contains(&format!(
            "CLI stdout line exceeded {ORDINARY_CLI_STDOUT_MAX_LINE_BYTES} bytes"
        )) && error.contains("event_type=message_end"),
        "unexpected oversized record failure: {error}"
    );
    assert!(
        !error.contains("xxxx") && error.len() < 256,
        "record content must not reach the failure: {error}"
    );
    assert_eq!(
        failed.cli_termination.map(|termination| termination.reason),
        Some(CliTerminationReason::StdoutIngestion)
    );

    Ok(())
}
