use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
#[cfg(unix)]
use std::path::PathBuf;

#[cfg(unix)]
use chrono::{DateTime, Utc};
use codex_mock::{session_artifacts, session_files};
#[cfg(unix)]
use guest_contracts::{
    codex_session_path::codex_rollout_relative_path, codex_thread_id::CodexThreadId,
};
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::app_server::{
    AppServerProcess, MOCK_CODEX_SESSION_TIMESTAMP_ENV, initialize_params,
    spawn_app_server_with_env, text_input,
};

const THREAD_ID: &str = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const SESSION_TIMESTAMP: &str = "2026-06-09T12:34:56Z";

fn spawn_resumed_app_server(codex_home: &Path) -> std::io::Result<AppServerProcess> {
    let mut server = spawn_app_server_with_env(
        codex_home,
        &["app-server", "--stdio"],
        None,
        &[(MOCK_CODEX_SESSION_TIMESTAMP_ENV, SESSION_TIMESTAMP)],
    )?;
    server.request(1, "initialize", initialize_params())?;
    let resumed = server.request(
        2,
        "thread/resume",
        json!({
            "threadId": THREAD_ID,
        }),
    )?;
    assert_eq!(
        resumed.pointer("/result/thread/id").and_then(Value::as_str),
        Some(THREAD_ID)
    );
    Ok(server)
}

fn assert_turn_persistence_rejected(codex_home: &Path) -> std::io::Result<()> {
    let mut server = spawn_resumed_app_server(codex_home)?;
    let error = match server.request(
        3,
        "turn/start",
        json!({
            "threadId": THREAD_ID,
            "input": [text_input("must not persist")],
        }),
    ) {
        Ok(response) => {
            return Err(std::io::Error::other(format!(
                "invalid session storage unexpectedly accepted turn: {response}"
            )));
        }
        Err(error) => error,
    };
    assert!(
        matches!(
            error.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::BrokenPipe
        ),
        "unexpected app-server failure: {error}"
    );
    assert_ne!(server.close_and_wait()?, 0);
    Ok(())
}

#[cfg(unix)]
fn current_session_path(codex_home: &Path) -> std::io::Result<PathBuf> {
    let timestamp = DateTime::parse_from_rfc3339(SESSION_TIMESTAMP)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?
        .with_timezone(&Utc);
    let thread_id = CodexThreadId::parse(THREAD_ID).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid test thread id")
    })?;
    Ok(codex_home.join(codex_rollout_relative_path(&thread_id, timestamp)))
}

