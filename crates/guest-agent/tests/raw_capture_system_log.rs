//! Raw process-env capture must leave system-log installation to runtime bootstrap.
//!
//! Keep this contract in a single-test binary to exclusively own process env
//! and the process-global logger.

use guest_agent::env::GuestConfigRaw;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn raw_capture_does_not_install_system_log_sink() -> TestResult {
    let tmp = tempfile::tempdir()?;
    // SAFETY: this binary contains exactly one synchronous test, and it does
    // not start background threads while configuring or capturing process env.
    unsafe {
        std::env::set_var(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            tmp.path(),
        );
    }
    guest_telemetry::log::clear_system_log_file();

    let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;
    let runtime_dir = raw
        .guest_runtime_dir
        .ok_or_else(|| std::io::Error::other("raw capture lost the canonical runtime directory"))?;
    assert_eq!(runtime_dir, tmp.path());
    let log_path = guest_contracts::runtime_paths::system_log_file(&runtime_dir);

    // Installing a sink opens it lazily, so emit before checking the actual path.
    guest_telemetry::log_info!("sandbox:guest-agent-test", "raw capture system log marker");
    assert!(
        !log_path.try_exists()?,
        "raw capture routed subsequent logs into the canonical runtime sink"
    );

    // Prove absence above was not caused by a path the logger could not write.
    guest_telemetry::log::set_system_log_file(&log_path);
    guest_telemetry::log_info!(
        "sandbox:guest-agent-test",
        "explicit installation system log control"
    );
    guest_telemetry::log::clear_system_log_file();
    let content = std::fs::read_to_string(&log_path)?;
    assert!(content.contains("explicit installation system log control"));
    Ok(())
}
