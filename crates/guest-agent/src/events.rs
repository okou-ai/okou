//! Event sending — forwards masked JSONL events to the webhook endpoint.
//!
//! Captures framework session metadata for finalization use and prepares masked
//! event payloads for webhook delivery.

use crate::constants;
use crate::env::{Framework, GuestConfig};
use crate::error::AgentError;
use crate::failure_patterns::{
    has_exact_codex_oauth_connector, is_codex_chatgpt_account_unsupported_model_message,
    is_codex_chatgpt_account_unsupported_model_run_error, is_codex_context_window_exceeded_message,
    is_codex_model_capacity_message, is_codex_output_token_limit_message,
    is_codex_provider_server_error_message, is_content_policy_rejection_message,
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
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CodexFailureDiagnostic {
    pub event_type: &'static str,
    pub message: String,
    pub failure_reason: Option<FailureReason>,
    pub evidence: Option<guest_contracts::codex_failure::CodexFailureEvidence>,
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
}

impl EventPayloadEnvelope {
    pub(crate) fn new(run_id: &str) -> Result<Self, AgentError> {
        let run_id = serde_json::to_vec(run_id)?;
        let mut prefix = Vec::with_capacity(
            EVENT_PAYLOAD_RUN_ID_PREFIX.len() + run_id.len() + EVENT_PAYLOAD_EVENTS_PREFIX.len(),
        );
        prefix.extend_from_slice(EVENT_PAYLOAD_RUN_ID_PREFIX);
        prefix.extend_from_slice(&run_id);
        prefix.extend_from_slice(EVENT_PAYLOAD_EVENTS_PREFIX);
        Ok(Self {
            prefix: Bytes::from(prefix),
        })
    }

    pub(crate) fn singleton_bytes(&self, event_bytes: usize) -> usize {
        self.prefix
            .len()
            .saturating_add(event_bytes)
            .saturating_add(EVENT_PAYLOAD_EVENTS_SUFFIX.len())
            .saturating_add(EVENT_PAYLOAD_PUBLIC_SUFFIX.len())
    }

    pub(crate) fn payload(&self, events: &[Bytes]) -> Bytes {
        let event_bytes = events.iter().map(Bytes::len).sum::<usize>();
        let event_separators = events.len().saturating_sub(1);
        let mut payload = Vec::with_capacity(self.singleton_bytes(event_bytes) + event_separators);
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
        payload.extend_from_slice(EVENT_PAYLOAD_PUBLIC_SUFFIX);
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
        evidence: diagnostic.evidence,
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
        "error" if event.get("will_retry").and_then(Value::as_bool) != Some(true) => {
            let error = event.get("error");
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: raw_message_from_field(event.get("message"))
                    .unwrap_or_else(|| "error".into()),
                failure_reason: codex_error_failure_reason(event, error),
                evidence: error.and_then(crate::codex_failure::terminal_evidence),
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
                failure_reason: codex_error_failure_reason(event, turn_error),
                evidence: turn_error.and_then(crate::codex_failure::terminal_evidence),
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

fn codex_error_failure_reason(event: &Value, error: Option<&Value>) -> Option<FailureReason> {
    let error = error?;
    if is_codex_access_program_unavailable(event, error) {
        return Some(FailureReason::CodexAccessProgramUnavailable);
    }
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
        // A generic SDK server variant must not erase explicit provider queue
        // expiry. Specific credential/quota/context/policy evidence still wins.
        if matches!(
            failure_reason,
            FailureReason::ProviderServerError | FailureReason::ProviderOverloaded
        ) && crate::provider_failure::provider_error_reason(error)
            == Some(FailureReason::ProviderQueueTimeout)
        {
            return Some(FailureReason::ProviderQueueTimeout);
        }
        return Some(failure_reason);
    }
    if let Some(reason) = crate::provider_failure::provider_error_reason(error) {
        return Some(reason);
    }
    if codex_error_message(Some(error))
        .as_deref()
        .is_some_and(is_codex_provider_server_error_message)
    {
        return Some(FailureReason::ProviderServerError);
    }
    // Codex maps this incomplete-response stream error to `other`. Recognized
    // native/provider causes above remain authoritative over display text.
    if codex_error_message(Some(error))
        .as_deref()
        .is_some_and(is_codex_output_token_limit_message)
    {
        return Some(FailureReason::OutputTokenLimit);
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
        .is_some_and(|message| {
            is_codex_chatgpt_account_unsupported_model_message(message)
                || is_codex_chatgpt_account_unsupported_model_run_error(message)
        })
    {
        return Some(FailureReason::UnsupportedModel);
    }
    None
}

fn is_codex_access_program_unavailable(event: &Value, error: &Value) -> bool {
    event.get("status").and_then(Value::as_u64) == Some(400)
        && error.get("type").and_then(Value::as_str) == Some("invalid_request_error")
        && error.get("code").and_then(Value::as_str) == Some("unsupported_parameter")
        && error.get("param").and_then(Value::as_str) == Some("access_programs.cyber")
        && error.get("message").and_then(Value::as_str)
            == Some("The access_programs parameter is not enabled for this organization.")
}

fn codex_error_info_failure_reason(error: &Value) -> Option<FailureReason> {
    match codex_error_info_variant(error)? {
        "contextWindowExceeded" => Some(FailureReason::ContextWindowExceeded),
        "rateLimitExceeded" => Some(FailureReason::ProviderRateLimited),
        "serverOverloaded" => Some(FailureReason::ProviderOverloaded),
        "internalServerError" => Some(FailureReason::ProviderServerError),
        "unauthorized" => Some(FailureReason::InvalidCredentials),
        "responseTooManyFailedAttempts" => error
            .pointer("/codex_error_info/responseTooManyFailedAttempts/httpStatusCode")
            .and_then(Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .and_then(crate::provider_failure::http_failure_reason),
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

/// Capture session metadata needed by finalization.
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
mod tests;
