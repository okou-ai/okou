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
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
    SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE, SessionHistoryFramework,
    SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySidecarExportFailure,
    SessionHistorySidecarExportMetadata, SessionHistorySidecarIoErrorClass,
    SessionHistorySidecarRepresentation, SessionHistorySourceRef,
};
#[cfg(target_os = "linux")]
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const SESSION_HISTORY_HELPER_TIMEOUT: Duration = Duration::from_secs(10);

fn assert_export_timings(
    output: &Output,
    metadata: &SessionHistorySidecarExportMetadata,
    resources_available: bool,
) {
    let timings = &metadata.timings;
    let stages_us =
        timings.metadata_us + timings.resolve_us + timings.read_verify_us + timings.write_us;
    // Four adjacent intervals lose at most three microseconds to rounding.
    assert!(timings.total_us >= stages_us);
    assert!(timings.total_us - stages_us <= 3);
    assert!(
        output.stdout.len() < 2048,
        "helper result must remain bounded"
    );
    assert!(
        output.stderr.is_empty(),
        "timings must not add stderr output"
    );
    assert_eq!(timings.read_verify_resources.is_some(), resources_available);
    assert_eq!(timings.write_resources.is_some(), resources_available);
}

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

struct SourceOpenWatch {
    #[cfg(target_os = "linux")]
    inotify: Inotify,
}

impl SourceOpenWatch {
    fn new(path: &Path) -> TestResult<Self> {
        #[cfg(target_os = "linux")]
        {
            let inotify = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)?;
            let _watch = inotify.add_watch(
                path,
                AddWatchFlags::IN_OPEN | AddWatchFlags::IN_CLOSE_NOWRITE,
            )?;
            Ok(Self { inotify })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            Ok(Self {})
        }
    }

    fn assert_opened_once(self) -> TestResult {
        #[cfg(target_os = "linux")]
        {
            let events = match self.inotify.read_events() {
                Ok(events) => events,
                Err(nix::errno::Errno::EAGAIN) => Vec::new(),
                Err(error) => return Err(error.into()),
            };
            let open_count = events
                .iter()
                .filter(|event| event.mask.contains(AddWatchFlags::IN_OPEN))
                .count();
            assert_eq!(open_count, 1, "source events: {events:?}");
        }
        Ok(())
    }

    fn assert_not_opened(self) -> TestResult {
        #[cfg(target_os = "linux")]
        {
            let events = match self.inotify.read_events() {
                Ok(events) => events,
                Err(nix::errno::Errno::EAGAIN) => Vec::new(),
                Err(error) => return Err(error.into()),
            };
            let open_count = events
                .iter()
                .filter(|event| event.mask.contains(AddWatchFlags::IN_OPEN))
                .count();
            assert_eq!(open_count, 0, "source events: {events:?}");
        }
        Ok(())
    }
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
async fn export_session_history_sidecar_reads_raw_source_once() -> TestResult {
    check_raw_export(false).await
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn export_session_history_sidecar_succeeds_when_resource_collection_is_denied() -> TestResult
{
    check_raw_export(true).await
}

async fn check_raw_export(deny_resource_syscall: bool) -> TestResult {
    let dir = tempfile::tempdir()?;
    let history = br#"{"type":"system"}"#;
    let session_id = "raw-sidecar-history";
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
    let metadata_path = write_metadata(dir.path(), "raw-identity.json", &identity)?;
    let export_path = dir.path().join("raw-sidecar");
    let source_watch = SourceOpenWatch::new(&history_path)?;

    let mut command = export_helper_command(&metadata_path, &export_path);
    #[cfg(target_os = "linux")]
    if deny_resource_syscall {
        deny_getrusage(&mut command);
    }
    let output = common::command_output_with_timeout(
        &mut command,
        SESSION_HISTORY_HELPER_TIMEOUT,
        "raw sidecar export exceeded its completion budget",
    )
    .await?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    source_watch.assert_opened_once()?;
    let export_metadata =
        serde_json::from_slice::<SessionHistorySidecarExportMetadata>(&output.stdout)?;
    assert_eq!(
        export_metadata.representation,
        SessionHistorySidecarRepresentation::Raw
    );
    assert_eq!(export_metadata.encoded_size, history.len() as u64);
    assert_export_timings(
        &output,
        &export_metadata,
        cfg!(target_os = "linux") && !deny_resource_syscall,
    );
    assert_eq!(std::fs::read(export_path)?, history);
    Ok(())
}

#[tokio::test]
async fn export_session_history_sidecar_rejects_proc_magic_link_source_without_output() -> TestResult
{
    let dir = tempfile::tempdir()?;
    let sentinel = b"parent-only-secret-sentinel";
    let session_id = "proc-magic-link-source";
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(session_id),
        SessionHistoryRefKind::Blob,
        sha256_hex(sentinel),
        sentinel.len() as u64,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: "/proc/self".to_string(),
            working_dir: guest_agent::paths::CANONICAL_WORKING_DIR.to_string(),
            session_id: session_id.to_string(),
        },
    )?;
    let metadata_path = write_metadata(dir.path(), "proc-magic-link.json", &identity)?;
    let export_path = dir.path().join("proc-magic-link-sidecar");

    let output = run_export_helper(&metadata_path, &export_path).await?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ)
    );
    assert!(!export_path.exists());
    assert!(
        !output
            .stdout
            .windows(sentinel.len())
            .any(|bytes| bytes == sentinel)
    );
    assert!(
        !output
            .stderr
            .windows(sentinel.len())
            .any(|bytes| bytes == sentinel)
    );
    Ok(())
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn export_session_history_sidecar_rejects_final_symlink_without_output() -> TestResult {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir()?;
    let sentinel = b"parent-only-secret-sentinel";
    let session_id = "symlink-source";
    let (history_path, history_source) = claude_history_fixture(dir.path(), session_id)?;
    let outside_path = dir.path().join("outside-history.jsonl");
    std::fs::write(&outside_path, sentinel)?;
    symlink(&outside_path, &history_path)?;
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(session_id),
        SessionHistoryRefKind::Blob,
        sha256_hex(sentinel),
        sentinel.len() as u64,
        history_source,
    )?;
    let metadata_path = write_metadata(dir.path(), "symlink-source.json", &identity)?;
    let export_path = dir.path().join("symlink-sidecar");

    let output = run_export_helper(&metadata_path, &export_path).await?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ)
    );
    assert!(!export_path.exists());
    assert!(
        !output
            .stdout
            .windows(sentinel.len())
            .any(|bytes| bytes == sentinel)
    );
    assert!(
        !output
            .stderr
            .windows(sentinel.len())
            .any(|bytes| bytes == sentinel)
    );
    Ok(())
}

