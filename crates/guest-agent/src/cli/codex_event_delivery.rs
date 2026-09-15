//! Codex content policy for the shared delivery budget engine.
use super::bounded_event_delivery::{
    ContentPolicy, DELIVERY_NOTICE, PathSegment, json_string_bytes,
};
use crate::error::AgentError;
use serde_json::{Value, json};

pub(super) fn labels(event: &Value) -> (&'static str, &'static str) {
    (event_type_label(event), item_type_label(event))
}

pub(super) fn content_policy(
    value: &Value,
    path: &[PathSegment],
    item_type: Option<&str>,
) -> ContentPolicy {
    if item_type == Some("collab_agent_tool_call")
        && let [PathSegment::Key(item), PathSegment::Key(states), rest @ ..] = path
        && item == "item"
        && states == "agents_states"
    {
        // Child IDs are keys, even when they match a protected field name.
        return match rest {
            [] | [PathSegment::Key(_)] => ContentPolicy::Descend,
            [PathSegment::Key(_), PathSegment::Key(field)] if field == "message" => {
                ContentPolicy::Text("collab_agent_message")
            }
            _ => ContentPolicy::Preserve,
        };
    }
    if matches!(path, [PathSegment::Key(item), PathSegment::Key(output), PathSegment::Index(_)] if item == "item" && output == "output")
        && item_type == Some("function_call_output")
        && value.get("type").and_then(Value::as_str) == Some("input_image")
    {
        return ContentPolicy::Image("input_text");
    }
    if let Some(PathSegment::Key(key)) = path.last()
        && matches!(
            key.as_str(),
            "id" | "type"
                | "status"
                | "kind"
                | "thread_id"
                | "turn_id"
                | "name"
                | "namespace"
                | "call_id"
                | "tool"
                | "server"
                | "model"
                | "reasoning_effort"
                | "usage"
                | "sender_thread_id"
                | "receiver_thread_ids"
                | "agents_states"
                | "error_code"
                | "codex_error_info"
                | "http_status_code"
                | "memoryCitation"
        )
    {
        return ContentPolicy::Preserve;
    }
    if value.is_string() {
        ContentPolicy::Text(field_category(path, item_type))
    } else {
        ContentPolicy::Descend
    }
}

fn field_category(path: &[PathSegment], item_type: Option<&str>) -> &'static str {
    let keys = path
        .iter()
        .filter_map(|segment| match segment {
            PathSegment::Key(key) => Some(key.as_str()),
            PathSegment::Index(_) => None,
        })
        .collect::<Vec<_>>();

    match keys.as_slice() {
        ["item", "text"] => match item_type {
            Some("agent_message") => "agent_message_text",
            Some("reasoning") => "reasoning_text",
            Some("plan") => "plan_text",
            _ => "item_text",
        },
        ["item", "aggregated_output"] | ["item", "output"] => "command_output",
        ["item", "command"] => "command",
        ["item", "changes", "diff"] => "file_diff",
        ["item", "changes", "path"] => "file_path",
        ["plan", "step"] => "plan_step",
        ["explanation"] => "plan_explanation",
        ["message"] | ["error", "message"] | ["turn", "error", "message"] => "message",
        _ => "other_content",
    }
}

pub(super) fn minimum_event(mut event: Value, omitted_image: bool) -> Result<Value, AgentError> {
    for path in [
        "/message",
        "/error/message",
        "/turn/error/message",
        "/item/error/message",
    ] {
        if let Some(text) = event.pointer_mut(path).filter(|text| text.is_string()) {
            *text = json!(DELIVERY_NOTICE);
        }
    }
    let fields = event
        .as_object_mut()
        .ok_or_else(|| AgentError::Execution("normalized Codex event is not an object".into()))?;
    if fields.get("type").and_then(Value::as_str) == Some("turn.plan.updated") {
        let plan = fields
            .get("plan")
            .and_then(Value::as_array)
            .ok_or_else(|| AgentError::Execution("Codex delivery plan is not an array".into()))?;
        let status = if plan
            .iter()
            .all(|step| step.get("status").and_then(Value::as_str) == Some("completed"))
        {
            "completed"
        } else if plan
            .iter()
            .any(|step| step.get("status").and_then(Value::as_str) == Some("in_progress"))
        {
            "in_progress"
        } else {
            "pending"
        };
        fields.insert(
            "plan".into(),
            json!([{"step": DELIVERY_NOTICE, "status": status}]),
        );
        fields.insert("explanation".into(), json!(DELIVERY_NOTICE));
    }
    if let Some(item) = fields.get_mut("item").and_then(Value::as_object_mut) {
        match item.get("type").and_then(Value::as_str) {
            Some("agent_message" | "reasoning" | "plan") => {
                item.insert("text".into(), json!(DELIVERY_NOTICE));
            }
            Some("command_execution") => {
                item.insert("command".into(), json!(DELIVERY_NOTICE));
                item.insert("aggregated_output".into(), json!(DELIVERY_NOTICE));
            }
            Some("collab_agent_tool_call") => {
                if let Some(prompt) = item.get_mut("prompt") {
                    minimize_text(prompt);
                }
                // A shallow in-place pass covers messages beyond candidate, key,
                // and traversal limits without retaining input-sized path state.
                if let Some(states) = item.get_mut("agents_states").and_then(Value::as_object_mut) {
                    for state in states.values_mut() {
                        if let Some(message) = state.get_mut("message") {
                            minimize_text(message);
                        }
                    }
                }
            }
            Some("function_call_output") => {
                let output = if let Some(output) = item.get("output").and_then(Value::as_array) {
                    let images = output.iter().any(|block| {
                        block.get("type").and_then(Value::as_str) == Some("input_image")
                    });
                    let mut blocks = vec![json!({"type": "input_text", "text": DELIVERY_NOTICE})];
                    if omitted_image || images {
                        blocks.push(super::bounded_event_delivery::image_notice("input_text"));
                    }
                    Value::Array(blocks)
                } else {
                    json!(DELIVERY_NOTICE)
                };
                item.insert("output".into(), output);
            }
            Some("file_change") => {
                // Each canonical file-change event already has one change.
                if let Some(changes) = item.get_mut("changes").and_then(Value::as_array_mut) {
                    for change in changes {
                        if let Some(change) = change.as_object_mut() {
                            change.insert("diff".into(), json!(DELIVERY_NOTICE));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(event)
}

fn minimize_text(value: &mut Value) {
    if value.as_str().is_some_and(|text| {
        text.len() > DELIVERY_NOTICE.len() || json_string_bytes(text) > DELIVERY_NOTICE.len() + 2
    }) {
        *value = json!(DELIVERY_NOTICE);
    }
}

fn event_type_label(event: &Value) -> &'static str {
    match event.get("type").and_then(Value::as_str) {
        Some("thread.started") => "thread.started",
        Some("turn.started") => "turn.started",
        Some("turn.completed") => "turn.completed",
        Some("turn.plan.updated") => "turn.plan.updated",
        Some("item.started") => "item.started",
        Some("item.completed") => "item.completed",
        Some("warning") => "warning",
        Some("error") => "error",
        _ => "other",
    }
}

fn item_type_label(event: &Value) -> &'static str {
    match event.pointer("/item/type").and_then(Value::as_str) {
        Some("agent_message") => "agent_message",
        Some("plan") => "plan",
        Some("reasoning") => "reasoning",
        Some("command_execution") => "command_execution",
        Some("collab_agent_tool_call") => "collab_agent_tool_call",
        Some("file_change") => "file_change",
        Some("function_call_output") => "function_call_output",
        Some(_) => "other",
        None => "none",
    }
}
