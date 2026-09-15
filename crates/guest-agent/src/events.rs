//! Event sending — forwards masked JSONL events to the webhook endpoint.
//!
//! Captures framework session metadata for checkpoint use and prepares masked
//! event payloads for webhook delivery.

use crate::constants;
use crate::env::{Framework, GuestConfig};
use crate::error::AgentError;
use crate::failure_patterns::{
    has_exact_codex_oauth_connector, is_codex_chatgpt_account_unsupported_model_message,
    is_codex_context_window_exceeded_message, is_codex_model_capacity_message,
    is_content_policy_rejection_message,
};
use crate::http::{HttpAttemptObserver, HttpClient};
use crate::masker::SecretMasker;
use crate::paths;
use crate::session_metadata::{self, SessionHistoryLaunchSource, SessionMetadataStore};
use bytes::Bytes;
use guest_contracts::diagnostics::FailureReason;
use serde_json::{Map, Value, json};

const FAILURE_DIAGNOSTIC_MAX_BYTES: usize = 4096;
const FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX: &str = "...[truncated]";
const EVENT_PAYLOAD_RUN_ID_PREFIX: &[u8] = b"{\"runId\":";
const EVENT_PAYLOAD_EVENTS_PREFIX: &[u8] = b",\"events\":[";
const EVENT_PAYLOAD_EVENTS_SUFFIX: &[u8] = b"]";
const EVENT_PAYLOAD_PUBLIC_SUFFIX: &[u8] = b"}";
const PI_MEMORY_CITATION_TRANSPORT_PREFIX: &[u8] =
    b",\"piMemoryCitationTransport\":{\"schemaVersion\":1,\"citations\":[";
