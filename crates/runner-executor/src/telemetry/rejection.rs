use serde::Deserialize;

use super::TelemetryPayload;

const MAX_RESPONSE_BYTES: usize = 4096;
const MAX_FIELD_DEPTH: usize = 3;

pub(super) struct TelemetryRejection {
    pub(super) schema_field: String,
    pub(super) operation_index: Option<usize>,
    pub(super) operation: Option<&'static str>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ValidationError,
}

#[derive(Deserialize)]
struct ValidationError {
    code: String,
    message: String,
}

/// Read only bounded validation attribution; response text and payload values
/// never become log fields. The request's timeout also bounds response reads.
pub(super) async fn read(
    mut response: reqwest::Response,
    payload: &TelemetryPayload,
) -> Option<TelemetryRejection> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: ErrorBody = serde_json::from_slice(&bytes).ok()?;
    if body.error.code != "BAD_REQUEST" {
        return None;
    }
    // requestValidationError formats the first issue as '<path>: <message>'.
    // Do not retain the message, even when it looks like a validation error.
    let (path, _) = body.error.message.split_once(": ")?;
    let mut parts = path.split('.');
    let root = parts.next()?;
    if root != "sandboxOperations" {
        let field = match root {
            "runId" => "runId",
            "runnerHostname" => "runnerHostname",
            "runnerVersion" => "runnerVersion",
            _ => return None,
        };
        return parts.next().is_none().then(|| TelemetryRejection {
            schema_field: field.to_owned(),
            operation_index: None,
            operation: None,
        });
    }
    let Some(index) = parts.next() else {
        return Some(TelemetryRejection {
            schema_field: "sandboxOperations".to_owned(),
            operation_index: None,
            operation: None,
        });
    };
    let index: usize = index.parse().ok()?;
    let operation = payload.sandbox_operations.get(index)?;
    let fields: Vec<_> = parts.collect();
    if fields.is_empty() || fields.len() > MAX_FIELD_DEPTH {
        return None;
    }

    // SandboxOp and its flattened fields contain only statically named object
    // members, never user-keyed maps. Match canonical keys from that typed
    // serialization so an untrusted response cannot introduce a private key.
    // Serialize only the affected operation, not the whole rejected batch.
    let serialized = serde_json::to_value(operation).ok()?;
    let mut cursor = &serialized;
    let mut schema_field = String::new();
    for field in fields {
        let (key, value) = cursor.as_object()?.get_key_value(field)?;
        if !schema_field.is_empty() {
            schema_field.push('.');
        }
        schema_field.push_str(key);
        cursor = value;
    }
    Some(TelemetryRejection {
        schema_field,
        operation_index: Some(index),
        operation: match operation.action_type.as_str() {
            "api_to_spawn" => Some("api_to_spawn"),
            "api_to_agent_ready" => Some("api_to_agent_ready"),
            _ => None,
        },
    })
}
