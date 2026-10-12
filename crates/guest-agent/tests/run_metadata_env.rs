//! Canonical run-metadata bootstrap values are captured at the process-env boundary.

use std::ffi::OsStr;
use std::path::Path;

use guest_agent::env::GuestConfigRaw;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy)]
struct RunMetadataEnvSpec {
    canonical: &'static str,
    value: fn(&GuestConfigRaw) -> &str,
}

const RUN_METADATA_ENV_SPECS: [RunMetadataEnvSpec; 5] = [
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
        value: |raw| &raw.sandbox_id,
    },
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
        value: |raw| &raw.sandbox_reuse_result,
    },
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_HOME_REUSE_RESULT_ENV,
        value: |raw| &raw.home_reuse_result,
    },
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
        value: |raw| &raw.resume_session_id,
    },
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_API_START_TIME_ENV,
        value: |raw| &raw.api_start_time,
    },
];

fn set_test_env(key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test does not start threads while configuring or capturing process env.
    unsafe {
        std::env::set_var(key, value);
    }
}

fn remove_test_env(key: impl AsRef<OsStr>) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test does not start threads while configuring or capturing process env.
    unsafe {
        std::env::remove_var(key);
    }
}

fn clear_run_metadata_env() {
    for spec in RUN_METADATA_ENV_SPECS {
        remove_test_env(spec.canonical);
    }
}

fn capture_raw(log_path: &Path) -> TestResult<GuestConfigRaw> {
    guest_telemetry::log::clear_system_log_file();
    let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;
    assert!(
        !log_path.exists(),
        "raw capture installed or wrote a system-log sink"
    );
    Ok(raw)
}

fn assert_canonical_capture_behaviors(
    tmp: &Path,
    index: usize,
    spec: RunMetadataEnvSpec,
) -> TestResult {
    clear_run_metadata_env();
    let raw = capture_raw(&tmp.join(format!("{index}-absent.log")))?;
    assert_eq!((spec.value)(&raw), "");

    set_test_env(spec.canonical, "");
    let raw = capture_raw(&tmp.join(format!("{index}-canonical-empty.log")))?;
    assert_eq!((spec.value)(&raw), "");

    let canonical_value = format!("canonical-value-值-{index}");
    clear_run_metadata_env();
    set_test_env(spec.canonical, &canonical_value);
    let raw = capture_raw(&tmp.join(format!("{index}-canonical.log")))?;
    assert_eq!((spec.value)(&raw), canonical_value);
    Ok(())
}

#[cfg(unix)]
fn assert_non_unicode_behaviors(tmp: &Path, index: usize, spec: RunMetadataEnvSpec) -> TestResult {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    clear_run_metadata_env();
    set_test_env(spec.canonical, OsString::from_vec(vec![0xff]));
    let raw = capture_raw(&tmp.join(format!("{index}-canonical-non-unicode.log")))?;
    assert_eq!((spec.value)(&raw), "");
    Ok(())
}

fn assert_guest_config_uses_canonical_values(tmp: &Path) -> TestResult {
    clear_run_metadata_env();
    let runtime_dir = tmp.join("canonical-config-runtime");
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)?;
    std::fs::write(
        &payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;

    let values = [
        "shared-sandbox-id",
        "reused",
        "sandboxReused",
        "resume-session-id",
        "1700000000000",
    ];
    set_test_env(guest_contracts::env::RUN_ID_ENV, "canonical-config-run");
    set_test_env("HOME", tmp.join("home"));
    set_test_env(
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        &runtime_dir,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &payload_path,
    );
    remove_test_env(guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV);
    for (spec, value) in RUN_METADATA_ENV_SPECS.into_iter().zip(values) {
        set_test_env(spec.canonical, value);
    }

    let raw = capture_raw(&tmp.join("canonical-config.log"))?;
    let config = guest_agent::env::GuestConfig::from_raw(raw).map_err(std::io::Error::other)?;

    assert_eq!(config.sandbox_id, values[0]);
    assert_eq!(config.sandbox_reuse_result, values[1]);
    assert_eq!(config.home_reuse_result, values[2]);
    assert_eq!(config.resume_session_id, values[3]);
    assert_eq!(config.api_start_time, values[4]);

    clear_run_metadata_env();
    Ok(())
}

#[test]
fn process_env_preserves_canonical_run_metadata() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for (index, spec) in RUN_METADATA_ENV_SPECS.into_iter().enumerate() {
        assert_canonical_capture_behaviors(tmp.path(), index, spec)?;
        #[cfg(unix)]
        assert_non_unicode_behaviors(tmp.path(), index, spec)?;
    }

    assert_guest_config_uses_canonical_values(tmp.path())
}
