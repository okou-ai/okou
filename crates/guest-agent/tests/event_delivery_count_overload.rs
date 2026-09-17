//! Claude Code event delivery must fail without blocking stdout when the
//! bounded delivery queue fills behind a stalled event endpoint.
//!
//! Configure the test child's environment and working directory before spawn.

mod common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;
use tokio::process::Command;

const RUN_ID: &str = "event-delivery-count-overload-test";
const CHILD_COMPLETE: &str = "Claude count-overload assertions passed";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn claude_code_event_delivery_count_overload_terminates_promptly()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();
    let mut prompt_lines = vec!["@ECHO-HANG@".to_string()];
    prompt_lines
        .extend((0..640).map(|index| json!({ "type": "assistant", "index": index }).to_string()));
    let prompt = prompt_lines.join("\n");

    let stalled_events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200).delay(Duration::from_secs(30));
    });

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), RUN_ID)?;
    let payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt,
            ..Default::default()
        },
    )?;
    common::ensure_canonical_workspace_for_test()?;

    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "claude_code_event_delivery_count_overload_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "claude-code")
        .env(guest_contracts::env::USE_MOCK_CLAUDE_ENV, "true")
        .env(
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            mock_cli,
        )
        .env(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "1",
        )
        .env(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "1",
        )
        .env(
            guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "60",
        )
        .env(guest_contracts::env::RUN_ID_ENV, RUN_ID)
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            server.base_url(),
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        )
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            payload_path,
        )
        .env("HOME", tmp.path())
        .env("OKOU_TEST_CLAUDE_CONFIG_DIR", tmp.path().join(".claude"))
        .env("PATH", "/usr/bin:/bin")
        .current_dir(tmp.path());
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }

    // Clean up the child's session, including CLI descendants, before releasing
    // the mock server and temporary files on success, failure, or timeout.
    let output = common::command_output_with_timeout(
        &mut command,
        Duration::from_secs(15),
        "count-overload child test did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "count-overload child failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains(CHILD_COMPLETE),
        "count-overload child did not complete its assertions; stdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        stalled_events.calls() <= 1,
        "the serial sender should have at most one stalled request in flight"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
#[ignore = "spawned with isolated startup inputs by the count-overload parent test"]
async fn claude_code_event_delivery_count_overload_child() -> Result<(), Box<dyn std::error::Error>>
{
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let masker = SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("delivery overload should not wait for the stalled event request");

    let result = execution.expect("the live CLI should use controlled delivery termination");
    let error = result
        .control_error
        .expect("count overload should be exposed as a control error")
        .to_string();
    assert!(
        error.contains("event delivery queue exceeded 512 pending events"),
        "unexpected overload error: {error}"
    );
    assert_eq!(result.last_event_sequence, None);
    assert_eq!(
        result
            .cli_termination
            .expect("delivery overload should record process-group termination")
            .reason,
        guest_contracts::diagnostics::CliTerminationReason::EventDelivery
    );
    println!("{CHILD_COMPLETE}");

    Ok(())
}
