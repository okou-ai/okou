//! Production startup should persist post-path bootstrap failures to the run log.

use crate::common;

use std::process::Command;

#[test]
fn runtime_bootstrap_logs_missing_api_url_to_system_log() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "missing api url prompt".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_guest-agent"))
        .env_clear()
        .env(
            guest_contracts::env::RUN_ID_ENV,
            "guest-runtime-missing-api-url",
        )
        .env("HOME", tmp.path().join("home"))
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            run_payload_file,
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
        .env(guest_contracts::env::CANONICAL_API_URL_ENV, "")
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(1),
        "missing API URL should fail startup; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("Fatal:"),
        "stderr should be fatal: {stderr}"
    );
    assert!(
        stderr.contains(guest_contracts::env::CANONICAL_API_URL_ENV),
        "stderr should identify {}, got: {stderr}",
        guest_contracts::env::CANONICAL_API_URL_ENV
    );

    let system_log_path = guest_contracts::runtime_paths::system_log_file(&runtime_dir);
    let system_log = std::fs::read_to_string(system_log_path).unwrap();
    assert!(
        system_log.contains("Fatal:"),
        "system log should contain the fatal bootstrap diagnostic: {system_log}"
    );
    assert!(
        system_log.contains(guest_contracts::env::CANONICAL_API_URL_ENV),
        "system log should identify {}, got: {system_log}",
        guest_contracts::env::CANONICAL_API_URL_ENV
    );
}