#[tokio::test]
async fn export_session_history_sidecar_reads_native_codex_zstd_once() -> TestResult {
    let dir = tempfile::tempdir()?;
    let sessions_dir = dir.path().join("sessions");
    let day_dir = sessions_dir.join("2026").join("07").join("13");
    std::fs::create_dir_all(&day_dir)?;
    let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let history = br#"{"type":"session_meta","timestamp":"2026-07-13T10:00:00Z"}"#;
    let encoded = zstd::encode_all(history.as_slice(), 0)?;
    let history_path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst");
    std::fs::write(&history_path, &encoded)?;
    let history_source = SessionHistorySourceRef::Codex {
        sessions_dir: sessions_dir.to_string_lossy().into_owned(),
        thread_id: thread_id.to_string(),
    };
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::Codex,
        session_id_hash(thread_id),
        SessionHistoryRefKind::Blob,
        sha256_hex(history),
        history.len() as u64,
        history_source,
    )?;
    let metadata_path = write_metadata(dir.path(), "codex-identity.json", &identity)?;
    let export_path = dir.path().join("codex-sidecar");
    let source_watch = SourceOpenWatch::new(&history_path)?;

    let output = run_export_helper(&metadata_path, &export_path).await?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    source_watch.assert_opened_once()?;
    let export_metadata =
        serde_json::from_slice::<SessionHistorySidecarExportMetadata>(&output.stdout)?;
    assert_eq!(
        export_metadata.representation,
        SessionHistorySidecarRepresentation::CodexZstd
    );
    assert_eq!(export_metadata.encoded_size, encoded.len() as u64);
    assert_export_timings(&output, &export_metadata, cfg!(target_os = "linux"));
    assert_eq!(std::fs::read(export_path)?, encoded);
    Ok(())
}

#[tokio::test]
async fn export_session_history_sidecar_rejects_metadata_above_resume_limit_before_reading()
-> TestResult {
    let dir = tempfile::tempdir()?;
    let session_id = "missing-oversized-history";
    let (_history_path, history_source) = claude_history_fixture(dir.path(), session_id)?;
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(session_id),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        RESUME_SESSION_HISTORY_MAX_BYTES + 1,
        history_source,
    )?;
    let metadata_path = write_metadata(dir.path(), "oversized-identity.json", &identity)?;
    let export_path = dir.path().join("oversized-sidecar");

    let output = run_export_helper(&metadata_path, &export_path).await?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(!export_path.exists());
    Ok(())
}

