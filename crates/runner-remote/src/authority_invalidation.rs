//! Shared strict envelope for SSH and VNC authority invalidation events.

use runner_types::ids::RunId;
use serde_json::Value;
use uuid::Uuid;

pub(crate) struct Notification {
    pub(crate) run: RunId,
    pub(crate) connection: Option<Uuid>,
}

pub(crate) fn parse(data: &Value) -> Option<Notification> {
    let data = data.as_object()?;
    if data.len() != 2 {
        return None;
    }
    let run = data.get("runId")?.as_str()?.parse().ok()?;
    // Only an explicit null in the exact event envelope selects the whole Run.
    let connection = match data.get("connectionId")? {
        Value::Null => None,
        Value::String(value) => Some(value.parse().ok()?),
        _ => return None,
    };
    Some(Notification { run, connection })
}
