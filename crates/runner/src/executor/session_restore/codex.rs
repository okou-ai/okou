use sandbox::{CodexSessionCleanupRequest, ExecResult, Sandbox};
use tracing::info;

use api_contracts::generated::constants::runners::paths::CANONICAL_CODEX_HOME_DIR;
#[cfg(test)]
use api_contracts::generated::constants::runners::paths::CANONICAL_CODEX_SESSIONS_DIR;

use super::{MaterializedResumeSession, SessionRestoreDiagnostics, write_session_history_file};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::types::{ExecutionContext, SandboxReuseResult};

use super::super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult};
use guest_contracts::{
    codex_session_path::{codex_rollout_relative_path, is_canonical_codex_rollout_relative_path},
    codex_thread_id::CodexThreadId,
};

const INVALID_CODEX_CLEANUP_OUTPUT: &str = "invalid codex session cleanup output";

fn codex_restore_rollout_timestamp(
    session: &MaterializedResumeSession,
    fallback_timestamp: chrono::DateTime<chrono::Utc>,
) -> chrono::DateTime<chrono::Utc> {
    session.codex_timestamp().unwrap_or(fallback_timestamp)
}

/// Restore a Codex session history file as canonical JSONL or zstd-compressed
/// JSONL under
/// `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-{thread_id}.jsonl[.zst]`.
///
/// Codex 0.137 filters filesystem resume candidates through its canonical
/// rollout filename parser, so a bare `{thread_id}.jsonl` is ignored. The
/// canonical path without the optional `.zst` suffix is the logical rollout
/// path; the suffix is added only for compressed restored history.
///
/// On an idle-reused sandbox (`SandboxReuseResult::Reused`), cleanup runs
/// before this function writes the replacement history. Every other reuse
/// outcome writes to the timestamp-derived fallback path without scanning
/// prior Codex state. The cleanup helper scans the complete
/// `~/.codex/sessions` tree, bounded by `OKOU_CODEX_SESSION_CLEANUP_SCAN_BUDGET`
/// (default: 16,384 entries), because duplicate resume candidates can exist
/// outside the fallback date directory.
///
/// Cleanup removes matching regular files and symlinks whose names contain the
/// dashed or undashed session key and end in `.jsonl`, `.jsonl.zst`,
/// `.jsonl.vm0tmp-*`, or `.jsonl.zst.vm0tmp-*`. Unrelated entries and
/// directories are preserved. A matching regular file in the canonical
/// `YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-{thread_id}.jsonl[.zst]` layout is a
/// logical-path candidate: raw and zstd siblings map to the same logical path,
/// no candidate selects the fallback, and multiple distinct candidates are an
/// ambiguity that fails before deletion.
///
/// The helper emits either empty stdout or exactly one LF-terminated canonical
/// logical path. Rust validates that output independently at the guest trust
/// boundary, including its layout, date/time fields, and session ID, before it
/// becomes the write destination. A scan, deletion, helper, ambiguity,
/// malformed/truncated-output, or path-validation failure therefore prevents
/// the replacement history from being written.
pub(super) async fn restore_codex_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
    sandbox_reuse_result: SandboxReuseResult,
) -> RunnerResult<SessionRestoreDiagnostics> {
    let original_session_id = session.cli_agent_session_id();
    let thread_id = CodexThreadId::parse(original_session_id)
        .ok_or_else(|| RunnerError::Internal("invalid codex session_id".into()))?;
    let session_id = thread_id.as_str();

    let timestamp = codex_restore_rollout_timestamp(session, chrono::Utc::now());
    let (session_history, physical_suffix) = if let Some(bytes) = session.codex_zstd_history() {
        (bytes, ".zst")
    } else {
        (session.history_bytes(), "")
    };
    let fallback_relative_path = codex_rollout_relative_path(&thread_id, timestamp);
    let fallback_logical_path = format!("{CANONICAL_CODEX_HOME_DIR}/{fallback_relative_path}");

    // Only an idle-reused sandbox can retain a prior framework home. Fresh
    // sandboxes may attach a cached workspace drive, but that drive contains
    // only the working directory and cannot contain Codex session rollouts.
    let logical_path = match sandbox_reuse_result {
        SandboxReuseResult::Reused => cleanup_existing_codex_session_files(
            sandbox,
            context,
            session_id,
            &fallback_relative_path,
        )
        .await?
        .unwrap_or(fallback_logical_path),
        SandboxReuseResult::NoReuseKey
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::DeviceLimitMismatch
        | SandboxReuseResult::UnparkFailed => fallback_logical_path,
    };
    let session_path = format!("{logical_path}{physical_suffix}");

    let transfer = write_session_history_file(sandbox, &session_path, session).await?;

    let diagnostics = SessionRestoreDiagnostics {
        framework: "codex",
        session_id: session_id.to_string(),
        bytes_in: session_history.len(),
        transfer,
    };
    info!(
        run_id = %context.run_id,
        framework = diagnostics.framework,
        session_id = %diagnostics.session_id,
        bytes_in = diagnostics.bytes_in,
        "restored session history",
    );
    Ok(diagnostics)
}

