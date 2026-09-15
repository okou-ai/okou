//! Pi's projected message shapes remain intact when only delivery content shrinks.

use serde_json::{Value, json};

use super::bounded_event_delivery::{ContentPolicy, DELIVERY_NOTICE, PathSegment};
use crate::error::AgentError;

pub(super) fn labels(event: &Value) -> (&'static str, &'static str) {
    let event_type = match event.get("type").and_then(Value::as_str) {
        Some("assistant") => "assistant",
        Some("user") => "user",
        Some("result") => "result",
        Some("system") => "system",
        _ => "other",
    };
    let content_type = match event
        .pointer("/message/content/0/type")
        .and_then(Value::as_str)
    {
        Some("text") => "text",
        Some("tool_use") => "tool_use",
        Some("tool_result") => "tool_result",
        _ => "none",
    };
    (event_type, content_type)
}

pub(super) fn content_policy(value: &Value, path: &[PathSegment]) -> ContentPolicy {
    use PathSegment::{Index, Key};
    match path {
        [] => ContentPolicy::Descend,
        [Key(message)] if message == "message" => ContentPolicy::Descend,
        [Key(result)] if result == "result" => ContentPolicy::Text("result_text"),
        [Key(message), Key(content)] if message == "message" && content == "content" => {
            ContentPolicy::Descend
        }
        [Key(message), Key(content), Index(_)] if message == "message" && content == "content" => {
            ContentPolicy::Descend
        }
        [Key(message), Key(content), Index(_), Key(field), rest @ ..]
            if message == "message" && content == "content" =>
        {
            match field.as_str() {
                "text" if rest.is_empty() => ContentPolicy::Text("message_text"),
                "input" => {
                    if value.is_string() {
                        ContentPolicy::Text("tool_input")
                    } else {
                        ContentPolicy::Descend
                    }
                }
                "content" => {
                    if value.get("type").and_then(Value::as_str) == Some("image") {
                        ContentPolicy::Image("text")
                    } else if value.is_string()
                        && matches!(rest.last(), Some(Key(key)) if key == "text")
                    {
                        ContentPolicy::Text("tool_output")
                    } else if value.is_array() || value.is_object() {
                        ContentPolicy::Descend
                    } else {
                        ContentPolicy::Preserve
                    }
                }
                _ => ContentPolicy::Preserve,
            }
        }
        _ => ContentPolicy::Preserve,
    }
}

pub(super) fn minimum_event(mut event: Value, omitted_image: bool) -> Result<Value, AgentError> {
    let fields = event
        .as_object_mut()
        .ok_or_else(|| AgentError::Execution("normalized Pi event is not an object".into()))?;
    match fields.get("type").and_then(Value::as_str) {
        Some("assistant" | "user") => {
            let blocks = fields
                .get_mut("message")
                .and_then(|message| message.get_mut("content"))
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    AgentError::Execution("Pi delivery minimum requires message content".into())
                })?;
            // Normalization owns expansion before sequence allocation; never split here.
            let [block] = blocks.as_mut_slice() else {
                return Err(AgentError::Execution(
                    "Pi delivery minimum requires one canonical content block".into(),
                ));
            };
            let block = block.as_object_mut().ok_or_else(|| {
                AgentError::Execution("Pi delivery content is not an object".into())
            })?;
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    block.insert("text".into(), json!(DELIVERY_NOTICE));
                }
                Some("tool_use") if block.get("input").is_some_and(Value::is_object) => {
                    block.insert("input".into(), json!({"_delivery_notice": DELIVERY_NOTICE}));
                }
                Some("tool_result") => {
                    let images =
                        block
                            .get("content")
                            .and_then(Value::as_array)
                            .is_some_and(|blocks| {
                                blocks.iter().any(|block| {
                                    block.get("type").and_then(Value::as_str) == Some("image")
                                })
                            });
                    let mut content = vec![json!({"type": "text", "text": DELIVERY_NOTICE})];
                    if omitted_image || images {
                        content.push(super::bounded_event_delivery::image_notice("text"));
                    }
                    block.insert("content".into(), Value::Array(content));
                }
                _ => {
                    return Err(AgentError::Execution(
                        "unsupported Pi delivery minimum content".into(),
                    ));
                }
            }
        }
        Some("result") => {
            fields.insert("result".into(), json!(DELIVERY_NOTICE));
        }
        _ => {
            return Err(AgentError::Execution(
                "unsupported Pi delivery minimum event".into(),
            ));
        }
    }
    // All outer fields, tool identities, usage, outcomes and unknown data remain.
    // The final admission guard rejects any irreducibly oversized protected core.
    Ok(event)
}
