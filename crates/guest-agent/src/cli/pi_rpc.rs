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
//! The stdout projection records successful steer ACK observation for the
//! matching writer-owned frame before processing a following `agent_settled`.
//! Result-time closure can therefore account for that ACK without depending on
//! when the writer consumes it. The writer retains acceptance and declaration
//! ownership; queued or unacknowledged frames still block closure.
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
//!   supported content emit no public event. Their raw records remain local.
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
//! sequenced public event per block. The source order is retained, and common
//! masking and bounded delivery happen after that normalization.
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
//! itself close the public run. `stopReason` values `error` and `aborted` set
//! the cached failure flag. The result text uses `errorMessage` when present,
//! otherwise the joined non-empty assistant text. An `errorMessage` is
//! upstream-controlled, so it passes through
//! [`crate::upstream_error_text::project_model_error_text`]: a markup document
//! becomes a bounded content-free description and any other message keeps its
//! exact text under a size bound. Assistant text is the run's own answer and is
//! never bounded here. Except for `length`, an empty result falls back to
//! `Pi model turn <stopReason>` when a stop reason exists.
//! A final `length` result follows Pi's completed outcome and retains the partial
//! assistant answer. The SDK owns truncated-response recovery before settlement.
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

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use guest_contracts::diagnostics::ModelRequestDiagnostic;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

use super::pi_session_output::{PiSessionOutputSender, SESSION_OUTPUT_DELTA_MAX_BYTES};
use crate::active_input::{ActiveInputController, ActiveInputFrame, ActiveInputWriter};
use crate::error::AgentError;
use crate::masker::{SecretMasker, StreamingSecretMasker};
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

struct PiAssistantStream<'a> {
    event_id_prefix: String,
    masker: &'a SecretMasker,
    masking: BTreeMap<usize, StreamingSecretMasker<'a>>,
    started_sources: HashSet<usize>,
    closed_sources: HashSet<usize>,
    output: PiSessionOutputSender,
}

impl<'a> PiAssistantStream<'a> {
    fn new(output: PiSessionOutputSender, masker: &'a SecretMasker) -> Self {
        Self {
            event_id_prefix: format!("sandbox:{}", uuid::Uuid::new_v4()),
            masker,
            masking: BTreeMap::new(),
            started_sources: HashSet::new(),
            closed_sources: HashSet::new(),
            output,
        }
    }

    fn push(&mut self, source: usize, text: &str) {
        if source > MAX_STREAM_CONTENT_INDEX || text.is_empty() {
            return;
        }
        if self.closed_sources.contains(&source) {
            return;
        }
        // Mask each source before trimming or transport chunk boundaries.
        let masked = self
            .masking
            .entry(source)
            .or_insert_with(|| self.masker.stream())
            .push(text);
        self.emit_masked(source, &masked);
    }

    fn emit_masked(&mut self, source: usize, text: &str) {
        if self.closed_sources.contains(&source) {
            return;
        }
        let text = if self.started_sources.contains(&source) {
            text
        } else {
            text.trim_start()
        };
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
                self.masking.remove(&source);
                break;
            }
            self.started_sources.insert(source);
            remaining = &remaining[end..];
        }
    }

    fn finish(mut self) -> String {
        for (source, masking) in std::mem::take(&mut self.masking) {
            self.emit_masked(source, &masking.finish());
        }
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
    fn from_message(message: &Value) -> Self {
        let stop_reason = message.get("stopReason").and_then(Value::as_str);
        let failed = matches!(stop_reason, Some("error" | "aborted"));
        // A model error is upstream-controlled text. Bounding it here keeps the
        // public result, the delivered event and the failure diagnostic on the
        // same actionable value; assistant text stays untouched because it is
        // the run's own answer.
        let result = if stop_reason == Some("length") {
            assistant_text(message)
        } else {
            message
                .get("errorMessage")
                .and_then(Value::as_str)
                .map_or_else(|| assistant_text(message), project_model_error_text)
        };
        let result = if stop_reason != Some("length") && result.is_empty() {
            stop_reason.map_or_else(String::new, |reason| format!("Pi model turn {reason}"))
        } else {
            result
        };
        let model_request = (stop_reason == Some("error"))
            .then(|| model_request_diagnostic(message))
            .flatten();
        let failure_reason = match stop_reason {
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
        Some("openai-codex-responses" | "openai-responses" | "openai-completions")
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
/// `agent_end` carries the agent loop's messages, and `turn_end` carries the
/// current assistant message and tool results. The RPC wire has already
/// delivered those messages individually as `message_end` records, so
/// [`PiRpcProjection::project`] ignores both boundaries and `agent_settled`
/// owns the public terminal result. Discarding either oversized boundary
/// therefore drops only duplicate content.
///
/// The allowlist is limited to these two proven duplicate boundaries. Other
/// records remain fatal when oversized, including unrecognized types. Only
/// the record's type is known here — it is recovered from a bounded prefix
/// and never parsed — so nothing may be assumed about content.
pub(super) fn oversized_record_is_discardable(event_type: &str) -> bool {
    matches!(event_type, "agent_end" | "turn_end")
}

pub(super) struct PiRpcProjection<'a> {
    run_id: String,
    session_id: String,
    started_at: Instant,
    emitted_session_init: bool,
    assistant_terminal: Option<PiAssistantTerminal>,
    session_output: Option<(PiSessionOutputSender, &'a SecretMasker)>,
    assistant_stream: Option<PiAssistantStream<'a>>,
    pending_retry: Option<PiRetryAttempt>,
    terminal_error: bool,
    active_input: Option<ActiveInputController>,
}

impl<'a> PiRpcProjection<'a> {
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
            active_input: None,
        }
    }

    pub(super) fn with_active_input(mut self, controller: ActiveInputController) -> Self {
        self.active_input = Some(controller);
        self
    }

    pub(super) fn with_session_output(
        mut self,
        output: PiSessionOutputSender,
        masker: &'a SecretMasker,
    ) -> Self {
        self.session_output = Some((output, masker));
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
        let steer_ack = (command == Some("steer")
            && response.get("success").and_then(Value::as_bool) == Some(true))
        .then(|| response.get("id").and_then(Value::as_str))
        .flatten()
        .map(str::to_owned);
        responses.try_send(response, record_bytes)?;
        if let Some(controller) = &self.active_input
            && let Some(id) = steer_ack
        {
            controller.mark_backend_acknowledged(&id);
        }
        Ok(projected)
    }

    fn project_message_start(&mut self, event: &Value) {
        if event.pointer("/message/role").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        self.assistant_stream = self
            .session_output
            .as_ref()
            .map(|(output, masker)| PiAssistantStream::new(output.clone(), masker));
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
        if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
            return;
        }
        if let Some(text) = delta.get("delta").and_then(Value::as_str) {
            stream.push(source, text);
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
        let mut terminal = PiAssistantTerminal::from_message(&message);
        let retry = self.pending_retry.take();
        if let Some(request) = terminal.model_request.as_mut() {
            // Only a scheduled SDK retry is a retry. Compaction and queued
            // input can continue after an error without sharing its budget.
            request.retry_attempts = retry.map_or(0, |retry| retry.attempt);
            request.retry_limit = retry.map(|retry| retry.max_attempts);
        }
        self.assistant_terminal = Some(terminal);
        let content = assistant_content(&mut message, event_id_prefix)?;
        if content.is_empty() {
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
        let projected_message = owned_object([
            ("id", Value::String(id)),
            ("role", Value::from("assistant")),
            ("content", Value::Array(content)),
            ("model", Value::String(model.to_string())),
            ("usage", usage),
        ]);
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
mod tests;
