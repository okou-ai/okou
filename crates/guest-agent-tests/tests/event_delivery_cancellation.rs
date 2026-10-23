//! Cancelling the CLI owner during final draining retires its upload worker.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;

#[tokio::test]
async fn dropping_execution_during_drain_closes_active_upload()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let api_url = format!("http://{}", listener.local_addr()?);
    let prompt = format!(
        "@ECHO@\n{}",
        json!({"type":"result","marker":"cancel-delivery"})
    );
    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var(guest_contracts::env::CANONICAL_API_URL_ENV, &api_url);
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
    let (mut upload, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept()).await??;
    let mut request_started = [0u8; 1];
    tokio::time::timeout(
        Duration::from_secs(5),
        upload.read_exact(&mut request_started),
    )
    .await??;
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
    // Keep the peer open without replying. EOF proves cancellation retired the
    // active upload, without advancing virtual time through real socket I/O.
    tokio::time::timeout(
        Duration::from_secs(5),
        tokio::io::copy(&mut upload, &mut tokio::io::sink()),
    )
    .await
    .expect("dropping the owner must close the active upload before its HTTP timeout")?;
    Ok(())
}
