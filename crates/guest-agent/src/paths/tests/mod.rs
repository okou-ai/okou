use super::*;

#[test]
fn guest_paths_derives_runtime_files_from_run_dir() {
    let runtime_dir = PathBuf::from("/tmp/vm0-run");
    let paths = GuestPaths::from_runtime_dir(runtime_dir.clone());

    assert_eq!(paths.runtime_dir(), runtime_dir.as_path());
    assert_eq!(
        paths.session_id_file(),
        guest_contracts::runtime_paths::session_id_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.finalization_error_file(),
        guest_contracts::runtime_paths::finalization_error_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.final_session_history_identity_file(),
        guest_contracts::runtime_paths::final_session_history_identity_file(&runtime_dir)
            .to_string_lossy()
    );
    assert_eq!(
        paths.failure_diagnostic_file(),
        guest_contracts::runtime_paths::failure_diagnostic_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.pi_launch_payload_file(),
        guest_contracts::runtime_paths::pi_launch_payload_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.system_log_file(),
        guest_contracts::runtime_paths::system_log_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.agent_log_file(),
        guest_contracts::runtime_paths::agent_log_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.metrics_log_file(),
        guest_contracts::runtime_paths::metrics_log_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.sandbox_ops_file(),
        guest_contracts::runtime_paths::sandbox_ops_log_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.telemetry_system_log_pos_file(),
        guest_contracts::runtime_paths::telemetry_system_log_pos_file(&runtime_dir)
            .to_string_lossy()
    );
    assert_eq!(
        paths.telemetry_metrics_pos_file(),
        guest_contracts::runtime_paths::telemetry_metrics_pos_file(&runtime_dir).to_string_lossy()
    );
    assert_eq!(
        paths.telemetry_sandbox_ops_pos_file(),
        guest_contracts::runtime_paths::telemetry_sandbox_ops_pos_file(&runtime_dir)
            .to_string_lossy()
    );
}

#[test]
fn guest_paths_from_home_uses_default_runtime_layout() {
    let home = PathBuf::from("/home/vm0");
    let paths = GuestPaths::from_home(&home, "run-123").unwrap();
    let expected_runtime =
        guest_contracts::runtime_paths::run_dir_for_home(&home, "run-123").unwrap();

    assert_eq!(paths.runtime_dir(), expected_runtime.as_path());
    assert_eq!(
        paths.agent_log_file(),
        guest_contracts::runtime_paths::agent_log_file(&expected_runtime).to_string_lossy()
    );
}

#[test]
fn guest_paths_from_captured_env_uses_absolute_runtime_dir() {
    let runtime_dir = PathBuf::from("/tmp/vm0-runtime");
    let paths =
        GuestPaths::from_captured_env("ignored/for-override", Some(&runtime_dir), None).unwrap();

    assert_eq!(paths.runtime_dir(), runtime_dir.as_path());
}

#[test]
fn guest_paths_from_captured_env_rejects_relative_runtime_dir() {
    let err = GuestPaths::from_captured_env(
        "run-123",
        Some(Path::new("relative-runtime")),
        Some(Path::new("/home/vm0")),
    )
    .unwrap_err();

    assert_eq!(
        err,
        guest_contracts::runtime_paths::RuntimePathError::InvalidRuntimeDir
    );
}

#[test]
fn guest_paths_from_captured_env_falls_back_to_process_home() {
    let paths =
        GuestPaths::from_captured_env("run-123", None, Some(Path::new("/home/vm0"))).unwrap();
    let expected_runtime =
        guest_contracts::runtime_paths::run_dir_for_home("/home/vm0", "run-123").unwrap();

    assert_eq!(paths.runtime_dir(), expected_runtime.as_path());
}

#[test]
fn guest_paths_from_captured_env_rejects_missing_process_home() {
    let err = GuestPaths::from_captured_env("run-123", None, Some(Path::new(""))).unwrap_err();

    assert_eq!(
        err,
        guest_contracts::runtime_paths::RuntimePathError::MissingHome
    );
}
