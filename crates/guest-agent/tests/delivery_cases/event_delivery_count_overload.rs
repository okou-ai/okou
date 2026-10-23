//! Claude Code retains the newest events without blocking stdout when its queue fills.
//!
//! Configure the test child's environment and working directory before spawn.

use crate::common;

use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::time::Duration;
use tokio::process::Command;

const RUN_ID: &str = "event-delivery-count-overload-test";
const CHILD_COMPLETE: &str = "Claude count-overload assertions passed";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn claude_code_event_delivery_count_overload_keeps_recent_events()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let mut prompt_lines = vec!["@ECHO@".to_string()];
    prompt_lines
        .extend((0..640).map(|index| json!({ "type": "assistant", "index": index }).to_string()));
    prompt_lines.push(json!({ "type": "result", "marker": "count-overload-finished" }).to_string());
    let prompt = prompt_lines.join("\n");

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
            "delivery_cases::event_delivery_count_overload::claude_code_event_delivery_count_overload_child",
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
            &server.base_url,
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
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
    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    let delivery = async {
        let first = server.next_request(Duration::from_secs(5)).await?;
        common::wait_for_file_contains(
            std::path::Path::new(paths.agent_log_file()),
            "count-overload-finished",
            Duration::from_secs(5),
        )
        .await?;
        let mut delivered = common::event_request_sequences(&first.request)?;
        first.respond(200)?;
        while delivered.last() != Some(&640) {
            let request = server.next_request(Duration::from_secs(5)).await?;
            delivered.extend(common::event_request_sequences(&request.request)?);
            request.respond(200)?;
        }
        Ok::<_, Box<dyn std::error::Error>>(delivered)
    };
    let (output, delivered) = tokio::join!(
        common::command_output_with_timeout(
            &mut command,
            Duration::from_secs(15),
            "count-overload child test did not finish",
        ),
        delivery,
    );
    let output = output?;
    let delivered = delivered?;
    assert_eq!(
        delivered
            .iter()
            .copied()
            .filter(|sequence| *sequence >= 129)
            .collect::<Vec<_>>(),
        (129..=640).collect::<Vec<_>>(),
        "the newest 512 events should survive a stalled upload"
    );
    assert!(delivered.len() < 641);
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
    .expect("delivery should finish after the pending requests are acknowledged");

    let result = execution?;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert!(
        result
            .last_event_sequence
            .is_none_or(|sequence| sequence < 640)
    );
    println!("{CHILD_COMPLETE}");

    Ok(())
}
