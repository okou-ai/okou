//! Claude Code and Pi share canonical message blocks before delivery reduction.

use serde_json::{Value, json};

use super::bounded_event_delivery::{ContentPolicy, DELIVERY_NOTICE, PathSegment};

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
        [Key(message)] if message == "message" && value.is_string() => {
            ContentPolicy::Text("message_text")
        }
        [Key(message)] if message == "message" => ContentPolicy::Descend,
        [Key(result)] if result == "result" => ContentPolicy::Text("result_text"),
        [Key(message), Key(content)] if message == "message" && content == "content" => {
            if value.is_string() {
                ContentPolicy::Text("message_text")
            } else {
                ContentPolicy::Descend
            }
        }
        [Key(message), Key(content), Index(_)] if message == "message" && content == "content" => {
            if value.get("type").and_then(Value::as_str) == Some("image") {
                ContentPolicy::Image("text")
            } else {
                ContentPolicy::Descend
            }
        }
        [Key(message), Key(content), Index(_), Key(field), rest @ ..]
            if message == "message" && content == "content" =>
        {
            match field.as_str() {
                "text" if rest.is_empty() => ContentPolicy::Text("message_text"),
                "thinking" if rest.is_empty() => ContentPolicy::Text("thinking_text"),
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
                        && (rest.is_empty()
                            || matches!(rest.last(), Some(Key(key)) if key == "text"))
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

pub(super) fn minimum_event(mut event: Value, omitted_image: bool) -> Option<Value> {
    let fields = event.as_object_mut()?;
    match fields.get("type").and_then(Value::as_str) {
        Some("assistant" | "user") => {
            let message = fields.get_mut("message")?;
            if message.is_string() {
                *message = json!(DELIVERY_NOTICE);
                return Some(event);
            }
            let content = message.get_mut("content")?;
            if content.is_string() {
                *content = json!(DELIVERY_NOTICE);
                return Some(event);
            }
            let blocks = content.as_array_mut()?;
            // Normalization owns expansion before sequence allocation; never split here.
            let [block] = blocks.as_mut_slice() else {
                return None;
            };
            let block = block.as_object_mut()?;
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    block.insert("text".into(), json!(DELIVERY_NOTICE));
                }
                Some("thinking") => {
                    block.insert("thinking".into(), json!(DELIVERY_NOTICE));
                }
                Some("image") => {
                    *block = serde_json::Map::from_iter([
                        ("type".into(), json!("text")),
                        ("text".into(), json!("[image omitted for delivery]")),
                    ]);
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
                    return None;
                }
            }
        }
        Some("result") => {
            fields.insert("result".into(), json!(DELIVERY_NOTICE));
        }
        _ => {
            return None;
        }
    }
    // All outer fields, tool identities, usage, outcomes and unknown data remain.
    // An irreducibly oversized protected core is omitted by the delivery owner.
    Some(event)
}
