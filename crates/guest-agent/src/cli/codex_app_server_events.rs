//! Compatibility policy for adapting Codex app-server notifications to Codex JSONL events.
//!
//! This module is the normalization boundary between the evolving app-server
//! notification surface and the established JSONL shape consumed by guest-agent
//! event ingestion. Notifications are not forwarded verbatim: supported
//! lifecycle, plan, item, warning, and error notifications are validated and
//! translated into the existing event and diagnostic conventions. Malformed
//! required data on a supported notification returns an error so the backend
//! fails the execution instead of emitting a partial event.
//!
//! Item and command delta/progress notifications do not emit events because
//! completed-item snapshots provide the canonical output and emitting both would
//! duplicate partial content. Other configured opt-out methods likewise do not
//! emit, and unknown methods are ignored for forward compatibility.
//!
//! Item starts are deliberately asymmetric. Command execution, collaboration,
//! and context-compaction starts become JSONL `item.started` events, while
//! reasoning and agent-message starts are captured separately as first-output
//! timing metadata. Other item starts are ignored. Completed items with known
//! types receive strict, type-specific normalization. Unknown completed types
//! use a bounded, shallow, and lossy projection: names become snake case,
//! scalar values and scalar members of shallow collections are retained, deeper
//! collections are dropped, and top-level fields and collections beyond fixed
//! limits are omitted.
//!
//! Statuses, file-change patch kinds, and error fields are normalized into the
//! legacy JSONL and failure-diagnostic shapes rather than preserving their raw
//! app-server representation.

use guest_contracts::epoch_milliseconds::is_plausible_epoch_milliseconds;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::codex_app_server::ServerNotification;

/// Notification methods that emit no JSONL event and are requested as app-server opt-outs.
///
/// The backend advertises this set during initialization. If app-server still
/// sends one of these notifications, the mapper ignores it.
pub(super) const IGNORED_NOTIFICATION_METHODS: &[&str] = &[
    "command/exec/outputDelta",
    "process/outputDelta",
    "process/exited",
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/commandExecution/outputDelta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/mcpToolCall/progress",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
    "thread/realtime/transcript/delta",
    "thread/realtime/outputAudio/delta",
];

