pub mod support;

use std::fs;
use std::io::Write;
use std::process::Stdio;

use serde_json::Value;
use support::{
    ACTIVE_INPUT_READY_RESULT, event_kind, expected_history_path, init_session_id, mock_claude,
    parse_jsonl, recv_until_result, spawn_managed_mock_child, spawn_stream_json_child,
    stream_json_user_frame, stream_json_user_frame_with_uuid, wait_child_output,
};

#[test]
fn stream_json_input_reads_prompt_from_stdin() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut command = mock_claude();
    command
        .env("HOME", home.path())
        .args([
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--",
            "printf argv-wrong",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_managed_mock_child(&mut command)?;

    let mut stdin = child.take_stdin().ok_or("missing stdin")?;
    stdin.write_all(stream_json_user_frame("printf stdin-ok").as_bytes())?;
    drop(stdin);

    let output = wait_child_output(child)?;
    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let result = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("result"))
        .and_then(|event| event.get("result"))
        .and_then(Value::as_str)
        .ok_or("missing result")?;
    assert_eq!(result, "stdin-ok");

    let command = events
        .iter()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("assistant")
                && event
                    .pointer("/message/content/0/type")
                    .and_then(Value::as_str)
                    == Some("tool_use")
        })
        .and_then(|event| event.pointer("/message/content/0/input/command"))
        .and_then(Value::as_str)
        .ok_or("missing command")?;
    assert_eq!(command, "printf stdin-ok");
    Ok(())
}

#[test]
fn stream_json_input_does_not_wait_for_stdin_eof() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), false)?;

    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame("printf stdin-ok").as_bytes())?;
    stream.stdin_mut()?.flush()?;

    let events = recv_until_result(&stream.rx, "stdin-ok")?;
    stream.close_stdin();

    let (status, stderr) = stream.wait()?;
    assert!(status.success(), "expected success, stderr: {stderr}");
    assert!(stderr.is_empty());

    let command = events
        .iter()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("assistant")
                && event
                    .pointer("/message/content/0/type")
                    .and_then(Value::as_str)
                    == Some("tool_use")
        })
        .and_then(|event| event.pointer("/message/content/0/input/command"))
        .and_then(Value::as_str)
        .ok_or("missing command")?;
    assert_eq!(command, "printf stdin-ok");
    Ok(())
}

#[test]
fn active_input_stream_reads_followups_after_ready() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), false)?;

    stream.stdin_mut()?.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke:2", "active-initial").as_bytes(),
    )?;
    stream.stdin_mut()?.flush()?;

    let mut events = recv_until_result(&stream.rx, ACTIVE_INPUT_READY_RESULT)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success"]
    );

    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame_with_uuid("first", "follow-up-1").as_bytes())?;
    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame_with_uuid("second", "follow-up-2").as_bytes())?;
    stream.stdin_mut()?.flush()?;

    events.extend(recv_until_result(&stream.rx, "RESULT=first+second")?);
    stream.close_stdin();

    let (status, stderr) = stream.wait()?;
    assert!(status.success(), "expected success, stderr: {stderr}");
    assert!(stderr.is_empty());
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success", "result/success"]
    );

    let session_id = init_session_id(&events)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;
    assert_eq!(parse_jsonl(history.as_bytes())?, events);
    Ok(())
}

#[test]
fn active_input_ready_smoke_gates_readiness_on_first_followup()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), false)?;

    stream.stdin_mut()?.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke-ready:2", "active-initial")
            .as_bytes(),
    )?;
    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame_with_uuid("first", "follow-up-1").as_bytes())?;
    stream.stdin_mut()?.flush()?;

    let mut events = recv_until_result(&stream.rx, ACTIVE_INPUT_READY_RESULT)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success",]
    );

    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame_with_uuid("second", "follow-up-2").as_bytes())?;
    stream.stdin_mut()?.flush()?;
    events.extend(recv_until_result(&stream.rx, "RESULT=first+second")?);
    stream.close_stdin();

    let (status, stderr) = stream.wait()?;
    assert!(status.success(), "expected success, stderr: {stderr}");
    assert!(stderr.is_empty());

    let session_id = init_session_id(&events)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;
    assert_eq!(parse_jsonl(history.as_bytes())?, events);
    Ok(())
}

#[test]
fn active_input_ready_smoke_replays_first_followup_after_readiness()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), true)?;

    stream.stdin_mut()?.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke-ready:2", "active-initial")
            .as_bytes(),
    )?;
    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame_with_uuid("first", "follow-up-1").as_bytes())?;
    stream.stdin_mut()?.flush()?;

    let mut events = recv_until_result(&stream.rx, ACTIVE_INPUT_READY_RESULT)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "user/", "result/success"],
    );

    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame_with_uuid("second", "follow-up-2").as_bytes())?;
    stream.stdin_mut()?.flush()?;
    events.extend(recv_until_result(&stream.rx, "RESULT=first+second")?);
    stream.close_stdin();

    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "user/",
            "result/success",
            "user/",
            "user/",
            "result/success",
        ],
    );
    assert_eq!(
        events[3]
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("first")
    );

    let (status, stderr) = stream.wait()?;
    assert!(status.success(), "expected success, stderr: {stderr}");
    assert!(stderr.is_empty());

    let session_id = init_session_id(&events)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;
    assert_eq!(parse_jsonl(history.as_bytes())?, events);
    Ok(())
}

