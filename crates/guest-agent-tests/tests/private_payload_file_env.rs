//! Canonical private payload pointers are captured before destructive file loading.

#![cfg(unix)]

use guest_agent_tests as common;

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use guest_agent::env::{GuestConfig, GuestConfigRaw};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_POINTER: &str = "/private/canonical-pointer";

#[derive(Clone, Copy)]
struct PrivateFileEnv {
    canonical: &'static str,
    value: fn(&GuestConfigRaw) -> &str,
}

const PRIVATE_FILE_ENVS: [PrivateFileEnv; 2] = [
    PrivateFileEnv {
        canonical: guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        value: |raw| &raw.user_env_file,
    },
    PrivateFileEnv {
        canonical: guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        value: |raw| &raw.run_payload_file,
    },
];

#[derive(Clone, Copy)]
enum CanonicalInput {
    Absent,
    Readable(&'static str),
    NonUnicode,
}

#[derive(Clone, Copy)]
struct CaptureCase {
    name: &'static str,
    input: CanonicalInput,
    expected: &'static str,
}

const CAPTURE_CASES: [CaptureCase; 4] = [
    CaptureCase {
        name: "missing",
        input: CanonicalInput::Absent,
        expected: "",
    },
    CaptureCase {
        name: "empty",
        input: CanonicalInput::Readable(""),
        expected: "",
    },
    CaptureCase {
        name: "non-unicode",
        input: CanonicalInput::NonUnicode,
        expected: "",
    },
    CaptureCase {
        name: "readable",
        input: CanonicalInput::Readable(CANONICAL_POINTER),
        expected: CANONICAL_POINTER,
    },
];

struct PrivateFiles {
    runtime_dir: PathBuf,
    user_env_dir: PathBuf,
    user_env_path: PathBuf,
    run_payload_dir: PathBuf,
    run_payload_path: PathBuf,
    prompt: String,
    model: String,
}

fn set_test_env(key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test starts no threads while configuring or capturing process env.
    unsafe {
        std::env::set_var(key, value);
    }
}

fn remove_test_env(key: impl AsRef<OsStr>) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test starts no threads while configuring or capturing process env.
    unsafe {
        std::env::remove_var(key);
    }
}

fn reset_bootstrap_env() {
    guest_telemetry::log::clear_system_log_file();
    guest_telemetry::telemetry::clear_sandbox_ops_log_file();
    // SAFETY: the integration binary contains exactly one synchronous test and
    // no thread is reading the environment while scenarios are configured.
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
    }
}

fn clear_private_file_env() {
    for spec in PRIVATE_FILE_ENVS {
        remove_test_env(spec.canonical);
    }
}

fn apply_canonical_input(key: &str, input: CanonicalInput) {
    remove_test_env(key);
    match input {
        CanonicalInput::Absent => {}
        CanonicalInput::Readable(value) => set_test_env(key, value),
        CanonicalInput::NonUnicode => set_test_env(key, OsString::from_vec(vec![0xff])),
    }
}

fn capture_raw() -> TestResult<GuestConfigRaw> {
    GuestConfigRaw::from_process_env()
        .map_err(std::io::Error::other)
        .map_err(Into::into)
}

fn expect_config_error(raw: GuestConfigRaw, context: &str) -> TestResult<String> {
    match GuestConfig::from_raw(raw) {
        Ok(_) => Err(format!("{context} unexpectedly built GuestConfig").into()),
        Err(error) => Ok(error),
    }
}

fn write_private_files(root: &Path, name: &str) -> TestResult<PrivateFiles> {
    let runtime_dir = root.join(format!("{name}-runtime"));
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let prompt = format!("prompt-{name}");
    let model = format!("model-{name}");

    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "HOME": root.join(format!("{name}-user-home")),
            "OPENAI_MODEL": model,
        }))?,
    )?;
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload {
            prompt: prompt.clone(),
            tools: "Bash".to_string(),
            ..guest_contracts::env::RunPayload::default()
        })?,
    )?;

    Ok(PrivateFiles {
        runtime_dir,
        user_env_dir,
        user_env_path,
        run_payload_dir,
        run_payload_path,
        prompt,
        model,
    })
}

