//! Official Pi RPC command lifecycle and public-event projection.
//!
//! ## Ownership and data flow
//!
//! The sandbox TypeScript host opens the run's Pi session (the Runner-restored
//! history, or a fresh session) and enters Pi's official `runRpcMode`. The
//! guest owns the other side of that boundary. Its stdout loop in `cli/mod.rs`
//! starts the shared event pipeline on the first official RPC record and then
//! applies this module's projection.
//!
//! There are two coupled JSONL paths after startup:
//!
//! - The guest writer owns child stdin. It sends `get_state`, waits until the
//!   stdout loop has started the event pipeline, sends the initial `prompt`,
//!   and then delivers accepted active-input frames. The stdout loop routes
//!   `response` records into the writer's bounded response channel without
//!   waiting for capacity.
//! - The stdout loop owns child stdout. It retains each ordinary raw record in
//!   the best-effort local agent transcript, projects supported records into
//!   the existing public event shape, and passes projected events through
//!   normalization, secret masking, sequencing, bounded FIFO delivery, and the
//!   HTTP event worker.
//!
//! The public event pipeline is deliberately created only at startup.
//! `CliEventIngestor` and `EventDeliveryRuntime` receive the same first
//! sequence, so the first public event and the delivery acknowledgement
//! watermark cannot start from different boundaries.
//!
//! ## Startup boundary
//!
//! `PiRpcStartupBoundary` starts the run exactly once: the first official JSON
//! record starts the event pipeline at sequence 1 and is then projected
//! normally. Before that record, non-JSON stdout fails with
//! `PI_HANDOFF_BOUNDARY_INVALID`, and stdout closing fails with
//! `PI_HANDOFF_BOUNDARY_MISSING`. After a startup failure,
//! `discard_remaining` makes all later records non-projecting.
//!
//! No official RPC record may reach projection, masking, sequencing, or
//! delivery until the startup has installed the first event sequence.
//!
//! ## Command and acknowledgement lifecycle
//!
//! `write_commands` has one serialized command flow. It first writes
//! `get_state` with ID `<run-id>:pi:get-state` and waits for a response with
//! the exact ID, command name, and `success: true`. The successful response is
//! sent to the response channel and is also used by the projection to emit
//! `system/init` after validating the configured session ID, returned
//! `data.sessionId`, and required `data.sessionFile`.
//!
//! After `get_state`, the writer waits for the stdout loop to start the event
//! pipeline. It then sends the original initial `prompt` with ID
//! `<run-id>:pi:initial-prompt`, which the host executes normally.
//!
//! Once the initial acknowledgement arrives, each accepted active input is sent
//! with the `steer` command. The command ID is the source chat-event UUID, and
//! the matching successful response is required before
//! `mark_backend_accepted_without_replay` records acceptance and queues the
//! steered declaration. A failed or interrupted command marks the input failed
//! and enters the abort/error path.
//!
//! Normal response waits reject an unexpected ID, unexpected command,
//! unsuccessful response, or a closed response channel. Abort is different in
//! one respect: it ignores unrelated response IDs while waiting for its own
//! acknowledgement. It writes ID `<run-id>:pi:abort`, requires the matching
//! successful `abort` response, and has a ten-second timeout covering the write
//! and acknowledgement wait.
//!
//! The guest keeps child stdin owned by this writer after the initial prompt.
//! The host's official RPC loop therefore remains alive while the guest waits
//! for active input and while stdout drains through `agent_settled`. After a
//! projected terminal result, Pi active input closes when no follow-up frame is
//! pending; final guest cleanup closes it in all remaining cases, allowing the
//! host to observe stdin EOF.
//!
//! User cancellation closes active-input state and cancels the Pi writer. When
//! cancellation wins while the writer is waiting for a command response, the
//! writer sends the bounded `abort` command. If cancellation wins inside the
//! cancellable stdin write itself, that write returns an interruption error
//! before an abort can be written; this is a distinct early-write failure path.
//! The final guest control result records `Run cancelled by user` and the
//! `UserCancellation` termination reason. Pi tool-result events remain ordinary
//! tool results. Claude-only replay filtering is enabled outside this module;
//! Pi does not set `replay_user_messages`.
//!
//! ## Record admission and projection
//!
//! `PiRpcProjection::project` receives only official records admitted by the
//! startup boundary. The common loop records the raw JSONL line locally even
//! when the record has no public projection. The routing contract is:
//!
//! - `response`: every response is routed to the command channel. Admission is
//!   bounded by count and by retained stdout-record bytes. The byte budget is
//!   held while the response is queued or being validated by the writer. Only
//!   the first successful `get_state` response emits `system/init`; prompt,
//!   steer, abort, and other responses are acknowledgement records only. The
//!   raw response remains in the local transcript.
//! - `message_end` with an assistant message: the latest assistant terminal
//!   state is cached. Supported content is emitted as an `assistant` event;
//!   Empty content, unknown content blocks, and assistant messages with no
//!   supported content emit no public event unless a hidden citation was
//!   extracted; citation-only messages emit an empty assistant event carrying
//!   structured provenance. Their raw records remain local.
//! - `message_end` with a `toolResult` message: required tool-result fields are
//!   validated and one public `user` event containing one `tool_result` block is
//!   emitted. The raw record remains local. Other message roles are ignored
//!   publicly and retained locally.
//! - `agent_settled`: this is the sole Pi owner of the public terminal
//!   `result` event. It consumes the cached assistant terminal state. Neither
//!   `message_end` nor `agent_end` owns the public terminal result.
//! - `extension_error`: no public event is emitted. Projection becomes
//!   terminal and returns an execution error; later records are discarded from
//!   public projection while the stdout loop continues its controlled failure
//!   and local-transcript handling.
//! - Unsupported official records, including `agent_end`, emit no public
//!   event and are retained locally unless the projection is already terminal.
//!
//! After projection, assistant and user events with multiple content blocks
//! are split by `provider_event_normalization` into one independently
//! sequenced public event per block. Citation metadata stays only on the final
//! split assistant event. The source order is retained, and common masking and
//! bounded delivery happen after that normalization.
//!
//! ## Public event shapes
//!
//! A successful `get_state` projects to:
//!
//! ```json
//! {
//!   "type": "system",
//!   "subtype": "init",
//!   "session_id": "<configured-session-id>",
//!   "session_file": "<returned-session-file>"
//! }
//! ```
//!
//! An assistant `message_end` projects to an `assistant` envelope whose
//! message contains `id`, `role: "assistant"`, ordered `content`, `model`, and
//! `usage`. The ID is `responseId` when supplied, otherwise
//! `<run-id>:<timestamp>:<model>`. Usage maps `input`, `output`, `cacheRead`,
//! and `cacheWrite` to `input_tokens`, `output_tokens`,
//! `cache_read_input_tokens`, and `cache_creation_input_tokens`.
//!
//! Text blocks are trimmed and empty text is omitted. A `toolCall` requires a
//! non-empty `id` and `name` plus an object `arguments`, and becomes a
//! `{type: "tool_use", id, name, input}` block. Unknown assistant content
//! types are omitted. A tool-only assistant message still produces an
//! assistant event because its `toolCall` block is supported.
//!
//! A `toolResult` message requires a non-empty `toolCallId`, an array
//! `content`, and a boolean `isError`. It becomes:
//!
//! ```json
//! {
//!   "type": "user",
//!   "session_id": "<configured-session-id>",
//!   "message": {
//!     "role": "user",
//!     "content": [{
//!       "type": "tool_result",
//!       "tool_use_id": "<toolCallId>",
//!       "content": [],
//!       "is_error": false
//!     }]
//!   }
//! }
//! ```
//!
//! Tool-result text blocks retain their text. Image blocks become base64 image
//! sources with `mimeType` mapped to `media_type` and `data` mapped to
//! `data`; unsupported result content blocks are omitted. The resulting `user`
//! event is classified as a tool result rather than a replayable prompt.
//!
//! ## Terminal result and failure ownership
//!
//! Each assistant `message_end` updates `PiAssistantTerminal`; it does not
//! itself close the public run. `stopReason` values `error`, `aborted`, and `length` set
//! the cached failure flag. The result text uses `errorMessage` when present,
//! otherwise the joined non-empty assistant text. An `errorMessage` is
//! upstream-controlled, so it passes through
//! [`crate::upstream_error_text::project_model_error_text`]: a markup document
//! becomes a bounded content-free description and any other message keeps its
//! exact text under a size bound. Assistant text is the run's own answer and is
//! never bounded here. If both are empty, it falls back to
//! `Pi model turn <stopReason>` when a stop reason exists.
//! A final `length` result uses a bounded output-limit message and the existing
//! `output_token_limit` reason; any partial assistant answer remains in its event.
//! Runtime model diagnostics carry observed HTTP status, attempt counts,
//! allowlisted transport exception evidence, and a failure reason. No raw causes
//! or network addresses enter `modelRequest`. The reason is forwarded separately
//! from `modelRequest` so older guests can ignore these additive fields.
//!
//! When `agent_settled` arrives, the cached state is consumed and the public
//! result contains `type: "result"`, `subtype: "error_during_execution"` and
//! `is_error: true` for a cached failure, or `subtype: "success"` and
//! `is_error: false` otherwise. It also contains the selected `result` text,
//! configured `session_id`, and elapsed `duration_ms`. With no cached assistant
//! message, the default terminal state is successful with an empty result.
//!
//! The common guest loop treats this projected result as the terminal JSONL
//! event: it masks the printed result, closes idle Pi active input, and drains
//! successful delivery or aborts unsent delivery on a control/error path. A
//! user cancellation can subsequently override the final guest control
//! diagnostic, but it does not mutate the public tool-result shape.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use guest_contracts::diagnostics::ModelRequestDiagnostic;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

