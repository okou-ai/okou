//! Strict schema/category validation for the admitted sandbox application channel.
//! Generated DTOs preserve shapes; this adapter enforces their literal, byte,
//! role and payload semantics before a runtime may dispatch business work.

use api_contracts::generated::constants::sandbox_channel as limits;
use api_contracts::generated::types::sandbox_channel::{diagnostics, fs};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Generated installed-category reply; always enter through [`decode_hello_result`].
pub use api_contracts::generated::types::sandbox_channel::HelloResult;
/// Generated envelope; always enter through [`decode_message`].
pub use api_contracts::generated::types::sandbox_channel::Message;

/// Immutable installed role revisions for one connection epoch.
pub type Categories = BTreeMap<String, u64>;

/// Business message origin, independent of the external bootstrap role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// External admitted client.
    External,
    /// Sandbox Guest.
    Guest,
}

/// Current category operations; later businesses add their own contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// Read one readonly directory page.
    FsList,
    /// Release an owned continuation.
    FsListClose,
    /// Bounded echo in either direction.
    Echo,
    /// External request causing a reverse Guest echo.
    PeerEcho,
}

/// Safe failures with no untrusted body/path/exception text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelError {
    /// Envelope revision differs from the current schema.
    UnsupportedSchema,
    /// Malformed common framing or typed result.
    InvalidRequest,
    /// Invalid category payload.
    InvalidParams,
    /// Required category is absent on either participant.
    UnsupportedCategory,
    /// Exact category revisions do not agree.
    CategoryVersionMismatch,
    /// Uninstalled operation or event name.
    UnknownOperation,
    /// Operation is not allowed from this role.
    Forbidden,
    /// Encoded message or finite data budget exceeded.
    LimitExceeded,
}

impl ChannelError {
    /// Stable bounded code for a business error response.
    pub const fn code(self) -> &'static str {
        match self {
            Self::UnsupportedSchema => "unsupported_schema",
            Self::InvalidRequest => "invalid_request",
            Self::InvalidParams => "invalid_params",
            Self::UnsupportedCategory => "unsupported_category",
            Self::CategoryVersionMismatch => "category_version_mismatch",
            Self::UnknownOperation => "unknown_operation",
            Self::Forbidden => "forbidden",
            Self::LimitExceeded => "limit_exceeded",
        }
    }
}

impl std::fmt::Display for ChannelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}
impl std::error::Error for ChannelError {}

/// Validated category-specific incoming parameters.
#[derive(Debug, PartialEq)]
pub enum Params {
    /// New listing or owned continuation.
    FsList(fs::ListParams),
    /// Owned continuation release.
    FsListClose(fs::ListCloseParams),
    /// Echo or reverse-echo bytes.
    Echo(diagnostics::Echo),
}

/// Validated result associated with the captured outgoing operation.
#[derive(Debug, PartialEq)]
pub enum ResultPayload {
    /// One readonly directory page.
    FsList(fs::ListResult),
    /// Cursor release acknowledgment.
    FsListClose(fs::ListCloseResult),
    /// Bounded echo bytes.
    Echo(diagnostics::Echo),
}