fn configure_private_files(files: &PrivateFiles, name: &str) -> TestResult {
    reset_bootstrap_env();
    let root = files
        .runtime_dir
        .parent()
        .ok_or("test runtime directory must have a parent")?;
    set_test_env(
        guest_contracts::env::RUN_ID_ENV,
        format!("private-payload-{name}"),
    );
    set_test_env("HOME", root.join(format!("{name}-process-home")));
    set_test_env(
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        &files.runtime_dir,
    );
    Ok(())
}

fn set_canonical_pointers(files: &PrivateFiles) {
    set_test_env(
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        &files.user_env_path,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &files.run_payload_path,
    );
}

fn assert_canonical_capture_semantics() -> TestResult {
    reset_bootstrap_env();
    for spec in PRIVATE_FILE_ENVS {
        for case in CAPTURE_CASES {
            clear_private_file_env();
            apply_canonical_input(spec.canonical, case.input);
            let raw = capture_raw()?;
            assert_eq!(
                (spec.value)(&raw),
                case.expected,
                "{} captured the wrong value for {}",
                case.name,
                spec.canonical
            );
        }
    }
    Ok(())
}

fn assert_canonical_is_authoritative_and_captured_once(root: &Path) -> TestResult {
    let name = "canonical-authoritative";
    let files = write_private_files(root, name)?;
    configure_private_files(&files, name)?;
    set_canonical_pointers(&files);

    let replacement_user_path = root.join("replacement-user-pointer-must-remain");
    let replacement_payload_path = root.join("replacement-payload-pointer-must-remain");
    std::fs::write(
        &replacement_user_path,
        "replacement user pointer must not be read",
    )?;
    std::fs::write(
        &replacement_payload_path,
        "replacement payload pointer must not be read",
    )?;

    let raw = capture_raw()?;
    assert_eq!(
        raw.user_env_file,
        files.user_env_path.to_string_lossy().as_ref()
    );
    assert_eq!(
        raw.run_payload_file,
        files.run_payload_path.to_string_lossy().as_ref()
    );

    let retry = raw.clone();
    set_test_env(
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        &replacement_user_path,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &replacement_payload_path,
    );
    let config = GuestConfig::from_raw(raw).map_err(std::io::Error::other)?;

    assert_eq!(config.prompt, files.prompt);
    assert_eq!(config.tools, "Bash");
    assert_eq!(config.user_env.get("OPENAI_MODEL"), Some(&files.model));
    assert!(!files.user_env_path.exists());
    assert!(!files.user_env_dir.exists());
    assert!(!files.run_payload_path.exists());
    assert!(!files.run_payload_dir.exists());
    assert!(replacement_user_path.exists());
    assert!(replacement_payload_path.exists());

    let retry_error = expect_config_error(retry, "second private-file consume")?;
    assert!(retry_error.contains(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV));
    assert!(replacement_user_path.exists());
    assert!(replacement_payload_path.exists());
    Ok(())
}

fn assert_user_env_remains_optional(root: &Path) -> TestResult {
    let name = "optional-user-env";
    let files = write_private_files(root, name)?;
    configure_private_files(&files, name)?;
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &files.run_payload_path,
    );

    let config = GuestConfig::from_raw(capture_raw()?).map_err(std::io::Error::other)?;
    assert!(config.user_env.is_empty());
    assert!(files.user_env_path.exists());
    assert!(files.user_env_dir.exists());
    assert!(!files.run_payload_path.exists());
    assert!(!files.run_payload_dir.exists());
    Ok(())
}

fn assert_missing_run_payload_precedes_user_env(root: &Path) -> TestResult {
    for case in &CAPTURE_CASES[..3] {
        let name = format!("missing-run-payload-{}", case.name);
        let files = write_private_files(root, &name)?;
        configure_private_files(&files, &name)?;
        set_test_env(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            &files.user_env_path,
        );
        apply_canonical_input(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            case.input,
        );

        let raw = capture_raw()?;
        assert!(raw.run_payload_file.is_empty());
        let error = expect_config_error(raw, &name)?;
        assert_eq!(
            error,
            format!(
                "{} is required",
                guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV
            )
        );
        assert!(files.user_env_path.exists());
        assert!(files.user_env_dir.exists());
        assert!(files.run_payload_path.exists());
        assert!(files.run_payload_dir.exists());
    }
    Ok(())
}

