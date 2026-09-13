//! Official Pi RPC command lifecycle and public-event projection.
//!
//! ## Ownership and data flow
//!
//! The sandbox TypeScript host resolves the API-first handoff, restores the
//! validated ownership-transfer session file, writes one private startup
//! record to stdout, and then enters Pi's official `runRpcMode`. The guest owns the
//! other side of that boundary. Its stdout loop in `cli/mod.rs` admits the
//! boundary before any official RPC record, starts the shared event pipeline
//! from the installed sequence, and then applies this module's projection.
//!
//! There are two coupled JSONL paths after startup:
//!
//! - The guest writer owns child stdin. It sends `get_state`, waits until the
//!   private startup record is installed, sends the initial `prompt`, and then
//!   delivers accepted active-input frames. The stdout loop routes `response`
//!   records into the writer's bounded response channel without waiting for
//!   capacity.
//! - The stdout loop owns child stdout. It retains each ordinary raw record in
//!   the best-effort local agent transcript, projects supported records into
//!   the existing public event shape, and passes projected events through
//!   normalization, secret masking, sequencing, bounded FIFO delivery, and the
//!   HTTP event worker. The startup control is the exception: it is consumed
//!   before the transcript and public pipeline and is never delivered.
//!
//! The public event pipeline is deliberately created only after boundary
//! installation. `CliEventIngestor` and `EventDeliveryRuntime` receive the same
//! installed first sequence, so the first public event and the delivery
//! acknowledgement watermark cannot start from different boundaries.
//!
//! ## API-first startup boundary
//!
//! Manifest V3 handoffs emit this private control before official RPC output:
//!
//! ```json
//! {
//!   "type": "vm0_pi_api_first_turn_boundary",
//!   "schemaVersion": 2,
//!   "sandboxEventSequenceStart": 4,
//!   "ownershipTransferMode": "pending-tool-continuation"
//! }
//! ```
//!
//! Boundary schema V2 carries one explicit `ownershipTransferMode`:
//! `sandbox-first`,
//! `pending-tool-continuation`, or `settled-session-continuation`. The private
//! boundary schema is independent of the public manifest schema. Rust accepts a
//! boundary only when its type and schema version are exact, all fields are
//! known, the mode is valid for that schema, and the sequence is in
//! `1..=i32::MAX` (`1..=2,147,483,647`).
//!
//! `PiRpcStartupBoundary` is a fail-closed one-time gate:
//!
//! - Before installation, a non-control JSON record fails with
//!   `PI_HANDOFF_BOUNDARY_MISSING`. A malformed control, invalid schema, zero,
//!   overflowing, or otherwise invalid sequence fails with
//!   `PI_HANDOFF_BOUNDARY_INVALID`.
//! - The first valid control installs the boundary. A second control before an
//!   official record is a duplicate; a different value is a conflict; and a
//!   control after an official record is late. Each is terminal and rejects
//!   the stream.
//! - After a rejection, `discard_remaining` makes all later records
//!   non-projecting. Invalid non-JSON input is also fatal while the boundary is
//!   still required, or when the raw line resembles the control type.
//! - `cli/mod.rs` consumes the installed control before projection. It is not
//!   written to the agent transcript, assigned a public sequence, sent to the
//!   webhook, or rendered as an agent/Chat event.
//!
//! This ordering is the API-first reader contract: no official RPC record may
//! reach projection, masking, sequencing, or delivery until the boundary that
//! authorized the restored H1 session has been installed.
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
//! After `get_state`, the writer waits for the stdout loop to install the
//! startup boundary. It then sends the original initial `prompt` with ID
//! `<run-id>:pi:initial-prompt`; the TypeScript host interprets that official
//! command according to the installed mode. Sandbox-first executes it normally,
//! pending-tool continuation substitutes pending-tool execution, and settled
//! continuation acknowledges it without a model request. This preserves the
//! official RPC acknowledgement while preventing original-prompt replay.
//!
//! Once the initial acknowledgement arrives, accepted active input keeps the
//! existing `steer` command for sandbox-first and pending-tool continuation. A
//! settled transfer has no active model turn, so its newly owned continuation
//! uses `prompt` with `streamingBehavior: "steer"`. Prompt acknowledgements are
//! preflight acceptance, not turn completion: the SDK starts an idle turn or
//! steers an already running one for each subsequent input. In both cases the
//! command ID is the delivery UUID, and the matching successful response is
//! required before `mark_backend_accepted_without_replay` records ownership.
//! A failed or interrupted command marks the delivery failed and enters the
//! abort/error path.
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
//! `PiRpcProjection::project` receives only official records admitted after the
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
//! itself close the public run. `stopReason` values `error` and `aborted` set
//! the cached failure flag. The result text uses `errorMessage` when present,
//! otherwise the joined non-empty assistant text. An `errorMessage` is
//! upstream-controlled, so it passes through
//! [`crate::upstream_error_text::project_model_error_text`]: a markup document
//! becomes a bounded content-free description and any other message keeps its
//! exact text under a size bound. Assistant text is the run's own answer and is
//! never bounded here. If both are empty, it falls back to
//! `Pi model turn <stopReason>` when a stop reason exists.
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

