//! Translate one official stream-json turn into the Guest message/event contract.

use super::super::session_output::{AssistantTextStream, SessionOutputSender};
use crate::masker::SecretMasker;
use guest_contracts::diagnostics::FailureReason;
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use serde_json::{Value, json};
use sha2::Digest;
use std::collections::{HashMap, HashSet};
use std::fmt::Display;
use std::io;

struct TextStep<'a> {
    text: String,
    preview: Option<AssistantTextStream<'a>>,
}

pub(in crate::cli) struct Projection<'a> {
    model: &'a str,
    session: Option<String>,
    output: Option<SessionOutputSender>,
    masker: &'a SecretMasker,
    text: HashMap<u64, TextStep<'a>>,
    buffered: usize,
    tools: HashSet<u64>,
    completed: HashSet<u64>,
    last_text_digest: Option<[u8; 32]>,
    terminal: bool,
    // A completed tool can produce both a call and its result. The second
    // record is drained before the next provider record is read.
    pending: Option<Value>,
}

fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

impl<'a> Projection<'a> {
    pub(in crate::cli) fn new(
        model: &'a str,
        output: Option<SessionOutputSender>,
        masker: &'a SecretMasker,
    ) -> Self {
        Self {
            model,
            session: None,
            output,
            masker,
            text: HashMap::new(),
            buffered: 0,
            tools: HashSet::new(),
            completed: HashSet::new(),
            last_text_digest: None,
            terminal: false,
            pending: None,
        }
    }

    pub(in crate::cli) fn take_pending(&mut self) -> Option<Value> {
        self.pending.take()
    }

    pub(in crate::cli) fn project_line(&mut self, line: &str) -> io::Result<Option<Value>> {
        if line.trim().is_empty() {
            return Ok(None);
        }
        let mut value: Value =
            serde_json::from_str(line).map_err(|_| invalid("Invalid Antigravity JSON record"))?;
        let event = match value.get("event").and_then(Value::as_str) {
            Some("init") if !self.terminal && self.session.is_none() => {
                let id = value
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .filter(|s| uuid::Uuid::try_parse(s).is_ok())
                    .ok_or_else(|| invalid("Invalid Antigravity conversation ID"))?;
                if value.pointer("/init/model").and_then(Value::as_str) != Some(self.model) {
                    return Err(invalid(
                        "Antigravity started a different model than the assigned model",
                    ));
                }
                self.session = Some(id.to_owned());
                Some(json!({"type":"system","subtype":"init","session_id":id,"model":self.model}))
            }
            Some("step_update") if !self.terminal => self.step(
                value
                    .get_mut("step_update")
                    .ok_or_else(|| invalid("Missing Antigravity step update"))?,
            )?,
            Some("result") if !self.terminal => Some(
                self.result(
                    value
                        .get("result")
                        .ok_or_else(|| invalid("Missing Antigravity result"))?,
                )?,
            ),
            Some("init" | "step_update" | "result") => {
                return Err(invalid("Unexpected Antigravity record order"));
            }
            Some(_) => None,
            None => return Err(invalid("Missing Antigravity event type")),
        };
        Ok(event)
    }

    fn check_session(&self, record: &Value) -> io::Result<()> {
        let Some(session) = self.session.as_deref() else {
            return Err(invalid("Antigravity output before initialization"));
        };
        if record.get("conversation_id").and_then(Value::as_str) != Some(session) {
            return Err(invalid("Antigravity changed conversations during the Run"));
        }
        Ok(())
    }