const PI_MEMORY_CITATION_TRANSPORT_SUFFIX: &[u8] = b"]}}";

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CodexFailureDiagnostic {
    pub event_type: &'static str,
    pub message: String,
    pub failure_reason: Option<FailureReason>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct JsonlResultFailureDiagnostic {
    pub subtype: Option<&'static str>,
    pub message: String,
}

/// Send a single event using an explicit guest-agent runtime snapshot.
///
/// Captures session metadata using the provided config and paths before
/// preparing and posting the webhook payload.
pub async fn send_event_for_config(
    http: &HttpClient,
    event: Value,
    seq: u32,
    masker: &SecretMasker,
    config: &GuestConfig,
    paths: &paths::GuestPaths,
) -> Result<(), AgentError> {
    let capture = SessionMetadataCapture::new(
        SessionHistoryLaunchSource::for_config(config),
        SessionMetadataStore::default(),
        paths.session_id_file(),
    );
    capture.capture_event(&event);

    if !http.has_api() {
        return Ok(());
    }

    let payload = prepare_event_payload_for_run_id(event, seq, masker, &config.run_id);
    post_event(http, &payload).await
}

/// Prepare one event for delivery in a `runId` envelope.
///
/// Event-controlled content is masked before the system-owned
/// `sequenceNumber` is added. The sequence number is added only when the event
/// is a JSON object. The returned payload contains exactly one event under the
/// supplied `run_id`.
///
/// This helper only prepares the payload; it does not capture session metadata
/// or perform network I/O. Use [`send_event_for_config`] for the normal path
/// that captures metadata, prepares the payload, and posts the event.
pub fn prepare_event_payload_for_run_id(
    event: Value,
    seq: u32,
    masker: &SecretMasker,
    run_id: &str,
) -> Value {
    let event = prepare_event_for_delivery(event, seq, masker);
    event_payload_for_run_id(vec![event], run_id)
}

pub(crate) fn prepare_event_for_delivery(
    mut event: Value,
    seq: u32,
    masker: &SecretMasker,
) -> Value {
    // Mask event-controlled content before adding system-owned fields.
    masker.mask_value(&mut event);

    // Add sequence number
    if let Some(obj) = event.as_object_mut() {
        obj.insert("sequenceNumber".to_string(), json!(seq));
    }

    event
}

pub(crate) fn event_payload_for_run_id(events: Vec<Value>, run_id: &str) -> Value {
    let mut payload = Map::new();
    payload.insert("runId".to_string(), Value::String(run_id.to_string()));
    payload.insert("events".to_string(), Value::Array(events));
    Value::Object(payload)
}

pub(crate) struct EventPayloadEnvelope {
    prefix: Bytes,
    pi_memory_citation_transport: bool,
}

impl EventPayloadEnvelope {
    pub(crate) fn new(
        run_id: &str,
        pi_memory_citation_transport: bool,
    ) -> Result<Self, AgentError> {
        let run_id = serde_json::to_vec(run_id)?;
        let mut prefix = Vec::with_capacity(
            EVENT_PAYLOAD_RUN_ID_PREFIX.len() + run_id.len() + EVENT_PAYLOAD_EVENTS_PREFIX.len(),
        );
        prefix.extend_from_slice(EVENT_PAYLOAD_RUN_ID_PREFIX);
        prefix.extend_from_slice(&run_id);
        prefix.extend_from_slice(EVENT_PAYLOAD_EVENTS_PREFIX);
        Ok(Self {
            prefix: Bytes::from(prefix),
            pi_memory_citation_transport,
        })
    }

    pub(crate) fn take_private_citation(
        &self,
        sequence: u32,
        event: &mut Value,
    ) -> Result<Option<Bytes>, AgentError> {
        if !self.pi_memory_citation_transport {
            return Ok(None);
        }
        let Some(event_fields) = event.as_object_mut() else {
            return Ok(None);
        };
        let event_citation = event_fields.remove("memoryCitation");
        let message_citation = event_fields
            .get_mut("message")
            .and_then(Value::as_object_mut)
            .and_then(|message| message.remove("memoryCitation"));
        let Some(citation) = message_citation.or(event_citation) else {
            return Ok(None);
        };
        Ok(Some(Bytes::from(serde_json::to_vec(&json!({
            "sequenceNumber": sequence,
            "citation": citation,
        }))?)))
    }

    pub(crate) fn singleton_bytes(
        &self,
        event_bytes: usize,
        private_citation_bytes: usize,
    ) -> usize {
        self.prefix
            .len()
            .saturating_add(event_bytes)
            .saturating_add(EVENT_PAYLOAD_EVENTS_SUFFIX.len())
            .saturating_add(if self.pi_memory_citation_transport {
                PI_MEMORY_CITATION_TRANSPORT_PREFIX
                    .len()
                    .saturating_add(private_citation_bytes)
                    .saturating_add(PI_MEMORY_CITATION_TRANSPORT_SUFFIX.len())
            } else {
                EVENT_PAYLOAD_PUBLIC_SUFFIX.len()
            })
    }

    pub(crate) fn payload(&self, events: &[Bytes], private_citations: &[Bytes]) -> Bytes {
        let event_bytes = events.iter().map(Bytes::len).sum::<usize>();
        let event_separators = events.len().saturating_sub(1);
        let private_citation_bytes = private_citations.iter().map(Bytes::len).sum::<usize>();
        let private_citation_separators = private_citations.len().saturating_sub(1);
        let mut payload = Vec::with_capacity(
            self.prefix.len()
                + event_bytes
                + event_separators
                + EVENT_PAYLOAD_EVENTS_SUFFIX.len()
                + if self.pi_memory_citation_transport {
                    PI_MEMORY_CITATION_TRANSPORT_PREFIX.len()
                        + private_citation_bytes
                        + private_citation_separators
                        + PI_MEMORY_CITATION_TRANSPORT_SUFFIX.len()
                } else {
                    EVENT_PAYLOAD_PUBLIC_SUFFIX.len()
                },
        );
        payload.extend_from_slice(&self.prefix);
        let mut needs_separator = false;
        for event in events {
            if needs_separator {
                payload.push(b',');
            }
            payload.extend_from_slice(event);
            needs_separator = true;
        }
        payload.extend_from_slice(EVENT_PAYLOAD_EVENTS_SUFFIX);
        if self.pi_memory_citation_transport {
            payload.extend_from_slice(PI_MEMORY_CITATION_TRANSPORT_PREFIX);
            needs_separator = false;
            for citation in private_citations {
                if needs_separator {
                    payload.push(b',');
                }
                payload.extend_from_slice(citation);
                needs_separator = true;
            }
            payload.extend_from_slice(PI_MEMORY_CITATION_TRANSPORT_SUFFIX);
        } else {
            payload.extend_from_slice(EVENT_PAYLOAD_PUBLIC_SUFFIX);
        }
        Bytes::from(payload)
    }
}

/// Extract a secret-masked Codex failure diagnostic from a compatibility event.
///
/// The Codex app-server adapter reports terminal failures as compatibility
/// JSONL (`type=error` or failed/interrupted `type=turn.completed`), while the
/// guest-agent process failure summary is built from stderr. Logging these
/// events into the system log preserves the real failure reason when stderr
/// only contains side-channel background-task noise.
pub(crate) fn masked_codex_failure_diagnostic(
    event: &Value,
    masker: &SecretMasker,
) -> Option<CodexFailureDiagnostic> {
    let diagnostic = extract_codex_failure_diagnostic(event)?;
    Some(CodexFailureDiagnostic {
        event_type: diagnostic.event_type,
        message: mask_and_truncate_diagnostic(&diagnostic.message, masker),
        failure_reason: diagnostic.failure_reason,
    })
}

/// Extract a secret-masked terminal JSONL result failure diagnostic.
///
/// JSONL CLI backends report the terminal run outcome as `type=result`. On
/// failure, the `result` field carries the concise terminal reason that is
/// otherwise lost when stderr is empty.
pub(crate) fn masked_jsonl_result_failure_diagnostic(
    event: &Value,
    masker: &SecretMasker,
) -> Option<JsonlResultFailureDiagnostic> {
    let diagnostic = extract_jsonl_result_failure_diagnostic(event)?;
    Some(JsonlResultFailureDiagnostic {
        subtype: diagnostic.subtype,
        message: mask_and_truncate_diagnostic(&diagnostic.message, masker),
    })
}

fn extract_codex_failure_diagnostic(event: &Value) -> Option<CodexFailureDiagnostic> {
    match event.get("type").and_then(Value::as_str)? {
        "error" => {
            let error = event.get("error");
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: raw_message_from_field(event.get("message"))
                    .unwrap_or_else(|| "error".into()),
                failure_reason: codex_error_failure_reason(error),
            })
        }
        "turn.completed" => {
            let status = codex_turn_completed_failure_status(event)?;
            let turn_error = event
                .pointer("/turn/error")
                .filter(|error| !error.is_null());
            Some(CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: codex_error_message(turn_error)
                    .unwrap_or_else(|| format!("turn {status}")),
                failure_reason: codex_error_failure_reason(turn_error),
            })
        }
        _ => None,
    }
}