use std::sync::Arc;
use std::time::Instant;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

use super::pi_memory_citation::{CitationProjection, project_segments};
use crate::active_input::{ActiveInputFrame, ActiveInputWriter};
use crate::error::AgentError;
use crate::upstream_error_text::project_model_error_text;

const PI_RPC_ABORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const PI_RPC_RESPONSE_QUEUE_CAPACITY: usize = 2;
const PI_RPC_RESPONSE_MAX_RETAINED_BYTES: usize =
    guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
const PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE: &str = "vm0_pi_api_first_turn_boundary";
const MAX_EVENT_SEQUENCE_NUMBER: u32 = i32::MAX as u32;

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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum PiRpcOwnershipTransferMode {
    SandboxFirst,
    PendingToolContinuation,
    SettledSessionContinuation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiApiFirstTurnBoundaryControlV2 {
    #[serde(rename = "type")]
    record_type: String,
    schema_version: u32,
    sandbox_event_sequence_start: u64,
    ownership_transfer_mode: PiRpcOwnershipTransferMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PiRpcStartup {
    pub(super) sandbox_event_sequence_start: u32,
    pub(super) ownership_transfer_mode: PiRpcOwnershipTransferMode,
}

pub(super) enum PiRpcRecordAdmission {
    InstallBoundary(PiRpcStartup),
    Project,
    Discard,
}

#[derive(Default)]
pub(super) struct PiRpcStartupBoundary {
    installed: Option<PiRpcStartup>,
    official_record_seen: bool,
    terminal_error: bool,
}

impl PiRpcStartupBoundary {
    pub(super) fn admit(&mut self, record: &Value) -> Result<PiRpcRecordAdmission, AgentError> {
        if self.terminal_error {
            return Ok(PiRpcRecordAdmission::Discard);
        }
        let is_control = record.get("type").and_then(Value::as_str)
            == Some(PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE);
        if !is_control {
            if self.installed.is_none() {
                return self.reject(Self::missing_error());
            }
            self.official_record_seen = true;
            return Ok(PiRpcRecordAdmission::Project);
        }

        let candidate = match parse_boundary_control(record) {
            Ok(candidate) => candidate,
            Err(error) => return self.reject(error),
        };
        let Some(installed) = self.installed else {
            self.installed = Some(candidate);
            return Ok(PiRpcRecordAdmission::InstallBoundary(candidate));
        };
        if candidate != installed {
            return self.reject(boundary_error(
                "PI_HANDOFF_BOUNDARY_CONFLICT",
                "Pi API first-turn handoff boundary conflicts with the installed boundary",
            ));
        }
        if self.official_record_seen {
            return self.reject(boundary_error(
                "PI_HANDOFF_BOUNDARY_LATE",
                "Pi API first-turn handoff boundary arrived after RPC startup",
            ));
        }
        self.reject(boundary_error(
            "PI_HANDOFF_BOUNDARY_INVALID",
            "Pi API first-turn handoff boundary was duplicated",
        ))
    }

    pub(super) fn requires_boundary(&self) -> bool {
        self.installed.is_none() && !self.terminal_error
    }

    pub(super) fn missing_error() -> AgentError {
        boundary_error(
            "PI_HANDOFF_BOUNDARY_MISSING",
            "Pi API first-turn handoff boundary is required before RPC startup",
        )
    }

    pub(super) fn malformed_record_error() -> AgentError {
        boundary_error(
            "PI_HANDOFF_BOUNDARY_INVALID",
            "Pi API first-turn handoff boundary is malformed",
        )
    }

    pub(super) fn looks_like_control(raw: &str) -> bool {
        raw.contains(PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE)
    }

    pub(super) fn discard_remaining(&mut self) {
        self.terminal_error = true;
    }

    fn reject(&mut self, error: AgentError) -> Result<PiRpcRecordAdmission, AgentError> {
        self.terminal_error = true;
        Err(error)
    }
}

fn validated_boundary_sequence(sequence: u64) -> Result<u32, AgentError> {
    let sequence =
        u32::try_from(sequence).map_err(|_| PiRpcStartupBoundary::malformed_record_error())?;
    if sequence == 0 || sequence > MAX_EVENT_SEQUENCE_NUMBER {
        return Err(PiRpcStartupBoundary::malformed_record_error());
    }
    Ok(sequence)
}

fn parse_boundary_control(record: &Value) -> Result<PiRpcStartup, AgentError> {
    match record.get("schemaVersion").and_then(Value::as_u64) {
        Some(2) => {
            let control: PiApiFirstTurnBoundaryControlV2 =
                serde_json::from_value(record.clone())
                    .map_err(|_| PiRpcStartupBoundary::malformed_record_error())?;
            if control.record_type != PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE
                || control.schema_version != 2
            {
                return Err(PiRpcStartupBoundary::malformed_record_error());
            }
            Ok(PiRpcStartup {
                sandbox_event_sequence_start: validated_boundary_sequence(
                    control.sandbox_event_sequence_start,
                )?,
                ownership_transfer_mode: control.ownership_transfer_mode,
            })
        }
        _ => Err(PiRpcStartupBoundary::malformed_record_error()),
    }
}

fn boundary_error(code: &str, message: &str) -> AgentError {
    AgentError::Execution(format!("[{code}] {message}"))
}

#[derive(Default)]
struct PiAssistantTerminal {
    failed: bool,
    result: String,
}

impl PiAssistantTerminal {
    fn from_message(message: &Value, preserve_empty_result: bool) -> Self {
        let stop_reason = message.get("stopReason").and_then(Value::as_str);
        let failed = matches!(stop_reason, Some("error" | "aborted"));
        // A model error is upstream-controlled text. Bounding it here keeps the
        // public result, the delivered event and the failure diagnostic on the
        // same actionable value; assistant text stays untouched because it is
        // the run's own answer.
        let result = message
            .get("errorMessage")
            .and_then(Value::as_str)
            .map_or_else(|| assistant_text(message), project_model_error_text);
        let result = if result.is_empty() && !preserve_empty_result {
            stop_reason.map_or_else(String::new, |reason| format!("Pi model turn {reason}"))
        } else {
            result
        };
        Self { failed, result }
    }
}

pub(super) struct PiRpcProjection {
    run_id: String,
    session_id: String,
    started_at: Instant,
    emitted_session_init: bool,
    assistant_terminal: Option<PiAssistantTerminal>,
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
            terminal_error: false,
        }
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
            Some("message_end") => self.project_message_end(record),
            Some("agent_settled") => Ok(Some(self.project_agent_settled())),
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

    fn project_message_end(&mut self, event: Value) -> Result<Option<Value>, AgentError> {
        let mut event = event;
        let Some(message) = event.get_mut("message").map(Value::take) else {
            return Err(AgentError::Execution(
                "Pi RPC message_end omitted its message".to_string(),
            ));
        };
        if message.get("role").and_then(Value::as_str) == Some("assistant") {
            return self.project_assistant_message(message);
        }
        if message.get("role").and_then(Value::as_str) == Some("toolResult") {
            return self.project_tool_result_message(message).map(Some);
        }
        Ok(None)
    }

    fn project_assistant_message(
        &mut self,
        mut message: Value,
    ) -> Result<Option<Value>, AgentError> {
        let citation_projection = normalize_assistant_citations(&mut message);
        self.assistant_terminal = Some(PiAssistantTerminal::from_message(
            &message,
            citation_projection.citation.is_some(),
        ));
        let content = assistant_content(&mut message)?;
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
        json!({
            "type": "result",
            "subtype": if assistant.failed { "error_during_execution" } else { "success" },
            "is_error": assistant.failed,
            "result": assistant.result,
            "session_id": self.session_id,
            "duration_ms": self.started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        })
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

fn assistant_content(message: &mut Value) -> Result<Vec<Value>, AgentError> {
    let blocks = match message.get_mut("content").map(Value::take) {
        Some(Value::Array(blocks)) => blocks,
        _ => return Ok(Vec::new()),
    };
    let mut content = Vec::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = block
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                content.push(json!({ "type": "text", "text": text }));
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
    streaming_behavior: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    let mut command = serde_json::Map::from_iter([
        ("id".to_owned(), json!(id)),
        ("type".to_owned(), json!("prompt")),
        ("message".to_owned(), json!(message)),
    ]);
    if let Some(streaming_behavior) = streaming_behavior {
        command.insert("streamingBehavior".to_owned(), json!(streaming_behavior));
    }
    write_command_with_cancellation(stdin, &Value::Object(command), cancellation).await?;
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
    ownership_transfer_mode: PiRpcOwnershipTransferMode,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    active_input.mark_writing(&frame.uuid);
    let request = match ownership_transfer_mode {
        PiRpcOwnershipTransferMode::SettledSessionContinuation => {
            request_prompt(
                stdin,
                responses,
                &frame.uuid,
                &frame.text,
                Some("steer"),
                cancellation,
            )
            .await
        }
        PiRpcOwnershipTransferMode::SandboxFirst
        | PiRpcOwnershipTransferMode::PendingToolContinuation => {
            request_steer(stdin, responses, &frame.uuid, &frame.text, cancellation).await
        }
    };
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
    ownership_transfer_mode: tokio::sync::oneshot::Receiver<PiRpcOwnershipTransferMode>,
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

    let ownership_transfer_mode = tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            abort(&mut stdin, &mut responses, run_id).await?;
            return Ok(());
        }
        mode = ownership_transfer_mode => mode.map_err(|_| AgentError::Execution(
            "Pi RPC startup boundary closed before ownership was installed".to_string(),
        ))?,
    };

    let prompt_id = format!("{run_id}:pi:initial-prompt");
    if !request_prompt(
        &mut stdin,
        &mut responses,
        &prompt_id,
        prompt,
        None,
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
                    ownership_transfer_mode,
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
    use std::time::Duration;

    use tokio::io::{AsyncBufReadExt, BufReader};

    use crate::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
    use crate::http::HttpClient;

    use super::*;

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
            // Guest sequencing belongs to the installed startup boundary and
            // ingestor. Projection does not invent the API's zero-based index.
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

    async fn next_command(reader: &mut BufReader<tokio::process::ChildStdout>) -> Value {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .expect("mock Pi stdout should be readable");
        serde_json::from_str(&line).expect("Pi command should be JSON")
    }

    #[test]
    fn boundary_v1_is_rejected() {
        let error = parse_boundary_control(&json!({
            "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
            "schemaVersion": 1,
            "sandboxEventSequenceStart": 4,
        }))
        .expect_err("legacy boundary should fail closed");

        assert!(error.to_string().contains("PI_HANDOFF_BOUNDARY_INVALID"));
    }

    #[test]
    fn boundary_v2_accepts_each_explicit_ownership_mode() {
        for (wire_mode, expected) in [
            ("sandbox-first", PiRpcOwnershipTransferMode::SandboxFirst),
            (
                "pending-tool-continuation",
                PiRpcOwnershipTransferMode::PendingToolContinuation,
            ),
            (
                "settled-session-continuation",
                PiRpcOwnershipTransferMode::SettledSessionContinuation,
            ),
        ] {
            let startup = parse_boundary_control(&json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 2,
                "sandboxEventSequenceStart": 7,
                "ownershipTransferMode": wire_mode,
            }))
            .expect("V2 boundary mode should be readable");

            assert_eq!(startup.sandbox_event_sequence_start, 7);
            assert_eq!(startup.ownership_transfer_mode, expected);
        }
    }

    #[test]
    fn boundary_modes_fail_closed_across_schema_versions() {
        for record in [
            json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 1,
                "sandboxEventSequenceStart": 4,
                "ownershipTransferMode": "sandbox-first",
            }),
            json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 2,
                "sandboxEventSequenceStart": 4,
            }),
            json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 2,
                "sandboxEventSequenceStart": 4,
                "ownershipTransferMode": "future-mode",
            }),
            json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 3,
                "sandboxEventSequenceStart": 4,
                "ownershipTransferMode": "pending-tool-continuation",
            }),
        ] {
            assert!(
                parse_boundary_control(&record)
                    .expect_err("unsupported boundary should fail closed")
                    .to_string()
                    .contains("PI_HANDOFF_BOUNDARY_INVALID")
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

    async fn exercise_steer_writer(ownership_transfer_mode: PiRpcOwnershipTransferMode) {
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
        let delivery_id = "11111111-1111-4111-8111-111111111111";
        let payload = json!({
            "type": "active-input",
            "deliveryId": delivery_id,
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
            .send(ownership_transfer_mode)
            .expect("startup mode should route");

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
        assert_eq!(steer["id"], delivery_id);
        assert_eq!(steer["type"], "steer");
        assert_eq!(steer["message"], "steer this turn");
        assert!(steer.get("streamingBehavior").is_none());
        response_tx
            .try_send(
                json!({
                    "id": delivery_id,
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
        assert_eq!(
            controller
                .finalize_receipts()
                .await
                .expect("receipts should finalize"),
            vec![delivery_id.to_string()]
        );
        child.wait().await.expect("cat should exit");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn sandbox_first_writer_uses_steer_ack_for_active_input_receipts() {
        exercise_steer_writer(PiRpcOwnershipTransferMode::SandboxFirst).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn pending_tool_writer_uses_steer_ack_for_active_input_receipts() {
        exercise_steer_writer(PiRpcOwnershipTransferMode::PendingToolContinuation).await;
    }

    #[derive(Clone, Copy)]
    enum SecondPromptOutcome {
        Accepted,
        Rejected,
        Cancelled,
    }

    async fn exercise_settled_writer(second_outcome: SecondPromptOutcome) {
        let directory = tempfile::tempdir().expect("receipt directory should exist");
        let journal_path = directory.path().join("active-input-receipts.json");
        let mut child = tokio::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("cat should spawn");
        let stdin = child.stdin.take().expect("cat stdin should exist");
        let stdout = child.stdout.take().expect("cat stdout should exist");
        let mut stdout = BufReader::new(stdout);
        let active_input = ActiveInputRuntime::new_with_receipts(
            "run",
            "original prompt",
            &journal_path,
            HttpClient::with_retry_delay(Duration::ZERO).expect("HTTP client should build"),
        )
        .expect("active-input runtime should start");
        let controller = active_input.controller();
        let first_id = "22222222-2222-4222-8222-222222222222";
        let second_id = "33333333-3333-4333-8333-333333333333";
        let idle_id = "44444444-4444-4444-8444-444444444444";
        let enqueue = |delivery_id: &str, text: &str| {
            let payload = guest_contracts::active_input::encode_active_input(delivery_id, text)
                .expect("active input should encode");
            assert_eq!(
                controller.handle_control_payload(&payload),
                ActiveInputControlOutcome::Accepted
            );
        };
        let receipts = || {
            guest_contracts::active_input_receipts::read_active_input_receipt_journal(
                &journal_path,
                "run",
            )
            .expect("receipt journal should be readable")
        };
        enqueue(first_id, "newly owned continuation");
        let (response_tx, response_rx) = response_channel();
        let (startup_tx, startup_rx) = tokio::sync::oneshot::channel();
        let cancellation = CancellationToken::new();
        let writer = write_commands(
            stdin,
            "run",
            "original prompt",
            active_input.into_writer(),
            response_rx,
            startup_rx,
            cancellation.clone(),
        );
        let respond = |command: &Value, success: bool, error: &str| {
            response_tx
                .try_send(
                    json!({
                        "id": command["id"],
                        "type": "response",
                        "command": command["type"],
                        "success": success,
                        "error": error,
                    }),
                    1,
                )
                .expect("RPC response should route");
        };
        let peer = async {
            let state = next_command(&mut stdout).await;
            assert_eq!(state["type"], "get_state");
            respond(&state, true, "");
            startup_tx
                .send(PiRpcOwnershipTransferMode::SettledSessionContinuation)
                .expect("startup mode should route");

            // The settled host acknowledges startup without replaying the original prompt.
            let initial = next_command(&mut stdout).await;
            assert_eq!(initial["id"], "run:pi:initial-prompt");
            assert_eq!(initial["type"], "prompt");
            assert_eq!(initial["message"], "original prompt");
            assert!(initial.get("streamingBehavior").is_none());
            respond(&initial, true, "");

            // An idle SDK starts a turn on prompt; a steer command alone would not start it.
            let first = next_command(&mut stdout).await;
            assert_eq!(first["id"], first_id);
            assert_eq!(first["type"], "prompt");
            assert_eq!(first["message"], "newly owned continuation");
            assert!(receipts().is_empty());
            respond(&first, true, "");
            controller
                .wait_for_sink_idle()
                .await
                .expect("first input should settle");
            assert_eq!(receipts(), vec![first_id]);

            // Admit B only after A's durable acceptance, keeping A's model turn open.
            enqueue(second_id, "steer the running continuation");
            let second = next_command(&mut stdout).await;
            assert_eq!(second["id"], second_id);
            assert_eq!(second["type"], "prompt");
            assert_eq!(second["message"], "steer the running continuation");
            assert_eq!(receipts(), vec![first_id]);
            match second_outcome {
                SecondPromptOutcome::Accepted => {
                    // Mirror SDK 0.85.1's preflight rejection of a bare streaming prompt.
                    let accepted = second["streamingBehavior"] == "steer";
                    respond(
                        &second,
                        accepted,
                        "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
                    );
                    controller
                        .wait_for_sink_idle()
                        .await
                        .expect("second input should settle");
                    if accepted {
                        assert_eq!(receipts(), vec![first_id, second_id]);
                        // A later idle turn must still start, rather than only queue a steer.
                        enqueue(idle_id, "start another idle continuation");
                        let idle = next_command(&mut stdout).await;
                        assert_eq!(idle["id"], idle_id);
                        assert_eq!(idle["type"], "prompt");
                        assert_eq!(idle["message"], "start another idle continuation");
                        respond(&idle, true, "");
                    }
                }
                SecondPromptOutcome::Rejected => {
                    respond(&second, false, "forced preflight rejection");
                }
                SecondPromptOutcome::Cancelled => {
                    cancellation.cancel();
                    let abort = next_command(&mut stdout).await;
                    assert_eq!(abort["id"], "run:pi:abort");
                    assert_eq!(abort["type"], "abort");
                    respond(&abort, true, "");
                }
            }
            controller.close_terminal();
        };
        let (result, ()) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(writer, peer) })
                .await
                .expect("settled writer exchange should finish");
        let expected_receipts = match second_outcome {
            SecondPromptOutcome::Accepted => {
                result.expect("streaming and idle inputs should both succeed");
                vec![
                    first_id.to_string(),
                    second_id.to_string(),
                    idle_id.to_string(),
                ]
            }
            SecondPromptOutcome::Rejected => {
                assert!(
                    result
                        .expect_err("failed prompt must fail closed")
                        .to_string()
                        .contains("Pi RPC prompt failed: forced preflight rejection")
                );
                vec![first_id.to_string()]
            }
            SecondPromptOutcome::Cancelled => {
                result.expect("cancellation should finish after abort acknowledgement");
                vec![first_id.to_string()]
            }
        };
        assert_eq!(
            controller
                .finalize_receipts()
                .await
                .expect("receipts should finalize"),
            expected_receipts
        );
        assert_eq!(receipts(), expected_receipts);
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("cat should exit promptly")
            .expect("cat should exit");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn settled_writer_accepts_sequential_streaming_and_idle_inputs() {
        exercise_settled_writer(SecondPromptOutcome::Accepted).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn settled_writer_does_not_receipt_a_rejected_second_input() {
        exercise_settled_writer(SecondPromptOutcome::Rejected).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn settled_writer_aborts_without_receipting_a_cancelled_second_input() {
        exercise_settled_writer(SecondPromptOutcome::Cancelled).await;
    }
}
