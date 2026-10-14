use std::collections::BTreeSet;
use std::path::Path;

use chrono::{DateTime, Utc};
use codex_mock::{read_session_file, session_files};
use guest_contracts::{
    codex_session_path::codex_rollout_relative_path, codex_thread_id::CodexThreadId,
};
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::app_server::{
    MOCK_CODEX_SESSION_TIMESTAMP_ENV, initialize_params, spawn_app_server_with_env, text_input,
};

const THREAD_ID: &str = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const SESSION_TIMESTAMP: &str = "2026-06-09T12:34:56Z";

fn persist_resume_turn(codex_home: &Path, thread_id: &str, prompt: &str) -> std::io::Result<()> {
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
            "threadId": thread_id,
        }),
    )?;
    assert_eq!(
        resumed.pointer("/result/thread/id").and_then(Value::as_str),
        Some(thread_id)
    );
    let started = server.request(
        3,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [text_input(prompt)],
        }),
    )?;
    assert!(
        started
            .pointer("/result/turn/id")
            .and_then(Value::as_str)
            .is_some()
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
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

    let mut handles = Vec::new();
    for prompt in ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"] {
        let codex_home = dir.path().to_path_buf();
        handles.push((
            prompt,
            std::thread::spawn(move || persist_resume_turn(&codex_home, THREAD_ID, prompt)),
        ));
    }

    for (prompt, handle) in handles {
        handle
            .join()
            .map_err(|_| std::io::Error::other(format!("{prompt}: resume thread panicked")))??;
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