fn extract_jsonl_result_failure_diagnostic(event: &Value) -> Option<JsonlResultFailureDiagnostic> {
    if event.get("type").and_then(Value::as_str)? != "result" {
        return None;
    }

    let raw_subtype = event.get("subtype").and_then(Value::as_str);
    let subtype = match raw_subtype {
        Some("error") => Some("error"),
        _ => None,
    };
    let is_failure = event.get("is_error").and_then(Value::as_bool) == Some(true)
        || raw_subtype == Some("error");
    if !is_failure {
        return None;
    }

    Some(JsonlResultFailureDiagnostic {
        subtype,
        message: raw_message_from_field(event.get("result"))?,
    })
}

fn codex_turn_completed_failure_status(event: &Value) -> Option<&'static str> {
    let status = event.pointer("/turn/status").and_then(Value::as_str)?;
    match status {
        "failed" => Some("failed"),
        "interrupted" => Some("interrupted"),
        _ => None,
    }
}

fn codex_error_message(error: Option<&Value>) -> Option<String> {
    let error = error?;
    if let Some(message) = raw_message_from_field(Some(error)) {
        return Some(message);
    }

    let message = error.get("message").and_then(Value::as_str);
    let details = error.get("additional_details").and_then(Value::as_str);
    combined_message_and_details(message, details)
}

fn codex_error_failure_reason(error: Option<&Value>) -> Option<FailureReason> {
    let error = error?;
    if error.get("code").and_then(Value::as_str) == Some("invalid_api_key") {
        return Some(FailureReason::InvalidApiKey);
    }
    if codex_refresh_error_code(error) == Some("TOKEN_REFRESH_FAILED")
        && error.get("failureReason").and_then(Value::as_str) == Some("reconnect_required")
        && has_exact_codex_oauth_connector(error)
    {
        return Some(FailureReason::ReconnectRequired);
    }
    if let Some(failure_reason) = codex_error_info_failure_reason(error) {
        return Some(failure_reason);
    }
    if codex_error_message(Some(error))
        .as_deref()
        .is_some_and(is_content_policy_rejection_message)
    {
        return Some(FailureReason::SafetyPolicyRefusal);
    }
    if codex_error_message(Some(error))
        .as_deref()
        .is_some_and(is_codex_model_capacity_message)
    {
        return Some(FailureReason::ProviderOverloaded);
    }
    if codex_error_message(Some(error))
        .as_deref()
        .is_some_and(is_codex_context_window_exceeded_message)
    {
        return Some(FailureReason::ContextWindowExceeded);
    }
    if codex_error_message(Some(error))
        .as_deref()
        .is_some_and(is_codex_chatgpt_account_unsupported_model_message)
    {
        return Some(FailureReason::UnsupportedModel);
    }
    None
}

