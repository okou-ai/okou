use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use codex_mock::{read_session_file, session_files};
use guest_contracts::{
    codex_session_path::codex_rollout_relative_path, codex_thread_id::CodexThreadId,
};
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::app_server::{
    AppServerProcess, MOCK_CODEX_RESUME_PERSISTENCE_SOCKET_ENV, MOCK_CODEX_SESSION_TIMESTAMP_ENV,
    initialize_params, spawn_app_server_with_env, text_input,
};

const THREAD_ID: &str = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const SESSION_TIMESTAMP: &str = "2026-06-09T12:34:56Z";
const PERSISTENCE_GATE_TIMEOUT: Duration = Duration::from_secs(5);

fn resume_app_server(
    codex_home: &Path,
    thread_id: &str,
    env: &[(&str, &str)],
) -> std::io::Result<AppServerProcess> {
    let mut mock_env = vec![(MOCK_CODEX_SESSION_TIMESTAMP_ENV, SESSION_TIMESTAMP)];
    mock_env.extend_from_slice(env);
    let mut server =
        spawn_app_server_with_env(codex_home, &["app-server", "--stdio"], None, &mock_env)?;
    server.request(1, "initialize", initialize_params())?;
    let resumed = server.request(
        2,
        "thread/resume",
        json!({
            "threadId": thread_id,
        }),
    )?;
    assert_eq!(
        resumed.pointer("/result/thread/id").and_then(Value::as_str),
        Some(thread_id)
    );
    Ok(server)
}

fn send_resume_turn(
    server: &mut AppServerProcess,
    thread_id: &str,
    prompt: &str,
) -> std::io::Result<()> {
    server.send(&json!({
        "id": 3,
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "input": [text_input(prompt)],
        },
    }))
}

fn finish_resume_turn(server: &mut AppServerProcess) -> std::io::Result<()> {
    let started = server.read_required()?;
    assert_eq!(started.get("id").and_then(Value::as_i64), Some(3));
    assert!(
        started
            .pointer("/result/turn/id")
            .and_then(Value::as_str)
            .is_some()
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

fn persist_resume_turn(codex_home: &Path, thread_id: &str, prompt: &str) -> std::io::Result<()> {
    let mut server = resume_app_server(codex_home, thread_id, &[])?;
    send_resume_turn(&mut server, thread_id, prompt)?;
    finish_resume_turn(&mut server)
}

fn accept_persistence_writer(listener: &UnixListener) -> std::io::Result<UnixStream> {
    let deadline = Instant::now() + PERSISTENCE_GATE_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(PERSISTENCE_GATE_TIMEOUT))?;
                stream.set_write_timeout(Some(PERSISTENCE_GATE_TIMEOUT))?;
                return Ok(stream);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "timed out waiting for a resume persistence writer",
                    ));
                }
                // Poll for an actual connection; elapsed time never establishes contention.
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error),
        }
    }
}

fn expected_fallback_path(codex_home: &Path) -> std::io::Result<std::path::PathBuf> {
    let timestamp = DateTime::parse_from_rfc3339(SESSION_TIMESTAMP)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?
        .with_timezone(&Utc);
    let thread_id = CodexThreadId::parse(THREAD_ID).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid test thread id")
    })?;
    Ok(codex_home.join(codex_rollout_relative_path(&thread_id, timestamp)))
}

#[test]
fn app_server_resume_creates_canonical_rollout_for_unknown_thread() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let session_path = expected_fallback_path(dir.path())?;

    persist_resume_turn(dir.path(), THREAD_ID, "turn-1")?;

    assert_eq!(session_files(dir.path())?, vec![session_path.clone()]);
    let events = read_session_file(&session_path)?;
    assert_eq!(
        events
            .iter()
            .filter_map(|event| event.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>(),
        vec!["turn-1"]
    );
    Ok(())
}

#[test]
fn app_server_resume_appends_restored_rollout_without_parsing_history() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let restored_path = dir.path().join(format!(
        "sessions/2001/01/01/rollout-2001-01-01T00-00-00-{THREAD_ID}.jsonl"
    ));
    if let Some(parent) = restored_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&restored_path, "{not-json}")?;

    persist_resume_turn(dir.path(), THREAD_ID, "turn-2")?;

    let raw = std::fs::read_to_string(&restored_path)?;
    assert!(
        raw.starts_with("{not-json}\n"),
        "resume should preserve existing raw history and add a line break: {raw:?}"
    );
    assert!(
        raw.contains("\"text\":\"turn-2\""),
        "resume should append the new app-server input event: {raw:?}"
    );
    assert_eq!(session_files(dir.path())?, vec![restored_path]);
    Ok(())
}

#[test]
fn concurrent_app_server_resume_writes_preserve_all_inputs() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let session_path = dir.path().join(format!(
        "sessions/2001/01/01/rollout-2001-01-01T00-00-00-{THREAD_ID}.jsonl"
    ));
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&session_path, "{\"type\":\"existing\"}\n")?;

    let socket_path = dir.path().join("persistence.sock");
    let listener = UnixListener::bind(&socket_path)?;
    listener.set_nonblocking(true)?;
    let socket_path = socket_path.to_str().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "non-UTF-8 socket path")
    })?;
    let prompts = ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"];
    let mut servers = prompts
        .iter()
        .map(|_| {
            resume_app_server(
                dir.path(),
                THREAD_ID,
                &[(MOCK_CODEX_RESUME_PERSISTENCE_SOCKET_ENV, socket_path)],
            )
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    for (server, prompt) in servers.iter_mut().zip(prompts) {
        send_resume_turn(server, THREAD_ID, prompt)?;
    }

    for _ in &servers {
        let mut writer = accept_persistence_writer(&listener)?;
        let mut ready = [0];
        writer.read_exact(&mut ready)?;
        assert_eq!(ready, *b"R");

        let lock_path = dir
            .path()
            .join(".session-locks")
            .join(format!("{THREAD_ID}.lock"));
        let probe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock_path)?;
        // SAFETY: `probe` owns an open file descriptor. A separate open-file
        // description must contend with the writer paused after reading history.
        let result = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        let error = std::io::Error::last_os_error();
        assert_eq!(
            result, -1,
            "resume writer must hold the session lock after reading history"
        );
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        writer.write_all(b"C")?;
    }

    for server in &mut servers {
        finish_resume_turn(server)?;
    }

    let events = read_session_file(&session_path)?;
    let prompts = events
        .iter()
        .filter_map(|event| event.get("text").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    assert_eq!(
        prompts,
        BTreeSet::from(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"])
    );
    let messages = events
        .iter()
        .filter(|event| event["type"] == "response_item")
        .filter_map(|event| {
            event
                .pointer("/payload/content/0/text")
                .and_then(Value::as_str)
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(messages, prompts);
    assert_eq!(events.len(), 11);
    Ok(())
}
