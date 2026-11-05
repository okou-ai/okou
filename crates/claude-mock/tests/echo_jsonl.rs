pub mod support;

use std::fs;

use support::{expected_history_path, mock_claude, run_mock_output};

#[test]
fn echo_jsonl_outputs_valid_payload_unchanged() -> Result<(), Box<dyn std::error::Error>> {
    let payload = [
        r#"{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"preview-1","tools":["Bash"],"model":"mock-claude"}"#,
        r#"{"type":"assistant","session_id":"preview-1","message":{"role":"assistant","content":[{"type":"text","text":"fixture response"}]}}"#,
        r#"{"type":"result","subtype":"success","session_id":"preview-1","is_error":false,"duration_ms":100,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}"#,
    ]
    .join("\n");
    for file_backed in [false, true] {
        let home = tempfile::tempdir()?;
        let prompt = if file_backed {
            let path = home.path().join("echo fixture 世界.jsonl");
            fs::write(&path, format!("{payload}\n"))?;
            format!("@ECHO-FILE@\n{}", path.display())
        } else {
            format!("@ECHO@\n{payload}\n")
        };

        let mut command = mock_claude();
        command
            .env("HOME", home.path())
            .args(["--output-format", "stream-json", "--", &prompt]);
        let output = run_mock_output(&mut command)?;

        assert!(
            output.status.success(),
            "expected success, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("{payload}\n")
        );
        assert!(output.stderr.is_empty());

        let history = fs::read_to_string(expected_history_path(home.path(), "preview-1"))?;
        assert_eq!(history, format!("{payload}\n"));
    }
    Ok(())
}

#[test]
fn file_echo_rejects_missing_input_before_output_or_history()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!(
        "@ECHO-FILE@\n{}",
        home.path().join("missing.jsonl").display()
    );
    let mut command = mock_claude();
    command
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", &prompt]);
    let output = run_mock_output(&mut command)?;
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("read @ECHO-FILE@ input:"));
    assert!(!home.path().join(".claude").exists());
    Ok(())
}

#[test]
fn echo_jsonl_without_init_skips_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let payload = r#"{"type":"assistant","session_id":"preview-no-init","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#;
    let prompt = format!("@ECHO@\n{payload}\n");

    let mut command = mock_claude();
    command
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", &prompt]);
    let output = run_mock_output(&mut command)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{payload}\n")
    );
    assert!(output.stderr.is_empty());
    assert!(!home.path().join(".claude").exists());
    Ok(())
}

#[test]
fn echo_jsonl_rejects_non_contract_session_ids_without_writing_history()
-> Result<(), Box<dyn std::error::Error>> {
    for session_id in ["../escape", "session.with.dot"] {
        let home = tempfile::tempdir()?;
        let payload = format!(
            r#"{{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"{session_id}","tools":["Bash"],"model":"mock-claude"}}"#
        );
        let prompt = format!("@ECHO@\n{payload}\n");

        let mut command = mock_claude();
        command
            .env("HOME", home.path())
            .args(["--output-format", "stream-json", "--", &prompt]);
        let output = run_mock_output(&mut command)?;

        assert!(!output.status.success());
        assert!(
            output.stdout.is_empty(),
            "expected empty stdout, got: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("invalid @ECHO@ session_id"));
        assert!(stderr.contains(session_id));
        assert!(
            !home.path().join(".claude").exists(),
            "rejected session id must not create history directories: {session_id:?}"
        );
    }
    Ok(())
}

#[test]
fn echo_jsonl_rejects_invalid_json_line() -> Result<(), Box<dyn std::error::Error>> {
    let mut command = mock_claude();
    command.args(["--output-format", "stream-json", "--", "@ECHO@\n{\"type\""]);
    let output = run_mock_output(&mut command)?;

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid @ECHO@ JSONL line 2"));
    Ok(())
}

#[test]
fn echo_jsonl_rejects_empty_payload() -> Result<(), Box<dyn std::error::Error>> {
    let mut command = mock_claude();
    command.args(["--output-format", "stream-json", "--", "@ECHO@\n\n"]);
    let output = run_mock_output(&mut command)?;

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("@ECHO@ payload must contain at least one JSONL event")
    );
    Ok(())
}