fn codex_error_info_failure_reason(error: &Value) -> Option<FailureReason> {
    match codex_error_info_variant(error)? {
        "contextWindowExceeded" => Some(FailureReason::ContextWindowExceeded),
        "rateLimitExceeded" => Some(FailureReason::ProviderRateLimited),
        "serverOverloaded" => Some(FailureReason::ProviderOverloaded),
        "responseStreamConnectionFailed" | "responseStreamDisconnected" => {
            Some(FailureReason::ResponseConnectionLost)
        }
        "usageLimitExceeded" => Some(FailureReason::UsageLimit),
        "cyberPolicy" | "misalignmentPolicyViolation" => Some(FailureReason::SafetyPolicyRefusal),
        _ => None,
    }
}

fn codex_error_info_variant(error: &Value) -> Option<&str> {
    let error_info = error.get("codex_error_info")?;

    match error_info {
        Value::String(variant) => Some(variant.as_str()),
        Value::Object(object) if object.len() == 1 => object.keys().next().map(String::as_str),
        _ => None,
    }
}

fn codex_refresh_error_code(value: &Value) -> Option<&str> {
    value
        .get("code")
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
}

fn raw_message_from_field(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(trimmed_message)
}

fn combined_message_and_details(message: Option<&str>, details: Option<&str>) -> Option<String> {
    match (
        message.and_then(trimmed_message),
        details.and_then(trimmed_message),
    ) {
        (Some(message), Some(details)) => Some(format!("{message} ({details})")),
        (Some(message), None) => Some(message),
        (None, Some(details)) => Some(details),
        (None, None) => None,
    }
}

fn trimmed_message(message: &str) -> Option<String> {
    let message = message.trim();
    if message.is_empty() {
        return None;
    }

    Some(message.to_string())
}

fn mask_and_truncate_diagnostic(message: &str, masker: &SecretMasker) -> String {
    truncate_diagnostic_message(&escape_log_line_breaks(&masker.mask_string(message)))
}

fn escape_log_line_breaks(message: &str) -> String {
    message.replace('\r', "\\r").replace('\n', "\\n")
}

fn truncate_diagnostic_message(message: &str) -> String {
    if message.len() <= FAILURE_DIAGNOSTIC_MAX_BYTES {
        return message.to_string();
    }

    let mut end = FAILURE_DIAGNOSTIC_MAX_BYTES - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len();
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &message[..end], FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX)
}

/// Post an already-prepared event payload to the configured events endpoint.
///
/// The payload is serialized and sent using the existing
/// `HTTP_MAX_ATTEMPTS` retry policy. This function does not mask payload
/// content or capture session metadata, and successful HTTP responses are
/// accepted without parsing their response bodies. Use
/// [`send_event_for_config`] for the normal path that captures metadata,
/// masks the event, prepares the envelope, and posts it.
pub async fn post_event(http: &HttpClient, payload: &Value) -> Result<(), AgentError> {
    let url = http.events_url()?;
    let payload = Bytes::from(serde_json::to_vec(payload)?);
    http.post_event_bytes(url, payload, constants::HTTP_MAX_ATTEMPTS, None)
        .await
}

pub(crate) async fn post_serialized_event(
    http: &HttpClient,
    payload: Bytes,
    observer: &dyn HttpAttemptObserver,
) -> Result<(), AgentError> {
    let url = http.events_url()?;
    http.post_event_bytes(url, payload, constants::HTTP_MAX_ATTEMPTS, Some(observer))
        .await
}

/// Tool event extracted from a Claude Code JSONL line.
#[derive(Debug, PartialEq)]
pub(crate) enum ClaudeToolEvent<'a> {
    /// Tool invocation: `(tool_use_id, tool_name)`.
    Use { id: &'a str, name: &'a str },
    /// Tool result: `(tool_use_id)`.
    Result { tool_use_id: &'a str },
}