const MAX_GENERIC_COLLECTION_ITEMS: usize = 16;
const MAX_GENERIC_OBJECT_FIELDS: usize = 24;
const MAX_GENERIC_OPTIONAL_FIELDS: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CodexOutputItemKind {
    Reasoning,
    AgentMessage,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct CodexOutputItemStart {
    pub(super) thread_id: String,
    pub(super) turn_id: String,
    pub(super) started_at_ms: u64,
    pub(super) kind: CodexOutputItemKind,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CodexTokenUsage {
    input_tokens: i64,
    cached_input_tokens: i64,
    cache_write_input_tokens: i64,
    output_tokens: i64,
    reasoning_output_tokens: i64,
    total_tokens: i64,
}

impl CodexTokenUsage {
    fn is_non_negative(self) -> bool {
        self.input_tokens >= 0
            && self.cached_input_tokens >= 0
            && self.cache_write_input_tokens >= 0
            && self.output_tokens >= 0
            && self.reasoning_output_tokens >= 0
            && self.total_tokens >= 0
    }

    fn checked_sub(self, baseline: Self, method: &str) -> Result<Self, CodexAppServerEventError> {
        let difference = |latest: i64, prior: i64| {
            latest
                .checked_sub(prior)
                .filter(|value| *value >= 0)
                .ok_or_else(|| invalid_field_for_method(method, "tokenUsage.total"))
        };
        Ok(Self {
            input_tokens: difference(self.input_tokens, baseline.input_tokens)?,
            cached_input_tokens: difference(
                self.cached_input_tokens,
                baseline.cached_input_tokens,
            )?,
            cache_write_input_tokens: difference(
                self.cache_write_input_tokens,
                baseline.cache_write_input_tokens,
            )?,
            output_tokens: difference(self.output_tokens, baseline.output_tokens)?,
            reasoning_output_tokens: difference(
                self.reasoning_output_tokens,
                baseline.reasoning_output_tokens,
            )?,
            total_tokens: difference(self.total_tokens, baseline.total_tokens)?,
        })
    }

    fn into_value(self) -> Value {
        json!({
            "input_tokens": self.input_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "cache_write_input_tokens": self.cache_write_input_tokens,
            "output_tokens": self.output_tokens,
            "reasoning_output_tokens": self.reasoning_output_tokens,
            "total_tokens": self.total_tokens,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct CodexTokenUsageUpdate {
    pub(super) thread_id: String,
    pub(super) turn_id: String,
    total: CodexTokenUsage,
    last: CodexTokenUsage,
}

#[derive(Debug, Default)]
pub(super) struct CodexTurnUsageTracker {
    baseline: Option<CodexTokenUsage>,
    latest: Option<CodexTokenUsage>,
}

impl CodexTurnUsageTracker {
    pub(super) fn observe_replay(&mut self, update: CodexTokenUsageUpdate) {
        self.baseline = Some(update.total);
    }

    pub(super) fn observe_current(
        &mut self,
        update: CodexTokenUsageUpdate,
    ) -> Result<(), CodexAppServerEventError> {
        let baseline = match self.baseline {
            Some(baseline) => baseline,
            None => {
                let baseline = update
                    .total
                    .checked_sub(update.last, "thread/tokenUsage/updated")?;
                self.baseline = Some(baseline);
                baseline
            }
        };
        update
            .total
            .checked_sub(baseline, "thread/tokenUsage/updated")?;
        self.latest = Some(update.total);
        Ok(())
    }

    pub(super) fn usage(&self) -> Result<Option<Value>, CodexAppServerEventError> {
        let (Some(baseline), Some(latest)) = (self.baseline, self.latest) else {
            return Ok(None);
        };
        latest
            .checked_sub(baseline, "thread/tokenUsage/updated")
            .map(CodexTokenUsage::into_value)
            .map(Some)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TurnStatus {
    Completed,
    Interrupted,
    Failed,
    InProgress,
}

impl TurnStatus {
    fn normalized(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
            Self::InProgress => "in_progress",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ItemStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CollabAgentTool {
    SpawnAgent,
    SendInput,
    ResumeAgent,
    Wait,
    CloseAgent,
    SendMessage,
    FollowupTask,
    InterruptAgent,
    ListAgents,
}

impl CollabAgentTool {
    fn normalized(self) -> &'static str {
        match self {
            Self::SpawnAgent => "spawn_agent",
            Self::SendInput => "send_input",
            Self::ResumeAgent => "resume_agent",
            Self::Wait => "wait",
            Self::CloseAgent => "close_agent",
            Self::SendMessage => "send_message",
            Self::FollowupTask => "followup_task",
            Self::InterruptAgent => "interrupt_agent",
            Self::ListAgents => "list_agents",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CollabAgentToolCallStatus {
    InProgress,
    Completed,
    Failed,
    Interrupted,
}

impl CollabAgentToolCallStatus {
    fn normalized(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubAgentActivityKind {
    Started,
    Interacted,
    Interrupted,
    Completed,
}

impl SubAgentActivityKind {
    fn normalized(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Interacted => "interacted",
            Self::Interrupted => "interrupted",
            Self::Completed => "completed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CollabAgentStatus {
    PendingInit,
    Running,
    Interrupted,
    Completed,
    Errored,
    Shutdown,
    NotFound,
}

impl CollabAgentStatus {
    fn normalized(self) -> &'static str {
        match self {
            Self::PendingInit => "pending_init",
            Self::Running => "running",
            Self::Interrupted => "interrupted",
            Self::Completed => "completed",
            Self::Errored => "errored",
            Self::Shutdown => "shutdown",
            Self::NotFound => "not_found",
        }
    }
}

impl ItemStatus {
    fn normalized(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Declined => "declined",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

impl PlanStepStatus {
    fn normalized(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
        }
    }
}

/// Error returned when a supported Codex app-server notification is malformed.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(super) enum CodexAppServerEventError {
    #[error("codex app-server notification {method} missing params")]
    MissingParams { method: String },
    #[error("codex app-server notification {method} missing field {field}")]
    MissingField { method: String, field: &'static str },
    #[error("codex app-server notification {method} has invalid field {field}")]
    InvalidField { method: String, field: &'static str },
}

/// Extract a notification's thread id for early secondary-thread filtering.
///
/// This is a best-effort lookup performed before strict event mapping. Missing,
/// empty, malformed, or unsupported thread-id locations return `None`; a later
/// supported mapper can still reject the notification as malformed.
pub(super) fn notification_thread_id(notification: &ServerNotification) -> Option<&str> {
    let params = notification.params.as_ref()?;
    let thread_id = match notification.method.as_str() {
        "thread/started" => params.pointer("/thread/id"),
        "turn/started"
        | "turn/completed"
        | "turn/plan/updated"
        | "item/started"
        | "item/completed"
        | "thread/tokenUsage/updated"
        | "error"
        | "warning" => params.get("threadId"),
        _ => None,
    }?;
    thread_id.as_str().filter(|thread_id| !thread_id.is_empty())
}

/// Extract first-output timing metadata from a reasoning or agent-message start.
///
/// Non-`item/started` notifications and other valid started item kinds return
/// `Ok(None)`. Selected starts require valid thread, turn, and epoch timestamp
/// fields. The backend records this metadata separately because these starts do
/// not become JSONL item events.
pub(super) fn codex_output_item_start(
    notification: &ServerNotification,
) -> Result<Option<CodexOutputItemStart>, CodexAppServerEventError> {
    if notification.method != "item/started" {
        return Ok(None);
    }

    let params = required_params_object(notification)?;
    let item = required_object_key(params, &notification.method, "item", "item")?;
    let item_type = required_non_empty_string_key(item, &notification.method, "type", "item.type")?;
    let kind = match item_type {
        "reasoning" => CodexOutputItemKind::Reasoning,
        "agentMessage" => CodexOutputItemKind::AgentMessage,
        _ => return Ok(None),
    };
    let thread_id =
        required_non_empty_string_key(params, &notification.method, "threadId", "threadId")?;
    let turn_id = required_non_empty_string_key(params, &notification.method, "turnId", "turnId")?;
    let started_at_ms = params
        .get("startedAtMs")
        .ok_or_else(|| missing_field(&notification.method, "startedAtMs"))?
        .as_u64()
        .filter(|value| is_plausible_epoch_milliseconds(*value))
        .ok_or_else(|| invalid_field_for_method(&notification.method, "startedAtMs"))?;

    Ok(Some(CodexOutputItemStart {
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        started_at_ms,
        kind,
    }))
}

/// Convert a Codex app-server notification into the existing Codex JSONL event shape.
///
/// `Ok(Some(_))` contains a normalized event. Deliberately non-emitting
/// notifications, unknown methods, and started item kinds without a JSONL event
/// return `Ok(None)`. Supported notifications with malformed required fields
/// return an error.
pub(super) fn notification_to_codex_event(
    notification: &ServerNotification,
) -> Result<Option<Value>, CodexAppServerEventError> {
    match notification.method.as_str() {
        "thread/started" => map_thread_started(notification).map(Some),
        "turn/started" => map_turn_started(notification).map(Some),
        "turn/completed" => map_turn_completed(notification).map(Some),
        "turn/plan/updated" => map_turn_plan_updated(notification).map(Some),
        "item/started" => map_item(notification, "item.started", "started_at_ms", "startedAtMs"),
        "item/completed" => map_item(
            notification,
            "item.completed",
            "completed_at_ms",
            "completedAtMs",
        ),
        "error" => map_error(notification).map(Some),
        "warning" => map_warning(notification).map(Some),
        method if IGNORED_NOTIFICATION_METHODS.contains(&method) => Ok(None),
        _ => Ok(None),
    }
}

pub(super) fn codex_token_usage_update(
    notification: &ServerNotification,
) -> Result<Option<CodexTokenUsageUpdate>, CodexAppServerEventError> {
    if notification.method != "thread/tokenUsage/updated" {
        return Ok(None);
    }

    let params = required_params_object(notification)?;
    let thread_id =
        required_non_empty_string_key(params, &notification.method, "threadId", "threadId")?;
    let turn_id = required_non_empty_string_key(params, &notification.method, "turnId", "turnId")?;
    let token_usage =
        required_object_key(params, &notification.method, "tokenUsage", "tokenUsage")?;
    let total = required_token_usage(
        required_object_key(
            token_usage,
            &notification.method,
            "total",
            "tokenUsage.total",
        )?,
        &notification.method,
        "tokenUsage.total",
    )?;
    let last = required_token_usage(
        required_object_key(token_usage, &notification.method, "last", "tokenUsage.last")?,
        &notification.method,
        "tokenUsage.last",
    )?;

    Ok(Some(CodexTokenUsageUpdate {
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        total,
        last,
    }))
}

fn map_thread_started(
    notification: &ServerNotification,
) -> Result<Value, CodexAppServerEventError> {
    let params = required_params_object(notification)?;
    let thread = required_object_key(params, &notification.method, "thread", "thread")?;
    let thread_id = required_non_empty_string_key(thread, &notification.method, "id", "thread.id")?;

    Ok(json!({
        "type": "thread.started",
        "thread_id": thread_id,
    }))
}

fn map_turn_started(notification: &ServerNotification) -> Result<Value, CodexAppServerEventError> {
    let params = required_params_object(notification)?;
    let thread_id =
        required_non_empty_string_key(params, &notification.method, "threadId", "threadId")?;
    let turn = required_object_key(params, &notification.method, "turn", "turn")?;
    let status = required_turn_status_key(turn, &notification.method, "status", "turn.status")?;
    if status != TurnStatus::InProgress {
        return Err(invalid_field_for_method(
            &notification.method,
            "turn.status",
        ));
    }
    if non_null_field(turn, "error") {
        return Err(invalid_field_for_method(&notification.method, "turn.error"));
    }

    Ok(json!({
        "type": "turn.started",
        "thread_id": thread_id,
        "turn": normalize_turn(turn, &notification.method, status)?,
    }))
}

fn map_turn_completed(
    notification: &ServerNotification,
) -> Result<Value, CodexAppServerEventError> {
    let params = required_params_object(notification)?;
    let thread_id =
        required_non_empty_string_key(params, &notification.method, "threadId", "threadId")?;
    let turn = required_object_key(params, &notification.method, "turn", "turn")?;
    let status = required_turn_status_key(turn, &notification.method, "status", "turn.status")?;
    if status == TurnStatus::InProgress {
        return Err(invalid_field_for_method(
            &notification.method,
            "turn.status",
        ));
    }
    if status == TurnStatus::Completed && non_null_field(turn, "error") {
        return Err(invalid_field_for_method(&notification.method, "turn.error"));
    }

    let mut event = Map::new();
    event.insert(
        "type".to_string(),
        Value::String("turn.completed".to_string()),
    );
    event.insert(
        "thread_id".to_string(),
        Value::String(thread_id.to_string()),
    );
    event.insert(
        "turn".to_string(),
        normalize_turn(turn, &notification.method, status)?,
    );
    Ok(Value::Object(event))
}

fn required_token_usage(
    usage: &Map<String, Value>,
    method: &str,
    field: &'static str,
) -> Result<CodexTokenUsage, CodexAppServerEventError> {
    let usage = serde_json::from_value::<CodexTokenUsage>(Value::Object(usage.clone()))
        .map_err(|_error| invalid_field_for_method(method, field))?;
    usage
        .is_non_negative()
        .then_some(usage)
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn map_turn_plan_updated(
    notification: &ServerNotification,
) -> Result<Value, CodexAppServerEventError> {
    let params = required_params_object(notification)?;
    let thread_id =
        required_non_empty_string_key(params, &notification.method, "threadId", "threadId")?;
    let turn_id = required_non_empty_string_key(params, &notification.method, "turnId", "turnId")?;
    let explanation =
        optional_nullable_string_key(params, &notification.method, "explanation", "explanation")?;
    let plan = required_array_key(params, &notification.method, "plan", "plan")?;
    let plan = plan
        .iter()
        .map(|step| normalize_turn_plan_step(step, &notification.method))
        .collect::<Result<Vec<_>, _>>()?;

    let mut event = Map::new();
    event.insert(
        "type".to_string(),
        Value::String("turn.plan.updated".to_string()),
    );
    event.insert(
        "thread_id".to_string(),
        Value::String(thread_id.to_string()),
    );
    event.insert("turn_id".to_string(), Value::String(turn_id.to_string()));
    event.insert("plan".to_string(), Value::Array(plan));
    if let Some(explanation) = explanation {
        event.insert(
            "explanation".to_string(),
            Value::String(explanation.to_string()),
        );
    }

    Ok(Value::Object(event))
}

fn map_item(
    notification: &ServerNotification,
    event_type: &'static str,
    output_timestamp_field: &'static str,
    input_timestamp_field: &'static str,
) -> Result<Option<Value>, CodexAppServerEventError> {
    let params = required_params_object(notification)?;
    let thread_id =
        required_non_empty_string_key(params, &notification.method, "threadId", "threadId")?;
    let turn_id = required_non_empty_string_key(params, &notification.method, "turnId", "turnId")?;
    let timestamp = required_number_key(
        params,
        &notification.method,
        input_timestamp_field,
        input_timestamp_field,
    )?;
    let item = required_object_key(params, &notification.method, "item", "item")?;
    let Some(normalized_item) = normalize_item(item, &notification.method)? else {
        return Ok(None);
    };

    let mut event = Map::new();
    event.insert("type".to_string(), Value::String(event_type.to_string()));
    event.insert(
        "thread_id".to_string(),
        Value::String(thread_id.to_string()),
    );
    event.insert("turn_id".to_string(), Value::String(turn_id.to_string()));
    event.insert("item".to_string(), normalized_item);
    event.insert(output_timestamp_field.to_string(), timestamp);

    Ok(Some(Value::Object(event)))
}

fn map_error(notification: &ServerNotification) -> Result<Value, CodexAppServerEventError> {
    let params = required_params_object(notification)?;
    let thread_id =
        required_non_empty_string_key(params, &notification.method, "threadId", "threadId")?;
    let turn_id = required_non_empty_string_key(params, &notification.method, "turnId", "turnId")?;
    let will_retry = required_bool_key(params, &notification.method, "willRetry", "willRetry")?;
    let error = required_object_key(params, &notification.method, "error", "error")?;
    let message =
        required_non_empty_string_key(error, &notification.method, "message", "error.message")?;
    let message = error_message_with_details(error, message);
    let event_type = if will_retry { "warning" } else { "error" };

    Ok(json!({
        "type": event_type,
        "thread_id": thread_id,
        "turn_id": turn_id,
        "will_retry": will_retry,
        "message": message,
        "error": normalize_error_object(error),
    }))
}

fn map_warning(notification: &ServerNotification) -> Result<Value, CodexAppServerEventError> {
    let params = required_params_object(notification)?;
    let message =
        required_non_empty_string_key(params, &notification.method, "message", "message")?;
    let thread_id = optional_nullable_non_empty_string_key(
        params,
        &notification.method,
        "threadId",
        "threadId",
    )?;

    let mut event = Map::new();
    event.insert("type".to_string(), Value::String("warning".to_string()));
    event.insert("message".to_string(), Value::String(message.to_string()));
    if let Some(thread_id) = thread_id {
        event.insert(
            "thread_id".to_string(),
            Value::String(thread_id.to_string()),
        );
    }

    Ok(Value::Object(event))
}

fn normalize_turn(
    turn: &Map<String, Value>,
    method: &str,
    status: TurnStatus,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = Map::new();
    let id = required_non_empty_string_key(turn, method, "id", "turn.id")?;
    normalized.insert("id".to_string(), Value::String(id.to_string()));
    normalized.insert(
        "status".to_string(),
        Value::String(status.normalized().to_string()),
    );
    if let Some(error) = turn.get("error") {
        normalized.insert("error".to_string(), normalize_optional_error(error));
    }
    copy_optional_field(&mut normalized, "started_at", turn, "startedAt");
    copy_optional_field(&mut normalized, "completed_at", turn, "completedAt");
    copy_optional_field(&mut normalized, "duration_ms", turn, "durationMs");

    Ok(Value::Object(normalized))
}

fn normalize_turn_plan_step(step: &Value, method: &str) -> Result<Value, CodexAppServerEventError> {
    let step = step
        .as_object()
        .ok_or_else(|| invalid_field_for_method(method, "plan[]"))?;
    let text = required_string_key(step, method, "step", "plan[].step")?;
    let status = required_plan_step_status_key(step, method, "status", "plan[].status")?;

    Ok(json!({
        "step": text,
        "status": status.normalized(),
    }))
}

fn normalize_item(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Option<Value>, CodexAppServerEventError> {
    let item_type = required_non_empty_string_key(item, method, "type", "item.type")?;
    match (method, item_type) {
        ("item/started", "commandExecution") => normalize_command_execution(item, method).map(Some),
        ("item/started", "collabAgentToolCall") => {
            normalize_collab_agent_tool_call(item, method).map(Some)
        }
        ("item/started", "contextCompaction") => {
            normalize_context_compaction(item, method).map(Some)
        }
        ("item/started", _) => Ok(None),
        ("item/completed", "agentMessage") => normalize_agent_message(item, method).map(Some),
        ("item/completed", "plan") => normalize_plan(item, method).map(Some),
        ("item/completed", "reasoning") => normalize_reasoning(item, method).map(Some),
        ("item/completed", "functionCallOutput") => {
            normalize_function_call_output(item, method).map(Some)
        }
        ("item/completed", "commandExecution") => {
            normalize_command_execution(item, method).map(Some)
        }
        ("item/completed", "fileChange") => normalize_file_change(item, method).map(Some),
        ("item/completed", "collabAgentToolCall") => {
            normalize_collab_agent_tool_call(item, method).map(Some)
        }
        ("item/completed", "subAgentActivity") => {
            normalize_sub_agent_activity(item, method).map(Some)
        }
        ("item/completed", "contextCompaction") => {
            normalize_context_compaction(item, method).map(Some)
        }
        ("item/completed", _) => normalize_generic_completed_item(item, method).map(Some),
        _ => Ok(None),
    }
}

fn normalize_agent_message(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "agent_message")?;
    let text = required_string_key(item, method, "text", "item.text")?;
    normalized.insert("text".to_string(), Value::String(text.to_string()));
    Ok(Value::Object(normalized))
}

fn normalize_plan(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "plan")?;
    let text = required_string_key(item, method, "text", "item.text")?;
    normalized.insert("text".to_string(), Value::String(text.to_string()));
    Ok(Value::Object(normalized))
}

fn normalize_reasoning(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "reasoning")?;
    let text_metrics = reasoning_text_metrics(item, method)?;
    if text_metrics.part_count > 0 {
        let mut text = String::with_capacity(text_metrics.joined_byte_len());
        let mut has_part = false;
        append_reasoning_text_parts(
            &mut text,
            &mut has_part,
            item,
            method,
            "summary",
            "item.summary",
        )?;
        append_reasoning_text_parts(
            &mut text,
            &mut has_part,
            item,
            method,
            "content",
            "item.content",
        )?;
        normalized.insert("text".to_string(), Value::String(text));
    }
    Ok(Value::Object(normalized))
}

fn normalize_command_execution(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "command_execution")?;
    let command = required_string_key(item, method, "command", "item.command")?;
    normalized.insert("command".to_string(), Value::String(command.to_string()));
    let status = required_item_status_key(item, method, "status", "item.status")?;
    validate_item_status_for_method(method, status)?;
    normalized.insert(
        "status".to_string(),
        Value::String(status.normalized().to_string()),
    );
    copy_optional_field(&mut normalized, "cwd", item, "cwd");
    copy_optional_field(
        &mut normalized,
        "aggregated_output",
        item,
        "aggregatedOutput",
    );
    copy_optional_field(&mut normalized, "exit_code", item, "exitCode");
    copy_optional_field(&mut normalized, "duration_ms", item, "durationMs");
    Ok(Value::Object(normalized))
}

fn normalize_function_call_output(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "function_call_output")?;
    let name = required_string_key(item, method, "name", "item.name")?;
    normalized.insert("name".to_string(), Value::String(name.to_string()));
    copy_optional_field(&mut normalized, "namespace", item, "namespace");
    let output = item
        .get("output")
        .filter(|output| matches!(output, Value::String(_) | Value::Array(_)))
        .ok_or_else(|| invalid_field_for_method(method, "item.output"))?;
    normalized.insert("output".to_string(), output.clone());
    Ok(Value::Object(normalized))
}

fn normalize_file_change(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "file_change")?;
    let status = required_item_status_key(item, method, "status", "item.status")?;
    validate_item_status_for_method(method, status)?;
    normalized.insert(
        "status".to_string(),
        Value::String(status.normalized().to_string()),
    );
    let changes = required_array_key(item, method, "changes", "item.changes")?;
    let changes = changes
        .iter()
        .map(|change| normalize_file_update_change(change, method))
        .collect::<Result<Vec<_>, _>>()?;
    normalized.insert("changes".to_string(), Value::Array(changes));
    Ok(Value::Object(normalized))
}

fn normalize_collab_agent_tool_call(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "collab_agent_tool_call")?;
    let tool = required_collab_agent_tool_key(item, method, "tool", "item.tool")?;
    let status = required_collab_agent_tool_call_status_key(item, method, "status", "item.status")?;
    validate_collab_agent_tool_call_status_for_method(method, status)?;
    let sender_thread_id =
        required_non_empty_string_key(item, method, "senderThreadId", "item.senderThreadId")?;
    let receiver_thread_ids = required_non_empty_string_array_key(
        item,
        method,
        "receiverThreadIds",
        "item.receiverThreadIds",
    )?;
    let prompt = required_nullable_string_key(item, method, "prompt", "item.prompt")?;
    let model = required_nullable_string_key(item, method, "model", "item.model")?;
    let reasoning_effort =
        required_nullable_string_key(item, method, "reasoningEffort", "item.reasoningEffort")?;
    if reasoning_effort.is_some_and(|value| value.is_empty()) {
        return Err(invalid_field_for_method(method, "item.reasoningEffort"));
    }
    let agents_states = required_object_key(item, method, "agentsStates", "item.agentsStates")?;

    normalized.insert(
        "tool".to_string(),
        Value::String(tool.normalized().to_string()),
    );
    normalized.insert(
        "status".to_string(),
        Value::String(status.normalized().to_string()),
    );
    normalized.insert(
        "sender_thread_id".to_string(),
        Value::String(sender_thread_id.to_string()),
    );
    normalized.insert(
        "receiver_thread_ids".to_string(),
        Value::Array(receiver_thread_ids),
    );
    normalized.insert(
        "prompt".to_string(),
        prompt.map_or(Value::Null, |value| Value::String(value.to_string())),
    );
    normalized.insert(
        "model".to_string(),
        model.map_or(Value::Null, |value| Value::String(value.to_string())),
    );
    normalized.insert(
        "reasoning_effort".to_string(),
        reasoning_effort.map_or(Value::Null, |value| Value::String(value.to_string())),
    );
    normalized.insert(
        "agents_states".to_string(),
        normalize_collab_agent_states(agents_states, method)?,
    );
    Ok(Value::Object(normalized))
}

fn normalize_sub_agent_activity(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "sub_agent_activity")?;
    let kind = required_sub_agent_activity_kind_key(item, method, "kind", "item.kind")?;
    let agent_thread_id =
        required_non_empty_string_key(item, method, "agentThreadId", "item.agentThreadId")?;
    let agent_path = required_non_empty_string_key(item, method, "agentPath", "item.agentPath")?;
    normalized.insert(
        "kind".to_string(),
        Value::String(kind.normalized().to_string()),
    );
    normalized.insert(
        "agent_thread_id".to_string(),
        Value::String(agent_thread_id.to_string()),
    );
    normalized.insert(
        "agent_path".to_string(),
        Value::String(agent_path.to_string()),
    );
    Ok(Value::Object(normalized))
}

fn normalize_context_compaction(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    base_item(item, method, "context_compaction").map(Value::Object)
}

fn normalize_collab_agent_states(
    states: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = Map::new();
    for (thread_id, state) in states {
        if thread_id.trim().is_empty() {
            return Err(invalid_field_for_method(method, "item.agentsStates"));
        }
        let state = state
            .as_object()
            .ok_or_else(|| invalid_field_for_method(method, "item.agentsStates[]"))?;
        let status = required_collab_agent_status_key(
            state,
            method,
            "status",
            "item.agentsStates[].status",
        )?;
        let message =
            required_nullable_string_key(state, method, "message", "item.agentsStates[].message")?;
        normalized.insert(
            thread_id.to_string(),
            json!({
                "status": status.normalized(),
                "message": message,
            }),
        );
    }
    Ok(Value::Object(normalized))
}

fn normalize_file_update_change(
    change: &Value,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let change = change
        .as_object()
        .ok_or_else(|| invalid_field_for_method(method, "item.changes[]"))?;
    let path = required_string_key(change, method, "path", "item.changes[].path")?;
    let kind = change
        .get("kind")
        .ok_or_else(|| missing_field(method, "item.changes[].kind"))?;
    let normalized_kind = normalize_patch_kind(kind, method)?;

    let mut normalized = Map::new();
    normalized.insert("path".to_string(), Value::String(path.to_string()));
    normalized.insert(
        "kind".to_string(),
        Value::String(normalized_kind.to_string()),
    );
    if let Some(diff) = change.get("diff").and_then(Value::as_str) {
        normalized.insert("diff".to_string(), Value::String(diff.to_string()));
    }

    Ok(Value::Object(normalized))
}

fn normalize_generic_completed_item(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let raw_type = required_non_empty_string_key(item, method, "type", "item.type")?;
    let mut normalized = base_item(item, method, &camel_to_snake(raw_type))?;
    if let Some(status) = optional_item_status_key(item, "status") {
        normalized.insert(
            "status".to_string(),
            Value::String(status.normalized().to_string()),
        );
    }

    let mut projected_fields = 0;
    for (key, value) in item {
        if projected_fields == MAX_GENERIC_OPTIONAL_FIELDS {
            break;
        }
        if key == "id" || key == "type" || key == "status" {
            continue;
        }
        let Some(value) = shallow_generic_value(value) else {
            continue;
        };
        let normalized_key = camel_to_snake(key);
        if normalized_key == "id" || normalized_key == "type" || normalized_key == "status" {
            continue;
        }
        normalized.insert(normalized_key, value);
        projected_fields += 1;
    }

    Ok(Value::Object(normalized))
}

fn base_item(
    item: &Map<String, Value>,
    method: &str,
    item_type: &str,
) -> Result<Map<String, Value>, CodexAppServerEventError> {
    let mut normalized = Map::new();
    let id = required_non_empty_string_key(item, method, "id", "item.id")?;
    normalized.insert("id".to_string(), Value::String(id.to_string()));
    normalized.insert("type".to_string(), Value::String(item_type.to_string()));
    Ok(normalized)
}

fn normalize_optional_error(error: &Value) -> Value {
    match error {
        Value::Object(error) => normalize_error_object(error),
        Value::Null => Value::Null,
        value => value.clone(),
    }
}

fn normalize_error_object(error: &Map<String, Value>) -> Value {
    let mut normalized = Map::new();
    copy_optional_field(&mut normalized, "code", error, "code");
    copy_optional_field(&mut normalized, "error", error, "error");
    copy_optional_field(&mut normalized, "message", error, "message");
    copy_first_optional_field(
        &mut normalized,
        "additional_details",
        error,
        &["additional_details", "additionalDetails"],
    );
    copy_first_optional_field(
        &mut normalized,
        "codex_error_info",
        error,
        &["codex_error_info", "codexErrorInfo"],
    );
    copy_optional_field(&mut normalized, "connectors", error, "connectors");
    copy_optional_field(&mut normalized, "failureReason", error, "failureReason");
    if let Some(misalignment) = error.get("misalignment") {
        normalized.insert(
            "misalignment".to_string(),
            normalize_optional_misalignment(misalignment),
        );
    }
    Value::Object(normalized)
}

fn normalize_optional_misalignment(misalignment: &Value) -> Value {
    let Value::Object(misalignment) = misalignment else {
        return misalignment.clone();
    };
    let mut normalized = Map::new();
    copy_first_optional_field(
        &mut normalized,
        "error_type",
        misalignment,
        &["error_type", "errorType"],
    );
    copy_first_optional_field(
        &mut normalized,
        "detailed_explanation",
        misalignment,
        &["detailed_explanation", "detailedExplanation"],
    );
    if let Some(steer) = misalignment.get("steer") {
        normalized.insert("steer".to_string(), steer.clone());
    }
    Value::Object(normalized)
}

fn error_message_with_details(error: &Map<String, Value>, message: &str) -> String {
    let Some(details) = error
        .get("additional_details")
        .or_else(|| error.get("additionalDetails"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|details| !details.is_empty())
    else {
        return message.to_string();
    };
    format!("{message} ({details})")
}

fn normalize_patch_kind(
    kind: &Value,
    method: &str,
) -> Result<&'static str, CodexAppServerEventError> {
    let (kind, field) = match kind {
        Value::String(kind) => (kind.as_str(), "item.changes[].kind"),
        Value::Object(kind) => (
            required_string_key(kind, method, "type", "item.changes[].kind.type")?,
            "item.changes[].kind.type",
        ),
        _ => return Err(invalid_field_for_method(method, "item.changes[].kind")),
    };
    match kind {
        "add" => Ok("add"),
        "delete" => Ok("delete"),
        "modify" | "update" => Ok("modify"),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn validate_item_status_for_method(
    method: &str,
    status: ItemStatus,
) -> Result<(), CodexAppServerEventError> {
    match (method, status) {
        ("item/started", ItemStatus::InProgress) => Ok(()),
        ("item/completed", ItemStatus::Completed | ItemStatus::Failed | ItemStatus::Declined) => {
            Ok(())
        }
        ("item/started" | "item/completed", _) => {
            Err(invalid_field_for_method(method, "item.status"))
        }
        _ => Ok(()),
    }
}

fn shallow_generic_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Some(value.clone()),
        Value::Array(values) => {
            if values.len() > MAX_GENERIC_COLLECTION_ITEMS {
                return None;
            }
            let values = values
                .iter()
                .filter(|value| is_scalar_json_value(value))
                .cloned()
                .collect();
            Some(Value::Array(values))
        }
        Value::Object(fields) => {
            if fields.len() > MAX_GENERIC_OBJECT_FIELDS {
                return None;
            }
            let mut output = Map::new();
            for (key, value) in fields {
                match value {
                    Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                        output.insert(camel_to_snake(key), value.clone());
                    }
                    _ => {}
                }
            }
            Some(Value::Object(output))
        }
    }
}

fn is_scalar_json_value(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

fn required_params_object(
    notification: &ServerNotification,
) -> Result<&Map<String, Value>, CodexAppServerEventError> {
    let params =
        notification
            .params
            .as_ref()
            .ok_or_else(|| CodexAppServerEventError::MissingParams {
                method: notification.method.clone(),
            })?;
    params
        .as_object()
        .ok_or_else(|| invalid_field(notification, "params"))
}

fn required_object_key<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<&'a Map<String, Value>, CodexAppServerEventError> {
    object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?
        .as_object()
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_array_key<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<&'a Vec<Value>, CodexAppServerEventError> {
    object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?
        .as_array()
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_string_key<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<&'a str, CodexAppServerEventError> {
    object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?
        .as_str()
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_non_empty_string_key<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<&'a str, CodexAppServerEventError> {
    let value = required_string_key(object, method, key, field)?.trim();
    if value.is_empty() {
        return Err(invalid_field_for_method(method, field));
    }
    Ok(value)
}

fn optional_nullable_string_key<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<Option<&'a str>, CodexAppServerEventError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(Some)
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_nullable_string_key<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<Option<&'a str>, CodexAppServerEventError> {
    let value = object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?;
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(Some)
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_non_empty_string_array_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<Vec<Value>, CodexAppServerEventError> {
    required_array_key(object, method, key, field)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| Value::String(value.to_string()))
                .ok_or_else(|| invalid_field_for_method(method, field))
        })
        .collect()
}

fn optional_nullable_non_empty_string_key<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<Option<&'a str>, CodexAppServerEventError> {
    let Some(value) = optional_nullable_string_key(object, method, key, field)? else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid_field_for_method(method, field));
    }
    Ok(Some(value))
}

fn required_bool_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<bool, CodexAppServerEventError> {
    object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?
        .as_bool()
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_number_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<Value, CodexAppServerEventError> {
    let value = object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?;
    if value.is_number() {
        return Ok(value.clone());
    }
    Err(invalid_field_for_method(method, field))
}

fn required_turn_status_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<TurnStatus, CodexAppServerEventError> {
    let status = required_string_key(object, method, key, field)?;
    match status {
        "completed" => Ok(TurnStatus::Completed),
        "interrupted" => Ok(TurnStatus::Interrupted),
        "failed" => Ok(TurnStatus::Failed),
        "inProgress" => Ok(TurnStatus::InProgress),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn required_plan_step_status_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<PlanStepStatus, CodexAppServerEventError> {
    let status = required_string_key(object, method, key, field)?;
    match status {
        "pending" => Ok(PlanStepStatus::Pending),
        "inProgress" => Ok(PlanStepStatus::InProgress),
        "completed" => Ok(PlanStepStatus::Completed),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn required_item_status_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<ItemStatus, CodexAppServerEventError> {
    let status = required_string_key(object, method, key, field)?;
    parse_item_status(status).ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_collab_agent_tool_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<CollabAgentTool, CodexAppServerEventError> {
    match required_string_key(object, method, key, field)? {
        "spawnAgent" => Ok(CollabAgentTool::SpawnAgent),
        "sendInput" => Ok(CollabAgentTool::SendInput),
        "resumeAgent" => Ok(CollabAgentTool::ResumeAgent),
        "wait" => Ok(CollabAgentTool::Wait),
        "closeAgent" => Ok(CollabAgentTool::CloseAgent),
        "sendMessage" => Ok(CollabAgentTool::SendMessage),
        "followupTask" => Ok(CollabAgentTool::FollowupTask),
        "interruptAgent" => Ok(CollabAgentTool::InterruptAgent),
        "listAgents" => Ok(CollabAgentTool::ListAgents),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn required_collab_agent_tool_call_status_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<CollabAgentToolCallStatus, CodexAppServerEventError> {
    match required_string_key(object, method, key, field)? {
        "inProgress" => Ok(CollabAgentToolCallStatus::InProgress),
        "completed" => Ok(CollabAgentToolCallStatus::Completed),
        "failed" => Ok(CollabAgentToolCallStatus::Failed),
        "interrupted" => Ok(CollabAgentToolCallStatus::Interrupted),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn required_sub_agent_activity_kind_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<SubAgentActivityKind, CodexAppServerEventError> {
    match required_string_key(object, method, key, field)? {
        "started" => Ok(SubAgentActivityKind::Started),
        "interacted" => Ok(SubAgentActivityKind::Interacted),
        "interrupted" => Ok(SubAgentActivityKind::Interrupted),
        "completed" => Ok(SubAgentActivityKind::Completed),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn required_collab_agent_status_key(
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<CollabAgentStatus, CodexAppServerEventError> {
    match required_string_key(object, method, key, field)? {
        "pendingInit" => Ok(CollabAgentStatus::PendingInit),
        "running" => Ok(CollabAgentStatus::Running),
        "interrupted" => Ok(CollabAgentStatus::Interrupted),
        "completed" => Ok(CollabAgentStatus::Completed),
        "errored" => Ok(CollabAgentStatus::Errored),
        "shutdown" => Ok(CollabAgentStatus::Shutdown),
        "notFound" => Ok(CollabAgentStatus::NotFound),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn optional_item_status_key(object: &Map<String, Value>, key: &str) -> Option<ItemStatus> {
    object.get(key)?.as_str().and_then(parse_item_status)
}

fn validate_collab_agent_tool_call_status_for_method(
    method: &str,
    status: CollabAgentToolCallStatus,
) -> Result<(), CodexAppServerEventError> {
    match (method, status) {
        ("item/started", CollabAgentToolCallStatus::InProgress) => Ok(()),
        (
            "item/completed",
            CollabAgentToolCallStatus::Completed
            | CollabAgentToolCallStatus::Failed
            | CollabAgentToolCallStatus::Interrupted,
        ) => Ok(()),
        ("item/started" | "item/completed", _) => {
            Err(invalid_field_for_method(method, "item.status"))
        }
        _ => Ok(()),
    }
}

fn parse_item_status(status: &str) -> Option<ItemStatus> {
    match status {
        "inProgress" => Some(ItemStatus::InProgress),
        "completed" => Some(ItemStatus::Completed),
        "failed" => Some(ItemStatus::Failed),
        "declined" => Some(ItemStatus::Declined),
        _ => None,
    }
}

#[derive(Default)]
struct ReasoningTextMetrics {
    part_count: usize,
    byte_len: usize,
}

impl ReasoningTextMetrics {
    fn add_part(&mut self, part: &str) {
        self.part_count += 1;
        self.byte_len += part.len();
    }

    fn joined_byte_len(&self) -> usize {
        self.byte_len + self.part_count.saturating_sub(1)
    }
}

fn reasoning_text_metrics(
    object: &Map<String, Value>,
    method: &str,
) -> Result<ReasoningTextMetrics, CodexAppServerEventError> {
    let mut metrics = ReasoningTextMetrics::default();
    add_string_array_text_metrics(&mut metrics, object, method, "summary", "item.summary")?;
    add_string_array_text_metrics(&mut metrics, object, method, "content", "item.content")?;
    Ok(metrics)
}

fn add_string_array_text_metrics(
    metrics: &mut ReasoningTextMetrics,
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<(), CodexAppServerEventError> {
    for value in optional_string_array_values(object, method, key, field)? {
        let part = value
            .as_str()
            .ok_or_else(|| invalid_field_for_method(method, field))?;
        metrics.add_part(part);
    }
    Ok(())
}

fn append_reasoning_text_parts(
    text: &mut String,
    has_part: &mut bool,
    object: &Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<(), CodexAppServerEventError> {
    for value in optional_string_array_values(object, method, key, field)? {
        let part = value
            .as_str()
            .ok_or_else(|| invalid_field_for_method(method, field))?;
        if *has_part {
            text.push('\n');
        } else {
            *has_part = true;
        }
        text.push_str(part);
    }
    Ok(())
}

fn optional_string_array_values<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    key: &str,
    field: &'static str,
) -> Result<&'a [Value], CodexAppServerEventError> {
    let Some(values) = object.get(key) else {
        return Ok(&[]);
    };
    if values.is_null() {
        return Ok(&[]);
    }
    values
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn copy_optional_field(
    output: &mut Map<String, Value>,
    output_key: &'static str,
    input: &Map<String, Value>,
    input_key: &'static str,
) {
    if let Some(value) = input.get(input_key) {
        output.insert(output_key.to_string(), value.clone());
    }
}

fn copy_first_optional_field(
    output: &mut Map<String, Value>,
    output_key: &'static str,
    input: &Map<String, Value>,
    input_keys: &[&'static str],
) {
    for input_key in input_keys {
        if let Some(value) = input.get(*input_key) {
            output.insert(output_key.to_string(), value.clone());
            return;
        }
    }
}

fn non_null_field(object: &Map<String, Value>, key: &'static str) -> bool {
    object.get(key).is_some_and(|value| !value.is_null())
}

fn camel_to_snake(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for (index, character) in value.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if index > 0 {
                output.push('_');
            }
            output.push(character.to_ascii_lowercase());
        } else {
            output.push(character);
        }
    }
    output
}

fn missing_field(method: &str, field: &'static str) -> CodexAppServerEventError {
    CodexAppServerEventError::MissingField {
        method: method.to_string(),
        field,
    }
}

fn invalid_field(
    notification: &ServerNotification,
    field: &'static str,
) -> CodexAppServerEventError {
    invalid_field_for_method(&notification.method, field)
}

fn invalid_field_for_method(method: &str, field: &'static str) -> CodexAppServerEventError {
    CodexAppServerEventError::InvalidField {
        method: method.to_string(),
        field,
    }
}

#[cfg(test)]
mod tests {
    use guest_contracts::diagnostics::FailureReason;
    use serde_json::{Value, json};

    use crate::events;
    use crate::masker::SecretMasker;

    use super::*;

    fn notification(method: &str, params: Value) -> ServerNotification {
        ServerNotification {
            method: method.to_string(),
            params: Some(params),
        }
    }

    fn mapped_event(method: &str, params: Value) -> Value {
        notification_to_codex_event(&notification(method, params))
            .expect("notification should map")
            .expect("notification should produce an event")
    }

    fn completed_reasoning_params(item: Value) -> Value {
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": item
        })
    }

    fn completed_command_item() -> Value {
        json!({
            "type": "commandExecution",
            "id": "cmd-1",
            "command": "ls -la",
            "cwd": "/workspace",
            "processId": "proc-1",
            "source": "shell",
            "status": "completed",
            "commandActions": [],
            "aggregatedOutput": "README.md\n",
            "exitCode": 0,
            "durationMs": 123
        })
    }

    #[test]
    fn thread_started_maps_to_top_level_thread_id() {
        let event = mapped_event(
            "thread/started",
            json!({"thread": {"id": "thread-1", "name": "demo"}}),
        );

        assert_eq!(
            event,
            json!({
                "type": "thread.started",
                "thread_id": "thread-1"
            })
        );
    }

    #[test]
    fn turn_started_normalizes_in_progress_status() {
        let event = mapped_event(
            "turn/started",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "inProgress",
                    "error": null,
                    "startedAt": 10,
                    "completedAt": null,
                    "durationMs": null
                }
            }),
        );

        assert_eq!(event["type"], "turn.started");
        assert_eq!(event["thread_id"], "thread-1");
        assert_eq!(event["turn"]["id"], "turn-1");
        assert_eq!(event["turn"]["status"], "in_progress");
        assert_eq!(event["turn"]["started_at"], 10);
    }

    #[test]
    fn turn_completed_does_not_read_non_contract_usage() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "completed",
                    "error": null,
                    "startedAt": 10,
                    "completedAt": 20,
                    "durationMs": 1000
                },
                "usage": {"input_tokens": 1}
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "turn.completed",
                "thread_id": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "completed",
                    "error": null,
                    "started_at": 10,
                    "completed_at": 20,
                    "duration_ms": 1000
                }
            })
        );
    }

    #[test]
    fn token_usage_update_rejects_negative_count() {
        let error = codex_token_usage_update(&notification(
            "thread/tokenUsage/updated",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": {
                    "total": {
                        "inputTokens": -1,
                        "cachedInputTokens": 0,
                        "cacheWriteInputTokens": 0,
                        "outputTokens": 0,
                        "reasoningOutputTokens": 0,
                        "totalTokens": 0
                    },
                    "last": {
                        "inputTokens": 0,
                        "cachedInputTokens": 0,
                        "cacheWriteInputTokens": 0,
                        "outputTokens": 0,
                        "reasoningOutputTokens": 0,
                        "totalTokens": 0
                    },
                    "modelContextWindow": 258400
                }
            }),
        ))
        .expect_err("negative token usage should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "thread/tokenUsage/updated".to_string(),
                field: "tokenUsage.total"
            }
        );
    }

    #[test]
    fn failed_turn_preserves_queue_expiry_over_generic_server_variants() {
        let queue_message = "We were unable to start processing your request within the 900-second timeout limit. Please try again later.";
        for (info, expected) in [
            (
                json!("serverOverloaded"),
                FailureReason::ProviderQueueTimeout,
            ),
            (
                json!("internalServerError"),
                FailureReason::ProviderQueueTimeout,
            ),
            (
                json!({"responseTooManyFailedAttempts": {"httpStatusCode": 503}}),
                FailureReason::ProviderQueueTimeout,
            ),
            (json!("unauthorized"), FailureReason::InvalidCredentials),
            (json!("usageLimitExceeded"), FailureReason::UsageLimit),
            (
                json!("rateLimitExceeded"),
                FailureReason::ProviderRateLimited,
            ),
            (
                json!("contextWindowExceeded"),
                FailureReason::ContextWindowExceeded,
            ),
            (json!("cyberPolicy"), FailureReason::SafetyPolicyRefusal),
        ] {
            let event = mapped_event(
                "turn/completed",
                json!({
                    "threadId": "thread-1",
                    "turn": {"id": "turn-1", "status": "failed", "error": {
                        "message": queue_message, "codexErrorInfo": info
                    }}
                }),
            );
            let diagnostic =
                events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                    .expect("failed turn diagnostic");
            assert_eq!(diagnostic.failure_reason, Some(expected), "{info}");
        }
    }

    #[test]
    fn failed_turn_completed_preserves_nested_error_for_diagnostics() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {
                        "message": "selected model is at capacity. please try a different model.",
                        "additionalDetails": "retry later",
                        "codexErrorInfo": "serverOverloaded"
                    },
                    "startedAt": 10,
                    "completedAt": 20,
                    "durationMs": 1000
                }
            }),
        );

        assert_eq!(event["type"], "turn.completed");
        assert_eq!(event["turn"]["status"], "failed");
        assert_eq!(event["turn"]["error"]["additional_details"], "retry later");
        assert_eq!(
            event["turn"]["error"]["codex_error_info"],
            "serverOverloaded"
        );
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(events::CodexFailureDiagnostic {
                event_type: "turn.completed",
                message:
                    "selected model is at capacity. please try a different model. (retry later)"
                        .to_string(),
                failure_reason: Some(FailureReason::ProviderOverloaded),
            })
        );
    }

    #[test]
    fn failed_turn_completed_classifies_rate_limit_for_diagnostics() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {
                        "message": "Rate limit exceeded.",
                        "codexErrorInfo": "rateLimitExceeded"
                    }
                }
            }),
        );

        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(events::CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: "Rate limit exceeded.".to_string(),
                failure_reason: Some(FailureReason::ProviderRateLimited),
            })
        );
    }

    #[test]
    fn failed_turn_completed_preserves_cyber_policy_reason_for_diagnostics() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {
                        "message": "This request has been flagged for possible cybersecurity risk.",
                        "codexErrorInfo": "cyberPolicy"
                    },
                    "startedAt": 10,
                    "completedAt": 20,
                    "durationMs": 1000
                }
            }),
        );

        assert_eq!(event["turn"]["error"]["codex_error_info"], "cyberPolicy");
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(events::CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: "This request has been flagged for possible cybersecurity risk."
                    .to_string(),
                failure_reason: Some(FailureReason::SafetyPolicyRefusal),
            })
        );
    }

    #[test]
    fn failed_turn_completed_classifies_upstream_content_policy_rejection() {
        const ENVELOPE: &str = r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#;
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {"message": ENVELOPE},
                    "startedAt": 10,
                    "completedAt": 20,
                    "durationMs": 1000
                }
            }),
        );

        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(events::CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: ENVELOPE.to_string(),
                failure_reason: Some(FailureReason::SafetyPolicyRefusal),
            })
        );
    }

    #[test]
    fn failed_turn_completed_keeps_request_format_errors_unclassified() {
        const ENVELOPE: &str = r#"{"error":{"message":"Invalid Format","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#;
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {"message": ENVELOPE},
                    "startedAt": 10,
                    "completedAt": 20,
                    "durationMs": 1000
                }
            }),
        );

        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(events::CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: ENVELOPE.to_string(),
                failure_reason: None,
            })
        );
    }

    #[test]
    fn failed_turn_completed_classifies_misalignment_policy_violation() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {
                        "message": "This request violates the provider's alignment policy.",
                        "codexErrorInfo": "misalignmentPolicyViolation",
                        "misalignment": {
                            "errorType": "policy_violation",
                            "detailedExplanation": "Try a safer direction.",
                            "steer": {"message": "Continue with a safe alternative."}
                        }
                    },
                    "startedAt": 10,
                    "completedAt": 20,
                    "durationMs": 1000
                }
            }),
        );

        assert_eq!(
            event["turn"]["error"]["codex_error_info"],
            "misalignmentPolicyViolation"
        );
        assert_eq!(
            event["turn"]["error"]["misalignment"],
            json!({
                "error_type": "policy_violation",
                "detailed_explanation": "Try a safer direction.",
                "steer": {"message": "Continue with a safe alternative."}
            })
        );
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(events::CodexFailureDiagnostic {
                event_type: "turn.completed",
                message: "This request violates the provider's alignment policy.".to_string(),
                failure_reason: Some(FailureReason::SafetyPolicyRefusal),
            })
        );
    }

    #[test]
    fn interrupted_turn_completed_stays_turn_completed() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "interrupted",
                    "error": {"message": "turn interrupted"},
                    "startedAt": 10,
                    "completedAt": 20,
                    "durationMs": 1000
                }
            }),
        );

        assert_eq!(event["type"], "turn.completed");
        assert_eq!(event["turn"]["status"], "interrupted");
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .map(|diagnostic| diagnostic.message),
            Some("turn interrupted".to_string())
        );
    }

    #[test]
    fn turn_plan_updated_maps_steps() {
        let event = mapped_event(
            "turn/plan/updated",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "explanation": "working",
                "plan": [
                    {"step": "read", "status": "completed"},
                    {"step": "write", "status": "inProgress"},
                    {"step": "test", "status": "pending"}
                ]
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "turn.plan.updated",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "explanation": "working",
                "plan": [
                    {"step": "read", "status": "completed"},
                    {"step": "write", "status": "in_progress"},
                    {"step": "test", "status": "pending"}
                ]
            })
        );
    }

    #[test]
    fn item_completed_agent_message_maps_to_existing_output_shape() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "agentMessage",
                    "id": "item-1",
                    "text": "hello",
                    "phase": null,
                    "memoryCitation": null
                }
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "item.completed",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "completed_at_ms": 42,
                "item": {
                    "id": "item-1",
                    "type": "agent_message",
                    "text": "hello"
                }
            })
        );
    }

    #[test]
    fn blank_agent_message_text_preserves_shape() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "agentMessage",
                    "id": "item-1",
                    "text": ""
                }
            }),
        );

        assert_eq!(event["item"]["type"], "agent_message");
        assert_eq!(event["item"]["text"], "");
    }

    #[test]
    fn plan_item_completed_maps_text() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "plan",
                    "id": "plan-1",
                    "text": "1. inspect\n2. implement"
                }
            }),
        );

        assert_eq!(
            event["item"],
            json!({
                "id": "plan-1",
                "type": "plan",
                "text": "1. inspect\n2. implement"
            })
        );
    }

    #[test]
    fn reasoning_joins_summary_and_content() {
        let event = mapped_event(
            "item/completed",
            completed_reasoning_params(json!({
                    "type": "reasoning",
                    "id": "reason-1",
                    "summary": ["summary"],
                    "content": ["detail one", "detail two"]
            })),
        );

        assert_eq!(event["item"]["type"], "reasoning");
        assert_eq!(event["item"]["text"], "summary\ndetail one\ndetail two");
    }

    #[test]
    fn reasoning_omits_text_without_parts() {
        for item in [
            json!({
                "type": "reasoning",
                "id": "reason-1"
            }),
            json!({
                "type": "reasoning",
                "id": "reason-1",
                "summary": null,
                "content": null
            }),
            json!({
                "type": "reasoning",
                "id": "reason-1",
                "summary": [],
                "content": []
            }),
        ] {
            let event = mapped_event("item/completed", completed_reasoning_params(item));
            let item = event["item"]
                .as_object()
                .expect("mapped item should be an object");
            assert!(!item.contains_key("text"));
        }
    }

    #[test]
    fn reasoning_preserves_empty_string_text_part() {
        let event = mapped_event(
            "item/completed",
            completed_reasoning_params(json!({
                "type": "reasoning",
                "id": "reason-1",
                "summary": [""]
            })),
        );

        let item = event["item"]
            .as_object()
            .expect("mapped item should be an object");
        assert_eq!(item.get("text").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn reasoning_preserves_newline_placement_for_empty_parts() {
        let event = mapped_event(
            "item/completed",
            completed_reasoning_params(json!({
                "type": "reasoning",
                "id": "reason-1",
                "summary": ["", "summary"],
                "content": [""]
            })),
        );

        assert_eq!(event["item"]["text"], "\nsummary\n");
    }

    #[test]
    fn invalid_reasoning_text_fields_return_invalid_field() {
        for (item, field) in [
            (
                json!({
                    "type": "reasoning",
                    "id": "reason-1",
                    "summary": "summary"
                }),
                "item.summary",
            ),
            (
                json!({
                    "type": "reasoning",
                    "id": "reason-1",
                    "content": "content"
                }),
                "item.content",
            ),
            (
                json!({
                    "type": "reasoning",
                    "id": "reason-1",
                    "summary": [1]
                }),
                "item.summary",
            ),
            (
                json!({
                    "type": "reasoning",
                    "id": "reason-1",
                    "content": [1]
                }),
                "item.content",
            ),
        ] {
            let error = notification_to_codex_event(&notification(
                "item/completed",
                completed_reasoning_params(item),
            ))
            .expect_err("invalid reasoning text field should fail");

            assert_eq!(
                error,
                CodexAppServerEventError::InvalidField {
                    method: "item/completed".to_string(),
                    field,
                }
            );
        }
    }

    #[test]
    fn command_execution_completed_maps_output_and_status() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": completed_command_item()
            }),
        );

        assert_eq!(
            event["item"],
            json!({
                "id": "cmd-1",
                "type": "command_execution",
                "command": "ls -la",
                "status": "completed",
                "cwd": "/workspace",
                "aggregated_output": "README.md\n",
                "exit_code": 0,
                "duration_ms": 123
            })
        );
    }

    #[test]
    fn command_execution_started_maps_in_progress_tool_use_shape() {
        let mut item = completed_command_item();
        item["status"] = json!("inProgress");
        item["aggregatedOutput"] = Value::Null;
        item["exitCode"] = Value::Null;
        item["durationMs"] = Value::Null;

        let event = mapped_event(
            "item/started",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "startedAtMs": 42,
                "item": item
            }),
        );

        assert_eq!(event["type"], "item.started");
        assert_eq!(event["item"]["type"], "command_execution");
        assert_eq!(event["item"]["status"], "in_progress");
    }

    #[test]
    fn file_change_completed_maps_changes() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "fileChange",
                    "id": "file-1",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "src/lib.rs",
                            "kind": {"type": "update", "move_path": null},
                            "diff": "@@"
                        },
                        {
                            "path": "src/new.rs",
                            "kind": {"type": "add"},
                            "diff": "+new"
                        }
                    ]
                }
            }),
        );

        assert_eq!(
            event["item"],
            json!({
                "id": "file-1",
                "type": "file_change",
                "status": "completed",
                "changes": [
                    {"path": "src/lib.rs", "kind": "modify", "diff": "@@"},
                    {"path": "src/new.rs", "kind": "add", "diff": "+new"}
                ]
            })
        );
    }

    #[test]
    fn unsupported_completed_item_maps_to_generic_item() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "mcpToolCall",
                    "id": "mcp-1",
                    "status": "completed",
                    "server": "github",
                    "tool": "listIssues",
                    "durationMs": 50,
                    "arguments": {"owner": "vm0-ai", "nested": {"ignored": true}},
                    "large": [1, 2, 3]
                }
            }),
        );

        assert_eq!(event["type"], "item.completed");
        assert_eq!(event["item"]["id"], "mcp-1");
        assert_eq!(event["item"]["type"], "mcp_tool_call");
        assert_eq!(event["item"]["status"], "completed");
        assert_eq!(event["item"]["duration_ms"], 50);
        assert_eq!(event["item"]["arguments"], json!({"owner": "vm0-ai"}));
        assert_eq!(event["item"]["large"], json!([1, 2, 3]));
    }

    #[test]
    fn function_call_output_preserves_structured_output() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "functionCallOutput",
                    "id": "function-output-1",
                    "name": "lookup",
                    "namespace": "tools",
                    "output": [
                        {"type": "input_text", "text": "result"},
                        {"type": "input_image", "image_url": "data:image/png;base64,AA=="}
                    ]
                }
            }),
        );

        assert_eq!(
            event["item"],
            json!({
                "type": "function_call_output",
                "id": "function-output-1",
                "name": "lookup",
                "namespace": "tools",
                "output": [
                    {"type": "input_text", "text": "result"},
                    {"type": "input_image", "image_url": "data:image/png;base64,AA=="}
                ]
            })
        );
    }

    #[test]
    fn generic_completed_item_keeps_only_bounded_shallow_values() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "dynamicToolCall",
                    "id": "tool-1",
                    "status": "completed",
                    "contentItems": [
                        "kept",
                        {"nested": "dropped"},
                        ["also", "dropped"],
                        7
                    ],
                    "arguments": {
                        "query": "kept",
                        "nested": {"ignored": true},
                        "items": ["ignored"]
                    },
                    "tooManyItems": [
                        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
                        11, 12, 13, 14, 15, 16, 17
                    ],
                    "tooManyFields": {
                        "a": 1, "b": 2, "c": 3, "d": 4, "e": 5,
                        "f": 6, "g": 7, "h": 8, "i": 9, "j": 10,
                        "k": 11, "l": 12, "m": 13, "n": 14, "o": 15,
                        "p": 16, "q": 17, "r": 18, "s": 19, "t": 20,
                        "u": 21, "v": 22, "w": 23, "x": 24, "y": 25
                    }
                }
            }),
        );

        assert_eq!(event["item"]["type"], "dynamic_tool_call");
        assert_eq!(event["item"]["content_items"], json!(["kept", 7]));
        assert_eq!(event["item"]["arguments"], json!({"query": "kept"}));
        assert!(event["item"].get("too_many_items").is_none());
        assert!(event["item"].get("too_many_fields").is_none());
    }

    #[test]
    fn generic_completed_item_limits_top_level_fields_deterministically() {
        let mut item = Map::new();
        item.insert("id".to_string(), json!("tool-1"));
        item.insert("type".to_string(), json!("dynamicToolCall"));
        item.insert("status".to_string(), json!("completed"));
        item.insert("Id".to_string(), json!("shadow-id"));
        item.insert("Type".to_string(), json!("shadowType"));
        item.insert("Status".to_string(), json!("failed"));

        let unsupported_fields = (0..=MAX_GENERIC_OBJECT_FIELDS)
            .map(|index| (format!("nested{index:02}"), json!(index)))
            .collect();
        item.insert(
            "aaaUnsupported".to_string(),
            Value::Object(unsupported_fields),
        );
        for index in 0..MAX_GENERIC_OPTIONAL_FIELDS + 2 {
            item.insert(format!("field{index:02}"), json!(index));
        }

        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": item
            }),
        );
        let normalized = event["item"]
            .as_object()
            .expect("mapped item should be an object");

        assert_eq!(normalized.len(), MAX_GENERIC_OPTIONAL_FIELDS + 3);
        assert_eq!(normalized["id"], "tool-1");
        assert_eq!(normalized["type"], "dynamic_tool_call");
        assert_eq!(normalized["status"], "completed");
        for index in 0..MAX_GENERIC_OPTIONAL_FIELDS {
            assert_eq!(normalized[&format!("field{index:02}")], index);
        }
        for index in MAX_GENERIC_OPTIONAL_FIELDS..MAX_GENERIC_OPTIONAL_FIELDS + 2 {
            assert!(!normalized.contains_key(&format!("field{index:02}")));
        }
        assert!(!normalized.contains_key("aaa_unsupported"));
    }

    #[test]
    fn unsupported_started_item_is_ignored() {
        let result = notification_to_codex_event(&notification(
            "item/started",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "startedAtMs": 42,
                "item": {"type": "mcpToolCall", "id": "mcp-1"}
            }),
        ))
        .expect("unsupported started item should not error");

        assert_eq!(result, None);
    }

    #[test]
    fn non_retryable_error_maps_to_diagnostic_compatible_error() {
        let event = mapped_event(
            "error",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": false,
                "error": {
                    "message": "usage limit exceeded",
                    "additionalDetails": "upgrade required",
                    "codexErrorInfo": "usageLimitExceeded"
                }
            }),
        );

        assert_eq!(event["type"], "error");
        assert_eq!(event["error"]["additional_details"], "upgrade required");
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(events::CodexFailureDiagnostic {
                event_type: "error",
                message: "usage limit exceeded (upgrade required)".to_string(),
                failure_reason: Some(FailureReason::UsageLimit),
            })
        );
    }

    #[test]
    fn output_token_limit_is_classified_only_after_native_terminal_error() {
        let message = "stream disconnected before completion: Incomplete response returned, reason: max_output_tokens";
        for will_retry in [true, false] {
            let event = mapped_event(
                "error",
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "willRetry": will_retry,
                    "error": {
                        "message": message,
                        "codexErrorInfo": "other",
                        "additionalDetails": null
                    }
                }),
            );
            let diagnostic =
                events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""));
            if will_retry {
                assert_eq!(event["type"], "warning");
                assert_eq!(diagnostic, None);
            } else {
                assert_eq!(event["type"], "error");
                let diagnostic = diagnostic.expect("terminal error diagnostic");
                assert_eq!(diagnostic.message, message);
                assert_eq!(
                    diagnostic.failure_reason,
                    Some(FailureReason::OutputTokenLimit)
                );
            }
        }
    }

    #[test]
    fn retryable_error_maps_to_warning() {
        let event = mapped_event(
            "error",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": true,
                "error": {"message": "temporarily unavailable"}
            }),
        );

        assert_eq!(event["type"], "warning");
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn warning_maps_to_non_failure_event() {
        let event = mapped_event(
            "warning",
            json!({
                "threadId": null,
                "message": "configuration warning"
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "warning",
                "message": "configuration warning"
            })
        );
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn delta_and_progress_notifications_are_ignored() {
        for method in [
            "item/agentMessage/delta",
            "item/plan/delta",
            "item/commandExecution/outputDelta",
            "item/fileChange/patchUpdated",
            "item/reasoning/textDelta",
            "item/mcpToolCall/progress",
        ] {
            let result = notification_to_codex_event(&notification(
                method,
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": "partial"
                }),
            ))
            .expect("ignored notification should not error");
            assert_eq!(result, None, "method {method}");
        }
    }

    #[test]
    fn output_item_start_selects_reasoning_and_agent_message_only() {
        for (item_type, expected_kind) in [
            ("reasoning", Some(CodexOutputItemKind::Reasoning)),
            ("agentMessage", Some(CodexOutputItemKind::AgentMessage)),
            ("commandExecution", None),
        ] {
            let start = codex_output_item_start(&notification(
                "item/started",
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "startedAtMs": 1_700_000_000_123_u64,
                    "item": {
                        "type": item_type
                    }
                }),
            ))
            .expect("valid item start should parse");

            assert_eq!(start.map(|start| start.kind), expected_kind);
        }
    }

    #[test]
    fn output_item_start_rejects_non_epoch_timestamp() {
        let error = codex_output_item_start(&notification(
            "item/started",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "startedAtMs": 42,
                "item": {
                    "id": "item-1",
                    "type": "agentMessage",
                    "text": ""
                }
            }),
        ))
        .expect_err("non-epoch item start should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/started".to_string(),
                field: "startedAtMs",
            }
        );
    }

    #[test]
    fn unknown_method_is_ignored() {
        let result = notification_to_codex_event(&notification(
            "thread/status/changed",
            json!({"threadId": "thread-1", "status": "running"}),
        ))
        .expect("unknown method should not error");

        assert_eq!(result, None);
    }

    #[test]
    fn supported_method_without_params_returns_missing_params() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "thread/started".to_string(),
            params: None,
        })
        .expect_err("missing params should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::MissingParams {
                method: "thread/started".to_string()
            }
        );
    }

    #[test]
    fn missing_required_field_returns_missing_field() {
        let error = notification_to_codex_event(&notification("thread/started", json!({})))
            .expect_err("missing thread should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::MissingField {
                method: "thread/started".to_string(),
                field: "thread",
            }
        );
    }

    #[test]
    fn invalid_required_field_type_returns_invalid_field() {
        let error = notification_to_codex_event(&notification(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": "later",
                "item": {"type": "agentMessage", "id": "item-1", "text": "hello"}
            }),
        ))
        .expect_err("wrong timestamp type should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/completed".to_string(),
                field: "completedAtMs",
            }
        );
    }

    #[test]
    fn empty_required_id_returns_invalid_field() {
        let error = notification_to_codex_event(&notification(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {"type": "agentMessage", "id": " ", "text": "hello"}
            }),
        ))
        .expect_err("empty item id should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/completed".to_string(),
                field: "item.id",
            }
        );
    }

    #[test]
    fn started_turn_rejects_terminal_status() {
        let error = notification_to_codex_event(&notification(
            "turn/started",
            json!({
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "status": "completed", "error": null}
            }),
        ))
        .expect_err("started turn should reject terminal status");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/started".to_string(),
                field: "turn.status",
            }
        );
    }

    #[test]
    fn completed_turn_rejects_in_progress_status() {
        let error = notification_to_codex_event(&notification(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "status": "inProgress", "error": null}
            }),
        ))
        .expect_err("completed turn should reject in-progress status");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/completed".to_string(),
                field: "turn.status",
            }
        );
    }

    #[test]
    fn successful_turn_completed_rejects_non_null_error() {
        let error = notification_to_codex_event(&notification(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "completed",
                    "error": {"message": "should not exist on success"}
                }
            }),
        ))
        .expect_err("successful completed turn should not carry an error");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/completed".to_string(),
                field: "turn.error",
            }
        );
    }
}