    fn step(&mut self, step: &mut Value) -> io::Result<Option<Value>> {
        self.check_session(step)?;
        let kind = step.get("step_type").and_then(Value::as_str);
        if !matches!(kind, Some("agent_response" | "tool")) {
            return Ok(None);
        }
        let index = step
            .get("step_index")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("Invalid Antigravity step index"))?;
        let done = match step.get("state").and_then(Value::as_str) {
            Some("DONE") => true,
            Some("ACTIVE") => false,
            _ => return Ok(None),
        };
        if self.completed.contains(&index) {
            return Ok(None);
        }
        // Bound per-run bookkeeping even for a stream of empty tool/text steps.
        if self.completed.len() + self.text.len() + self.tools.len() >= 65_536 {
            return Err(invalid("Antigravity step count exceeded the guest limit"));
        }
        if done {
            self.completed.insert(index);
        }
        match kind {
            Some("agent_response") => self.text_step(
                index,
                step.get("text_delta").and_then(Value::as_str).unwrap_or(""),
                done,
            ),
            _ => self.tool_step(index, step, done),
        }
    }

    fn text_step(&mut self, index: u64, delta: &str, done: bool) -> io::Result<Option<Value>> {
        self.buffered += delta.len();
        if self.buffered > ORDINARY_CLI_STDOUT_MAX_LINE_BYTES {
            return Err(invalid(
                "Antigravity response exceeded the guest message limit",
            ));
        }
        let step = self.text.entry(index).or_insert_with(|| TextStep {
            text: String::new(),
            preview: self
                .output
                .clone()
                .map(|s| AssistantTextStream::new(s, self.masker)),
        });
        step.text.push_str(delta);
        if let Some(preview) = &mut step.preview {
            preview.push(0, delta);
        }
        if !done {
            return Ok(None);
        }
        let Some(step) = self.text.remove(&index) else {
            return Ok(None);
        };
        self.buffered -= step.text.len();
        if step.text.is_empty() {
            return Ok(None);
        }
        self.last_text_digest = Some(sha2::Sha256::digest(step.text.trim_end().as_bytes()).into());
        let mut event = self.assistant(index, json!({"type":"text","text":step.text}));
        if let (Some(preview), Some(fields)) = (step.preview, event.as_object_mut()) {
            fields.insert(
                "runEventId".into(),
                json!(format!("{}:0", preview.finish())),
            );
        }
        Ok(Some(event))
    }

    fn assistant(&self, suffix: impl Display, content: Value) -> Value {
        json!({"type":"assistant","message":{"id":format!("agy-{}-{suffix}",self.session.as_deref().unwrap_or_default()),"role":"assistant","model":self.model,"content":[content]}})
    }

    fn tool_step(&mut self, index: u64, step: &mut Value, done: bool) -> io::Result<Option<Value>> {
        let mut info = step
            .get_mut("tool_info")
            .map(Value::take)
            .unwrap_or_default();
        let name = info
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| step.get("tool_name").and_then(Value::as_str));
        let command = name == Some("run_command");
        // Some ACTIVE notifications precede the tool call details.
        if !done && (!info.get("parameters").is_some_and(Value::is_object) || name.is_none()) {
            return Ok(None);
        }
        let id = format!(
            "agy-{}-tool-{index}",
            self.session.as_deref().unwrap_or_default()
        );
        let call = if self.tools.insert(index) {
            let name = name
                .ok_or_else(|| invalid("Missing Antigravity tool name"))?
                .to_owned();
            let input = info
                .as_object_mut()
                .and_then(|fields| fields.remove("parameters"))
                .unwrap_or_else(|| json!({}));
            Some(self.assistant(
                index,
                json!({"type":"tool_use","id":id,"name":name,"input":input}),
            ))
        } else {
            None
        };
        if !done {
            return Ok(call);
        }
        self.tools.remove(&index);
        let tool_error = info.get("error").is_some_and(|error| !error.is_null());
        let content = if tool_error {
            info.pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Tool failed")
        } else {
            info.get("output").and_then(Value::as_str).unwrap_or("")
        };
        // 1.5.15 reports a terminal command's nonzero exit in the status
        // header; command output begins only after a blank line.
        let failed = tool_error
            || (command
                && content
                    .lines()
                    .take_while(|line| !line.is_empty())
                    .filter_map(|line| {
                        line.strip_prefix("Command exited with code ")?
                            .strip_suffix('.')?
                            .parse::<i32>()
                            .ok()
                    })
                    .any(|code| code != 0));
        let response = json!({"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":id,"content":content,"is_error":failed}]}});
        if call.is_some() {
            self.pending = Some(response);
            Ok(call)
        } else {
            Ok(Some(response))
        }
    }

    fn result(&mut self, result: &Value) -> io::Result<Value> {
        let failed = match result.get("status").and_then(Value::as_str) {
            Some("SUCCESS") => false,
            Some("ERROR") => true,
            _ => return Err(invalid("Unrecognized Antigravity terminal status")),
        };
        // agy can fail authentication before creating a conversation.
        if !failed || self.session.is_some() {
            self.check_session(result)?;
        }
        if !failed && (!self.text.is_empty() || !self.tools.is_empty()) {
            return Err(invalid("Antigravity completed with unfinished steps"));
        }
        self.terminal = true;
        let error = result.get("error").and_then(Value::as_str).unwrap_or("");
        let (reason, response) = if !failed {
            (
                None,
                result
                    .get("response")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("Missing Antigravity final response"))?,
            )
        } else if error.starts_with("authentication failed")
            || error.starts_with("authentication required")
        {
            (
                Some(FailureReason::InvalidCredentials),
                "Antigravity requires a signed-in Google account",
            )
        } else if error.starts_with("RESOURCE_EXHAUSTED")
            || error.starts_with("429 Too Many Requests")
        {
            (
                Some(FailureReason::ProviderRateLimited),
                "Google reported an Antigravity usage limit",
            )
        } else {
            // Provider errors can include live account challenges.
            (None, "Antigravity reported an execution error")
        };
        let mut fields = serde_json::Map::from_iter([
            ("type".into(), json!("result")),
            (
                "subtype".into(),
                json!(if failed { "error" } else { "success" }),
            ),
            ("is_error".into(), json!(failed)),
            ("result".into(), json!(response)),
            (
                "num_turns".into(),
                json!(result.get("num_turns").and_then(Value::as_u64)),
            ),
            ("session_id".into(), json!(self.session)),
        ]);
        if let Some(reason) = reason {
            fields.insert("failureReason".into(), json!(reason));
        }
        if let Some(usage) = result.get("usage").and_then(Value::as_object) {
            let tokens: serde_json::Map<_, _> = [
                "input_tokens",
                "output_tokens",
                "thinking_tokens",
                "cache_read_tokens",
                "total_tokens",
            ]
            .into_iter()
            .filter_map(|k| usage.get(k)?.as_u64().map(|v| (k.into(), json!(v))))
            .collect();
            fields.insert("usage".into(), Value::Object(tokens));
        }
        let event = Value::Object(fields);
        if !failed
            && !response.is_empty()
            && self.last_text_digest
                != Some(sha2::Sha256::digest(response.trim_end().as_bytes()).into())
        {
            self.pending = Some(event);
            return Ok(self.assistant("final", json!({"type":"text","text":response})));
        }
        Ok(event)
    }
}
