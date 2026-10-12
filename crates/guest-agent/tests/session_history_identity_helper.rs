mod common;

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use guest_contracts::session_history_identity::{
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS, SessionHistoryFramework, SessionHistoryIdentity,
    SessionHistoryRefKind, SessionHistorySourceRef,
};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const SESSION_HISTORY_HELPER_TIMEOUT: Duration = Duration::from_secs(10);

fn claude_history_fixture(
    root: &Path,
    session_id: &str,
) -> TestResult<(PathBuf, SessionHistorySourceRef)> {
    let config_dir = root.join(format!("{session_id}-config"));
    let history_path = config_dir
        .join("projects/-home-user-workspace")
        .join(format!("{session_id}.jsonl"));
    let history_parent = history_path
        .parent()
        .ok_or("Claude history has no parent")?;
    std::fs::create_dir_all(history_parent)?;
    Ok((
        history_path,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: config_dir.to_string_lossy().into_owned(),
            working_dir: guest_agent::paths::CANONICAL_WORKING_DIR.to_string(),
            session_id: session_id.to_string(),
        },
    ))
}

fn session_id_hash(session_id: &str) -> String {
    sha256_hex(session_id.as_bytes())
}

struct VerifyCase {
    name: &'static str,
    metadata_path: PathBuf,
    expectation_args: Vec<OsString>,
    expected_exit_code: i32,
}