use super::pi_memory_citation::{CitationParser, CitationProjection, project_segments};
use super::pi_session_output::{PiSessionOutputSender, SESSION_OUTPUT_DELTA_MAX_BYTES};
use crate::active_input::{ActiveInputFrame, ActiveInputWriter};
use crate::error::AgentError;
use crate::upstream_error_text::project_model_error_text;

const PI_RPC_ABORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const PI_RPC_RESPONSE_QUEUE_CAPACITY: usize = 2;
const PI_RPC_RESPONSE_MAX_RETAINED_BYTES: usize =
    guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
const MAX_STREAM_CONTENT_INDEX: usize = 1024;

pub(super) struct PiRpcResponse {
    value: Value,
    _retained_bytes: OwnedSemaphorePermit,
}

pub(super) struct PiRpcResponseSender {
    tx: mpsc::Sender<PiRpcResponse>,
    retained_bytes: Arc<Semaphore>,
}

pub(super) fn response_channel() -> (PiRpcResponseSender, mpsc::Receiver<PiRpcResponse>) {
    let (tx, rx) = mpsc::channel(PI_RPC_RESPONSE_QUEUE_CAPACITY);
    (
        PiRpcResponseSender {
            tx,
            retained_bytes: Arc::new(Semaphore::new(PI_RPC_RESPONSE_MAX_RETAINED_BYTES)),
        },
        rx,
    )
}

impl PiRpcResponseSender {
    fn try_send(&self, value: Value, record_bytes: usize) -> Result<(), AgentError> {
        let available_bytes = self.retained_bytes.available_permits();
        let retained_bytes = Arc::clone(&self.retained_bytes)
            .try_acquire_many_owned(record_bytes as u32)
            .map_err(|_| {
                AgentError::Execution(format!(
                    "Pi RPC response byte buffer exhausted: response is {record_bytes} bytes, {available_bytes} of {PI_RPC_RESPONSE_MAX_RETAINED_BYTES} bytes available"
                ))
            })?;
        let response = PiRpcResponse {
            value,
            _retained_bytes: retained_bytes,
        };
        match self.tx.try_send(response) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => Err(AgentError::Execution(format!(
                "Pi RPC response queue exceeded {PI_RPC_RESPONSE_QUEUE_CAPACITY} pending responses"
            ))),
        }
    }
}

#[derive(Debug)]
pub(super) enum PiRpcRecordAdmission {
    /// First official record: start the public event pipeline at
    /// [`PI_RPC_FIRST_EVENT_SEQUENCE`], then project the record itself.
    Start,
    Project,
    Discard,
}

/// The sandbox owns the whole turn, so its public events start at sequence 1.
pub(super) const PI_RPC_FIRST_EVENT_SEQUENCE: u32 = 1;

#[derive(Default)]
pub(super) struct PiRpcStartupBoundary {
    started: bool,
    terminal_error: bool,
}

impl PiRpcStartupBoundary {
    pub(super) fn admit(&mut self) -> PiRpcRecordAdmission {
        if self.terminal_error {
            return PiRpcRecordAdmission::Discard;
        }
        if !self.started {
            self.started = true;
            return PiRpcRecordAdmission::Start;
        }
        PiRpcRecordAdmission::Project
    }

    pub(super) fn requires_boundary(&self) -> bool {
        !self.started && !self.terminal_error
    }

    pub(super) fn missing_error() -> AgentError {
        boundary_error(
            "PI_HANDOFF_BOUNDARY_MISSING",
            "Pi RPC stdout closed before RPC startup",
        )
    }

    pub(super) fn malformed_record_error() -> AgentError {
        boundary_error(
            "PI_HANDOFF_BOUNDARY_INVALID",
            "Pi RPC stdout was not JSON before RPC startup",
        )
    }

    pub(super) fn discard_remaining(&mut self) {
        self.terminal_error = true;
    }
}

fn boundary_error(code: &str, message: &str) -> AgentError {
    AgentError::Execution(format!("[{code}] {message}"))
}

struct PiAssistantStream {
    event_id_prefix: String,
    parser: CitationParser,
    started_sources: HashSet<usize>,
    closed_sources: HashSet<usize>,
    output: PiSessionOutputSender,
}

impl PiAssistantStream {
    fn new(output: PiSessionOutputSender) -> Self {
        Self {
            event_id_prefix: format!("sandbox:{}", uuid::Uuid::new_v4()),
            parser: CitationParser::new(0),
            started_sources: HashSet::new(),
            closed_sources: HashSet::new(),
            output,
        }
    }

    fn push(&mut self, source: usize, text: &str) {
        if source > MAX_STREAM_CONTENT_INDEX || text.is_empty() {
            return;
        }
        self.parser.push(text, source);
        let visible = self.parser.take_visible_segments();
        self.emit_visible(visible);
    }

    fn emit_visible(&mut self, visible: impl IntoIterator<Item = (usize, String)>) {
        for (source, text) in visible {
            if text.is_empty() || self.closed_sources.contains(&source) {
                continue;
            }
            let text = if self.started_sources.contains(&source) {
                text.as_str()
            } else {
                text.trim_start()
            };
            if text.is_empty() {
                continue;
            }

            let run_event_id = format!("{}:{source}", self.event_id_prefix);
            let mut remaining = text;
            while !remaining.is_empty() {
                let mut end = remaining.len().min(SESSION_OUTPUT_DELTA_MAX_BYTES);
                while !remaining.is_char_boundary(end) {
                    end -= 1;
                }
                let delta = remaining[..end].to_string();
                if !self.output.try_send(&run_event_id, delta) {
                    self.closed_sources.insert(source);
                    break;
                }
                self.started_sources.insert(source);
                remaining = &remaining[end..];
            }
        }
    }

    fn finish(mut self) -> String {
        let parser = std::mem::replace(&mut self.parser, CitationParser::new(0));
        let projection = parser.finish();
        self.emit_visible(projection.visible_segments.into_iter().enumerate());
        self.event_id_prefix
    }
}

#[derive(Default)]
struct PiAssistantTerminal {
    failed: bool,
    result: String,
    model_request: Option<ModelRequestDiagnostic>,
    failure_reason: Option<guest_contracts::diagnostics::FailureReason>,
}

impl PiAssistantTerminal {
    fn from_message(message: &Value, preserve_empty_result: bool) -> Self {
        let stop_reason = message.get("stopReason").and_then(Value::as_str);
        let failed = matches!(stop_reason, Some("error" | "aborted" | "length"));
        // A model error is upstream-controlled text. Bounding it here keeps the
        // public result, the delivered event and the failure diagnostic on the
        // same actionable value; assistant text stays untouched because it is
        // the run's own answer.
        let result = if stop_reason == Some("length") {
            "Pi model response exceeded the output token limit.".to_owned()
        } else {
            message
                .get("errorMessage")
                .and_then(Value::as_str)
                .map_or_else(|| assistant_text(message), project_model_error_text)
        };
        let result = if result.is_empty() && !preserve_empty_result {
            stop_reason.map_or_else(String::new, |reason| format!("Pi model turn {reason}"))
        } else {
            result
        };
        let model_request = (stop_reason == Some("error"))
            .then(|| model_request_diagnostic(message))
            .flatten();
        let failure_reason = match stop_reason {
            Some("length") => Some(guest_contracts::diagnostics::FailureReason::OutputTokenLimit),
            Some("error") if model_request.is_some() => model_request_details(message)
                .and_then(|details| details.get("failureReason"))
                .and_then(|reason| serde_json::from_value(reason.clone()).ok()),
            _ => None,
        };
        Self {
            failed,
            result,
            model_request,
            failure_reason,
        }
    }
}

fn model_request_diagnostic(message: &Value) -> Option<ModelRequestDiagnostic> {
    let request: ModelRequestDiagnostic =
        serde_json::from_value(model_request_details(message)?.clone()).ok()?;
    if request
        .http_status
        .is_some_and(|status| !(100..=599).contains(&status))
    {
        return None;
    }
    Some(request)
}

