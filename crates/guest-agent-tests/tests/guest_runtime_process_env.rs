//! Production runtime bootstrap should install explicit guest-telemetry paths.
//!
//! This test lives in its own binary to isolate process env captured by
//! `GuestRuntime::from_process_env`.

use guest_agent_tests as common;

use std::time::Duration;

#[test]
fn runtime_bootstrap_scrubs_runner_env_and_installs_explicit_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");

    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(
            guest_contracts::env::RUN_ID_ENV,
            "guest-runtime-process-env",
        );
        std::env::set_var("HOME", tmp.path().join("home"));
        std::env::set_var(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "");
    }

    let missing_payload_error = match guest_agent::run_context::GuestRuntime::from_process_env() {
        Ok(_) => panic!("missing run payload file should fail fast"),
        Err(error) => error,
    };
    assert!(
        missing_payload_error.contains(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV),
        "error should identify {}, got: {missing_payload_error}",
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV
    );

    unsafe {
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "runtime process env prompt".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )
        .unwrap();
    }
    guest_telemetry::log::clear_system_log_file();
    guest_telemetry::telemetry::clear_sandbox_ops_log_file();

    let runtime = guest_agent::run_context::GuestRuntime::from_process_env().unwrap();

    assert!(runtime.workload_containment.is_none());
    assert_eq!(runtime.paths.runtime_dir(), runtime_dir.as_path());

    guest_telemetry::log_info!(
        "sandbox:guest-agent-test",
        "runtime bootstrap system log marker"
    );
    guest_telemetry::telemetry::record_sandbox_op(
        "runtime_bootstrap_sandbox_op",
        Duration::from_millis(7),
        true,
        None,
    );

    let system_log = std::fs::read_to_string(runtime.paths.system_log_file()).unwrap();
    assert!(system_log.contains("runtime bootstrap system log marker"));

    let sandbox_ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file()).unwrap();
    assert!(sandbox_ops.contains("runtime_bootstrap_sandbox_op"));
}
