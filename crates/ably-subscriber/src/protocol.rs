//! Ably wire protocol types, constants, and MessagePack encode/decode.

use std::collections::HashMap;
use std::fmt;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::Error;
use crate::types::{REDACTED_DEBUG_VALUE, redact_auth_query_params};

// ---------------------------------------------------------------------------
// Protocol action constants
// ---------------------------------------------------------------------------

pub mod action {
    pub const HEARTBEAT: i32 = 0;
    pub const CONNECTED: i32 = 4;
    pub const DISCONNECTED: i32 = 6;
    pub const CLOSE: i32 = 7;
    pub const CLOSED: i32 = 8;
    pub const ERROR: i32 = 9;
    pub const ATTACH: i32 = 10;
    pub const ATTACHED: i32 = 11;
    pub const DETACHED: i32 = 13;
    pub const MESSAGE: i32 = 15;
    pub const AUTH: i32 = 17;
    pub const PING: i32 = 22;
    pub const PONG: i32 = 23;
}

pub mod error_code {
    pub const TOKEN_EXPIRED: i32 = 40142;
    pub const FAILED: i32 = 80000;
    pub const TIMEOUT: i32 = 80014;
    pub const CHANNEL_OPERATION_FAILED: i32 = 90000;
    pub const BAD_REQUEST: i32 = 40000;

    pub(crate) fn is_token_error(code: i32) -> bool {
        (40140..40150).contains(&code)
    }
}

pub mod flags {
    // Ably protocol flag constants (complete set for ATTACHED responses).
    // Only ATTACH_RESUME and MODE_SUBSCRIBE are used for sending; the
    // others are kept for decoding server responses.
    pub const HAS_PRESENCE: i32 = 1;
    pub const HAS_BACKLOG: i32 = 2;
    pub const HAS_CHANNEL_RESUMED: i32 = 4;
    pub const ATTACH_RESUME: i32 = 1 << 5; // 32
    pub const MODE_SUBSCRIBE: i32 = 262_144; // bit 18
}

// ---------------------------------------------------------------------------
// Wire protocol types (MessagePack)
// ---------------------------------------------------------------------------

// NOTE: We intentionally omit `skip_serializing_if = "Option::is_none"` on
// these structs. rmp_serde has a long-standing bug where skipped Option fields
// cause deserialization failures: https://github.com/3Hren/msgpack-rust/issues/86
/// Low-level representation of an Ably MessagePack protocol message.
///
/// Inbound frame compatibility is defined by [`decode_msg`]. Subscription
/// consumers observe [`crate::Event`] values; message events carry
/// [`crate::Message`] instead of this wire representation.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ProtocolMessage {
    pub action: i32,
    pub id: Option<String>,
    pub channel: Option<String>,
    pub channel_serial: Option<String>,
    pub connection_id: Option<String>,
    pub connection_key: Option<String>,
    pub connection_details: Option<ConnectionDetails>,
    /// Deprecated in protocol v3+; retained for wire compatibility with older servers.
    pub connection_serial: Option<i64>,
    pub msg_serial: Option<i64>,
    pub flags: Option<i32>,
    pub error: Option<ErrorInfo>,
    pub auth: Option<AuthDetails>,
    pub messages: Option<Vec<AblyMessage>>,
    pub timestamp: Option<i64>,
    pub params: Option<HashMap<String, String>>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionDetails {
    pub client_id: Option<String>,
    pub connection_key: Option<String>,
    pub connection_state_ttl: Option<i64>,
    pub max_idle_interval: Option<i64>,
    pub max_message_size: Option<i64>,
    pub max_frame_size: Option<i64>,
    pub server_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ErrorInfo {
    pub code: i32,
    pub status_code: Option<i32>,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AuthDetails {
    pub access_token: String,
}

impl fmt::Debug for ProtocolMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProtocolMessage")
            .field("action", &self.action)
            .field("id", &self.id)
            .field("channel", &self.channel)
            .field("channel_serial", &self.channel_serial)
            .field("connection_id", &self.connection_id)
            .field(
                "connection_key",
                &self.connection_key.as_ref().map(|_| REDACTED_DEBUG_VALUE),
            )
            .field("connection_details", &self.connection_details)
            .field("connection_serial", &self.connection_serial)
            .field("msg_serial", &self.msg_serial)
            .field("flags", &self.flags)
            .field("error", &self.error)
            .field("auth", &self.auth)
            .field("messages", &self.messages)
            .field("timestamp", &self.timestamp)
            .field("params", &self.params)
            .finish()
    }
}

