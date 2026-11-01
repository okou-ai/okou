use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use uuid::Uuid;

/// Generate a mock session ID: `mock-{uuid-v7}`.
pub(crate) fn generate_session_id() -> String {
    format!("mock-{}", Uuid::now_v7())
}

/// Build the session history file path and create the directory.
///
/// Claude Code stores session history at: `{config_dir}/projects/-{path}/{session_id}.jsonl`
fn build_session_history_path(session_id: &str, config_dir: &str) -> Option<String> {
    if !is_valid_cli_agent_session_id(session_id) {
        return None;
    }

    let project_name = CANONICAL_WORKING_DIR
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = PathBuf::from(config_dir)
        .join("projects")
        .join(format!("-{project_name}"));

    if std::fs::create_dir_all(&session_dir).is_err() {
        return None;
    }

    Some(
        session_dir
            .join(format!("{session_id}.jsonl"))
            .to_string_lossy()
            .into_owned(),
    )
}

/// Create session history using Claude Code's effective config directory.
pub(crate) fn create_session_history(session_id: &str) -> Option<String> {
    let config_dir = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string()))
                .join(".claude")
                .to_string_lossy()
                .into_owned()
        });
    build_session_history_path(session_id, &config_dir)
}

#[derive(Default)]
pub(crate) struct JsonlTranscript {
    lines: Vec<String>,
}

impl JsonlTranscript {
    pub(crate) fn emit_value(&mut self, event: Value) {
        self.emit_raw_line(event.to_string());
    }

    pub(crate) fn emit_raw_line(&mut self, line: String) {
        println!("{line}");
        self.lines.push(line);
    }

    pub(crate) fn write_session_history(&self, session_id: &str) {
        if let Some(path) = create_session_history(session_id) {
            self.write_session_history_file(&path);
        }
    }

    pub(crate) fn write_session_history_file(&self, path: &str) {
        if let Ok(mut file) = std::fs::File::create(path) {
            for line in &self.lines {
                let _ = writeln!(file, "{line}");
            }
        }
    }
}

pub(crate) fn init_event(session_id: &str, tools: &[&str]) -> Value {
    json!({
        "type": "system",
        "subtype": "init",
        "cwd": CANONICAL_WORKING_DIR,
        "session_id": session_id,
        "tools": tools,
        "model": "mock-claude"
    })
}

pub(crate) fn result_event(session_id: &str, is_error: bool, result: &str) -> Value {
    json!({
        "type": "result",
        "subtype": if is_error { "error" } else { "success" },
        "session_id": session_id,
        "is_error": is_error,
        "duration_ms": 100,
        "num_turns": 1,
        "result": result,
        "total_cost_usd": 0,
        "usage": {"input_tokens": 0, "output_tokens": 0}
    })
}

pub(crate) fn assistant_text_event(session_id: &str, text: &str) -> Value {
    json!({
        "type": "assistant",
        "session_id": session_id,
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}]
        }
    })
}

pub(crate) fn tool_use_event(session_id: &str, id: &str, name: &str, input: Value) -> Value {
    json!({
        "type": "assistant",
        "session_id": session_id,
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }]
        }
    })
}

pub(crate) fn tool_result_event(
    session_id: &str,
    tool_use_id: &str,
    content: &str,
    is_error: bool,
) -> Value {
    json!({
        "type": "user",
        "session_id": session_id,
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error
            }]
        }
    })
}

pub(crate) fn replayed_user_event(session_id: &str, uuid: Option<&str>, content: &str) -> Value {
    json!({
        "type": "user",
        "session_id": session_id,
        "uuid": uuid,
        "message": {
            "role": "user",
            "content": content
        },
        "parent_tool_use_id": null
    })
}

#[cfg(test)]
mod tests;
