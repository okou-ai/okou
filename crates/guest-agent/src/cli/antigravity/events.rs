//! Translate Antigravity ACP notifications and prompt results into the Guest
//! message/event contract.

use std::collections::HashSet;

use guest_contracts::diagnostics::{FailureDetailSource, FailureReason};
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use serde_json::{Map, Value, json};

use crate::cli::CliFailureDiagnostic;
use crate::cli::session_output::{AssistantTextStream, SessionOutputSender};
use crate::error::AgentError;
use crate::masker::SecretMasker;

use super::acp::{AcpNotification, JsonRpcError};

const MAX_TOOL_CALLS: usize = 65_536;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct UsageTotals {
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) thinking_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) total_tokens: u64,
    pub(super) has_any: bool,
}

impl UsageTotals {
    pub(super) fn accumulate(&mut self, usage: &Value) {
        let Some(obj) = usage.as_object() else {
            return;
        };
        let mut observed = false;
        if let Some(v) = obj.get("inputTokens").and_then(Value::as_u64) {
            self.input_tokens = self.input_tokens.saturating_add(v);
            observed = true;
        }
        if let Some(v) = obj.get("outputTokens").and_then(Value::as_u64) {
            self.output_tokens = self.output_tokens.saturating_add(v);
            observed = true;
        }
        if let Some(v) = obj.get("thoughtTokens").and_then(Value::as_u64) {
            self.thinking_tokens = self.thinking_tokens.saturating_add(v);
            observed = true;
        }
        if let Some(v) = obj.get("cachedReadTokens").and_then(Value::as_u64) {
            self.cache_read_tokens = self.cache_read_tokens.saturating_add(v);
            observed = true;
        }
        if let Some(v) = obj.get("totalTokens").and_then(Value::as_u64) {
            self.total_tokens = self.total_tokens.saturating_add(v);
            observed = true;
        }
        if observed {
            self.has_any = true;
        }
    }

    pub(super) fn to_json(&self) -> Option<Value> {
        if !self.has_any {
            return None;
        }
        Some(json!({
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "thinking_tokens": self.thinking_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "total_tokens": self.total_tokens,
        }))
    }
}

struct ActiveText<'a> {
    text: String,
    preview: Option<AssistantTextStream<'a>>,
}

pub(super) struct EventProjector<'a> {
    model: &'a str,
    session_id: Option<String>,
    output: Option<SessionOutputSender>,
    masker: &'a SecretMasker,
    active_text: Option<ActiveText<'a>>,
    next_message_seq: u64,
    active_tools: HashSet<String>,
    completed_tools: HashSet<String>,
    last_text: String,
    usage: UsageTotals,
    completed_prompts: u64,
}

impl<'a> EventProjector<'a> {
    pub(super) fn new(
        model: &'a str,
        output: Option<SessionOutputSender>,
        masker: &'a SecretMasker,
    ) -> Self {
        Self {
            model,
            session_id: None,
            output,
            masker,
            active_text: None,
            next_message_seq: 0,
            active_tools: HashSet::new(),
            completed_tools: HashSet::new(),
            last_text: String::new(),
            usage: UsageTotals::default(),
            completed_prompts: 0,
        }
    }