fn model_request_details(message: &Value) -> Option<&Value> {
    if !matches!(
        message.get("api").and_then(Value::as_str),
        Some(
            "openai-codex-responses"
                | "openai-responses"
                | "anthropic-messages"
                | "bedrock-converse-stream"
        )
    ) {
        return None;
    }
    let diagnostic = message
        .get("diagnostics")?
        .as_array()?
        .iter()
        .rev()
        .find(|diagnostic| {
            diagnostic.get("type").and_then(Value::as_str) == Some("okou_model_request")
        })?;
    diagnostic.get("details")
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiRetryAttempt {
    attempt: u32,
    max_attempts: u32,
}

/// Whether an over-limit record of this type can be discarded without losing
/// public output.
///
/// This is deliberately an allowlist of one. `agent_end` carries the agent
/// loop's return value — every message it produced — which the official RPC
/// wire has already delivered individually as `message_end` records, so
/// [`PiRpcProjection::project`] ignores it and `agent_settled` owns the public
/// terminal result. Discarding an oversized `agent_end` therefore drops a
/// duplicate, while terminating on one loses a run that has already finished
/// its work.
///
/// Every other record either owns public output or participates in the startup
/// boundary, so an oversized one must stay fatal: silently dropping it would
/// downgrade a structured record to nothing, which is worse than failing
/// loudly. Only the record's type is known here — it is recovered from a
/// bounded prefix and never parsed — so nothing may be assumed about content.
pub(super) fn oversized_record_is_discardable(event_type: &str) -> bool {
    event_type == "agent_end"
}

pub(super) struct PiRpcProjection {
    run_id: String,
    session_id: String,
    started_at: Instant,
    emitted_session_init: bool,
    assistant_terminal: Option<PiAssistantTerminal>,
    session_output: Option<PiSessionOutputSender>,
    assistant_stream: Option<PiAssistantStream>,
    pending_retry: Option<PiRetryAttempt>,
    terminal_error: bool,
}

impl PiRpcProjection {
    pub(super) fn new(run_id: &str, session_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            started_at: Instant::now(),
            emitted_session_init: false,
            assistant_terminal: None,
            session_output: None,
            assistant_stream: None,
            pending_retry: None,
            terminal_error: false,
        }
    }

    pub(super) fn with_session_output(mut self, output: PiSessionOutputSender) -> Self {
        self.session_output = Some(output);
        self
    }

    /// Project one official Pi RPC record into the existing public event stream.
    pub(super) fn project(
        &mut self,
        record: Value,
        responses: &PiRpcResponseSender,
        record_bytes: usize,
    ) -> Result<Option<Value>, AgentError> {
        if self.terminal_error {
            return Ok(None);
        }
        match record.get("type").and_then(Value::as_str) {
            Some("response") => self.project_response(record, responses, record_bytes),
            Some("message_start") => {
                self.project_message_start(&record);
                Ok(None)
            }
            Some("message_update") => {
                self.project_message_update(&record);
                Ok(None)
            }
            Some("message_end") => self.project_message_end(record),
            Some("agent_settled") => Ok(Some(self.project_agent_settled())),
            Some("auto_retry_start") => {
                self.pending_retry = serde_json::from_value(record).ok();
                // A cancelled backoff still proves the configured limit, but
                // does not complete the newly scheduled attempt.
                if let Some(retry) = self.pending_retry
                    && let Some(request) = self
                        .assistant_terminal
                        .as_mut()
                        .and_then(|terminal| terminal.model_request.as_mut())
                {
                    request.retry_limit = Some(retry.max_attempts);
                }
                Ok(None)
            }
            Some("auto_retry_end") => {
                self.pending_retry = None;
                Ok(None)
            }
            Some("extension_error") => {
                self.terminal_error = true;
                Err(AgentError::Execution(format!(
                    "Pi RPC extension failed: {}",
                    record
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown extension error")
                )))
            }
            _ => Ok(None),
        }
    }

    fn project_response(
        &mut self,
        response: Value,
        responses: &PiRpcResponseSender,
        record_bytes: usize,
    ) -> Result<Option<Value>, AgentError> {
        let command = response.get("command").and_then(Value::as_str);
        let projected = if command == Some("get_state")
            && response.get("success").and_then(Value::as_bool) == Some(true)
            && !self.emitted_session_init
        {
            let session_id = response
                .pointer("/data/sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AgentError::Execution(
                        "Pi RPC get_state response omitted the session id".to_string(),
                    )
                })?;
            if session_id != self.session_id {
                return Err(AgentError::Execution(
                    "Pi RPC reported an unexpected session id".to_string(),
                ));
            }
            let session_file = response
                .pointer("/data/sessionFile")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AgentError::Execution(
                        "Pi RPC get_state response omitted the session file".to_string(),
                    )
                })?;
            self.emitted_session_init = true;
            Some(json!({
                "type": "system",
                "subtype": "init",
                "session_id": session_id,
                "session_file": session_file,
            }))
        } else {
            None
        };
        responses.try_send(response, record_bytes)?;
        Ok(projected)
    }

    fn project_message_start(&mut self, event: &Value) {
        if event.pointer("/message/role").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        self.assistant_stream = self
            .session_output
            .as_ref()
            .cloned()
            .map(PiAssistantStream::new);
    }

    fn project_message_update(&mut self, event: &Value) {
        let Some(stream) = self.assistant_stream.as_mut() else {
            return;
        };
        let Some(delta) = event.get("assistantMessageEvent") else {
            return;
        };
        let Some(source) = delta
            .get("contentIndex")
            .and_then(Value::as_u64)
            .and_then(|source| usize::try_from(source).ok())
        else {
            return;
        };
        match delta.get("type").and_then(Value::as_str) {
            Some("text_start") => {
                if let Some(text) = delta.get("initialText").and_then(Value::as_str) {
                    stream.push(source, text);
                }
            }
            Some("text_delta") => {
                if let Some(text) = delta.get("delta").and_then(Value::as_str) {
                    stream.push(source, text);
                }
            }
            _ => {}
        }
    }

    fn project_message_end(&mut self, event: Value) -> Result<Option<Value>, AgentError> {
        let mut event = event;
        let Some(message) = event.get_mut("message").map(Value::take) else {
            return Err(AgentError::Execution(
                "Pi RPC message_end omitted its message".to_string(),
            ));
        };
        let projected = match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                let event_id_prefix = self.assistant_stream.take().map(PiAssistantStream::finish);
                self.project_assistant_message(message, event_id_prefix.as_deref())?
            }
            Some("toolResult") => Some(self.project_tool_result_message(message)?),
            _ => return Ok(None),
        };
        Ok(projected)
    }

    fn project_assistant_message(
        &mut self,
        mut message: Value,
        event_id_prefix: Option<&str>,
    ) -> Result<Option<Value>, AgentError> {
        let citation_projection = normalize_assistant_citations(&mut message);
        let mut terminal =
            PiAssistantTerminal::from_message(&message, citation_projection.citation.is_some());
        let retry = self.pending_retry.take();
        if let Some(request) = terminal.model_request.as_mut() {
            // Only a scheduled SDK retry is a retry. Compaction and queued
            // input can continue after an error without sharing its budget.
            request.retry_attempts = retry.map_or(0, |retry| retry.attempt);
            request.retry_limit = retry.map(|retry| retry.max_attempts);
        }
        self.assistant_terminal = Some(terminal);
        let content = assistant_content(&mut message, event_id_prefix)?;
        if content.is_empty() && citation_projection.citation.is_none() {
            return Ok(None);
        }
        let timestamp = message
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let id = message
            .get("responseId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{}:{timestamp}:{model}", self.run_id));
        let usage = owned_object([
            (
                "input_tokens",
                Value::from(
                    message
                        .pointer("/usage/input")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                ),
            ),
            (
                "output_tokens",
                Value::from(
                    message
                        .pointer("/usage/output")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                ),
            ),
            (
                "cache_read_input_tokens",
                Value::from(
                    message
                        .pointer("/usage/cacheRead")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                ),
            ),
            (
                "cache_creation_input_tokens",
                Value::from(
                    message
                        .pointer("/usage/cacheWrite")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                ),
            ),
        ]);
        let mut projected_message = owned_object([
            ("id", Value::String(id)),
            ("role", Value::from("assistant")),
            ("content", Value::Array(content)),
            ("model", Value::String(model.to_string())),
            ("usage", usage),
        ]);
        if let Some(citation) = citation_projection.citation
            && let Value::Object(fields) = &mut projected_message
        {
            fields.insert(
                "memoryCitation".to_string(),
                serde_json::to_value(citation)?,
            );
        }
        Ok(Some(owned_object([
            ("type", Value::from("assistant")),
            ("message", projected_message),
        ])))
    }

    fn project_tool_result_message(&self, mut message: Value) -> Result<Value, AgentError> {
        let tool_use_id = take_string_field(&mut message, "toolCallId")
            .filter(|tool_use_id| !tool_use_id.is_empty())
            .ok_or_else(|| {
                AgentError::Execution(
                    "Pi RPC toolResult message omitted its tool call id".to_string(),
                )
            })?;
        let blocks = match message.get_mut("content").map(Value::take) {
            Some(Value::Array(blocks)) => blocks,
            _ => {
                return Err(AgentError::Execution(
                    "Pi RPC toolResult message omitted its content".to_string(),
                ));
            }
        };
        let mut content = Vec::with_capacity(blocks.len());
        for block in blocks {
            if let Some(projected) = project_tool_result_content(block)? {
                content.push(projected);
            }
        }
        let is_error = message
            .get("isError")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                AgentError::Execution(
                    "Pi RPC toolResult message omitted its error status".to_string(),
                )
            })?;
        let tool_result = owned_object([
            ("type", Value::from("tool_result")),
            ("tool_use_id", Value::String(tool_use_id)),
            ("content", Value::Array(content)),
            ("is_error", Value::Bool(is_error)),
        ]);
        let projected_message = owned_object([
            ("role", Value::from("user")),
            ("content", Value::Array(vec![tool_result])),
        ]);
        Ok(owned_object([
            ("type", Value::from("user")),
            ("session_id", Value::String(self.session_id.clone())),
            ("message", projected_message),
        ]))
    }

    fn project_agent_settled(&mut self) -> Value {
        let assistant = self.assistant_terminal.take().unwrap_or_default();
        self.pending_retry = None;
        let mut result = serde_json::Map::from_iter([
            ("type".to_owned(), json!("result")),
            (
                "subtype".to_owned(),
                json!(if assistant.failed {
                    "error_during_execution"
                } else {
                    "success"
                }),
            ),
            ("is_error".to_owned(), json!(assistant.failed)),
            ("result".to_owned(), json!(assistant.result)),
            ("session_id".to_owned(), json!(self.session_id)),
            (
                "duration_ms".to_owned(),
                json!(
                    self.started_at
                        .elapsed()
                        .as_millis()
                        .min(u128::from(u64::MAX)) as u64
                ),
            ),
        ]);
        if let Some(request) = assistant.model_request {
            result.insert("modelRequest".to_owned(), json!(request));
        }
        if let Some(reason) = assistant.failure_reason {
            result.insert("failureReason".to_owned(), json!(reason));
        }
        Value::Object(result)
    }
}