#[tokio::test]
async fn verify_session_history_identity_returns_stable_exit_codes() -> TestResult {
    let dir = tempfile::tempdir()?;

    let matching_history = br#"{"type":"system"}"#;
    let matching_session_id = "matching-history";
    let (matching_history_path, matching_source) =
        claude_history_fixture(dir.path(), matching_session_id)?;
    std::fs::write(&matching_history_path, matching_history)?;
    let matching_history_hash = sha256_hex(matching_history);
    let matching_identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(matching_session_id),
        SessionHistoryRefKind::Blob,
        matching_history_hash.clone(),
        matching_history.len() as u64,
        matching_source.clone(),
    )?;
    let matching_metadata_path =
        write_metadata(dir.path(), "matching-identity.json", &matching_identity)?;

    let invalid_metadata_path = dir.path().join("invalid-identity.json");
    guest_contracts::runtime_paths::write_private(&invalid_metadata_path, b"not-json")?;

    let framework_mismatch_identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash("different-session"),
        SessionHistoryRefKind::Blob,
        matching_history_hash,
        matching_history.len() as u64,
        matching_source.clone(),
    )?;
    let framework_mismatch_metadata_path = write_metadata(
        dir.path(),
        "framework-mismatch-identity.json",
        &framework_mismatch_identity,
    )?;

    let missing_session_id = "missing-history";
    let (_missing_history_path, missing_source) =
        claude_history_fixture(dir.path(), missing_session_id)?;
    let history_read_identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(missing_session_id),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        1,
        missing_source,
    )?;
    let history_read_metadata_path = write_metadata(
        dir.path(),
        "history-read-identity.json",
        &history_read_identity,
    )?;

    let mismatch_session_id = "mismatched-history";
    let (mismatched_history_path, mismatch_source) =
        claude_history_fixture(dir.path(), mismatch_session_id)?;
    std::fs::write(&mismatched_history_path, b"actual!")?;
    let history_mismatch_identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(mismatch_session_id),
        SessionHistoryRefKind::Blob,
        sha256_hex(b"expect!"),
        7,
        mismatch_source,
    )?;
    let history_mismatch_metadata_path = write_metadata(
        dir.path(),
        "history-mismatch-identity.json",
        &history_mismatch_identity,
    )?;

    let history_too_large_identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(matching_session_id),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        RESUME_SESSION_HISTORY_MAX_BYTES + 1,
        matching_source,
    )?;
    let history_too_large_metadata_path = write_metadata(
        dir.path(),
        "history-too-large-identity.json",
        &history_too_large_identity,
    )?;

    let cases = [
        VerifyCase {
            name: "success",
            metadata_path: matching_metadata_path.clone(),
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
        },
        VerifyCase {
            name: "invalid arguments",
            metadata_path: matching_metadata_path.clone(),
            expectation_args: vec![OsString::from("claude-code")],
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
        },
        VerifyCase {
            name: "metadata read",
            metadata_path: dir.path().join("missing-identity.json"),
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
        },
        VerifyCase {
            name: "invalid metadata",
            metadata_path: invalid_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
        },
        VerifyCase {
            name: "framework mismatch",
            metadata_path: framework_mismatch_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
        },
        VerifyCase {
            name: "expected identity mismatch",
            metadata_path: matching_metadata_path,
            expectation_args: expectation_args(&matching_identity, "b".repeat(64)),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
        },
        VerifyCase {
            name: "history read",
            metadata_path: history_read_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
        },
        VerifyCase {
            name: "history mismatch",
            metadata_path: history_mismatch_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
        },
        VerifyCase {
            name: "history too large",
            metadata_path: history_too_large_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
        },
    ];

    for case in cases {
        let output = run_helper(&case).await?;
        assert_eq!(
            output.status.code(),
            Some(case.expected_exit_code),
            "{}: stdout={}, stderr={}",
            case.name,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(())
}

#[tokio::test]
async fn default_identity_path_preserves_runtime_selection_without_protocol_output() -> TestResult {
    #[derive(Clone, Copy)]
    enum CanonicalInput {
        Absent,
        Empty,
        Selected,
    }

    struct Case {
        name: &'static str,
        canonical: CanonicalInput,
        use_canonical: bool,
    }

    let dir = tempfile::tempdir()?;
    let history = br#"{"type":"system"}"#;
    let session_id = "runtime-env-default-path";
    let (history_path, history_source) = claude_history_fixture(dir.path(), session_id)?;
    std::fs::write(&history_path, history)?;
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(session_id),
        SessionHistoryRefKind::Blob,
        sha256_hex(history),
        history.len() as u64,
        history_source,
    )?;

    for case in [
        Case {
            name: "canonical-only",
            canonical: CanonicalInput::Selected,
            use_canonical: true,
        },
        Case {
            name: "canonical-absent",
            canonical: CanonicalInput::Absent,
            use_canonical: false,
        },
        Case {
            name: "canonical-empty",
            canonical: CanonicalInput::Empty,
            use_canonical: false,
        },
    ] {
        let run_id = if case.use_canonical {
            "not/validated/when/runtime-dir-is-set".to_string()
        } else {
            format!("helper-runtime-{}", case.name)
        };
        let home = dir.path().join(format!("{}-home", case.name));
        let canonical_dir = dir.path().join(format!("{}-canonical", case.name));
        let fallback_dir = if case.use_canonical {
            None
        } else {
            Some(guest_contracts::runtime_paths::run_dir_for_home(
                &home, &run_id,
            )?)
        };
        let runtime_dir = if case.use_canonical {
            &canonical_dir
        } else {
            fallback_dir
                .as_ref()
                .ok_or("fallback runtime is required")?
        };
        let metadata_path =
            guest_contracts::runtime_paths::final_session_history_identity_file(runtime_dir);
        guest_contracts::runtime_paths::write_private(&metadata_path, identity.to_json_vec()?)?;
        let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
        command
            .env_clear()
            .env(guest_contracts::env::RUN_ID_ENV, &run_id)
            .env("HOME", &home)
            .arg("verify-session-history-identity");
        match case.canonical {
            CanonicalInput::Absent => {}
            CanonicalInput::Empty => {
                command.env(
                    guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                    "",
                );
            }
            CanonicalInput::Selected => {
                command.env(
                    guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                    &canonical_dir,
                );
            }
        }
        let output = common::command_output_with_timeout(
            &mut command,
            SESSION_HISTORY_HELPER_TIMEOUT,
            &format!(
                "{} default identity-path helper exceeded its completion budget",
                case.name
            ),
        )
        .await?;
        assert!(
            output.status.success(),
            "{}: stdout={}, stderr={}",
            case.name,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty(), "{} changed stdout", case.name);
        assert!(output.stderr.is_empty(), "{} changed stderr", case.name);
    }

    Ok(())
}

fn write_metadata(
    dir: &Path,
    name: &str,
    identity: &SessionHistoryIdentity,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = dir.join(name);
    guest_contracts::runtime_paths::write_private(&path, identity.to_json_vec()?)?;
    Ok(path)
}

fn expectation_args(identity: &SessionHistoryIdentity, session_id_hash: String) -> Vec<OsString> {
    vec![
        OsString::from(identity.framework.as_str()),
        OsString::from(session_id_hash),
        OsString::from(identity.history_ref_kind.as_str()),
        OsString::from(&identity.history_hash),
        OsString::from(identity.history_size_bytes.to_string()),
    ]
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn run_helper(case: &VerifyCase) -> Result<Output, std::io::Error> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .arg("verify-session-history-identity")
        .arg(&case.metadata_path)
        .args(&case.expectation_args);
    let timeout_context = format!(
        "verify-session-history-identity case '{}' exceeded its completion budget",
        case.name
    );
    common::command_output_with_timeout(
        &mut command,
        SESSION_HISTORY_HELPER_TIMEOUT,
        &timeout_context,
    )
    .await
}