    pub(super) fn begin_session(&mut self, session_id: String) -> Value {
        self.session_id = Some(session_id.clone());
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "model": self.model,
        })
    }

    pub(super) fn project_notification(
        &mut self,
        notification: &AcpNotification,
    ) -> Result<Vec<Value>, AgentError> {
        if notification.method != "session/update" {
            return Ok(Vec::new());
        }
        let Some(params) = notification.params.as_ref().and_then(Value::as_object) else {
            return Ok(Vec::new());
        };
        if let Some(expected) = self.session_id.as_deref()
            && let Some(actual) = params.get("sessionId").and_then(Value::as_str)
            && actual != expected
        {
            return Err(AgentError::Execution(
                "Antigravity changed sessions during the Run".into(),
            ));
        }
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            return Ok(Vec::new());
        };
        let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
            return Ok(Vec::new());
        };

        match kind {
            "agent_message_chunk" => {
                if let Some(delta) = extract_text_chunk(update) {
                    self.append_text_delta(delta)?;
                }
                Ok(Vec::new())
            }
            "tool_call" => self.handle_tool_call(update),
            "tool_call_update" => self.handle_tool_call_update(update),
            _ => Ok(Vec::new()),
        }
    }

    pub(super) fn record_prompt_response(&mut self, result: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        if let Some(text_event) = self.flush_active_text() {
            events.push(text_event);
        }
        if let Some(usage) = result.get("usage") {
            self.usage.accumulate(usage);
        }
        self.completed_prompts = self.completed_prompts.saturating_add(1);
        events
    }

    pub(super) fn finish_success(&mut self) -> Vec<Value> {
        let mut events = Vec::new();
        if let Some(text_event) = self.flush_active_text() {
            events.push(text_event);
        }
        let mut fields = Map::from_iter([
            ("type".into(), json!("result")),
            ("subtype".into(), json!("success")),
            ("is_error".into(), json!(false)),
            ("result".into(), json!(self.last_text)),
            ("num_turns".into(), json!(self.completed_prompts)),
            ("session_id".into(), json!(self.session_id)),
        ]);
        if let Some(usage) = self.usage.to_json() {
            fields.insert("usage".into(), usage);
        }
        events.push(Value::Object(fields));
        events
    }

    pub(super) fn finish_rpc_error(
        &mut self,
        error: &JsonRpcError,
    ) -> (Vec<Value>, CliFailureDiagnostic) {
        let mut events = Vec::new();
        if let Some(text_event) = self.flush_active_text() {
            events.push(text_event);
        }
        let (reason, safe_message) = classify_rpc_error(error);
        let mut fields = Map::from_iter([
            ("type".into(), json!("result")),
            ("subtype".into(), json!("error")),
            ("is_error".into(), json!(true)),
            ("result".into(), json!(safe_message)),
            ("num_turns".into(), json!(self.completed_prompts)),
            ("session_id".into(), json!(self.session_id)),
        ]);
        if let Some(reason) = reason {
            fields.insert("failureReason".into(), json!(reason));
        }
        if let Some(usage) = self.usage.to_json() {
            fields.insert("usage".into(), usage);
        }
        events.push(Value::Object(fields));
        let diagnostic = CliFailureDiagnostic {
            message: safe_message.to_string(),
            source: FailureDetailSource::AntigravityResult,
            failure_reason: reason,
            codex_failure: None,
        };
        (events, diagnostic)
    }

    pub(super) fn flush_active_text(&mut self) -> Option<Value> {
        let active = self.active_text.take()?;
        if active.text.is_empty() {
            return None;
        }
        self.last_text = active.text.clone();
        let mut event = self.assistant_event(json!({"type": "text", "text": active.text}));
        if let (Some(preview), Some(fields)) = (active.preview, event.as_object_mut()) {
            fields.insert(
                "runEventId".into(),
                json!(format!("{}:0", preview.finish())),
            );
        }
        Some(event)
    }

    fn append_text_delta(&mut self, delta: &str) -> Result<(), AgentError> {
        if delta.is_empty() {
            return Ok(());
        }
        let current_len = self.active_text.as_ref().map_or(0, |a| a.text.len());
        if current_len.saturating_add(delta.len()) > ORDINARY_CLI_STDOUT_MAX_LINE_BYTES {
            return Err(AgentError::Execution(
                "Antigravity response exceeded the guest message limit".into(),
            ));
        }
        let active = self.active_text.get_or_insert_with(|| ActiveText {
            text: String::new(),
            preview: self
                .output
                .clone()
                .map(|sender| AssistantTextStream::new(sender, self.masker)),
        });
        active.text.push_str(delta);
        if let Some(preview) = active.preview.as_mut() {
            preview.push(0, delta);
        }
        Ok(())
    }

    fn handle_tool_call(&mut self, update: &Map<String, Value>) -> Result<Vec<Value>, AgentError> {
        let mut events = Vec::new();
        if let Some(text_event) = self.flush_active_text() {
            events.push(text_event);
        }
        let Some(tool_call_id) = update.get("toolCallId").and_then(Value::as_str) else {
            return Err(AgentError::Execution(
                "Missing Antigravity toolCallId".into(),
            ));
        };
        if self.completed_tools.contains(tool_call_id) || self.active_tools.contains(tool_call_id) {
            return Ok(events);
        }
        if self.active_tools.len() + self.completed_tools.len() >= MAX_TOOL_CALLS {
            return Err(AgentError::Execution(
                "Antigravity tool call count exceeded the guest limit".into(),
            ));
        }
        let name = update
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::Execution("Missing Antigravity tool name".into()))?;
        let input = update
            .get("rawInput")
            .or_else(|| update.get("args"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        self.active_tools.insert(tool_call_id.to_owned());
        events.push(self.assistant_event(json!({
            "type": "tool_use",
            "id": tool_call_id,
            "name": name,
            "input": input,
        })));
        Ok(events)
    }

    fn handle_tool_call_update(
        &mut self,
        update: &Map<String, Value>,
    ) -> Result<Vec<Value>, AgentError> {
        let Some(tool_call_id) = update.get("toolCallId").and_then(Value::as_str) else {
            return Err(AgentError::Execution(
                "Missing Antigravity toolCallId".into(),
            ));
        };
        let status = update.get("status").and_then(Value::as_str);
        if !matches!(status, Some("completed" | "failed")) {
            return Ok(Vec::new());
        }
        if self.completed_tools.contains(tool_call_id) {
            return Ok(Vec::new());
        }

        let mut events = Vec::new();
        if !self.active_tools.remove(tool_call_id) {
            if let Some(text_event) = self.flush_active_text() {
                events.push(text_event);
            }
            if self.active_tools.len() + self.completed_tools.len() >= MAX_TOOL_CALLS {
                return Err(AgentError::Execution(
                    "Antigravity tool call count exceeded the guest limit".into(),
                ));
            }
            let name = update
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| AgentError::Execution("Missing Antigravity tool name".into()))?;
            let input = update
                .get("rawInput")
                .or_else(|| update.get("args"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            events.push(self.assistant_event(json!({
                "type": "tool_use",
                "id": tool_call_id,
                "name": name,
                "input": input,
            })));
        }
        self.completed_tools.insert(tool_call_id.to_owned());

        let is_error = status == Some("failed")
            || update
                .get("rawOutput")
                .and_then(|raw| raw.get("exit_code"))
                .and_then(Value::as_i64)
                .is_some_and(|code| code != 0);
        let content = extract_tool_output(update, is_error);
        events.push(json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": content,
                    "is_error": is_error,
                }]
            }
        }));
        Ok(events)
    }

    fn assistant_event(&mut self, content: Value) -> Value {
        let seq = self.next_message_seq;
        self.next_message_seq = self.next_message_seq.saturating_add(1);
        json!({
            "type": "assistant",
            "message": {
                "id": format!("agy-{}-{seq}", self.session_id.as_deref().unwrap_or_default()),
                "role": "assistant",
                "model": self.model,
                "content": [content],
            }
        })
    }
}