fn normalize_assistant_citations(message: &mut Value) -> CitationProjection {
    let mut segments: Vec<String> = message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
                .map(ToString::to_string)
        })
        .collect();
    let error_index = message
        .get("errorMessage")
        .and_then(Value::as_str)
        .map(|error| {
            let index = segments.len();
            segments.push(error.to_string());
            index
        });
    let segment_refs: Vec<&str> = segments.iter().map(String::as_str).collect();
    let projection = project_segments(&segment_refs);
    let mut text_index = 0;
    if let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            if let Some(text) = block.get_mut("text") {
                *text = Value::String(
                    projection
                        .visible_segments
                        .get(text_index)
                        .cloned()
                        .unwrap_or_default(),
                );
            }
            text_index += 1;
        }
    }
    if let Some(error_index) = error_index
        && let Some(error) = message.get_mut("errorMessage")
    {
        *error = Value::String(
            projection
                .visible_segments
                .get(error_index)
                .cloned()
                .unwrap_or_default(),
        );
    }
    projection
}

fn owned_object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect(),
    )
}

fn assistant_content(
    message: &mut Value,
    event_id_prefix: Option<&str>,
) -> Result<Vec<Value>, AgentError> {
    let blocks = match message.get_mut("content").map(Value::take) {
        Some(Value::Array(blocks)) => blocks,
        _ => return Ok(Vec::new()),
    };
    let mut content = Vec::new();
    for (content_index, block) in blocks.into_iter().enumerate() {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = block
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                let mut projected = json!({ "type": "text", "text": text });
                if let Some(prefix) = event_id_prefix
                    && let Value::Object(fields) = &mut projected
                {
                    fields.insert(
                        "runEventId".to_string(),
                        Value::String(format!("{prefix}:{content_index}")),
                    );
                }
                content.push(projected);
            }
        } else if block.get("type").and_then(Value::as_str) == Some("toolCall") {
            content.push(project_tool_call(block)?);
        }
    }
    Ok(content)
}

fn project_tool_call(mut block: Value) -> Result<Value, AgentError> {
    let id = take_string_field(&mut block, "id")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            AgentError::Execution("Pi RPC toolCall content omitted its id".to_string())
        })?;
    let name = take_string_field(&mut block, "name")
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            AgentError::Execution("Pi RPC toolCall content omitted its name".to_string())
        })?;
    let arguments = block
        .get_mut("arguments")
        .filter(|arguments| arguments.is_object())
        .map(Value::take)
        .ok_or_else(|| {
            AgentError::Execution("Pi RPC toolCall content omitted its arguments".to_string())
        })?;
    Ok(owned_object([
        ("type", Value::from("tool_use")),
        ("id", Value::String(id)),
        ("name", Value::String(name)),
        ("input", arguments),
    ]))
}

fn project_tool_result_content(mut block: Value) -> Result<Option<Value>, AgentError> {
    if block.get("type").and_then(Value::as_str) == Some("text") {
        let text = take_string_field(&mut block, "text").ok_or_else(|| {
            AgentError::Execution("Pi RPC toolResult text content omitted its text".to_string())
        })?;
        return Ok(Some(owned_object([
            ("type", Value::from("text")),
            ("text", Value::String(text)),
        ])));
    }
    if block.get("type").and_then(Value::as_str) == Some("image") {
        let media_type = take_string_field(&mut block, "mimeType").ok_or_else(|| {
            AgentError::Execution(
                "Pi RPC toolResult image content omitted its media type".to_string(),
            )
        })?;
        let data = take_string_field(&mut block, "data").ok_or_else(|| {
            AgentError::Execution("Pi RPC toolResult image content omitted its data".to_string())
        })?;
        let source = owned_object([
            ("type", Value::from("base64")),
            ("media_type", Value::String(media_type)),
            ("data", Value::String(data)),
        ]);
        return Ok(Some(owned_object([
            ("type", Value::from("image")),
            ("source", source),
        ])));
    }
    Ok(None)
}

fn take_string_field(value: &mut Value, field: &str) -> Option<String> {
    match value.get_mut(field).map(Value::take) {
        Some(Value::String(value)) => Some(value),
        _ => None,
    }
}

fn assistant_text(message: &Value) -> String {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn write_command(
    stdin: &mut tokio::process::ChildStdin,
    command: &Value,
) -> Result<(), AgentError> {
    let mut line = serde_json::to_vec(command)?;
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

async fn write_command_with_cancellation(
    stdin: &mut tokio::process::ChildStdin,
    command: &Value,
    cancellation: &CancellationToken,
) -> Result<(), AgentError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(AgentError::Execution(
            "Pi RPC command write was interrupted by cancellation".to_string(),
        )),
        result = write_command(stdin, command) => result,
    }
}

async fn wait_for_response(
    responses: &mut mpsc::Receiver<PiRpcResponse>,
    expected_id: &str,
    expected_command: &str,
    allow_unmatched: bool,
) -> Result<(), AgentError> {
    while let Some(response) = responses.recv().await {
        let response = &response.value;
        let response_id = response.get("id").and_then(Value::as_str);
        if response_id != Some(expected_id) {
            if allow_unmatched {
                continue;
            }
            return Err(AgentError::Execution(
                "Pi RPC returned an unexpected response id".to_string(),
            ));
        }
        if response.get("command").and_then(Value::as_str) != Some(expected_command) {
            return Err(AgentError::Execution(format!(
                "Pi RPC response {expected_id} named an unexpected command"
            )));
        }
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown RPC failure");
            return Err(AgentError::Execution(format!(
                "Pi RPC {expected_command} failed: {message}"
            )));
        }
        return Ok(());
    }
    Err(AgentError::Execution(
        "Pi RPC stdout closed before the command was acknowledged".to_string(),
    ))
}

async fn abort(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::Receiver<PiRpcResponse>,
    run_id: &str,
) -> Result<(), AgentError> {
    let id = format!("{run_id}:pi:abort");
    tokio::time::timeout(PI_RPC_ABORT_TIMEOUT, async {
        write_command(stdin, &json!({ "id": id, "type": "abort" })).await?;
        wait_for_response(responses, &id, "abort", true).await
    })
    .await
    .map_err(|_| AgentError::Execution("Pi RPC abort timed out".to_string()))?
}

async fn request_prompt(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::Receiver<PiRpcResponse>,
    id: &str,
    message: &str,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    write_command_with_cancellation(
        stdin,
        &json!({
            "id": id,
            "type": "prompt",
            "message": message,
        }),
        cancellation,
    )
    .await?;
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Ok(false),
        response = wait_for_response(responses, id, "prompt", false) => {
            response?;
            Ok(true)
        }
    }
}

async fn request_steer(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::Receiver<PiRpcResponse>,
    id: &str,
    message: &str,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    write_command_with_cancellation(
        stdin,
        &json!({
            "id": id,
            "type": "steer",
            "message": message,
        }),
        cancellation,
    )
    .await?;
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Ok(false),
        response = wait_for_response(responses, id, "steer", false) => {
            response?;
            Ok(true)
        }
    }
}

