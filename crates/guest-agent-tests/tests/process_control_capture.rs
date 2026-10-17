//! Canonical process-control bootstrap capture coverage.

#![cfg(unix)]

use guest_agent_tests as common;

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use guest_agent::run_context::GuestRuntime;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_ENDPOINT: &str = "canonical-endpoint-must-not-leak";

#[derive(Clone, Copy)]
enum EnvInput {
    Absent,
    Readable(&'static str),
    NonUnicode,
}

#[derive(Clone, Copy)]
struct SuccessCase {
    name: &'static str,
    canonical: EnvInput,
    expected_endpoint: Option<&'static str>,
}

const SUCCESS_CASES: [SuccessCase; 3] = [
    SuccessCase {
        name: "absent",
        canonical: EnvInput::Absent,
        expected_endpoint: None,
    },
    SuccessCase {
        name: "canonical-empty",
        canonical: EnvInput::Readable(""),
        expected_endpoint: None,
    },
    SuccessCase {
        name: "canonical-present",
        canonical: EnvInput::Readable(CANONICAL_ENDPOINT),
        expected_endpoint: Some(CANONICAL_ENDPOINT),
    },
];

fn apply_input(input: EnvInput) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test starts no threads while configuring or capturing process env.
    unsafe {
        std::env::remove_var(process_control_ipc::CANONICAL_BOOTSTRAP_ENV);
        match input {
            EnvInput::Absent => {}
            EnvInput::Readable(value) => {
                std::env::set_var(process_control_ipc::CANONICAL_BOOTSTRAP_ENV, value);
            }
            EnvInput::NonUnicode => {
                std::env::set_var(
                    process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
                    OsString::from_vec(vec![0xff]),
                );
            }
        }
    }
}

fn configure_case(root: &Path, name: &str, canonical: EnvInput) -> Result<PathBuf, String> {
    let runtime_dir = root.join(format!("{name}-runtime"));
    guest_telemetry::log::clear_system_log_file();
    guest_telemetry::telemetry::clear_sandbox_ops_log_file();
    // SAFETY: the integration binary contains one test and has not started
    // threads while configuring the next startup snapshot.
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(
            guest_contracts::env::RUN_ID_ENV,
            format!("process-control-env-{name}"),
        );
        std::env::set_var("HOME", root.join(format!("{name}-home")));
        std::env::set_var(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
        std::env::set_var("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true");
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload::default(),
        )?;
    }
    apply_input(canonical);
    Ok(runtime_dir)
}

fn read_system_log(runtime_dir: &Path) -> std::io::Result<String> {
    let path = guest_contracts::runtime_paths::system_log_file(runtime_dir);
    match std::fs::read_to_string(path) {
        Ok(log) => Ok(log),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error),
    }
}

fn assert_value_free(text: &str, context: &str) {
    assert!(
        !text.contains(CANONICAL_ENDPOINT),
        "{context} exposed process-control endpoint material"
    );
}

#[test]
fn startup_preserves_canonical_process_control_semantics_without_value_leaks() -> TestResult {
    assert_eq!(
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        "OKOU_PROCESS_CONTROL_ENDPOINT"
    );
    let tmp = tempfile::tempdir()?;

    for case in SUCCESS_CASES {
        let runtime_dir = configure_case(tmp.path(), case.name, case.canonical)?;
        let runtime = GuestRuntime::from_process_env().map_err(std::io::Error::other)?;
        assert_eq!(
            runtime.process_control_endpoint.as_deref(),
            case.expected_endpoint,
            "{} resolved the wrong endpoint",
            case.name
        );
        assert!(
            runtime.workload_containment.is_none(),
            "{} unexpectedly initialized workload containment",
            case.name
        );
        assert_value_free(&read_system_log(&runtime_dir)?, case.name);
    }

    configure_case(tmp.path(), "canonical-non-unicode", EnvInput::NonUnicode)?;
    let error = match GuestRuntime::from_process_env() {
        Ok(_) => return Err("canonical-non-unicode accepted a non-Unicode value".into()),
        Err(error) => error,
    };
    assert_eq!(
        error,
        format!(
            "{} must be valid UTF-8",
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV
        )
    );
    assert_value_free(&error, "canonical-non-unicode");

    // SAFETY: the single test has not started threads and is finished reading
    // the process environment.
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
    }
    Ok(())
}