fn count_limit(value: usize, maximum: u32) -> bool {
    u64::try_from(value).is_ok_and(|value| value <= u64::from(maximum))
}
fn object<'a>(
    value: &'a Value,
    allowed: &[&str],
    required: &[&str],
) -> Result<&'a Map<String, Value>, ChannelError> {
    let map = value.as_object().ok_or(ChannelError::InvalidRequest)?;
    if map.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !map.contains_key(*key))
    {
        return Err(ChannelError::InvalidRequest);
    }
    Ok(map)
}
fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, ChannelError> {
    map.get(key)
        .and_then(Value::as_str)
        .ok_or(ChannelError::InvalidRequest)
}
fn name(value: &str, maximum: u32, dotted: bool) -> bool {
    !value.is_empty()
        && count_limit(value.len(), maximum)
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'_' | b'-')
                || (dotted && byte == b'.')
        })
}
fn id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|uuid| {
        uuid.get_version_num() == 4
            && uuid.get_variant() == uuid::Variant::RFC4122
            && uuid.to_string() == value
    })
}
fn version(value: &Value) -> Result<u64, ChannelError> {
    if let Some(integer) = value.as_u64() {
        if integer > 0 && integer <= u64::from(limits::MAX_CATEGORY_VERSION) {
            return Ok(integer);
        }
    } else if let Some(number) = value.as_f64()
        && number >= 1.0
        && number <= f64::from(limits::MAX_CATEGORY_VERSION)
        && number.fract() == 0.0
    {
        // JSON 1, 1.0 and 1e0 have the same mathematical integer semantics.
        return number
            .to_string()
            .parse()
            .map_err(|_| ChannelError::InvalidRequest);
    }
    Err(ChannelError::InvalidRequest)
}
fn normalize_version(map: &mut Map<String, Value>, key: &str) -> Result<u64, ChannelError> {
    let value = version(map.get(key).ok_or(ChannelError::InvalidRequest)?)?;
    map.insert(key.to_owned(), Value::from(value));
    Ok(value)
}
fn normalize_categories(value: &mut Value) -> Result<(), ChannelError> {
    let map = value.as_object_mut().ok_or(ChannelError::InvalidRequest)?;
    if !count_limit(map.len(), limits::MAX_CATEGORIES) {
        return Err(ChannelError::InvalidRequest);
    }
    for (key, value) in map {
        if !name(key, limits::MAX_CATEGORY_NAME_BYTES, false) {
            return Err(ChannelError::InvalidRequest);
        }
        *value = Value::from(version(value)?);
    }
    Ok(())
}
fn depth(value: &Value, level: u32) -> Result<(), ChannelError> {
    if level > limits::MAX_JSON_DEPTH {
        return Err(ChannelError::LimitExceeded);
    }
    match value {
        Value::Array(items) => {
            for item in items {
                depth(item, level + 1)?;
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                if key == "__proto__" {
                    return Err(ChannelError::InvalidRequest);
                }
                depth(item, level + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Bounded UTF-8 decode with header/schema checks before current DTO decoding.
/// Result presence is preserved even for an explicit JSON null success.
pub fn decode_message(bytes: &[u8]) -> Result<Message, ChannelError> {
    if !count_limit(bytes.len(), limits::MAX_FRAME_BYTES) {
        return Err(ChannelError::LimitExceeded);
    }
    let mut value: Value =
        serde_json::from_slice(bytes).map_err(|_| ChannelError::InvalidRequest)?;
    depth(&value, 0)?;
    let root = value.as_object_mut().ok_or(ChannelError::InvalidRequest)?;
    if normalize_version(root, "schemaVersion")? != u64::from(limits::SCHEMA_VERSION) {
        return Err(ChannelError::UnsupportedSchema);
    }
    if !id(string(root, "id")?) {
        return Err(ChannelError::InvalidRequest);
    }
    let kind = string(root, "type")?.to_owned();
    let explicit_null = kind == "response" && root.get("result") == Some(&Value::Null);
    match kind.as_str() {
        "hello" => {
            object(
                &value,
                &["schemaVersion", "type", "id", "categories"],
                &["categories"],
            )?;
            normalize_categories(
                value
                    .get_mut("categories")
                    .ok_or(ChannelError::InvalidRequest)?,
            )?;
        }
        "request" | "event" => {
            let (action, payload) = if kind == "request" {
                ("operation", "params")
            } else {
                ("event", "data")
            };
            object(
                &value,
                &[
                    "schemaVersion",
                    "type",
                    "id",
                    "category",
                    "categoryVersion",
                    action,
                    payload,
                ],
                &["category", "categoryVersion", action, payload],
            )?;
            let map = value.as_object_mut().ok_or(ChannelError::InvalidRequest)?;
            if !name(
                string(map, "category")?,
                limits::MAX_CATEGORY_NAME_BYTES,
                false,
            ) || !name(string(map, action)?, 64, true)
                || !map.get(payload).is_some_and(Value::is_object)
            {
                return Err(ChannelError::InvalidRequest);
            }
            normalize_version(map, "categoryVersion")?;
        }
        "response" => {
            let map = object(
                &value,
                &[
                    "schemaVersion",
                    "type",
                    "id",
                    "requestId",
                    "result",
                    "error",
                ],
                &["requestId"],
            )?;
            if !id(string(map, "requestId")?)
                || map.contains_key("result") == map.contains_key("error")
            {
                return Err(ChannelError::InvalidRequest);
            }
            if let Some(error) = value.get_mut("error") {
                let fields = object(
                    error,
                    &["code", "category", "expectedVersion", "receivedVersion"],
                    &["code"],
                )?;
                let code = string(fields, "code")?;
                if code.is_empty()
                    || code.len() > 64
                    || !code
                        .bytes()
                        .next()
                        .is_some_and(|byte| byte.is_ascii_lowercase())
                    || !code.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                {
                    return Err(ChannelError::InvalidRequest);
                }
                if let Some(category) = fields.get("category")
                    && !category.as_str().is_some_and(|name_value| {
                        name(name_value, limits::MAX_CATEGORY_NAME_BYTES, false)
                    })
                {
                    return Err(ChannelError::InvalidRequest);
                }
                let fields = error.as_object_mut().ok_or(ChannelError::InvalidRequest)?;
                for key in ["expectedVersion", "receivedVersion"] {
                    if fields.contains_key(key) {
                        normalize_version(fields, key)?;
                    }
                }
            }
        }
        _ => return Err(ChannelError::InvalidRequest),
    }
    let mut message: Message =
        serde_json::from_value(value).map_err(|_| ChannelError::InvalidRequest)?;
    if explicit_null && let Message::Response { result, .. } = &mut message {
        *result = Some(Value::Null);
    }
    Ok(message)
}

/// Validate an installed-category reply, including its exact closed shape.
pub fn decode_hello_result(mut value: Value) -> Result<HelloResult, ChannelError> {
    object(&value, &["categories"], &["categories"])?;
    normalize_categories(
        value
            .get_mut("categories")
            .ok_or(ChannelError::InvalidRequest)?,
    )?;
    serde_json::from_value(value).map_err(|_| ChannelError::InvalidRequest)
}

/// Ordered category presence/version gate shared by requests and events.
pub fn category_gate(
    category: &str,
    received: u64,
    local: &Categories,
    peer: &Categories,
) -> Result<(), ChannelError> {
    let local_version = local
        .get(category)
        .ok_or(ChannelError::UnsupportedCategory)?;
    let peer_version = peer
        .get(category)
        .ok_or(ChannelError::UnsupportedCategory)?;
    if *local_version != received || *peer_version != received {
        return Err(ChannelError::CategoryVersionMismatch);
    }
    Ok(())
}

/// Resolve a known operation after exact category/version checks and before IO.
pub fn operation_contract(
    category: &str,
    category_version: u64,
    operation: &str,
    origin: Role,
    local: &Categories,
    peer: &Categories,
) -> Result<Operation, ChannelError> {
    category_gate(category, category_version, local, peer)?;
    let selected = match (category, category_version, operation) {
        ("fs", version, "list") if version == u64::from(limits::fs::VERSION) => Operation::FsList,
        ("fs", version, "list.close") if version == u64::from(limits::fs::VERSION) => {
            Operation::FsListClose
        }
        ("diagnostics", version, "echo") if version == u64::from(limits::diagnostics::VERSION) => {
            Operation::Echo
        }
        ("diagnostics", version, "peer.echo")
            if version == u64::from(limits::diagnostics::VERSION) =>
        {
            Operation::PeerEcho
        }
        _ => return Err(ChannelError::UnknownOperation),
    };
    if origin == Role::Guest && selected != Operation::Echo {
        return Err(ChannelError::Forbidden);
    }
    Ok(selected)
}

fn handle(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
fn basename(value: &str) -> Result<Vec<u8>, ChannelError> {
    if value.len() > 340 || value.is_empty() {
        return Err(ChannelError::InvalidParams);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ChannelError::InvalidParams)?;
    if !count_limit(bytes.len(), limits::fs::MAX_NAME_BYTES)
        || bytes.is_empty()
        || bytes == b"."
        || bytes == b".."
        || bytes.contains(&b'/')
        || bytes.contains(&0)
        || URL_SAFE_NO_PAD.encode(&bytes) != value
    {
        return Err(ChannelError::InvalidParams);
    }
    Ok(bytes)
}
fn echo(value: Value) -> Result<diagnostics::Echo, ChannelError> {
    object(&value, &["payload"], &["payload"]).map_err(|_| ChannelError::InvalidParams)?;
    let parsed: diagnostics::Echo =
        serde_json::from_value(value).map_err(|_| ChannelError::InvalidParams)?;
    if !count_limit(
        parsed.payload.len(),
        4 * limits::diagnostics::MAX_BYTES.div_ceil(3),
    ) {
        return Err(ChannelError::InvalidParams);
    }
    let decoded = STANDARD
        .decode(&parsed.payload)
        .map_err(|_| ChannelError::InvalidParams)?;
    if !count_limit(decoded.len(), limits::diagnostics::MAX_BYTES)
        || STANDARD.encode(&decoded) != parsed.payload
    {
        return Err(ChannelError::InvalidParams);
    }
    Ok(parsed)
}

/// Consume and validate an operation's closed, typed params after routing gates.
pub fn decode_params(operation: Operation, value: Value) -> Result<Params, ChannelError> {
    match operation {
        Operation::FsList => {
            let fields = object(&value, &["path", "cursor"], &[])
                .map_err(|_| ChannelError::InvalidParams)?;
            if fields.contains_key("path") == fields.contains_key("cursor")
                || fields.values().any(Value::is_null)
            {
                return Err(ChannelError::InvalidParams);
            }
            let parsed: fs::ListParams =
                serde_json::from_value(value).map_err(|_| ChannelError::InvalidParams)?;
            if let Some(path) = &parsed.path {
                if !count_limit(path.len(), limits::fs::MAX_PATH_COMPONENTS) {
                    return Err(ChannelError::InvalidParams);
                }
                let mut bytes = path.len().saturating_sub(1);
                for token in path {
                    bytes += basename(token)?.len();
                }
                if !count_limit(bytes, limits::fs::MAX_PATH_BYTES) {
                    return Err(ChannelError::InvalidParams);
                }
            }
            if parsed
                .cursor
                .as_deref()
                .is_some_and(|cursor| !handle(cursor))
            {
                return Err(ChannelError::InvalidParams);
            }
            Ok(Params::FsList(parsed))
        }
        Operation::FsListClose => {
            object(&value, &["cursor"], &["cursor"]).map_err(|_| ChannelError::InvalidParams)?;
            let parsed: fs::ListCloseParams =
                serde_json::from_value(value).map_err(|_| ChannelError::InvalidParams)?;
            if !handle(&parsed.cursor) {
                return Err(ChannelError::InvalidParams);
            }
            Ok(Params::FsListClose(parsed))
        }
        Operation::Echo | Operation::PeerEcho => Ok(Params::Echo(echo(value)?)),
    }
}

/// Consume a result under the captured outgoing operation, never response.id.
pub fn decode_result(operation: Operation, value: Value) -> Result<ResultPayload, ChannelError> {
    match operation {
        Operation::FsList => {
            let payload_bytes = serde_json::to_vec(&value)
                .map_err(|_| ChannelError::InvalidRequest)?
                .len();
            let overhead = usize::try_from(limits::RESPONSE_OVERHEAD_BYTES)
                .map_err(|_| ChannelError::InvalidRequest)?;
            if !count_limit(
                payload_bytes.saturating_add(overhead),
                limits::fs::MAX_RESPONSE_BYTES,
            ) {
                return Err(ChannelError::InvalidRequest);
            }
            let fields = object(
                &value,
                &["listingId", "entries", "nextCursor"],
                &["listingId", "entries", "nextCursor"],
            )?;
            let entries = fields
                .get("entries")
                .and_then(Value::as_array)
                .ok_or(ChannelError::InvalidRequest)?;
            if !count_limit(entries.len(), limits::fs::MAX_ENTRIES) {
                return Err(ChannelError::InvalidRequest);
            }
            for entry in entries {
                object(
                    entry,
                    &["nameToken", "displayName", "kind"],
                    &["nameToken", "displayName", "kind"],
                )?;
            }
            let parsed: fs::ListResult =
                serde_json::from_value(value).map_err(|_| ChannelError::InvalidRequest)?;
            if !handle(&parsed.listing_id)
                || parsed
                    .next_cursor
                    .as_deref()
                    .is_some_and(|cursor| !handle(cursor))
            {
                return Err(ChannelError::InvalidRequest);
            }
            for entry in &parsed.entries {
                basename(&entry.name_token).map_err(|_| ChannelError::InvalidRequest)?;
                if entry.display_name.is_empty()
                    || !count_limit(entry.display_name.len(), limits::fs::MAX_DISPLAY_NAME_BYTES)
                    || entry.display_name.chars().any(char::is_control)
                {
                    return Err(ChannelError::InvalidRequest);
                }
            }
            Ok(ResultPayload::FsList(parsed))
        }
        Operation::FsListClose => {
            object(&value, &[], &[])?;
            let parsed = serde_json::from_value(value).map_err(|_| ChannelError::InvalidRequest)?;
            Ok(ResultPayload::FsListClose(parsed))
        }
        Operation::Echo | Operation::PeerEcho => Ok(ResultPayload::Echo(
            echo(value).map_err(|_| ChannelError::InvalidRequest)?,
        )),
    }
}

/// Validate the current one-way notice contract without producing a reply.
pub fn decode_notice(
    category: &str,
    category_version: u64,
    event: &str,
    value: Value,
    local: &Categories,
    peer: &Categories,
) -> Result<diagnostics::Notice, ChannelError> {
    category_gate(category, category_version, local, peer)?;
    if category != "diagnostics"
        || category_version != u64::from(limits::diagnostics::VERSION)
        || event != "notice"
    {
        return Err(ChannelError::UnknownOperation);
    }
    object(&value, &["message"], &["message"]).map_err(|_| ChannelError::InvalidParams)?;
    let parsed: diagnostics::Notice =
        serde_json::from_value(value).map_err(|_| ChannelError::InvalidParams)?;
    if parsed.message.is_empty() || parsed.message.encode_utf16().count() > 256 {
        return Err(ChannelError::InvalidParams);
    }
    Ok(parsed)
}