#[test]
fn app_server_rejects_sessions_file_root_without_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    std::fs::write(dir.path().join("sessions"), "not a directory")?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(session_artifacts(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_symlinked_codex_home_without_outside_writes() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let outside_home = dir.path().join("outside-home");
    let codex_home = dir.path().join("codex-home");
    std::fs::create_dir_all(&outside_home)?;
    std::os::unix::fs::symlink(&outside_home, &codex_home)?;

    assert_turn_persistence_rejected(&codex_home)?;

    assert!(codex_home.symlink_metadata()?.file_type().is_symlink());
    assert!(!outside_home.join(".session-locks").exists());
    assert!(!outside_home.join("sessions").exists());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_symlinked_sessions_root_without_outside_writes() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let outside_sessions = dir.path().join("outside-sessions");
    std::fs::create_dir_all(&outside_sessions)?;
    std::os::unix::fs::symlink(&outside_sessions, dir.path().join("sessions"))?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(outside_sessions.read_dir()?.next().is_none());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_symlinked_session_parent_without_outside_writes() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let sessions = dir.path().join("sessions");
    let outside_year = dir.path().join("outside-year");
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&outside_year)?;
    std::os::unix::fs::symlink(&outside_year, sessions.join("2026"))?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(outside_year.read_dir()?.next().is_none());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_special_lock_file_without_hanging() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let lock_dir = dir.path().join(".session-locks");
    std::fs::create_dir_all(&lock_dir)?;
    mkfifo(&lock_dir.join(format!("{THREAD_ID}.lock")))?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(session_artifacts(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_special_session_file_without_hanging() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let session_path = current_session_path(dir.path())?;
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    mkfifo(&session_path)?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(session_path.symlink_metadata()?.file_type().is_fifo());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_symlinked_fallback_without_overwriting_target() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let outside_path = dir.path().join("outside.jsonl");
    std::fs::write(&outside_path, "outside must survive")?;
    let session_path = current_session_path(dir.path())?;
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(&outside_path, &session_path)?;

    assert_turn_persistence_rejected(dir.path())?;

    assert_eq!(
        std::fs::read_to_string(&outside_path)?,
        "outside must survive"
    );
    assert!(session_path.symlink_metadata()?.file_type().is_symlink());
    Ok(())
}

#[test]
fn app_server_rejects_duplicate_matching_sessions_without_modifying_them() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let first_path = dir.path().join(format!(
        "sessions/2001/01/01/rollout-2001-01-01T00-00-00-{THREAD_ID}.jsonl"
    ));
    let second_path = dir.path().join(format!(
        "sessions/2001/01/02/rollout-2001-01-02T00-00-00-{THREAD_ID}.jsonl"
    ));
    for (path, contents) in [(&first_path, "first\n"), (&second_path, "second\n")] {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, contents)?;
    }

    assert_turn_persistence_rejected(dir.path())?;

    assert_eq!(std::fs::read_to_string(first_path)?, "first\n");
    assert_eq!(std::fs::read_to_string(second_path)?, "second\n");
    Ok(())
}

#[test]
fn session_files_skip_symlinked_files_and_dirs() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file =
        day_dir.join("rollout-2026-06-09T00-00-00-00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let linked_file =
        day_dir.join("rollout-2026-06-09T00-00-00-00000000-0000-0000-0000-000000000002.jsonl");
    std::os::unix::fs::symlink(&real_file, &linked_file)?;
    std::os::unix::fs::symlink(&sessions, sessions.join("loop"))?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    assert!(linked_file.symlink_metadata()?.file_type().is_symlink());
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_files_skip_dangling_jsonl_symlinks() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file =
        day_dir.join("rollout-2026-06-09T00-00-00-00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let missing_target = dir.path().join("missing/codex-session.jsonl");
    std::os::unix::fs::symlink(
        missing_target,
        day_dir.join("rollout-2026-06-09T00-00-00-00000000-0000-0000-0000-000000000002.jsonl"),
    )?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_files_skip_jsonl_symlink_loops() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file =
        day_dir.join("rollout-2026-06-09T00-00-00-00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let looped_file =
        day_dir.join("rollout-2026-06-09T00-00-00-00000000-0000-0000-0000-000000000002.jsonl");
    std::os::unix::fs::symlink(&looped_file, &looped_file)?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_artifacts_skip_root_symlink_loop() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    std::os::unix::fs::symlink(&sessions, &sessions)?;

    assert!(session_artifacts(dir.path())?.is_empty());
    assert!(session_files(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_artifacts_skip_symlinked_root_dir() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let real_sessions = dir.path().join("real-sessions");
    let real_day_dir = real_sessions.join("2026/06/09");
    std::fs::create_dir_all(&real_day_dir)?;
    std::fs::write(
        real_day_dir.join("rollout-2026-06-09T00-00-00-00000000-0000-0000-0000-000000000001.jsonl"),
        "{}\n",
    )?;
    std::os::unix::fs::symlink(&real_sessions, dir.path().join("sessions"))?;

    assert!(session_artifacts(dir.path())?.is_empty());
    assert!(session_files(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
fn mkfifo(path: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    nix::unistd::mkfifo(
        path.as_c_str(),
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .map_err(std::io::Error::from)
}