async fn cleanup_existing_codex_session_files(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session_id: &str,
    fallback_relative_path: &str,
) -> RunnerResult<Option<String>> {
    let result = sandbox
        .cleanup_codex_session(&CodexSessionCleanupRequest {
            session_id,
            fallback_relative_path,
            timeout: DEFAULT_EXEC_TIMEOUT,
        })
        .await?;
    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_helper_exec_failure(
            "codex session cleanup",
            &result,
        )));
    }
    info!(
        run_id = %context.run_id,
        session_id = %session_id,
        "cleaned up existing codex session files before restore",
    );
    parse_codex_cleanup_output(&result, session_id)
}

fn parse_codex_cleanup_output(
    result: &ExecResult,
    session_id: &str,
) -> RunnerResult<Option<String>> {
    // Helper stdout crosses the guest trust boundary and becomes a write
    // destination, so validate it independently of the shell classifier.
    if result.stdout_truncated {
        return Err(RunnerError::Internal(INVALID_CODEX_CLEANUP_OUTPUT.into()));
    }
    if result.stdout.is_empty() {
        return Ok(None);
    }
    let output = std::str::from_utf8(&result.stdout)
        .map_err(|_| RunnerError::Internal(INVALID_CODEX_CLEANUP_OUTPUT.into()))?;
    let path = output
        .strip_suffix('\n')
        .filter(|path| !path.is_empty() && !path.contains(['\r', '\n']))
        .filter(|path| is_canonical_codex_logical_path(path, session_id))
        .ok_or_else(|| RunnerError::Internal(INVALID_CODEX_CLEANUP_OUTPUT.into()))?;
    Ok(Some(path.to_string()))
}

