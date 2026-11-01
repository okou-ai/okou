use super::*;
use base64::Engine;

#[test]
fn execution_stderr_preserves_primary_error_and_escapes_controls() {
    let error = with_stderr_tail(
        AgentError::Execution("initialize failed".to_string()),
        &["第一行\r\u{1b}".to_string(), "second\tline".to_string()],
    );
    assert_eq!(
        error.to_string(),
        "execution: initialize failed; stderr tail: 第一行\\r\\u{1b}\\nsecond\\tline"
    );
}

#[test]
fn execution_stderr_bounds_rendered_controls_and_unicode() {
    for character in ['界', '\u{1b}', '\n'] {
        let error = with_stderr_tail(
            AgentError::Execution("initialize failed".to_string()),
            &[format!(
                "{}last diagnostic",
                character.to_string().repeat(5000)
            )],
        );
        let message = error.to_string();
        let (_, tail) = message.split_once("; stderr tail: ").unwrap();
        assert!(tail.len() <= 4096);
        assert!(tail.starts_with("[truncated] "));
        assert!(tail.ends_with("last diagnostic"));
        assert!(!tail.chars().any(char::is_control));
    }
}

#[test]
fn execution_stderr_masks_multiline_secrets_before_tail_truncation() {
    let secret = "secret-first-line\nsecret-second-line";
    let encoded_secret = base64::engine::general_purpose::STANDARD.encode(secret);
    let masker = SecretMasker::from_raw(&encoded_secret);
    // Raw tail truncation here would cut through the secret, leaving only a
    // suffix that the ordinary complete-secret matcher could not recognize.
    let lines = format!(
        "{}\n{secret}\n{}",
        "older context".repeat(400),
        "x".repeat(4060)
    )
    .lines()
    .map(str::to_string)
    .collect();
    let masked = masker.mask_diagnostic_lines(lines);
    let error = with_stderr_tail(
        AgentError::Execution("initialize failed".to_string()),
        &masked,
    );
    let message = error.to_string();
    assert!(!message.contains("first-line"));
    assert!(!message.contains("second-line"));
    assert!(message.contains("***"));
    assert!(message.ends_with(&"x".repeat(4060)));
}

#[test]
fn execution_stderr_leaves_empty_tail_and_typed_failure_unchanged() {
    let error = with_stderr_tail(AgentError::Execution("initialize failed".to_string()), &[]);
    assert_eq!(error.to_string(), "execution: initialize failed");
    let error = with_stderr_tail(
        AgentError::CodexInputTooLarge {
            actual_chars: 100,
            max_chars: 50,
        },
        &["secondary diagnostic".to_string()],
    );
    assert!(matches!(
        error,
        AgentError::CodexInputTooLarge {
            actual_chars: 100,
            max_chars: 50
        }
    ));
}

#[test]
fn active_input_is_read_only_after_source_and_turn_are_ready() {
    assert!(!can_read_active_input(false, false));
    assert!(!can_read_active_input(false, true));
    assert!(!can_read_active_input(true, false));
    assert!(can_read_active_input(true, true));
}

#[test]
fn codex_agent_message_text_reads_completed_agent_message_only() {
    let agent_message = json!({
        "type": "item.completed",
        "item": {
            "type": "agent_message",
            "text": "RESULT=ok"
        }
    });
    let plan_message = json!({
        "type": "item.completed",
        "item": {
            "type": "plan",
            "text": "not final output"
        }
    });
    let started_agent_message = json!({
        "type": "item.started",
        "item": {
            "type": "agent_message",
            "text": "not completed"
        }
    });

    assert_eq!(codex_agent_message_text(&agent_message), Some("RESULT=ok"));
    assert_eq!(codex_agent_message_text(&plan_message), None);
    assert_eq!(codex_agent_message_text(&started_agent_message), None);
}