/// Extract tool call info from a Claude Code JSONL event.
///
/// Iterates all content blocks (handles `[text, tool_use]` and parallel
/// `[tool_use, tool_use]` patterns).  Returns an empty vec for non-tool
/// events.
pub(crate) fn extract_claude_tool_info(event: &Value) -> Vec<ClaudeToolEvent<'_>> {
    let Some(contents) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    let mut results = Vec::new();
    for content in contents {
        let Some(content_type) = content.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        match content_type {
            "tool_use" => {
                if let (Some(id), Some(name)) = (
                    content.get("id").and_then(|v| v.as_str()),
                    content.get("name").and_then(|v| v.as_str()),
                ) {
                    results.push(ClaudeToolEvent::Use { id, name });
                }
            }
            "tool_result" => {
                if let Some(tool_use_id) = content.get("tool_use_id").and_then(|v| v.as_str()) {
                    results.push(ClaudeToolEvent::Result { tool_use_id });
                }
            }
            _ => {}
        }
    }
    results
}

/// Capture session metadata needed by checkpoint.
///
/// Both frameworks emit a single id-bearing event near the top of their
/// JSONL stream:
/// - Claude Code: `{type: system, subtype: init, session_id: <uuid>}`
/// - Codex:       `{type: thread.started, thread_id: <uuid>}`
/// - Pi:          `{type: system, subtype: init, session_id: <chat-thread-id>, session_file: <path>}`
///
pub(crate) struct SessionMetadataCapture {
    framework: Framework,
    capture: session_metadata::SessionMetadataCapture,
}

impl SessionMetadataCapture {
    pub(crate) fn new(
        launch_source: SessionHistoryLaunchSource,
        store: SessionMetadataStore,
        session_id_file: &str,
    ) -> Self {
        let framework = launch_source.framework();
        Self {
            framework,
            capture: session_metadata::SessionMetadataCapture::new(
                launch_source,
                store,
                session_id_file,
            ),
        }
    }

    pub(crate) fn capture_event(&self, event: &Value) {
        let session_id = match self.framework {
            Framework::ClaudeCode => extract_claude_session_id(event),
            Framework::Codex => extract_codex_thread_id(event),
            Framework::Pi => extract_claude_session_id(event),
        };
        let Some(session_id) = session_id else {
            return;
        };
        match self.framework {
            Framework::Pi => self
                .capture
                .capture_pi_session_id(&session_id, string_field(event, "session_file")),
            Framework::ClaudeCode | Framework::Codex => {
                self.capture.capture_session_id(&session_id);
            }
        }
    }
}

fn string_field<'a>(event: &'a Value, field: &str) -> Option<&'a str> {
    event
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// Claude variant — matches `system/init` and returns the raw Claude session id.
fn extract_claude_session_id(event: &Value) -> Option<String> {
    raw_claude_session_id(event).map(ToString::to_string)
}

fn raw_claude_session_id(event: &Value) -> Option<&str> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let subtype = event.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
    if event_type != "system" || subtype != "init" {
        return None;
    }
    string_field(event, "session_id")
}

/// Codex variant — matches `thread.started` and returns the canonical Codex
/// thread id.
fn extract_codex_thread_id(event: &Value) -> Option<String> {
    let thread_id = raw_codex_thread_id(event)?;
    guest_contracts::codex_thread_id::canonical_codex_thread_id(thread_id)
}

