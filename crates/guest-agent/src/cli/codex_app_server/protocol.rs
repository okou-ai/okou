//! Pure app-server message shapes, validation and bounded protocol diagnostics.

use serde_json::{Value, json};

use super::{CodexAppServerError, JsonRpcError, JsonRpcId, ServerNotification, ServerRequest};

pub(super) enum IncomingMessage {
    Success { id: JsonRpcId, result: Value },
    Error { id: JsonRpcId, error: JsonRpcError },
    Notification(ServerNotification),
    Request(ServerRequest),
}

pub(super) fn outgoing_request(id: &JsonRpcId, method: &str, params: Value) -> Value {
    json!({
        "id": id,
        "method": method,
        "params": params,
    })
}

pub(super) fn outgoing_notification(method: &str, params: Value) -> Value {
    if params.is_null() {
        json!({ "method": method })
    } else {
        json!({
            "method": method,
            "params": params,
        })
    }
}

pub(super) fn parse_incoming_message(line: &str) -> Result<IncomingMessage, CodexAppServerError> {
    let value: Value = serde_json::from_str(line).map_err(|error| {
        CodexAppServerError::Protocol(format!(
            "malformed app-server stdout JSON: {error}; line_bytes={}",
            line.len()
        ))
    })?;
    let Value::Object(mut fields) = value else {
        return Err(missing_id_or_method_error());
    };

    if fields.contains_key("method") {
        if fields.contains_key("result") || fields.contains_key("error") {
            return Err(CodexAppServerError::Protocol(
                "request or notification contains response fields".to_string(),
            ));
        }
        let Some(Value::String(method)) = fields.remove("method") else {
            return Err(CodexAppServerError::Protocol(
                "method must be a string".to_string(),
            ));
        };
        let params = fields.remove("params");
        if let Some(id_value) = fields.remove("id") {
            return Ok(IncomingMessage::Request(ServerRequest {
                id: parse_id(id_value)?,
                method,
                params,
            }));
        }
        return Ok(IncomingMessage::Notification(ServerNotification {
            method,
            params,
        }));
    }

    let Some(id_value) = fields.remove("id") else {
        return Err(missing_id_or_method_error());
    };
    let id = parse_id(id_value)?;

    match (fields.remove("result"), fields.remove("error")) {
        (Some(result), None) => Ok(IncomingMessage::Success { id, result }),
        (None, Some(error)) => Ok(IncomingMessage::Error {
            id,
            error: parse_error_object(error)?,
        }),
        (Some(_), Some(_)) => Err(CodexAppServerError::Protocol(
            "response contains both result and error".to_string(),
        )),
        (None, None) => Err(CodexAppServerError::Protocol(
            "response contains neither result nor error".to_string(),
        )),
    }
}

fn missing_id_or_method_error() -> CodexAppServerError {
    CodexAppServerError::Protocol("message has neither id nor method".to_string())
}

fn parse_id(value: Value) -> Result<JsonRpcId, CodexAppServerError> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .map(JsonRpcId::Number)
            .ok_or_else(invalid_id_error),
        Value::String(value) => Ok(JsonRpcId::String(value)),
        Value::Null => Ok(JsonRpcId::Null),
        _ => Err(invalid_id_error()),
    }
}

fn invalid_id_error() -> CodexAppServerError {
    CodexAppServerError::Protocol(
        "app-server message id must be an integer, string, or null".to_string(),
    )
}

fn parse_error_object(value: Value) -> Result<JsonRpcError, CodexAppServerError> {
    let Value::Object(mut fields) = value else {
        return Err(CodexAppServerError::Protocol(
            "error response must be an object".to_string(),
        ));
    };
    let code = fields
        .remove("code")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| {
            CodexAppServerError::Protocol("error response must contain an integer code".to_string())
        })?;
    let Some(Value::String(message)) = fields.remove("message") else {
        return Err(CodexAppServerError::Protocol(
            "error response must contain a string message".to_string(),
        ));
    };
    Ok(JsonRpcError {
        code,
        message,
        data: fields.remove("data"),
    })
}

pub(super) fn bounded_method_name(method: &str) -> String {
    const MAX_CHARS: usize = 120;
    let mut chars = method.chars();
    let bounded = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}...")
    } else {
        bounded
    }
}

pub(super) fn bounded_error_message(message: &str) -> String {
    const MAX_CHARS: usize = 240;
    let mut chars = message.chars();
    let bounded = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}...")
    } else {
        bounded
    }
}