impl fmt::Debug for ConnectionDetails {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionDetails")
            .field("client_id", &self.client_id)
            .field(
                "connection_key",
                &self.connection_key.as_ref().map(|_| REDACTED_DEBUG_VALUE),
            )
            .field("connection_state_ttl", &self.connection_state_ttl)
            .field("max_idle_interval", &self.max_idle_interval)
            .field("max_message_size", &self.max_message_size)
            .field("max_frame_size", &self.max_frame_size)
            .field("server_id", &self.server_id)
            .finish()
    }
}

impl fmt::Debug for ErrorInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ErrorInfo")
            .field("code", &self.code)
            .field("status_code", &self.status_code)
            .field("message", &redact_auth_query_params(&self.message))
            .finish()
    }
}

impl fmt::Debug for AuthDetails {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthDetails")
            .field("access_token", &REDACTED_DEBUG_VALUE)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AblyMessage {
    pub id: Option<String>,
    pub name: Option<String>,
    /// MessagePack payload normalized to JSON by [`decode_msg`].
    ///
    /// A missing, `nil`, or non-finite root value is `None`. See [`decode_msg`]
    /// for the complete recursive conversion contract.
    pub data: Option<serde_json::Value>,
    pub client_id: Option<String>,
    pub timestamp: Option<i64>,
    pub encoding: Option<String>,
}

// ---------------------------------------------------------------------------
// Encode / decode helpers
// ---------------------------------------------------------------------------

type MsgpackMap = Vec<(rmpv::Value, rmpv::Value)>;

// rmpv's default depth can exhaust a normal Rust thread stack before returning an error.
// This still permits roughly 128 nested containers, matching serde_json's default limit.
const MAX_MSGPACK_DECODE_DEPTH: usize = 256;

pub fn encode_msg(msg: &ProtocolMessage) -> Result<Vec<u8>, Error> {
    Ok(rmp_serde::to_vec_named(msg)?)
}

/// Decode one Ably MessagePack protocol frame.
///
/// This is the authoritative inbound compatibility contract for
/// [`ProtocolMessage`] and [`AblyMessage::data`]. This module contains
/// low-level wire types; subscription consumers observe [`crate::Event`]
/// values, with message events carrying [`crate::Message`].
///
/// # Frame contract
///
/// The input must contain exactly one bounded-depth MessagePack value that
/// consumes the full frame. Its root must be a map with an `action` integer
/// representable as an `i32`. Unknown numeric actions remain valid for forward
/// compatibility.
///
/// Known protocol fields, their known nested fields, and converted `params`
/// keys use last-wins semantics when repeated. Unknown protocol fields are
/// ignored.
///
/// # Message data normalization
///
/// A missing, `nil`, or non-finite root [`AblyMessage::data`] value becomes
/// `None`. Other values are converted recursively to JSON:
///
/// - MessagePack `nil` and non-finite values nested inside data become JSON
///   `null`.
/// - Booleans, integers, finite floats, and valid UTF-8 strings become their
///   corresponding JSON values.
/// - Binary and extension payload bytes become standard-base64 JSON strings;
///   an extension's type tag is not retained.
/// - Invalid UTF-8 strings and map keys become empty strings.
/// - Arrays become JSON arrays. Maps become JSON objects, with non-string keys
///   formatted as strings and duplicate converted keys using last-wins
///   semantics.
///
/// Channel delivery replaces a missing low-level data value with JSON `null`
/// and then applies supported Ably `encoding` layers; see
/// [`crate::Message::data`].
///
/// # Errors
///
/// Malformed MessagePack, excessive nesting, trailing bytes, an invalid root,
/// a missing `action`, and invalid field shapes or numeric ranges return
/// [`Error::Protocol`] with [`error_code::BAD_REQUEST`]. Diagnostic text is not
/// part of this compatibility contract.
pub fn decode_msg(data: &[u8]) -> Result<ProtocolMessage, Error> {
    let mut cursor = std::io::Cursor::new(data);
    let value = rmpv::decode::read_value_with_max_depth(&mut cursor, MAX_MSGPACK_DECODE_DEPTH)
        .map_err(|e| Error::Protocol {
            code: error_code::BAD_REQUEST,
            message: format!("msgpack decode error: {e}"),
        })?;
    if cursor.position() != data.len() as u64 {
        return Err(Error::Protocol {
            code: error_code::BAD_REQUEST,
            message: "msgpack frame has trailing bytes".to_string(),
        });
    }

    let map = match value {
        rmpv::Value::Map(map) => map,
        _ => {
            return Err(Error::Protocol {
                code: error_code::BAD_REQUEST,
                message: "protocol message must be a map".to_string(),
            });
        }
    };

    decode_protocol_message(map)
}

// Inbound decoding intentionally does not use direct rmp_serde struct
// deserialization. Ably can send duplicate MessagePack map keys, and serde
// rejects duplicate struct fields. The old decoder used a full
// MessagePack -> JSON -> ProtocolMessage round trip because serde_json object
// collection gave us last-wins duplicate-key behavior while rmpv handled
// MessagePack binary/ext values. This decoder keeps those compatibility
// semantics without materializing a JSON tree for the whole protocol message:
// known protocol fields are collected in wire order, and only AblyMessage.data
// is converted to JSON because that field is exposed as serde_json::Value.
fn decode_protocol_message(map: MsgpackMap) -> Result<ProtocolMessage, Error> {
    let mut action = None;
    let mut id = None;
    let mut channel = None;
    let mut channel_serial = None;
    let mut connection_id = None;
    let mut connection_key = None;
    let mut connection_details = None;
    let mut connection_serial = None;
    let mut msg_serial = None;
    let mut flags = None;
    let mut error = None;
    let mut auth = None;
    let mut messages = None;
    let mut timestamp = None;
    let mut params = None;

    for (key, value) in map {
        match msgpack_key_name(&key) {
            Some("action") => action = Some(value),
            Some("id") => id = Some(value),
            Some("channel") => channel = Some(value),
            Some("channelSerial") => channel_serial = Some(value),
            Some("connectionId") => connection_id = Some(value),
            Some("connectionKey") => connection_key = Some(value),
            Some("connectionDetails") => connection_details = Some(value),
            Some("connectionSerial") => connection_serial = Some(value),
            Some("msgSerial") => msg_serial = Some(value),
            Some("flags") => flags = Some(value),
            Some("error") => error = Some(value),
            Some("auth") => auth = Some(value),
            Some("messages") => messages = Some(value),
            Some("timestamp") => timestamp = Some(value),
            Some("params") => params = Some(value),
            _ => {}
        }
    }

    let Some(action) = action else {
        return Err(Error::Protocol {
            code: error_code::BAD_REQUEST,
            message: "protocol message missing action".to_string(),
        });
    };

    Ok(ProtocolMessage {
        action: required_i32("action", action)?,
        id: optional_string("id", id)?,
        channel: optional_string("channel", channel)?,
        channel_serial: optional_string("channelSerial", channel_serial)?,
        connection_id: optional_string("connectionId", connection_id)?,
        connection_key: optional_string("connectionKey", connection_key)?,
        connection_details: optional_map(
            "connectionDetails",
            connection_details,
            decode_connection_details,
        )?,
        connection_serial: optional_i64("connectionSerial", connection_serial)?,
        msg_serial: optional_i64("msgSerial", msg_serial)?,
        flags: optional_i32("flags", flags)?,
        error: optional_map("error", error, decode_error_info)?,
        auth: optional_map("auth", auth, decode_auth_details)?,
        messages: optional_messages(messages)?,
        timestamp: optional_i64("timestamp", timestamp)?,
        params: optional_params(params)?,
    })
}

fn decode_connection_details(map: MsgpackMap) -> Result<ConnectionDetails, Error> {
    let mut client_id = None;
    let mut connection_key = None;
    let mut connection_state_ttl = None;
    let mut max_idle_interval = None;
    let mut max_message_size = None;
    let mut max_frame_size = None;
    let mut server_id = None;

    for (key, value) in map {
        match msgpack_key_name(&key) {
            Some("clientId") => client_id = Some(value),
            Some("connectionKey") => connection_key = Some(value),
            Some("connectionStateTtl") => connection_state_ttl = Some(value),
            Some("maxIdleInterval") => max_idle_interval = Some(value),
            Some("maxMessageSize") => max_message_size = Some(value),
            Some("maxFrameSize") => max_frame_size = Some(value),
            Some("serverId") => server_id = Some(value),
            _ => {}
        }
    }

    Ok(ConnectionDetails {
        client_id: optional_string("connectionDetails.clientId", client_id)?,
        connection_key: optional_string("connectionDetails.connectionKey", connection_key)?,
        connection_state_ttl: optional_i64(
            "connectionDetails.connectionStateTtl",
            connection_state_ttl,
        )?,
        max_idle_interval: optional_i64("connectionDetails.maxIdleInterval", max_idle_interval)?,
        max_message_size: optional_i64("connectionDetails.maxMessageSize", max_message_size)?,
        max_frame_size: optional_i64("connectionDetails.maxFrameSize", max_frame_size)?,
        server_id: optional_string("connectionDetails.serverId", server_id)?,
    })
}

fn decode_error_info(map: MsgpackMap) -> Result<ErrorInfo, Error> {
    let mut code = None;
    let mut status_code = None;
    let mut message = None;

    for (key, value) in map {
        match msgpack_key_name(&key) {
            Some("code") => code = Some(value),
            Some("statusCode") => status_code = Some(value),
            Some("message") => message = Some(value),
            _ => {}
        }
    }

    Ok(ErrorInfo {
        code: required_i32_or_default("error.code", code)?,
        status_code: optional_i32("error.statusCode", status_code)?,
        message: required_string_or_default("error.message", message)?,
    })
}

fn decode_auth_details(map: MsgpackMap) -> Result<AuthDetails, Error> {
    let mut access_token = None;

    for (key, value) in map {
        if msgpack_key_name(&key) == Some("accessToken") {
            access_token = Some(value);
        }
    }

    Ok(AuthDetails {
        access_token: required_string_or_default("auth.accessToken", access_token)?,
    })
}

fn decode_ably_message(map: MsgpackMap) -> Result<AblyMessage, Error> {
    let mut id = None;
    let mut name = None;
    let mut data = None;
    let mut client_id = None;
    let mut timestamp = None;
    let mut encoding = None;

    for (key, value) in map {
        match msgpack_key_name(&key) {
            Some("id") => id = Some(value),
            Some("name") => name = Some(value),
            Some("data") => data = Some(value),
            Some("clientId") => client_id = Some(value),
            Some("timestamp") => timestamp = Some(value),
            Some("encoding") => encoding = Some(value),
            _ => {}
        }
    }

    Ok(AblyMessage {
        id: optional_string("messages[].id", id)?,
        name: optional_string("messages[].name", name)?,
        data: optional_json(data),
        client_id: optional_string("messages[].clientId", client_id)?,
        timestamp: optional_i64("messages[].timestamp", timestamp)?,
        encoding: optional_string("messages[].encoding", encoding)?,
    })
}

fn optional_messages(value: Option<rmpv::Value>) -> Result<Option<Vec<AblyMessage>>, Error> {
    match value {
        None => Ok(None),
        Some(value) if is_json_null_equivalent(&value) => Ok(None),
        Some(rmpv::Value::Array(messages)) => messages
            .into_iter()
            .map(|message| match message {
                rmpv::Value::Map(map) => decode_ably_message(map),
                other => Err(type_error("messages[]", "map", &other)),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(other) => Err(type_error("messages", "array", &other)),
    }
}

fn optional_params(value: Option<rmpv::Value>) -> Result<Option<HashMap<String, String>>, Error> {
    match value {
        None => Ok(None),
        Some(value) if is_json_null_equivalent(&value) => Ok(None),
        Some(rmpv::Value::Map(map)) => {
            let mut raw_values = HashMap::new();
            for (key, value) in map {
                raw_values.insert(json_map_key(key), value);
            }

            raw_values
                .into_iter()
                .map(|(key, value)| {
                    required_string("params value", value).map(|value| (key, value))
                })
                .collect::<Result<HashMap<_, _>, _>>()
                .map(Some)
        }
        Some(other) => Err(type_error("params", "map", &other)),
    }
}

fn optional_map<T>(
    field: &'static str,
    value: Option<rmpv::Value>,
    decode: fn(MsgpackMap) -> Result<T, Error>,
) -> Result<Option<T>, Error> {
    match value {
        None => Ok(None),
        Some(value) if is_json_null_equivalent(&value) => Ok(None),
        Some(rmpv::Value::Map(map)) => decode(map).map(Some),
        Some(other) => Err(type_error(field, "map", &other)),
    }
}

fn optional_json(value: Option<rmpv::Value>) -> Option<serde_json::Value> {
    match value {
        None => None,
        Some(value) if is_json_null_equivalent(&value) => None,
        Some(value) => Some(rmpv_to_json(value)),
    }
}

fn optional_string(
    field: &'static str,
    value: Option<rmpv::Value>,
) -> Result<Option<String>, Error> {
    match value {
        None => Ok(None),
        Some(value) if is_json_null_equivalent(&value) => Ok(None),
        Some(value) => required_string(field, value).map(Some),
    }
}

fn required_string_or_default(
    field: &'static str,
    value: Option<rmpv::Value>,
) -> Result<String, Error> {
    match value {
        None => Ok(String::new()),
        Some(value) => required_string(field, value),
    }
}

fn required_string(field: &'static str, value: rmpv::Value) -> Result<String, Error> {
    match value {
        rmpv::Value::String(s) => match s.into_str() {
            Some(s) => Ok(s),
            None => {
                tracing::warn!("msgpack string contains invalid UTF-8, substituting empty string");
                Ok(String::new())
            }
        },
        rmpv::Value::Binary(bytes) | rmpv::Value::Ext(_, bytes) => {
            Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
        }
        other => Err(type_error(field, "string", &other)),
    }
}

fn optional_i32(field: &'static str, value: Option<rmpv::Value>) -> Result<Option<i32>, Error> {
    match value {
        None => Ok(None),
        Some(value) if is_json_null_equivalent(&value) => Ok(None),
        Some(value) => required_i32(field, value).map(Some),
    }
}

fn required_i32_or_default(field: &'static str, value: Option<rmpv::Value>) -> Result<i32, Error> {
    match value {
        None => Ok(0),
        Some(value) => required_i32(field, value),
    }
}

fn required_i32(field: &'static str, value: rmpv::Value) -> Result<i32, Error> {
    match value {
        rmpv::Value::Integer(i) => {
            if let Some(n) = i.as_i64() {
                i32::try_from(n).map_err(|_| type_error(field, "i32", &rmpv::Value::Integer(i)))
            } else if let Some(n) = i.as_u64() {
                i32::try_from(n).map_err(|_| type_error(field, "i32", &rmpv::Value::Integer(i)))
            } else {
                Err(type_error(field, "i32", &rmpv::Value::Integer(i)))
            }
        }
        other => Err(type_error(field, "i32", &other)),
    }
}

fn optional_i64(field: &'static str, value: Option<rmpv::Value>) -> Result<Option<i64>, Error> {
    match value {
        None => Ok(None),
        Some(value) if is_json_null_equivalent(&value) => Ok(None),
        Some(value) => required_i64(field, value).map(Some),
    }
}

fn required_i64(field: &'static str, value: rmpv::Value) -> Result<i64, Error> {
    match value {
        rmpv::Value::Integer(i) => {
            if let Some(n) = i.as_i64() {
                Ok(n)
            } else if let Some(n) = i.as_u64() {
                i64::try_from(n).map_err(|_| type_error(field, "i64", &rmpv::Value::Integer(i)))
            } else {
                Err(type_error(field, "i64", &rmpv::Value::Integer(i)))
            }
        }
        other => Err(type_error(field, "i64", &other)),
    }
}

fn msgpack_key_name(key: &rmpv::Value) -> Option<&str> {
    match key {
        rmpv::Value::String(key) => key.as_str(),
        _ => None,
    }
}

fn json_map_key(key: rmpv::Value) -> String {
    match key {
        rmpv::Value::String(s) => match s.into_str() {
            Some(s) => s,
            None => {
                tracing::warn!("msgpack map key contains invalid UTF-8, substituting empty string");
                String::new()
            }
        },
        other => format!("{other}"),
    }
}

fn is_json_null_equivalent(value: &rmpv::Value) -> bool {
    match value {
        rmpv::Value::Nil => true,
        rmpv::Value::F32(value) => !value.is_finite(),
        rmpv::Value::F64(value) => !value.is_finite(),
        _ => false,
    }
}

fn type_error(field: &'static str, expected: &'static str, actual: &rmpv::Value) -> Error {
    Error::Protocol {
        code: error_code::BAD_REQUEST,
        message: format!(
            "message decode error: field {field} expected {expected}, got {}",
            value_kind(actual)
        ),
    }
}

fn value_kind(value: &rmpv::Value) -> &'static str {
    match value {
        rmpv::Value::Nil => "nil",
        rmpv::Value::Boolean(_) => "boolean",
        rmpv::Value::Integer(_) => "integer",
        rmpv::Value::F32(_) | rmpv::Value::F64(_) => "float",
        rmpv::Value::String(_) => "string",
        rmpv::Value::Binary(_) => "binary",
        rmpv::Value::Array(_) => "array",
        rmpv::Value::Map(_) => "map",
        rmpv::Value::Ext(_, _) => "ext",
    }
}

/// Convert a MessagePack value to JSON, encoding binary data as base64 strings.
fn rmpv_to_json(value: rmpv::Value) -> serde_json::Value {
    match value {
        rmpv::Value::Nil => serde_json::Value::Null,
        rmpv::Value::Boolean(b) => serde_json::Value::Bool(b),
        rmpv::Value::Integer(i) => {
            if let Some(n) = i.as_i64() {
                serde_json::Value::Number(n.into())
            } else if let Some(n) = i.as_u64() {
                serde_json::Value::Number(n.into())
            } else {
                serde_json::Value::Null
            }
        }
        rmpv::Value::F32(f) => serde_json::Number::from_f64(f64::from(f))
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        rmpv::Value::F64(f) => serde_json::Number::from_f64(f)
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        rmpv::Value::String(s) => match s.into_str() {
            Some(s) => serde_json::Value::String(s),
            None => {
                tracing::warn!("msgpack string contains invalid UTF-8, substituting empty string");
                serde_json::Value::String(String::new())
            }
        },
        rmpv::Value::Binary(bytes) | rmpv::Value::Ext(_, bytes) => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            serde_json::Value::String(encoded)
        }
        rmpv::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(rmpv_to_json).collect())
        }
        rmpv::Value::Map(map) => {
            let obj = map
                .into_iter()
                .map(|(k, v)| {
                    let key = match k {
                        rmpv::Value::String(s) => match s.into_str() {
                            Some(s) => s,
                            None => {
                                tracing::warn!("msgpack map key contains invalid UTF-8, substituting empty string");
                                String::new()
                            }
                        },
                        other => format!("{other}"),
                    };
                    (key, rmpv_to_json(v))
                })
                .collect();
            serde_json::Value::Object(obj)
        }
    }
}

// ---------------------------------------------------------------------------
// Helper to build an ATTACH message
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachMode {
    Clean,
    Resume,
}

pub fn build_attach_msg(
    channel: &str,
    params: Option<&HashMap<String, String>>,
    channel_serial: Option<&str>,
    attach_mode: AttachMode,
) -> ProtocolMessage {
    let (channel_serial, f) = match attach_mode {
        AttachMode::Clean => (None, flags::MODE_SUBSCRIBE),
        AttachMode::Resume => (
            channel_serial.map(str::to_string),
            flags::MODE_SUBSCRIBE | flags::ATTACH_RESUME,
        ),
    };
    ProtocolMessage {
        action: action::ATTACH,
        channel: Some(channel.to_string()),
        channel_serial,
        flags: Some(f),
        params: params.cloned(),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