async fn deliver_active_input(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::Receiver<PiRpcResponse>,
    active_input: &ActiveInputWriter,
    frame: &ActiveInputFrame,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    active_input.mark_writing(&frame.uuid);
    let request = request_steer(stdin, responses, &frame.uuid, &frame.text, cancellation).await;
    match request {
        Ok(true) => {
            active_input.mark_backend_accepted_without_replay(frame)?;
            Ok(true)
        }
        Ok(false) => {
            active_input.mark_backend_failed(frame);
            Ok(false)
        }
        Err(error) => {
            active_input.mark_backend_failed(frame);
            Err(error)
        }
    }
}

/// Drive official Pi RPC commands and keep stdin open through `agent_settled`.
pub(super) async fn write_commands(
    mut stdin: tokio::process::ChildStdin,
    run_id: &str,
    prompt: &str,
    mut active_input: ActiveInputWriter,
    mut responses: mpsc::Receiver<PiRpcResponse>,
    startup_installed: tokio::sync::oneshot::Receiver<()>,
    cancellation: CancellationToken,
) -> Result<(), AgentError> {
    let state_id = format!("{run_id}:pi:get-state");
    write_command_with_cancellation(
        &mut stdin,
        &json!({ "id": state_id, "type": "get_state" }),
        &cancellation,
    )
    .await?;
    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            abort(&mut stdin, &mut responses, run_id).await?;
            return Ok(());
        }
        response = wait_for_response(&mut responses, &state_id, "get_state", false) => {
            response?;
        }
    }

    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            abort(&mut stdin, &mut responses, run_id).await?;
            return Ok(());
        }
        installed = startup_installed => installed.map_err(|_| AgentError::Execution(
            "Pi RPC startup boundary closed before it was installed".to_string(),
        ))?,
    }

    let prompt_id = format!("{run_id}:pi:initial-prompt");
    if !request_prompt(
        &mut stdin,
        &mut responses,
        &prompt_id,
        prompt,
        &cancellation,
    )
    .await?
    {
        abort(&mut stdin, &mut responses, run_id).await?;
        return Ok(());
    }

    loop {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                abort(&mut stdin, &mut responses, run_id).await?;
                return Ok(());
            }
            frame = active_input.next_frame() => {
                let Some(frame) = frame else {
                    return Ok(());
                };
                if !deliver_active_input(
                    &mut stdin,
                    &mut responses,
                    &active_input,
                    &frame,
                    &cancellation,
                ).await? {
                    abort(&mut stdin, &mut responses, run_id).await?;
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::Stdio;

    use tokio::io::{AsyncBufReadExt, BufReader};

    use crate::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};

    use super::*;

    #[test]
    fn model_failure_reason_requires_valid_runtime_evidence() {
        let message = json!({
            "role": "assistant", "api": "openai-codex-responses", "stopReason": "error",
            "errorMessage": "private provider detail",
            "diagnostics": [{"type": "okou_model_request", "details": {
                "httpStatus": 429, "transportAttempts": 1, "failureReason": "provider_rate_limited"
            }}]
        });
        assert_eq!(
            PiAssistantTerminal::from_message(&message, false).failure_reason,
            Some(guest_contracts::diagnostics::FailureReason::ProviderRateLimited)
        );
        for (path, value) in [
            ("/api", json!("unrelated-api")),
            ("/stopReason", json!("stop")),
            ("/stopReason", json!("aborted")),
            ("/diagnostics/0/type", json!("provider_diagnostic")),
            ("/diagnostics/0/details/httpStatus", json!(999)),
            ("/diagnostics/0/details/transportAttempts", json!(-1)),
            (
                "/diagnostics/0/details/failureReason",
                json!("private-token"),
            ),
        ] {
            let mut invalid = message.clone();
            *invalid.pointer_mut(path).unwrap() = value;
            assert_eq!(
                PiAssistantTerminal::from_message(&invalid, false).failure_reason,
                None,
                "{path}"
            );
        }
    }

    #[test]
    fn model_request_evidence_tracks_completed_retries_and_clears_on_recovery() {
        let failed: Value = serde_json::from_str(include_str!(
            "../../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-rate-limit.json"
        ))
        .expect("shared model boundary fixture");
        let failure = json!({"type": "message_end", "message": failed});
        let retry = json!({"type": "auto_retry_start", "attempt": 1, "maxAttempts": 2});
        let success = json!({"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop", "content": []
        }});
        for (records, expected) in [
            (
                vec![failure.clone()],
                json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 0}),
            ),
            (
                vec![
                    failure.clone(),
                    retry.clone(),
                    failure.clone(),
                    json!({"type": "auto_retry_start", "attempt": 2, "maxAttempts": 2}),
                    failure.clone(),
                ],
                json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 2, "retryLimit": 2}),
            ),
            // The SDK can drain a queued follow-up after exhausting the first
            // retry budget, without settling between the two request cycles.
            (
                vec![
                    failure.clone(),
                    retry.clone(),
                    failure.clone(),
                    json!({"type": "auto_retry_start", "attempt": 2, "maxAttempts": 2}),
                    failure.clone(),
                    json!({"type": "auto_retry_end", "success": false, "attempt": 2}),
                    json!({"type": "message_end", "message": {"role": "user", "content": "next input"}}),
                    failure.clone(),
                    retry.clone(),
                    failure.clone(),
                    json!({"type": "auto_retry_start", "attempt": 2, "maxAttempts": 2}),
                    failure.clone(),
                    json!({"type": "auto_retry_end", "success": false, "attempt": 2}),
                ],
                json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 2, "retryLimit": 2}),
            ),
            // Scheduling a backoff that is then cancelled is not a completed retry.
            (
                vec![
                    failure.clone(),
                    retry.clone(),
                    json!({"type": "auto_retry_end", "success": false, "attempt": 1, "finalError": "Retry cancelled"}),
                ],
                json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 0, "retryLimit": 2}),
            ),
            (
                vec![
                    failure.clone(),
                    retry.clone(),
                    success.clone(),
                    failure.clone(),
                ],
                json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 0}),
            ),
            (vec![failure.clone(), retry, success], Value::Null),
        ] {
            let (responses, _rx) = response_channel();
            let mut projection = PiRpcProjection::new("run", "session");
            for record in records {
                projection
                    .project(record, &responses, 0)
                    .expect("project native event");
            }
            let result = projection
                .project(json!({"type": "agent_settled"}), &responses, 0)
                .expect("settled result")
                .expect("terminal event");
            assert_eq!(result["modelRequest"], expected);
            assert_eq!(result["is_error"], !expected.is_null());
        }
    }

    #[test]
    fn bedrock_failed_results_preserve_model_request_evidence() {
        for (status, reason) in [
            (429, "provider_rate_limited"),
            (503, "provider_server_error"),
            (200, "provider_server_error"),
        ] {
            let (responses, _rx) = response_channel();
            let mut projection = PiRpcProjection::new("run", "session");
            projection.project(json!({"type": "message_end", "message": {
                "role": "assistant", "api": "bedrock-converse-stream", "stopReason": "error",
                "errorMessage": "Provider rejected request",
                "diagnostics": [{"type": "okou_model_request", "details": {
                    "httpStatus": status, "transportAttempts": 1, "failureReason": reason
                }}]
            }}), &responses, 0).unwrap();
            let result = projection
                .project(json!({"type": "agent_settled"}), &responses, 0)
                .unwrap()
                .unwrap();
            assert_eq!(result["is_error"], true);
            assert_eq!(result["failureReason"], reason);
            assert_eq!(result["modelRequest"]["httpStatus"], status);
            assert_eq!(result["modelRequest"]["transportAttempts"], 1);
            assert_eq!(result["modelRequest"]["retryAttempts"], 0);
        }
    }

    #[test]
    fn semantic_http_success_keeps_failed_reason_and_observed_retries() {
        for (message, reason, retries) in [
            (
                "Codex error: Our servers are currently overloaded. Please try again later.",
                "provider_overloaded",
                3,
            ),
            (
                "Codex error: Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://example.invalid/policy",
                "safety_policy_refusal",
                0,
            ),
        ] {
            let failure = json!({"type": "message_end", "message": {
                "role": "assistant", "api": "openai-codex-responses", "stopReason": "error",
                "errorMessage": message,
                "diagnostics": [{"type": "okou_model_request", "details": {
                    "httpStatus": 200, "transportAttempts": 1, "failureReason": reason
                }}]
            }});
            let (responses, _rx) = response_channel();
            let mut projection = PiRpcProjection::new("run", "session");
            projection.project(failure.clone(), &responses, 0).unwrap();
            for attempt in 1..=retries {
                projection
                    .project(
                        json!({"type": "auto_retry_start", "attempt": attempt, "maxAttempts": 3}),
                        &responses,
                        0,
                    )
                    .unwrap();
                projection.project(failure.clone(), &responses, 0).unwrap();
            }
            let result = projection
                .project(json!({"type": "agent_settled"}), &responses, 0)
                .unwrap()
                .unwrap();
            assert_eq!(result["is_error"], true);
            assert_eq!(result["failureReason"], reason);
            assert_eq!(result["modelRequest"]["httpStatus"], 200);
            assert_eq!(result["modelRequest"]["transportAttempts"], 1);
            assert_eq!(result["modelRequest"]["retryAttempts"], retries);
            assert_eq!(
                result["modelRequest"]["retryLimit"],
                if retries == 0 { Value::Null } else { json!(3) }
            );
        }
    }

    #[test]
    fn model_request_evidence_is_only_accepted_from_valid_failed_assistant_messages() {
        let failed: Value = serde_json::from_str(include_str!(
            "../../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-rate-limit.json"
        ))
        .expect("shared model boundary fixture");
        let mut aborted = failed.clone();
        aborted["stopReason"] = json!("aborted");
        let mut wrong_api = failed.clone();
        wrong_api["api"] = json!("unrelated");
        let mut malformed = failed.clone();
        malformed["diagnostics"][0]["details"]["httpStatus"] = json!("429");
        let mut unknown = failed;
        unknown["diagnostics"][0]["type"] = json!("provider-authored-text");
        let tool = json!({
            "role": "toolResult", "toolCallId": "call", "isError": true,
            "content": [{"type": "text", "text": "{\"detail\":\"Rate limit exceeded\"}"}],
            "diagnostics": [{"type": "okou_model_request", "details": {"httpStatus": 429, "transportAttempts": 1}}],
        });
        for message in [aborted, wrong_api, malformed, unknown, tool] {
            let (responses, _rx) = response_channel();
            let mut projection = PiRpcProjection::new("run", "session");
            projection
                .project(
                    json!({"type": "message_end", "message": message}),
                    &responses,
                    0,
                )
                .expect("project native message");
            let result = projection
                .project(json!({"type": "agent_settled"}), &responses, 0)
                .expect("settled result")
                .expect("terminal event");
            assert!(result.get("modelRequest").is_none());
        }
    }

    #[test]
    fn projection_matches_shared_public_event_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../../fixtures/pi-public-events.json"))
                .expect("shared public event fixture must parse");
        for case in fixture["cases"].as_array().expect("fixture cases") {
            let name = case["name"].as_str().expect("case name");
            let (responses, _rx) = response_channel();
            let mut projection = PiRpcProjection::new(
                fixture["runId"].as_str().expect("run id"),
                fixture["sessionId"].as_str().expect("session id"),
            );
            let projected = projection
                .project(
                    json!({ "type": "message_end", "message": case["guestMessage"] }),
                    &responses,
                    0,
                )
                .expect("official assistant should project");
            let events: Vec<Value> = projected
                .into_iter()
                .flat_map(|event| {
                    super::super::provider_event_normalization::normalize_for_sequencing(
                        crate::env::Framework::Pi,
                        event,
                    )
                })
                .collect();
            let messages: Vec<&Value> = events.iter().map(|event| &event["message"]).collect();
            assert_eq!(json!(messages), case["expectedMessages"], "{name}");
            // Guest sequencing belongs to the startup boundary and ingestor. Projection does not invent the API's zero-based index.
            for event in events {
                assert_eq!(event["type"], "assistant", "{name}");
                assert!(event.get("sequenceNumber").is_none(), "{name}");
                assert!(event.get("duration_ms").is_none(), "{name}");
            }
            assert!(
                projection
                    .project(json!({ "type": "agent_end" }), &responses, 0)
                    .expect("agent_end is not terminal")
                    .is_none(),
                "{name}"
            );
            let terminal = projection
                .project(json!({ "type": "agent_settled" }), &responses, 0)
                .expect("agent_settled should project")
                .expect("only agent_settled owns the terminal result");
            assert_eq!(terminal["type"], "result", "{name}");
            assert_eq!(terminal["subtype"], "success", "{name}");
            assert_eq!(terminal["is_error"], false, "{name}");
            assert_eq!(terminal["result"], case["guestResult"], "{name}");
            assert_eq!(terminal["session_id"], fixture["sessionId"], "{name}");
            assert!(terminal["duration_ms"].as_u64().is_some(), "{name}");
        }
    }

    #[test]
    fn streaming_uses_native_content_indices_and_reconciles_each_response() {
        let hidden = "<oai-mem-citation><citation_entries>memory.md:1-1|note=[used]</citation_entries></oai-mem-citation>";
        let hidden_tail = hidden
            .strip_prefix("<oai-mem-")
            .expect("citation fixture prefix");
        let (output, mut output_rx) = super::super::pi_session_output::test_channel(32, "run-id");
        let (responses, _responses_rx) = response_channel();
        let mut projection =
            PiRpcProjection::new("run-id", "thread-id").with_session_output(output);

        assert!(
            projection
                .project(
                    json!({
                        "type": "message_start",
                        "message": { "role": "assistant", "content": [] }
                    }),
                    &responses,
                    0,
                )
                .expect("message start")
                .is_none()
        );
        projection
            .project(
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_start",
                        "contentIndex": 0,
                        "initialText": "  Alpha<oai-mem-"
                    },
                    "usage": {}
                }),
                &responses,
                0,
            )
            .expect("initial Anthropic text should stream");
        projection
            .project(
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "contentIndex": 0,
                        "delta": format!("{hidden_tail} one")
                    },
                    "usage": {}
                }),
                &responses,
                0,
            )
            .expect("cross-delta citation should stream safely");
        projection
            .project(
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_start",
                        "contentIndex": 2
                    },
                    "usage": {}
                }),
                &responses,
                0,
            )
            .expect("empty provider text start");
        projection
            .project(
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "contentIndex": 2,
                        "delta": "Third"
                    },
                    "usage": {}
                }),
                &responses,
                0,
            )
            .expect("second text block should stream");

        let first = projection
            .project(
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [
                            { "type": "text", "text": format!("  Alpha{hidden} one") },
                            { "type": "toolCall", "id": "call-1", "name": "read", "arguments": {} },
                            { "type": "text", "text": "Third" }
                        ],
                        "model": "model",
                        "timestamp": 1,
                        "usage": {},
                        "stopReason": "toolUse"
                    }
                }),
                &responses,
                0,
            )
            .expect("first response should project")
            .expect("first response event");
        let first_events = super::super::provider_event_normalization::normalize_for_sequencing(
            crate::env::Framework::Pi,
            first,
        );
        assert_eq!(first_events.len(), 3);
        let first_id = first_events[0]["runEventId"]
            .as_str()
            .expect("first text run event id");
        let third_id = first_events[2]["runEventId"]
            .as_str()
            .expect("third text run event id");
        assert!(first_id.ends_with(":0"));
        assert!(third_id.ends_with(":2"));
        assert_eq!(
            first_events[0]["message"]["content"][0]["text"],
            "Alpha one"
        );
        assert_eq!(first_events[2]["message"]["content"][0]["text"], "Third");
        assert!(first_events[1].get("runEventId").is_none());

        let mut first_chunks = Vec::new();
        while let Ok(chunk) = output_rx.try_recv() {
            first_chunks.push(chunk);
        }
        assert_eq!(first_chunks.len(), 3);
        assert_eq!(first_chunks[0].run_event_id, first_id);
        assert_eq!(first_chunks[0].delta, "Alpha");
        assert_eq!(first_chunks[1].run_event_id, first_id);
        assert_eq!(first_chunks[1].delta, " one");
        assert_eq!(first_chunks[2].run_event_id, third_id);
        assert_eq!(first_chunks[2].delta, "Third");
        let streamed = first_chunks
            .iter()
            .map(|chunk| chunk.delta.as_str())
            .collect::<String>();
        assert!(!streamed.contains("oai-mem-citation"));
        assert!(!streamed.contains("memory.md"));

        projection
            .project(
                json!({
                    "type": "message_start",
                    "message": { "role": "assistant", "content": [] }
                }),
                &responses,
                0,
            )
            .expect("second response start");
        projection
            .project(
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "contentIndex": 0,
                        "delta": "Beta"
                    },
                    "usage": {}
                }),
                &responses,
                0,
            )
            .expect("second response delta");
        let second = projection
            .project(
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "Beta" }],
                        "model": "model",
                        "timestamp": 2,
                        "usage": {},
                        "stopReason": "stop"
                    }
                }),
                &responses,
                0,
            )
            .expect("second response should project")
            .expect("second response event");
        let second_events = super::super::provider_event_normalization::normalize_for_sequencing(
            crate::env::Framework::Pi,
            second,
        );
        let second_id = second_events[0]["runEventId"]
            .as_str()
            .expect("second response run event id");
        assert!(second_id.ends_with(":0"));
        assert_ne!(second_id, first_id);
        let second_chunk = output_rx.try_recv().expect("second response chunk");
        assert_eq!(second_chunk.run_event_id, second_id);
        assert_eq!(second_chunk.delta, "Beta");
    }

    #[test]
    fn streaming_overflow_preserves_the_authoritative_message_and_result() {
        let (output, _output_rx) = super::super::pi_session_output::test_channel(1, "run-id");
        let (responses, _responses_rx) = response_channel();
        let mut projection =
            PiRpcProjection::new("run-id", "thread-id").with_session_output(output);

        projection
            .project(
                json!({
                    "type": "message_start",
                    "message": { "role": "assistant", "content": [] }
                }),
                &responses,
                0,
            )
            .expect("message start");
        for delta in ["first", " second"] {
            projection
                .project(
                    json!({
                        "type": "message_update",
                        "assistantMessageEvent": {
                            "type": "text_delta",
                            "contentIndex": 0,
                            "delta": delta
                        },
                        "usage": {}
                    }),
                    &responses,
                    0,
                )
                .expect("queue pressure must not fail projection");
        }
        let assistant = projection
            .project(
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "first second" }],
                        "model": "model",
                        "timestamp": 1,
                        "usage": {},
                        "stopReason": "stop"
                    }
                }),
                &responses,
                0,
            )
            .expect("authoritative message must project")
            .expect("authoritative message event");
        assert_eq!(assistant["message"]["content"][0]["text"], "first second");
        assert!(assistant["message"]["content"][0]["runEventId"].is_string());

        let result = projection
            .project(json!({ "type": "agent_settled" }), &responses, 0)
            .expect("settlement must project")
            .expect("settlement event");
        assert_eq!(result["subtype"], "success");
        assert_eq!(result["result"], "first second");
    }

    #[test]
    fn streaming_splits_utf8_deltas_at_the_request_byte_bound() {
        let (output, mut output_rx) = super::super::pi_session_output::test_channel(8, "run-id");
        let (responses, _responses_rx) = response_channel();
        let mut projection =
            PiRpcProjection::new("run-id", "thread-id").with_session_output(output);
        let text = "é".repeat(3000);

        projection
            .project(
                json!({
                    "type": "message_start",
                    "message": { "role": "assistant", "content": [] }
                }),
                &responses,
                0,
            )
            .expect("message start");
        projection
            .project(
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "contentIndex": 0,
                        "delta": text
                    },
                    "usage": {}
                }),
                &responses,
                0,
            )
            .expect("large delta");

        let first = output_rx.try_recv().expect("first bounded chunk");
        let second = output_rx.try_recv().expect("second bounded chunk");
        assert!(first.delta.len() <= SESSION_OUTPUT_DELTA_MAX_BYTES);
        assert!(second.delta.len() <= SESSION_OUTPUT_DELTA_MAX_BYTES);
        assert_eq!(format!("{}{}", first.delta, second.delta), "é".repeat(3000));
    }

    async fn next_command(reader: &mut BufReader<tokio::process::ChildStdout>) -> Value {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .expect("mock Pi stdout should be readable");
        serde_json::from_str(&line).expect("Pi command should be JSON")
    }

    #[test]
    fn first_official_record_starts_the_run_and_is_projected() {
        let mut boundary = PiRpcStartupBoundary::default();
        assert!(boundary.requires_boundary());

        assert!(matches!(boundary.admit(), PiRpcRecordAdmission::Start));
        assert!(!boundary.requires_boundary());
        assert!(matches!(boundary.admit(), PiRpcRecordAdmission::Project));

        boundary.discard_remaining();
        assert!(matches!(boundary.admit(), PiRpcRecordAdmission::Discard));
    }

    #[test]
    fn only_records_the_projection_ignores_are_discardable_when_oversized() {
        assert!(oversized_record_is_discardable("agent_end"));

        // Every record that owns public output, drives the startup boundary or
        // reports a failure must stay fatal when oversized: discarding one
        // would silently drop a structured record instead of failing loudly.
        for owned in [
            "message_end",
            "message_start",
            "message_update",
            "agent_settled",
            "response",
            "extension_error",
            "auto_retry_start",
            "auto_retry_end",
            "unknown",
            "",
        ] {
            assert!(
                !oversized_record_is_discardable(owned),
                "{owned} must not be discardable"
            );
        }
    }

    #[test]
    fn projection_uses_agent_settled_as_the_terminal_event() {
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        assert!(
            projection
                .project(
                    json!({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "text", "text": "done" }],
                            "model": "model",
                            "timestamp": 1,
                            "usage": {},
                            "stopReason": "stop",
                        }
                    }),
                    &responses,
                    0,
                )
                .expect("message should project")
                .is_some()
        );
        assert!(
            projection
                .project(
                    json!({ "type": "agent_end", "messages": [] }),
                    &responses,
                    0,
                )
                .expect("agent_end should be ignored")
                .is_none()
        );
        let result = projection
            .project(json!({ "type": "agent_settled" }), &responses, 0)
            .expect("agent_settled should project")
            .expect("agent_settled should emit result");
        assert_eq!(result["type"], "result");
        assert_eq!(result["result"], "done");
    }

    #[test]
    fn projection_hides_citations_in_assistant_and_terminal_result() {
        let hidden = "<oai-mem-citation><citation_entries>memory.md:2-3|note=[used]</citation_entries><rollout_ids>019c6e27-e55b-73d1-87d8-4e01f1f75043</rollout_ids></oai-mem-citation>";
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let assistant = projection
            .project(
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [
                            { "type": "text", "text": format!("before{}", &hidden[..12]) },
                            { "type": "text", "text": format!("{}after", &hidden[12..]) },
                        ],
                        "model": "model",
                        "timestamp": 1,
                        "usage": {},
                        "stopReason": "stop",
                    }
                }),
                &responses,
                0,
            )
            .expect("message should project")
            .expect("citation-bearing assistant should emit");
        assert_eq!(assistant["message"]["content"][0]["text"], "before");
        assert_eq!(assistant["message"]["content"][1]["text"], "after");
        assert_eq!(
            assistant["message"]["memoryCitation"]["entries"][0]["path"],
            "memory.md"
        );
        assert_eq!(
            assistant["message"]["memoryCitation"]["rolloutIds"][0],
            "019c6e27-e55b-73d1-87d8-4e01f1f75043"
        );

        let result = projection
            .project(json!({ "type": "agent_settled" }), &responses, 0)
            .expect("settled event should project")
            .expect("settled event should emit");
        assert_eq!(result["result"], "before\n\nafter");
        assert!(!result.to_string().contains("oai-mem-citation"));
    }

    #[test]
    fn short_fence_runs_keep_citations_out_of_assistant_and_terminal_text() {
        use super::super::pi_memory_citation::{CLOSE, OPEN};

        for (fence, short) in [("```", "``"), ("~~~~", "~~~")] {
            let (responses, _rx) = response_channel();
            let mut projection = PiRpcProjection::new("run", "session");
            let prefix = format!("before\n{fence}\n");
            let assistant = projection
                .project(
                    json!({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [
                                { "type": "text", "text": format!("{prefix}{OPEN}\n{short}") },
                                { "type": "text", "text": format!("\n{fence}\n<citation_entries>private-synthetic.md:1-1|note=[synthetic note]</citation_entries>{CLOSE}after") },
                            ],
                            "model": "model",
                            "timestamp": 1,
                            "usage": {},
                            "stopReason": "stop",
                        }
                    }),
                    &responses,
                    0,
                )
                .expect("message should project")
                .expect("assistant should emit");
            assert_eq!(
                assistant["message"]["content"],
                json!([
                    { "type": "text", "text": format!("before\n{fence}") },
                    { "type": "text", "text": "after" },
                ])
            );
            assert_eq!(
                assistant["message"]["memoryCitation"]["entries"],
                json!([{
                    "path": "private-synthetic.md",
                    "lineStart": 1,
                    "lineEnd": 1,
                    "note": "synthetic note",
                }])
            );

            let result = projection
                .project(json!({ "type": "agent_settled" }), &responses, 0)
                .expect("settled event should project")
                .expect("settled event should emit");
            assert_eq!(result["result"], format!("before\n{fence}\n\nafter"));
        }
    }

    #[test]
    fn citation_only_projection_keeps_provenance_without_fallback_text() {
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let assistant = projection
            .project(
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{
                            "type": "text",
                            "text": "<oai-mem-citation><citation_entries>x:1-1|note=[n]</citation_entries></oai-mem-citation>"
                        }],
                        "model": "model",
                        "timestamp": 1,
                        "usage": {},
                        "stopReason": "stop",
                    }
                }),
                &responses,
                0,
            )
            .expect("message should project")
            .expect("citation-only assistant should emit");
        assert_eq!(assistant["message"]["content"], json!([]));
        assert_eq!(
            assistant["message"]["memoryCitation"]["entries"][0]["path"],
            "x"
        );
        let result = projection
            .project(json!({ "type": "agent_settled" }), &responses, 0)
            .expect("settled event should project")
            .expect("settled event should emit");
        assert_eq!(result["result"], "");
    }

    #[test]
    fn projection_hides_citations_in_terminal_error_text() {
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let assistant = projection
            .project(
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [],
                        "errorMessage": "failed<oai-mem-citation><citation_entries>x:1-1|note=[n]</citation_entries></oai-mem-citation>",
                        "model": "model",
                        "timestamp": 1,
                        "usage": {},
                        "stopReason": "error",
                    }
                }),
                &responses,
                0,
            )
            .expect("message should project")
            .expect("citation-bearing error should emit");
        assert_eq!(assistant["message"]["content"], json!([]));
        assert_eq!(
            assistant["message"]["memoryCitation"]["entries"][0]["path"],
            "x"
        );
        let result = projection
            .project(json!({ "type": "agent_settled" }), &responses, 0)
            .expect("settled event should project")
            .expect("settled event should emit");
        assert_eq!(result["result"], "failed");
        assert!(!result.to_string().contains("oai-mem-citation"));
    }

    #[test]
    fn projection_moves_large_tool_payload_allocations() {
        const LARGE_PAYLOAD_BYTES: usize = 1024 * 1024;

        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let tool_call = json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "toolCall",
                    "id": "tool-1",
                    "name": "large_tool",
                    "arguments": {
                        "payload": "a".repeat(LARGE_PAYLOAD_BYTES),
                    },
                }],
                "model": "model",
                "timestamp": 1,
                "usage": {},
                "stopReason": "toolUse",
            },
        });
        let argument = tool_call
            .pointer("/message/content/0/arguments/payload")
            .and_then(Value::as_str)
            .expect("tool-call argument should be a string");
        let argument_ptr = argument.as_ptr();

        let tool_call = projection
            .project(tool_call, &responses, 0)
            .expect("tool call should project")
            .expect("tool call should emit an event");
        let projected_argument = tool_call
            .pointer("/message/content/0/input/payload")
            .and_then(Value::as_str)
            .expect("projected tool-call argument should be a string");
        assert_eq!(projected_argument.len(), LARGE_PAYLOAD_BYTES);
        assert!(std::ptr::eq(projected_argument.as_ptr(), argument_ptr));

        let tool_result = json!({
            "type": "message_end",
            "message": {
                "role": "toolResult",
                "toolCallId": "tool-1",
                "content": [
                    {
                        "type": "text",
                        "text": "t".repeat(LARGE_PAYLOAD_BYTES),
                    },
                    {
                        "type": "image",
                        "mimeType": "image/png",
                        "data": "i".repeat(LARGE_PAYLOAD_BYTES),
                    },
                ],
                "isError": false,
            },
        });
        let text = tool_result
            .pointer("/message/content/0/text")
            .and_then(Value::as_str)
            .expect("tool-result text should be a string");
        let text_ptr = text.as_ptr();
        let image_data = tool_result
            .pointer("/message/content/1/data")
            .and_then(Value::as_str)
            .expect("tool-result image data should be a string");
        let image_data_ptr = image_data.as_ptr();

        let tool_result = projection
            .project(tool_result, &responses, 0)
            .expect("tool result should project")
            .expect("tool result should emit an event");
        let projected_text = tool_result
            .pointer("/message/content/0/content/0/text")
            .and_then(Value::as_str)
            .expect("projected tool-result text should be a string");
        assert_eq!(projected_text.len(), LARGE_PAYLOAD_BYTES);
        assert!(std::ptr::eq(projected_text.as_ptr(), text_ptr));
        let projected_image_data = tool_result
            .pointer("/message/content/0/content/1/source/data")
            .and_then(Value::as_str)
            .expect("projected tool-result image data should be a string");
        assert_eq!(projected_image_data.len(), LARGE_PAYLOAD_BYTES);
        assert!(std::ptr::eq(projected_image_data.as_ptr(), image_data_ptr));
    }

    #[test]
    fn failed_tools_and_independent_quota_failure_reach_a_terminal_error() {
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let tool = projection
            .project(
                json!({
                    "type": "message_end", "message": {
                        "role": "toolResult", "timestamp": 20, "toolCallId": "tool-1",
                        "content": [{"type": "text", "text": "tool killed"}], "isError": true
                    }
                }),
                &responses,
                0,
            )
            .unwrap()
            .unwrap();
        assert_eq!(tool["message"]["content"][0]["is_error"], true);
        assert!(
            projection
                .project(
                    json!({
                        "type": "message_end", "message": {"role": "toolResult", "timestamp": 30}
                    }),
                    &responses,
                    0
                )
                .is_err()
        );
        projection
            .project(
                json!({
                    "type": "message_end", "message": {
                        "role": "assistant", "timestamp": 40, "content": [],
                        "stopReason": "error", "errorMessage": "ChatGPT Pro quota exhausted"
                    }
                }),
                &responses,
                0,
            )
            .unwrap();
        let terminal = projection
            .project(json!({"type": "agent_settled"}), &responses, 0)
            .unwrap()
            .unwrap();
        assert_eq!(terminal["is_error"], true);
        assert_eq!(terminal["subtype"], "error_during_execution");
    }

    #[test]
    fn projection_validates_get_state_session_identity() {
        let (responses, mut rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let event = projection
            .project(
                json!({
                    "id": "state",
                    "type": "response",
                    "command": "get_state",
                    "success": true,
                    "data": {
                        "sessionId": "session",
                        "sessionFile": "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl",
                    },
                }),
                &responses,
                1,
            )
            .expect("state should project")
            .expect("state should emit init");
        assert_eq!(event["session_id"], "session");
        assert_eq!(
            event["session_file"],
            "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl"
        );
        assert_eq!(
            rx.try_recv().expect("response should be routed").value["id"],
            "state"
        );
    }

    #[test]
    fn projection_discards_buffered_records_after_extension_failure() {
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let error = projection
            .project(
                json!({
                    "type": "extension_error",
                    "event": "message_end",
                    "error": "forced extension failure",
                }),
                &responses,
                0,
            )
            .expect_err("checkpoint failure should terminate projection");
        assert!(error.to_string().contains("forced extension failure"));

        assert!(
            projection
                .project(
                    json!({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "text", "text": "must not project" }],
                            "model": "model",
                            "timestamp": 1,
                            "usage": {},
                            "stopReason": "stop",
                        }
                    }),
                    &responses,
                    0,
                )
                .expect("buffered message should be discarded")
                .is_none()
        );
        assert!(
            projection
                .project(json!({ "type": "agent_settled" }), &responses, 0)
                .expect("buffered terminal event should be discarded")
                .is_none()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn writer_uses_steer_ack_for_active_input() {
        let mut child = tokio::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("cat should spawn");
        let stdin = child.stdin.take().expect("cat stdin should exist");
        let stdout = child.stdout.take().expect("cat stdout should exist");
        let mut stdout = BufReader::new(stdout);
        let active_input = ActiveInputRuntime::new_for_test("run", "initial prompt");
        let controller = active_input.controller();
        let event_id = "11111111-1111-4111-8111-111111111111";
        let payload = json!({
            "type": "active-input",
            "eventId": event_id,
            "text": "steer this turn",
        });
        assert_eq!(
            controller.handle_control_payload(&serde_json::to_vec(&payload).expect("payload")),
            ActiveInputControlOutcome::Accepted
        );
        let (response_tx, response_rx) = response_channel();
        let (startup_tx, startup_rx) = tokio::sync::oneshot::channel();
        let writer = tokio::spawn(write_commands(
            stdin,
            "run",
            "initial prompt",
            active_input.into_writer(),
            response_rx,
            startup_rx,
            CancellationToken::new(),
        ));

        let state = next_command(&mut stdout).await;
        assert_eq!(state["type"], "get_state");
        response_tx
            .try_send(json!({
                "id": state["id"],
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": {
                    "sessionId": "session",
                    "sessionFile": "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl",
                },
            }), 1)
            .expect("state response should route");
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                next_command(&mut stdout)
            )
            .await
            .is_err(),
            "initial prompt must wait for boundary installation"
        );
        startup_tx
            .send(())
            .expect("startup installation should route");

        let initial = next_command(&mut stdout).await;
        assert_eq!(initial["type"], "prompt");
        assert_eq!(initial["message"], "initial prompt");
        assert!(initial.get("streamingBehavior").is_none());
        response_tx
            .try_send(
                json!({
                    "id": initial["id"],
                    "type": "response",
                    "command": "prompt",
                    "success": true,
                }),
                1,
            )
            .expect("initial prompt response should route");

        let steer = next_command(&mut stdout).await;
        assert_eq!(steer["id"], event_id);
        assert_eq!(steer["type"], "steer");
        assert_eq!(steer["message"], "steer this turn");
        assert!(steer.get("streamingBehavior").is_none());
        response_tx
            .try_send(
                json!({
                    "id": event_id,
                    "type": "response",
                    "command": "steer",
                    "success": true,
                }),
                1,
            )
            .expect("steer response should route");
        controller.close_terminal();

        writer
            .await
            .expect("writer task should join")
            .expect("writer should succeed");
        controller
            .finalize_steered_declarations()
            .await
            .expect("steered declarations should finalize");
        child.wait().await.expect("cat should exit");
    }
}
