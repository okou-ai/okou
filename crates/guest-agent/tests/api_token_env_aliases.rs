//! Sensitive API token capture accepts only the canonical process-env key.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_TOKEN: &str = "canonical-token-must-not-leak";

#[derive(Clone, Copy)]
enum EnvInput {
    Absent,
    Readable(&'static str),
    NonUnicode,
}

#[derive(Clone, Copy)]
struct CaptureCase {
    name: &'static str,
    canonical: EnvInput,
    expected_value: &'static str,
}

const CAPTURE_CASES: [CaptureCase; 4] = [
    CaptureCase {
        name: "absent",
        canonical: EnvInput::Absent,
        expected_value: "",
    },
    CaptureCase {
        name: "canonical-readable",
        canonical: EnvInput::Readable(CANONICAL_TOKEN),
        expected_value: CANONICAL_TOKEN,
    },
    CaptureCase {
        name: "canonical-empty",
        canonical: EnvInput::Readable(""),
        expected_value: "",
    },
    CaptureCase {
        name: "canonical-non-unicode",
        canonical: EnvInput::NonUnicode,
        expected_value: "",
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

fn apply_input(key: &str, input: EnvInput) {
    remove_test_env(key);
    match input {
        EnvInput::Absent => {}
        EnvInput::Readable(value) => set_test_env(key, value),
        EnvInput::NonUnicode => set_test_env(key, OsString::from_vec(vec![0xff])),
    }
}

fn clear_api_token_env() {
    remove_test_env(guest_contracts::env::CANONICAL_API_TOKEN_ENV);
}

fn assert_value_free(text: &str, context: &str) {
    assert!(
        !text.contains(CANONICAL_TOKEN),
        "{context} exposed API token material"
    );
}

fn assert_http_mode(tmp: &Path, case: CaptureCase, raw: GuestConfigRaw) -> TestResult {
    let runtime_dir = tmp.join(format!("{}-runtime", case.name));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)?;
    std::fs::write(
        &payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;

    let raw = GuestConfigRaw {
        run_id: format!("api-token-canonical-{}", case.name),
        api_url: "http://127.0.0.1:1".to_string(),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    };
    let config = match GuestConfig::from_raw(raw) {
        Ok(config) => config,
        Err(error) => {
            assert_value_free(&error, case.name);
            return Err(std::io::Error::other(format!(
                "{} failed to materialize guest config",
                case.name
            ))
            .into());
        }
    };
    let http = match HttpClient::for_config(&config) {
        Ok(http) => http,
        Err(error) => {
            assert_value_free(&error.to_string(), case.name);
            return Err(std::io::Error::other(format!(
                "{} failed to construct HTTP client mode",
                case.name
            ))
            .into());
        }
    };
    assert!(
        http.has_api() != case.expected_value.is_empty(),
        "{} constructed the wrong HTTP client mode",
        case.name
    );
    Ok(())
}

#[test]
fn process_env_reads_only_canonical_api_token_without_value_leaks() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for case in CAPTURE_CASES {
        apply_input(
            guest_contracts::env::CANONICAL_API_TOKEN_ENV,
            case.canonical,
        );
        let raw = GuestConfigRaw::from_process_env();
        let raw = match raw {
            Ok(raw) => raw,
            Err(error) => {
                assert_value_free(&error, case.name);
                return Err(std::io::Error::other(format!(
                    "{} rejected canonical-only API-token capture",
                    case.name
                ))
                .into());
            }
        };
        assert!(
            raw.api_token == case.expected_value,
            "{} captured the wrong token state",
            case.name
        );
        assert_http_mode(tmp.path(), case, raw)?;
    }

    clear_api_token_env();
    Ok(())
}
