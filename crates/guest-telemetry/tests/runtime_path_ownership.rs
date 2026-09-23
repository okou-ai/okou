use guest_telemetry::log::{clear_system_log_file, emit, set_system_log_file};
use guest_telemetry::telemetry::{
    clear_sandbox_ops_log_file, record_sandbox_op, set_sandbox_ops_log_file,
};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const LOG_MESSAGE: &str = "run-id destination probe";
const OPERATION: &str = "run_id_destination_probe";

#[test]
fn run_id_does_not_select_telemetry_destinations() {
    for install_destinations in [false, true] {
        let dir = tempfile::tempdir().expect("create isolated runtime directory");
        let home = dir.path().join("home");
        let runtime_override = dir.path().join("runtime-override");
        let explicit = dir.path().join("explicit");
        std::fs::create_dir(&home).expect("create isolated home");

        let output = Command::new(std::env::current_exe().expect("resolve current test binary"))
            .args(["--exact", "telemetry_child", "--ignored", "--nocapture"])
            .current_dir(&home)
            .env("HOME", &home)
            .env("TMPDIR", dir.path())
            .env("OKOU_RUN_ID", "conflicting-run-id")
            .env("OKOU_GUEST_RUNTIME_DIR", &runtime_override)
            .env("TEST_EXPLICIT_DESTINATIONS", &explicit)
            .env(
                "TEST_INSTALL_DESTINATIONS",
                if install_destinations { "1" } else { "0" },
            )
            .output()
            .expect("run isolated guest telemetry test");

        let stderr = String::from_utf8(output.stderr).expect("decode child stderr");
        assert!(
            output.status.success(),
            "child failed with {} (installed={install_destinations}):\n{stderr}",
            output.status,
        );
        assert!(
            stderr.lines().any(|line| line.contains(&format!(
                "] [INFO] [sandbox:guest-telemetry-test] {LOG_MESSAGE}"
            ))),
            "structured log missing from stderr (installed={install_destinations}): {stderr:?}"
        );
        assert!(
            !stderr.contains("failed to append system log"),
            "system log unexpectedly failed (installed={install_destinations}): {stderr:?}"
        );

        assert!(
            std::fs::read_dir(&home)
                .expect("read isolated home")
                .next()
                .is_none(),
            "run ID created files under HOME (installed={install_destinations})"
        );
        assert!(
            !runtime_override.exists(),
            "run ID created the canonical runtime directory (installed={install_destinations})"
        );

        let system_log = explicit.join("system.log");
        let sandbox_ops = explicit.join("sandbox-ops.jsonl");
        if install_destinations {
            let content = std::fs::read_to_string(system_log).expect("read explicit system log");
            assert!(
                content.contains(&format!(
                    "] [INFO] [sandbox:guest-telemetry-test] {LOG_MESSAGE}\n"
                )),
                "explicit system log lacks emitted record: {content:?}"
            );

            let content =
                std::fs::read_to_string(sandbox_ops).expect("read explicit sandbox-ops log");
            let record: serde_json::Value =
                serde_json::from_str(content.trim_end()).expect("parse sandbox-ops JSONL");
            assert_eq!(record["action_type"], OPERATION);
            assert_eq!(record["duration_ms"], 23);
            assert_eq!(record["success"], true);
        } else {
            assert!(
                !explicit.exists(),
                "unconfigured telemetry created explicit destinations"
            );
        }
    }
}

#[test]
#[ignore = "run through the process-isolated parent test"]
fn telemetry_child() {
    clear_system_log_file();
    clear_sandbox_ops_log_file();

    if std::env::var_os("TEST_INSTALL_DESTINATIONS").as_deref() == Some(std::ffi::OsStr::new("1")) {
        let explicit = PathBuf::from(
            std::env::var_os("TEST_EXPLICIT_DESTINATIONS")
                .expect("explicit destination directory is set"),
        );
        set_system_log_file(explicit.join("system.log"));
        set_sandbox_ops_log_file(explicit.join("sandbox-ops.jsonl"));
    }

    emit(
        "INFO",
        "sandbox:guest-telemetry-test",
        format_args!("{LOG_MESSAGE}"),
    );
    record_sandbox_op(OPERATION, Duration::from_millis(23), true, None);

    clear_system_log_file();
    clear_sandbox_ops_log_file();
}
