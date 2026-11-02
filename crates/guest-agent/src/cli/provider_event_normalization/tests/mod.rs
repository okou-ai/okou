use base64::Engine as _;
use guest_contracts::managed_command::render_managed_shell_command;
use serde_json::json;

use super::*;
use crate::events;
use crate::masker::SecretMasker;

fn claude_bash_event(command: &str) -> Value {
    json!({
        "type": "assistant",
        "message": {
            "id": "message-1",
            "content": [{
                "type": "tool_use",
                "id": "tool-1",
                "name": "Bash",
                "input": {
                    "command": command,
                    "description": "run the command"
                }
            }]
        }
    })
}

fn codex_command_event(event_type: &str, command: &str, status: &str) -> Value {
    json!({
        "type": event_type,
        "item": {
            "id": "command-1",
            "type": "command_execution",
            "command": command,
            "status": status,
            "aggregated_output": "command output",
            "exit_code": 0,
            "duration_ms": 42
        }
    })
}

fn normalized_command(framework: Framework, event: Value, path: &str) -> String {
    let events = normalize_for_sequencing(framework, event);
    assert_eq!(events.len(), 1);
    events[0]
        .pointer(path)
        .and_then(Value::as_str)
        .unwrap()
        .to_string()
}

#[test]
fn both_providers_restore_lossless_original_commands() {
    let commands = [
        "printf '%s\\n' one".to_string(),
        "printf \"%s\\n\" \"$HOME\"".to_string(),
        "printf '%s' '$LITERAL'".to_string(),
        "printf '%s' `uname`".to_string(),
        "printf one | sed 's/one/two/'; printf done".to_string(),
        "  leading and trailing  ".to_string(),
        "printf first\nprintf second".to_string(),
        "printf '你好，世界 🌍'".to_string(),
        "x".repeat(1024 * 1024),
    ];
    for command in commands {
        let managed = render_managed_shell_command(&command).unwrap();
        assert_eq!(
            normalized_command(
                Framework::ClaudeCode,
                claude_bash_event(&managed),
                "/message/content/0/input/command"
            ),
            command
        );
        let codex_outer = format!("/bin/bash -lc '{managed}'");
        assert_eq!(
            normalized_command(
                Framework::Codex,
                codex_command_event("item.started", &codex_outer, "in_progress"),
                "/item/command"
            ),
            command
        );
    }
}

#[test]
fn codex_started_and_terminal_events_keep_execution_fields() {
    let original = "printf complete";
    let managed = render_managed_shell_command(original).unwrap();
    for (event_type, status) in [
        ("item.started", "in_progress"),
        ("item.completed", "completed"),
    ] {
        let events = normalize_for_sequencing(
            Framework::Codex,
            codex_command_event(event_type, &managed, status),
        );
        assert_eq!(events.len(), 1);
        let item = &events[0]["item"];
        assert_eq!(item["command"], original);
        assert_eq!(item["status"], status);
        assert_eq!(item["aggregated_output"], "command output");
        assert_eq!(item["exit_code"], 0);
        assert_eq!(item["duration_ms"], 42);
    }
}

#[test]
fn restored_commands_are_masked_in_plain_and_encoded_forms() {
    let secret = "managed-command-secret";
    let encoded_secret = base64::engine::general_purpose::STANDARD.encode(secret);
    let original = format!("printf '%s' '{secret}' '{encoded_secret}'");
    let managed = render_managed_shell_command(&original).unwrap();
    let masker = SecretMasker::from_raw(&encoded_secret);

    for (framework, event, path) in [
        (
            Framework::ClaudeCode,
            claude_bash_event(&managed),
            "/message/content/0/input/command",
        ),
        (
            Framework::Codex,
            codex_command_event("item.completed", &managed, "completed"),
            "/item/command",
        ),
    ] {
        let event = normalize_for_sequencing(framework, event).remove(0);
        let delivered = events::prepare_event_for_delivery(event, 7, &masker);
        assert_eq!(
            delivered.pointer(path).and_then(Value::as_str),
            Some("printf '%s' '***' '***'")
        );
        let serialized = serde_json::to_string(&delivered).unwrap();
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains(&encoded_secret));
        assert!(!serialized.contains("guest-tool-exec"));
        assert!(!serialized.contains("vm0.command"));
    }
}

#[test]
fn invalid_managed_envelopes_fail_closed_for_both_providers() {
    let managed = render_managed_shell_command("printf safe").unwrap();
    let envelope_end = managed.find(" --shell ").unwrap();
    let invalid = [
        format!(
            "{}{}",
            &managed[..envelope_end - 1],
            &managed[envelope_end..]
        ),
        managed.replace(".v1.", ".v2."),
        managed.replace("vm0.command.v1.", "vm0.command.v1.*"),
        managed[..envelope_end].to_string(),
        format!(
            "exec {} --shell \"$0\"",
            guest_contracts::guest_binary::TOOL_EXEC_PATH
        ),
    ];
    for command in invalid {
        assert!(
            normalize_for_sequencing(Framework::ClaudeCode, claude_bash_event(&command)).is_empty()
        );
        assert!(
            normalize_for_sequencing(
                Framework::Codex,
                codex_command_event(
                    "item.completed",
                    &format!("/bin/bash -lc '{command}'"),
                    "completed"
                )
            )
            .is_empty()
        );
    }
}

#[test]
fn ordinary_commands_pass_through_and_one_invalid_claude_block_does_not_hide_siblings() {
    for (framework, event) in [
        (Framework::ClaudeCode, claude_bash_event("printf plain")),
        (
            Framework::Codex,
            codex_command_event("item.started", "printf plain", "in_progress"),
        ),
    ] {
        let path = match framework {
            Framework::ClaudeCode => "/message/content/0/input/command",
            Framework::Codex | Framework::Pi => "/item/command",
        };
        assert_eq!(normalized_command(framework, event, path), "printf plain");
    }

    let malformed = format!(
        "exec {} --command-envelope=vm0.command.v1.12.cHJpbnRm --shell \"$0\"",
        guest_contracts::guest_binary::TOOL_EXEC_PATH
    );
    let event = json!({
        "type": "assistant",
        "message": {
            "content": [
                { "type": "text", "text": "before" },
                {
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "Bash",
                    "input": { "command": malformed }
                },
                {
                    "type": "tool_use",
                    "id": "tool-2",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }
            ]
        }
    });
    let events = normalize_for_sequencing(Framework::ClaudeCode, event);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0].pointer("/message/content/0/type"),
        Some(&json!("text"))
    );
    assert_eq!(
        events[1].pointer("/message/content/0/name"),
        Some(&json!("Read"))
    );
}

#[test]
fn pi_singleton_block_lifts_its_native_run_event_id() {
    let events = normalize_for_sequencing(
        Framework::Pi,
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "text",
                    "text": "only",
                    "runEventId": "sandbox:response:4"
                }]
            }
        }),
    );
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["runEventId"], "sandbox:response:4");
    assert!(events[0].pointer("/message/content/0/runEventId").is_none());
}