fn raw_codex_thread_id(event: &Value) -> Option<&str> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_type != "thread.started" {
        return None;
    }
    string_field(event, "thread_id")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_event_payload_adds_sequence_and_masks_object_event() {
        let event = serde_json::json!({
            "type": "test",
            "data": "contains secret-value"
        });
        let masker = SecretMasker::from_raw("c2VjcmV0LXZhbHVl");

        let payload = prepare_event_payload_for_run_id(event, 7, &masker, "test-run");

        assert_eq!(payload["events"][0]["type"], "test");
        assert_eq!(payload["events"][0]["sequenceNumber"], 7);
        assert_eq!(payload["events"][0]["data"], "contains ***");
    }

    #[test]
    fn prepare_event_payload_wraps_non_object_event_without_sequence_number() {
        let event = serde_json::json!("contains secret-value");
        let masker = SecretMasker::from_raw("c2VjcmV0LXZhbHVl");

        let payload = prepare_event_payload_for_run_id(event, 7, &masker, "test-run");

        assert_eq!(payload["events"][0], "contains ***");
    }

    #[test]
    fn pi_private_citation_sidecar_matches_shared_rollback_wire_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../fixtures/pi-memory-citation-new-guest-wire.json"
        ))
        .expect("shared rollback fixture must be valid JSON");
        let expected = fixture["wirePayload"].clone();
        let mut assistant = expected["events"][0].clone();
        assistant["message"]["memoryCitation"] =
            expected["piMemoryCitationTransport"]["citations"][0]["citation"].clone();
        let result = expected["events"][1].clone();

        let envelope = EventPayloadEnvelope::new(
            expected["runId"]
                .as_str()
                .expect("fixture run ID must be a string"),
            true,
        )
        .expect("Pi event envelope must be constructible");
        let citation = envelope
            .take_private_citation(7, &mut assistant)
            .expect("structured citation must be serializable")
            .expect("fixture must carry one structured citation");
        let events = [assistant, result].map(|event| {
            Bytes::from(serde_json::to_vec(&event).expect("public event must be serializable"))
        });
        let actual: Value = serde_json::from_slice(&envelope.payload(&events, &[citation]))
            .expect("wire payload must be valid JSON");

        assert_eq!(actual, expected);
        let public_events =
            serde_json::to_string(&actual["events"]).expect("public events must be serializable");
        for private_value in fixture["privateValues"]
            .as_array()
            .expect("fixture private values must be an array")
        {
            assert!(
                !public_events.contains(
                    private_value
                        .as_str()
                        .expect("fixture private value must be a string")
                )
            );
        }
    }

    #[test]
    fn non_pi_event_envelope_remains_byte_for_byte_unchanged() {
        let envelope = EventPayloadEnvelope::new("ordinary-run", false)
            .expect("ordinary event envelope must be constructible");
        let event = Bytes::from_static(br#"{"type":"assistant","sequenceNumber":0}"#);

        assert_eq!(
            envelope.payload(&[event], &[]).as_ref(),
            br#"{"runId":"ordinary-run","events":[{"type":"assistant","sequenceNumber":0}]}"#
        );
    }

    #[test]
    fn extract_tool_use() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "id": "t1", "name": "WebFetch", "input": {}}]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![ClaudeToolEvent::Use {
                id: "t1",
                name: "WebFetch"
            }]
        );
    }

    #[test]
    fn extract_tool_result() {
        let event = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![ClaudeToolEvent::Result { tool_use_id: "t1" }]
        );
    }

    #[test]
    fn extract_text_then_tool_use() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "Let me search..."},
                    {"type": "tool_use", "id": "t2", "name": "WebSearch", "input": {}}
                ]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![ClaudeToolEvent::Use {
                id: "t2",
                name: "WebSearch"
            }]
        );
    }

    #[test]
    fn extract_parallel_tool_uses() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "t1", "name": "WebFetch", "input": {}},
                    {"type": "tool_use", "id": "t2", "name": "WebSearch", "input": {}}
                ]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![
                ClaudeToolEvent::Use {
                    id: "t1",
                    name: "WebFetch"
                },
                ClaudeToolEvent::Use {
                    id: "t2",
                    name: "WebSearch"
                },
            ]
        );
    }

    #[test]
    fn extract_tool_use_missing_id_skipped() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "name": "WebFetch", "input": {}}]
            }
        });
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn extract_tool_result_missing_id_skipped() {
        let event = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{"type": "tool_result", "content": "ok"}]
            }
        });
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn extract_text_event_returns_empty() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": "hello"}]
            }
        });
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn extract_non_network_tool_still_parsed() {
        // Non-network tools (Bash, Read, etc.) ARE parsed by extract_claude_tool_info.
        // Filtering by STUCK_TOOL_NAMES happens in the caller (cli.rs watchdog).
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep 999"}}]
            }
        });
        assert_eq!(
            extract_claude_tool_info(&event),
            vec![ClaudeToolEvent::Use {
                id: "t1",
                name: "Bash"
            }]
        );
    }

    #[test]
    fn extract_init_event_returns_empty() {
        let event = serde_json::json!({"type": "system", "subtype": "init"});
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn extract_empty_content_returns_empty() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {"content": []}
        });
        assert!(extract_claude_tool_info(&event).is_empty());
    }

    #[test]
    fn codex_error_event_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "error",
            "message": "server rejected request",
            "error": {"message": "server rejected request"}
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "server rejected request".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_nested_invalid_api_key_code_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Incorrect API key provided",
            "error": {
                "code": "invalid_api_key",
                "message": "Incorrect API key provided"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Incorrect API key provided".to_string(),
                failure_reason: Some(FailureReason::InvalidApiKey),
            })
        );
    }

    #[test]
    fn codex_error_event_model_capacity_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Selected model is at capacity. Please try a different model.",
            "error": {
                "message": "Selected model is at capacity. Please try a different model."
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Selected model is at capacity. Please try a different model.".to_string(),
                failure_reason: Some(FailureReason::ProviderOverloaded),
            })
        );
    }

    #[test]
    fn codex_error_event_context_window_exceeded_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
            "error": {
                "message": "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.".to_string(),
                failure_reason: Some(FailureReason::ContextWindowExceeded),
            })
        );
    }

    #[test]
    fn codex_error_event_unsupported_model_yields_failure_reason() {
        let message =
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";
        let event = serde_json::json!({
            "type": "error",
            "message": message,
            "error": {"message": message}
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: message.to_string(),
                failure_reason: Some(FailureReason::UnsupportedModel),
            })
        );
    }

    #[test]
    fn codex_error_event_unsupported_model_near_miss_remains_unclassified() {
        let message =
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account";
        let event = serde_json::json!({
            "type": "error",
            "message": message,
            "error": {"message": message}
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: message.to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_error_string_invalid_api_key_remains_unclassified() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Provider reported invalid_api_key in an error field",
            "error": {
                "error": "invalid_api_key",
                "message": "Provider reported invalid_api_key in an error field"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Provider reported invalid_api_key in an error field".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_nested_reconnect_required_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Access token expired and refresh failed for: codex-oauth-token.",
            "error": {
                "code": "TOKEN_REFRESH_FAILED",
                "message": "Access token expired and refresh failed for: codex-oauth-token.",
                "connectors": ["codex-oauth-token"],
                "failureReason": "reconnect_required"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Access token expired and refresh failed for: codex-oauth-token."
                    .to_string(),
                failure_reason: Some(FailureReason::ReconnectRequired),
            })
        );
    }

    #[test]
    fn codex_error_event_nested_error_string_reconnect_required_yields_failure_reason() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Access token expired and refresh failed for: codex-oauth-token.",
            "error": {
                "error": "TOKEN_REFRESH_FAILED",
                "message": "Access token expired and refresh failed for: codex-oauth-token.",
                "connectors": ["codex-oauth-token"],
                "failureReason": "reconnect_required"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Access token expired and refresh failed for: codex-oauth-token."
                    .to_string(),
                failure_reason: Some(FailureReason::ReconnectRequired),
            })
        );
    }

    #[test]
    fn codex_error_event_upstream_provider_refresh_remains_unclassified() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Access token refresh failed for: codex-oauth-token.",
            "error": {
                "code": "TOKEN_REFRESH_FAILED",
                "message": "Access token refresh failed for: codex-oauth-token.",
                "connectors": ["codex-oauth-token"],
                "failureReason": "upstream_provider"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Access token refresh failed for: codex-oauth-token.".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_multi_connector_reconnect_remains_unclassified() {
        let event = serde_json::json!({
            "type": "error",
            "message": "Access token expired and refresh failed for: notion, codex-oauth-token.",
            "error": {
                "code": "TOKEN_REFRESH_FAILED",
                "message": "Access token expired and refresh failed for: notion, codex-oauth-token.",
                "connectors": ["notion", "codex-oauth-token"],
                "failureReason": "reconnect_required"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Access token expired and refresh failed for: notion, codex-oauth-token."
                    .to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_error_event_accepts_nested_error_shape() {
        let event = serde_json::json!({
            "type": "error",
            "message": "server rejected request (policy denied)",
            "error": {
                "message": "server rejected request",
                "additional_details": "policy denied"
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "server rejected request (policy denied)".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failed_turn_completed_event_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "turn.completed",
            "turn": {
                "status": "failed",
                "error": {"message": "failed TurnCompleted reason"}
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: "failed TurnCompleted reason".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failed_turn_completed_without_error_message_uses_status() {
        let event = serde_json::json!({
            "type": "turn.completed",
            "turn": {
                "status": "failed",
                "error": {}
            }
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: "turn failed".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failure_diagnostic_masks_secrets() {
        let event = serde_json::json!({
            "type": "error",
            "message": "request failed with token supersecret"
        });
        let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &masker),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "request failed with token ***".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failure_diagnostic_escapes_line_breaks() {
        let event = serde_json::json!({
            "type": "error",
            "message": "first line\nsecond line\rthird line"
        });

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "first line\\nsecond line\\rthird line".to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn codex_failure_diagnostic_masks_before_truncating() {
        let prefix = "x".repeat(
            FAILURE_DIAGNOSTIC_MAX_BYTES
                - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len()
                - "super".len(),
        );
        let event = serde_json::json!({
            "type": "error",
            "message": format!("{prefix}supersecret after-boundary")
        });
        let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");
        let diagnostic = masked_codex_failure_diagnostic(&event, &masker)
            .expect("error event should produce a diagnostic");

        assert!(
            diagnostic.message.contains("***"),
            "diagnostic should keep the masked token marker: {diagnostic:?}"
        );
        assert!(
            !diagnostic.message.contains("super"),
            "diagnostic should not leak a partial secret near the truncation boundary: {diagnostic:?}"
        );
    }

    #[test]
    fn codex_failure_diagnostic_truncates_to_max_bytes() {
        let event = serde_json::json!({
            "type": "error",
            "message": "x".repeat(FAILURE_DIAGNOSTIC_MAX_BYTES + 100)
        });
        let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
            .expect("error event should produce a diagnostic");

        assert_eq!(diagnostic.message.len(), FAILURE_DIAGNOSTIC_MAX_BYTES);
        assert!(
            diagnostic
                .message
                .ends_with(FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX),
            "diagnostic should end with truncation marker: {diagnostic:?}"
        );
    }

    #[test]
    fn jsonl_error_result_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "error",
            "is_error": true,
            "result": "permission denied while running command"
        });

        assert_eq!(
            masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(JsonlResultFailureDiagnostic {
                subtype: Some("error"),
                message: "permission denied while running command".to_string(),
            })
        );
    }

    #[test]
    fn jsonl_error_subtype_without_is_error_yields_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "error",
            "result": "terminal result failed"
        });

        assert_eq!(
            masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(JsonlResultFailureDiagnostic {
                subtype: Some("error"),
                message: "terminal result failed".to_string(),
            })
        );
    }

    #[test]
    fn jsonl_result_failure_diagnostic_drops_unrecognized_subtype() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "secret\nsubtype",
            "is_error": true,
            "result": "terminal result failed"
        });

        assert_eq!(
            masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(JsonlResultFailureDiagnostic {
                subtype: None,
                message: "terminal result failed".to_string(),
            })
        );
    }

    #[test]
    fn jsonl_success_result_has_no_failure_diagnostic() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "Done."
        });

        assert_eq!(
            masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn jsonl_error_result_requires_nonempty_result_message() {
        let event = serde_json::json!({
            "type": "result",
            "subtype": "error",
            "is_error": true,
            "result": " \n\t "
        });

        assert_eq!(
            masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn jsonl_result_failure_diagnostic_masks_and_escapes_line_breaks() {
        let event = serde_json::json!({
            "type": "result",
            "is_error": true,
            "result": "first line with supersecret\nsecond\rthird"
        });
        let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");

        assert_eq!(
            masked_jsonl_result_failure_diagnostic(&event, &masker),
            Some(JsonlResultFailureDiagnostic {
                subtype: None,
                message: "first line with ***\\nsecond\\rthird".to_string(),
            })
        );
    }

    #[test]
    fn jsonl_result_failure_diagnostic_truncates_to_max_bytes() {
        let event = serde_json::json!({
            "type": "result",
            "is_error": true,
            "result": "é".repeat(FAILURE_DIAGNOSTIC_MAX_BYTES)
        });
        let diagnostic =
            masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("JSONL error result should produce a diagnostic");

        assert_eq!(diagnostic.message.len(), FAILURE_DIAGNOSTIC_MAX_BYTES);
        assert!(
            diagnostic
                .message
                .ends_with(FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX),
            "diagnostic should end with truncation marker: {diagnostic:?}"
        );
        assert!(diagnostic.message.is_char_boundary(
            FAILURE_DIAGNOSTIC_MAX_BYTES - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len()
        ));
    }

    #[test]
    fn non_failure_codex_event_has_no_failure_diagnostic() {
        let event = serde_json::json!({"type": "turn.completed", "usage": {}});

        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    // Note: end-to-end coverage of session metadata capture (including both
    // the Claude `system/init` branch and the codex `thread.started`
    // branch) lives in the integration test suites:
    //   - `tests/integration_cases/events.rs::send_event_extracts_claude_session_id`
    //   - `tests/codex_session_resume.rs` (codex variant)
    // The Claude/Codex helpers are private; their contracts are
    // exercised transitively through `send_event`.
}