fn extract_text_chunk(update: &Map<String, Value>) -> Option<&str> {
    let content = update.get("content")?.as_object()?;
    if content.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    content.get("text").and_then(Value::as_str)
}

fn extract_tool_output(update: &Map<String, Value>, is_error: bool) -> String {
    if let Some(raw) = update.get("rawOutput") {
        if let Some(output) = raw.get("output").and_then(Value::as_str) {
            return output.to_owned();
        }
        if let Some(error_msg) = raw.get("error").and_then(Value::as_str) {
            return error_msg.to_owned();
        }
    }
    if let Some(items) = update.get("content").and_then(Value::as_array) {
        let mut combined = String::new();
        for item in items {
            if let Some(text) = item
                .pointer("/content/text")
                .and_then(Value::as_str)
                .or_else(|| item.get("text").and_then(Value::as_str))
            {
                combined.push_str(text);
            }
        }
        if !combined.is_empty() {
            return combined;
        }
    }
    if is_error {
        "Tool failed".to_owned()
    } else {
        String::new()
    }
}

fn classify_rpc_error(error: &JsonRpcError) -> (Option<FailureReason>, &'static str) {
    let msg_lower = error.message.to_ascii_lowercase();
    if msg_lower.starts_with("authentication required")
        || msg_lower.starts_with("authentication failed")
    {
        (
            Some(FailureReason::InvalidCredentials),
            "Antigravity requires a signed-in Google account",
        )
    } else if error.message.starts_with("RESOURCE_EXHAUSTED")
        || error.message.starts_with("429 Too Many Requests")
    {
        (
            Some(FailureReason::ProviderRateLimited),
            "Google reported an Antigravity usage limit",
        )
    } else {
        (None, "Antigravity reported an execution error")
    }
}