#[test]
fn active_input_ready_smoke_rejects_early_eof() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut command = mock_claude();
    command
        .env("HOME", home.path())
        .args([
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_managed_mock_child(&mut command)?;

    let Some(mut stdin) = child.take_stdin() else {
        child.terminate();
        return Err("missing stdin".into());
    };
    let write_result = stdin.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke-ready:2", "active-initial")
            .as_bytes(),
    );
    drop(stdin);
    if let Err(error) = write_result {
        child.terminate();
        return Err(error.into());
    }

    let output = wait_child_output(child)?;
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("active-input stdin closed after 0 of 2 follow-up user messages"),
        "unexpected stderr: {stderr}"
    );

    // Observe complete stdout through exit so a premature READY cannot go unnoticed.
    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init"]
    );
    Ok(())
}

#[test]
fn active_input_stream_replays_user_messages() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), true)?;

    stream.stdin_mut()?.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke:2", "active-initial").as_bytes(),
    )?;
    stream.stdin_mut()?.flush()?;

    let mut events = recv_until_result(&stream.rx, ACTIVE_INPUT_READY_RESULT)?;
    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame_with_uuid("first", "follow-up-1").as_bytes())?;
    stream
        .stdin_mut()?
        .write_all(stream_json_user_frame_with_uuid("second", "follow-up-2").as_bytes())?;
    stream.stdin_mut()?.flush()?;
    events.extend(recv_until_result(&stream.rx, "RESULT=first+second")?);
    stream.close_stdin();

    let (status, stderr) = stream.wait()?;
    assert!(status.success(), "expected success, stderr: {stderr}");
    assert!(stderr.is_empty());

    let session_id = init_session_id(&events)?;
    let replayed_users = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("user"))
        .map(|event| {
            (
                event.get("uuid").and_then(Value::as_str),
                event.pointer("/message/content").and_then(Value::as_str),
                event.get("session_id").and_then(Value::as_str),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        replayed_users
            .iter()
            .map(|(uuid, content, _)| (*uuid, *content))
            .collect::<Vec<_>>(),
        [
            (Some("active-initial"), Some("@active-input-smoke:2")),
            (Some("follow-up-1"), Some("first")),
            (Some("follow-up-2"), Some("second")),
        ]
    );
    assert!(
        replayed_users
            .iter()
            .all(|(_, _, replayed_session_id)| *replayed_session_id == Some(session_id.as_str()))
    );

    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;
    assert_eq!(parse_jsonl(history.as_bytes())?, events);
    Ok(())
}

#[test]
fn active_input_stream_rejects_early_eof() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), false)?;

    stream.stdin_mut()?.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke:2", "active-initial").as_bytes(),
    )?;
    stream.stdin_mut()?.flush()?;
    let _ = recv_until_result(&stream.rx, ACTIVE_INPUT_READY_RESULT)?;
    stream.close_stdin();

    let (status, stderr) = stream.wait()?;
    assert!(!status.success());
    assert!(
        stderr.contains("active-input stdin closed after 0 of 2 follow-up user messages"),
        "unexpected stderr: {stderr}"
    );
    Ok(())
}

#[test]
fn active_input_stream_rejects_non_user_followup() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), false)?;

    stream.stdin_mut()?.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke:1", "active-initial").as_bytes(),
    )?;
    stream.stdin_mut()?.flush()?;
    let _ = recv_until_result(&stream.rx, ACTIVE_INPUT_READY_RESULT)?;

    stream.stdin_mut()?.write_all(
        serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": "not a user frame",
            },
        })
        .to_string()
        .as_bytes(),
    )?;
    stream.stdin_mut()?.write_all(b"\n")?;
    stream.close_stdin();

    let (status, stderr) = stream.wait()?;
    assert!(!status.success());
    assert!(
        stderr.contains("stream-json stdin follow-up message 1 must have type \"user\""),
        "unexpected stderr: {stderr}"
    );
    Ok(())
}

#[test]
fn active_input_stream_rejects_invalid_followup_json() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), false)?;

    stream.stdin_mut()?.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke:1", "active-initial").as_bytes(),
    )?;
    stream.stdin_mut()?.flush()?;
    let _ = recv_until_result(&stream.rx, ACTIVE_INPUT_READY_RESULT)?;

    stream.stdin_mut()?.write_all(b"{\"type\":\"user\"\n")?;
    stream.close_stdin();

    let (status, stderr) = stream.wait()?;
    assert!(!status.success());
    assert!(
        stderr.contains("parse stream-json stdin follow-up message 1"),
        "unexpected stderr: {stderr}"
    );
    Ok(())
}

#[test]
fn active_input_invalid_large_count_drains_stderr() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut stream = spawn_stream_json_child(home.path(), false)?;
    let invalid_count = "x".repeat(128 * 1024);

    stream.stdin_mut()?.write_all(
        stream_json_user_frame_with_uuid(
            &format!("@active-input-smoke:{invalid_count}"),
            "active-initial",
        )
        .as_bytes(),
    )?;
    stream.close_stdin();

    let (status, stderr) = stream.wait()?;
    assert!(!status.success());
    assert!(
        stderr.contains("invalid @active-input-smoke follow-up count"),
        "unexpected stderr prefix: {}",
        stderr.chars().take(120).collect::<String>()
    );
    assert!(stderr.contains("(131072 bytes)"));
    assert!(!stderr.contains(&invalid_count));
    assert!(stderr.len() < 128);
    Ok(())
}