fn is_canonical_codex_logical_path(path: &str, session_id: &str) -> bool {
    let Some(relative) = path
        .strip_prefix(CANONICAL_CODEX_HOME_DIR)
        .and_then(|path| path.strip_prefix('/'))
    else {
        return false;
    };
    CodexThreadId::parse(session_id)
        .is_some_and(|thread_id| is_canonical_codex_rollout_relative_path(relative, &thread_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    use sandbox::{ExecResult, ExecTermination};

    use crate::error::RunnerError;

    const SESSION_ID: &str = "019e9154-c304-70f0-adde-36efb1be1701";

    fn exec_result(stdout: Vec<u8>, stdout_truncated: bool) -> ExecResult {
        ExecResult {
            termination: ExecTermination::Exited { exit_code: 0 },
            guest_duration_ms: None,
            stdout,
            stderr: Vec::new(),
            diagnostic: String::new(),
            stdout_truncated,
            stderr_truncated: false,
        }
    }

    fn canonical_sessions_logical_path(date: &str, time: &str) -> String {
        let mut date_components = date.split('-');
        let year = date_components.next().unwrap();
        let month = date_components.next().unwrap();
        let day = date_components.next().unwrap();
        assert!(date_components.next().is_none());
        format!(
            "{CANONICAL_CODEX_SESSIONS_DIR}/{year}/{month}/{day}/rollout-{date}T{time}-{SESSION_ID}.jsonl"
        )
    }

    type CleanupOutputCase<'a> = (&'a str, Vec<u8>, bool, Result<Option<&'a str>, &'a str>);

    #[test]
    fn parse_codex_cleanup_output_accepts_and_rejects_expected_stdout() {
        let canonical = canonical_sessions_logical_path("2026-06-04", "07-18-08");
        let canonical_with_newline = format!("{canonical}\n");
        let different_session_id = "00000000-0000-0000-0000-000000000000";

        let cases: &[CleanupOutputCase<'_>] = &[
            (
                "empty stdout selects the fallback path",
                Vec::new(),
                false,
                Ok(None),
            ),
            (
                "one canonical newline-terminated path is accepted",
                canonical_with_newline.clone().into_bytes(),
                false,
                Ok(Some(canonical.as_str())),
            ),
            (
                "truncated stdout is rejected",
                canonical_with_newline.clone().into_bytes(),
                true,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "invalid UTF-8 stdout is rejected",
                vec![0xff, 0xfe, 0xfd],
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "newline-only stdout is rejected",
                b"\n".to_vec(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "missing newline terminator is rejected",
                canonical.clone().into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "extra newline terminator is rejected",
                format!("{canonical}\n\n").into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "CRLF terminator is rejected",
                format!("{canonical}\r\n").into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "multiple line terminators are rejected",
                format!("{canonical}\n{canonical}\n").into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "path outside the sessions root is rejected",
                format!(
                    "/home/user/.codex/other/2026/06/04/rollout-2026-06-04T07-18-08-{SESSION_ID}.jsonl\n"
                )
                .into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "extra path component is rejected",
                format!(
                    "{CANONICAL_CODEX_SESSIONS_DIR}/2026/06/04/extra/rollout-2026-06-04T07-18-08-{SESSION_ID}.jsonl\n"
                )
                .into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "mismatched session id is rejected",
                format!(
                    "{CANONICAL_CODEX_SESSIONS_DIR}/2026/06/04/rollout-2026-06-04T07-18-08-{different_session_id}.jsonl\n"
                )
                .into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "invalid calendar date is rejected",
                format!(
                    "{CANONICAL_CODEX_SESSIONS_DIR}/2026/02/31/rollout-2026-02-31T07-18-08-{SESSION_ID}.jsonl\n"
                )
                .into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "out-of-range hour is rejected",
                format!(
                    "{CANONICAL_CODEX_SESSIONS_DIR}/2026/06/04/rollout-2026-06-04T24-01-04-{SESSION_ID}.jsonl\n"
                )
                .into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "out-of-range minute is rejected",
                format!(
                    "{CANONICAL_CODEX_SESSIONS_DIR}/2026/06/04/rollout-2026-06-04T07-60-04-{SESSION_ID}.jsonl\n"
                )
                .into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
            (
                "out-of-range second is rejected",
                format!(
                    "{CANONICAL_CODEX_SESSIONS_DIR}/2026/06/04/rollout-2026-06-04T07-18-60-{SESSION_ID}.jsonl\n"
                )
                .into_bytes(),
                false,
                Err(INVALID_CODEX_CLEANUP_OUTPUT),
            ),
        ];

        for (name, stdout, stdout_truncated, expected) in cases {
            let result = parse_codex_cleanup_output(
                &exec_result(stdout.clone(), *stdout_truncated),
                SESSION_ID,
            );
            match *expected {
                Ok(None) => assert!(
                    matches!(result, Ok(None)),
                    "{name}: expected the fallback path, got {result:?}"
                ),
                Ok(Some(expected_path)) => {
                    let actual = result.unwrap_or_else(|error| {
                        panic!("{name}: expected a canonical path, got {error:?}")
                    });
                    assert_eq!(actual.as_deref(), Some(expected_path), "{name}");
                }
                Err(expected_message) => match result {
                    Err(RunnerError::Internal(message)) => {
                        assert_eq!(message.as_str(), expected_message, "{name}")
                    }
                    other => panic!("{name}: expected internal error, got {other:?}"),
                },
            }
        }
    }
}