fn assert_canonical_path_validation_and_failure_precedence(root: &Path) -> TestResult {
    let run_name = "invalid-run-payload-path";
    let run_files = write_private_files(root, run_name)?;
    configure_private_files(&run_files, run_name)?;
    let invalid_run_path = root.join("invalid-run-payload-pointer-must-not-leak");
    std::fs::write(&invalid_run_path, "must remain unread")?;
    set_test_env(
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        &run_files.user_env_path,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &invalid_run_path,
    );

    let run_error = expect_config_error(capture_raw()?, run_name)?;
    assert!(run_error.contains(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV));
    assert!(!run_error.contains(invalid_run_path.to_string_lossy().as_ref()));
    assert!(invalid_run_path.exists());
    assert!(run_files.user_env_path.exists());
    assert!(run_files.run_payload_path.exists());

    let user_name = "invalid-user-env-path";
    let user_files = write_private_files(root, user_name)?;
    configure_private_files(&user_files, user_name)?;
    let invalid_user_path = root.join("invalid-user-env-pointer-must-not-leak");
    std::fs::write(&invalid_user_path, "must remain unread")?;
    set_test_env(
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        &invalid_user_path,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &user_files.run_payload_path,
    );

    let user_error = expect_config_error(capture_raw()?, user_name)?;
    assert!(user_error.contains(guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV));
    assert!(!user_error.contains(invalid_user_path.to_string_lossy().as_ref()));
    assert!(invalid_user_path.exists());
    assert!(user_files.user_env_path.exists());
    assert!(user_files.user_env_dir.exists());
    assert!(!user_files.run_payload_path.exists());
    assert!(!user_files.run_payload_dir.exists());
    Ok(())
}

fn assert_json_validation_preserves_destructive_order(root: &Path) -> TestResult {
    let run_name = "invalid-run-payload-json";
    let run_files = write_private_files(root, run_name)?;
    std::fs::write(&run_files.run_payload_path, r#"{"prompt":"secret""#)?;
    configure_private_files(&run_files, run_name)?;
    set_canonical_pointers(&run_files);

    let run_error = expect_config_error(capture_raw()?, run_name)?;
    assert!(run_error.contains("parse OKOU_RUN_PAYLOAD_FILE JSON"));
    assert!(!run_error.contains("secret"));
    assert!(!run_files.run_payload_path.exists());
    assert!(!run_files.run_payload_dir.exists());
    assert!(run_files.user_env_path.exists());
    assert!(run_files.user_env_dir.exists());

    let user_name = "invalid-user-env-json";
    let user_files = write_private_files(root, user_name)?;
    std::fs::write(&user_files.user_env_path, r#"{"OPENAI_MODEL":"secret""#)?;
    configure_private_files(&user_files, user_name)?;
    set_canonical_pointers(&user_files);

    let user_error = expect_config_error(capture_raw()?, user_name)?;
    assert!(user_error.contains("parse OKOU_USER_ENV_FILE JSON"));
    assert!(!user_error.contains("secret"));
    assert!(!user_files.run_payload_path.exists());
    assert!(!user_files.run_payload_dir.exists());
    assert!(!user_files.user_env_path.exists());
    assert!(!user_files.user_env_dir.exists());
    Ok(())
}

#[test]
fn private_payload_files_are_captured_once_and_consumed_once() -> TestResult {
    assert_eq!(
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        "OKOU_USER_ENV_FILE"
    );
    assert_eq!(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        "OKOU_RUN_PAYLOAD_FILE"
    );

    let tmp = tempfile::tempdir()?;
    assert_canonical_capture_semantics()?;
    assert_canonical_is_authoritative_and_captured_once(tmp.path())?;
    assert_user_env_remains_optional(tmp.path())?;
    assert_missing_run_payload_precedes_user_env(tmp.path())?;
    assert_canonical_path_validation_and_failure_precedence(tmp.path())?;
    assert_json_validation_preserves_destructive_order(tmp.path())?;
    reset_bootstrap_env();
    Ok(())
}
