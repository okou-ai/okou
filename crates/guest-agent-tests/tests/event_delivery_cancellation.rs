//! Cancelling the CLI owner during final draining retires its upload worker.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn dropping_execution_during_drain_stops_event_retries()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let prompt = format!(
        "@ECHO@\n{}",
        json!({"type":"result","marker":"cancel-delivery"})
    );
    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let system_log = tmp.path().join("system.log");
    let _log = common::SystemLogOverrideGuard::set(&system_log);
    let execution = tokio::spawn(async move {
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        )
        .await
    });
    let stalled = server.next_request(Duration::from_secs(5)).await?;
    common::wait_for_file_contains(
        &system_log,
        "Event delivery drain started:",
        Duration::from_secs(5),
    )
    .await?;
    execution.abort();
    assert!(
        execution
            .await
            .expect_err("aborted execution should join as cancelled")
            .is_cancelled()
    );
    drop(stalled);
    tokio::time::pause();
    for _ in 0..150 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(
        server.request_count(),
        1,
        "dropping the owner must stop later requests"
    );
    Ok(())
}