#[tokio::test]
async fn export_session_history_sidecar_keeps_source_read_failures() -> TestResult {
    let dir = tempfile::tempdir()?;
    let session_id = "missing-source-history";
    let (_history_path, history_source) = claude_history_fixture(dir.path(), session_id)?;
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(session_id),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        1,
        history_source,
    )?;
    let metadata_path = write_metadata(dir.path(), "missing-source-identity.json", &identity)?;
    let export_path = dir.path().join("missing-source-sidecar");

    let output = run_export_helper(&metadata_path, &export_path).await?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert!(!export_path.exists());
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn export_session_history_sidecar_reports_safe_output_write_failure() -> TestResult {
    let dir = tempfile::tempdir()?;
    let history = br#"{"type":"system"}"#;
    let session_id = "output-failure-history";
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
    let metadata_path = write_metadata(dir.path(), "output-failure-identity.json", &identity)?;
    let target_dir = dir.path().join("target");
    let symlink_dir = dir.path().join("symlink");
    std::fs::create_dir(&target_dir)?;
    std::os::unix::fs::symlink(&target_dir, &symlink_dir)?;
    let export_path = symlink_dir.join("sidecar");

    let output = run_export_helper(&metadata_path, &export_path).await?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_SIDECAR_EXPORT_EXIT_WRITE_FAILURE),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let failure = serde_json::from_slice::<SessionHistorySidecarExportFailure>(&output.stdout)?;
    assert_eq!(
        failure.io_error_class,
        SessionHistorySidecarIoErrorClass::PermissionDenied
    );
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains(dir.path().to_string_lossy().as_ref()));
    assert!(!target_dir.join("sidecar").exists());
    Ok(())
}

#[tokio::test]
async fn export_session_history_sidecar_rejects_history_mismatch() -> TestResult {
    let dir = tempfile::tempdir()?;
    let history = b"actual";
    let session_id = "sidecar-mismatched-history";
    let (history_path, history_source) = claude_history_fixture(dir.path(), session_id)?;
    std::fs::write(&history_path, history)?;
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_id_hash(session_id),
        SessionHistoryRefKind::Blob,
        sha256_hex(b"expect"),
        history.len() as u64,
        history_source,
    )?;
    let metadata_path = write_metadata(dir.path(), "mismatched-identity.json", &identity)?;
    let export_path = dir.path().join("mismatched-sidecar");

    let output = run_export_helper(&metadata_path, &export_path).await?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!export_path.exists());
    Ok(())
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn export_session_history_sidecar_rejects_symlinked_metadata_without_opening_target()
-> TestResult {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir()?;
    let history = b"parent-only sentinel";
    let session_id = "symlinked-metadata";
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
    let target_path = write_metadata(dir.path(), "target-identity.json", &identity)?;
    let target_watch = SourceOpenWatch::new(&target_path)?;
    let metadata_path = dir.path().join("symlinked-identity.json");
    symlink(&target_path, &metadata_path)?;
    let export_path = dir.path().join("symlinked-metadata-sidecar");

    let output = run_export_helper(&metadata_path, &export_path).await?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!export_path.exists());
    target_watch.assert_not_opened()?;
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

async fn run_export_helper(
    metadata_path: &Path,
    export_path: &Path,
) -> Result<Output, std::io::Error> {
    let mut command = export_helper_command(metadata_path, export_path);
    common::command_output_with_timeout(
        &mut command,
        SESSION_HISTORY_HELPER_TIMEOUT,
        "export-session-history-sidecar exceeded its completion budget",
    )
    .await
}

fn export_helper_command(metadata_path: &Path, export_path: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .arg("export-session-history-sidecar")
        .arg(metadata_path)
        .arg(export_path);
    command
}

#[cfg(target_os = "linux")]
fn deny_getrusage(command: &mut Command) {
    // SAFETY: the child hook only constructs stack data and invokes prctl. The
    // filter survives exec, denies only getrusage and never changes the parent.
    unsafe {
        command.pre_exec(|| {
            let mut filter = [
                libc::sock_filter {
                    code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
                    jt: 0,
                    jf: 0,
                    k: 0, // seccomp_data.nr
                },
                libc::sock_filter {
                    code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 1,
                    k: libc::SYS_getrusage as u32,
                },
                libc::sock_filter {
                    code: (libc::BPF_RET | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 0,
                    k: libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
                },
                libc::sock_filter {
                    code: (libc::BPF_RET | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 0,
                    k: libc::SECCOMP_RET_ALLOW,
                },
            ];
            let program = libc::sock_fprog {
                len: filter.len() as u16,
                filter: filter.as_mut_ptr(),
            };
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}
