//! Failure diagnostics keep session IDs visible while still masking secrets.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use base64::Engine;
use common::SystemLogOverrideGuard;
use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn cli_failure_diagnostic_preserves_session_id_from_same_event()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let session_id = "result-session-id-123";
    let secret = "actual-secret-token-123";
    let prompt = format!(
        "@ECHO@\n{}",
        json!({
            "type": "result",
            "subtype": "error",
            "session_id": session_id,
            "is_error": true,
            "duration_ms": 100,
            "num_turns": 1,
            "result": format!("failed for {session_id} with {secret}"),
            "total_cost_usd": 0,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        })
    );

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);
    let secret_values = base64::engine::general_purpose::STANDARD.encode(secret);
    let masker = SecretMasker::from_raw(&secret_values);
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly")?;

    let failure_diagnostic = cli_result
        .failure_diagnostic
        .as_ref()
        .expect("result event should produce a failure diagnostic");
    assert_eq!(
        failure_diagnostic.message,
        format!("failed for {session_id} with ***")
    );
    assert!(
        failure_diagnostic.message.contains(session_id),
        "failure diagnostic should include session id: {}",
        failure_diagnostic.message
    );
    assert!(
        !failure_diagnostic.message.contains(secret),
        "failure diagnostic leaked secret: {}",
        failure_diagnostic.message
    );

    let system_log = std::fs::read_to_string(&system_log_path)?;
    assert!(
        system_log.contains("Claude JSONL failure result"),
        "system log should include the failure diagnostic log, got: {system_log}"
    );
    assert!(
        system_log.contains(&format!("failed for {session_id} with ***")),
        "system log should keep session id and mask secret, got: {system_log}"
    );
    assert!(
        !system_log.contains(secret),
        "system log leaked secret: {system_log}"
    );

    Ok(())
}
