//! Schema-bound response decoding and redacted diagnostic paths.
//!
//! Request transport, status classification and claim reconstruction keep their owners.

use api_contracts::generated::{
    decode_paths,
    types::runners::runs::steerable_inputs::next::Response as NextSteerableInputResponse,
};
use reqwest::Response;
use runner_types::types::{ConnectorRuntimeSyncBatchResponse, ExecutionContext};
use serde::de::DeserializeOwned;

use crate::error::{ProviderError, ProviderResult};
use crate::provider::builtin_firewall_catalog::BuiltinFirewallCatalog;

pub(super) trait ApiDecodePath: DeserializeOwned {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema;
}

impl ApiDecodePath for NextSteerableInputResponse {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::runs::by_run_id::steerable_inputs::next::RESPONSE;
}

impl ApiDecodePath for ExecutionContext {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::execution_publication::CONTEXT;
}

impl ApiDecodePath for ably_subscriber::TokenRequest {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::realtime::token::RESPONSE;
}

impl ApiDecodePath for ConnectorRuntimeSyncBatchResponse {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::runs::by_run_id::connector_runtime::sync::RESPONSE;
}

impl ApiDecodePath for BuiltinFirewallCatalog {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::builtin_firewalls::resolve::RESPONSE;
}

pub(super) async fn decode_api_json<T: ApiDecodePath>(
    resp: Response,
    label: &str,
) -> ProviderResult<T> {
    let body = resp.bytes().await.map_err(|e| {
        ProviderError::Api(format!("{label} decode read body: {}", e.without_url()))
    })?;
    decode_api_json_bytes(&body).map_err(|e| ProviderError::Api(format!("{label} decode: {e}")))
}

pub(super) fn decode_api_json_bytes<T: ApiDecodePath>(body: &[u8]) -> Result<T, String> {
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let value = serde_path_to_error::deserialize(&mut deserializer).map_err(|e| {
        format_json_decode_error(
            format_json_decode_path(e.path(), T::DECODE_PATH_SCHEMA),
            e.inner(),
        )
    })?;
    deserializer
        .end()
        .map_err(|e| format_json_decode_error(".".to_string(), &e))?;
    Ok(value)
}

fn format_json_decode_path(
    path: &serde_path_to_error::Path,
    schema: &'static api_contracts::DecodePathSchema,
) -> String {
    let mut formatted = String::new();
    let mut cursor = schema.root();

    for segment in path {
        match segment {
            serde_path_to_error::Segment::Seq { index } => {
                formatted.push('[');
                formatted.push_str(&index.to_string());
                formatted.push(']');
                cursor = cursor.sequence_item();
            }
            serde_path_to_error::Segment::Map { key } => {
                let (segment, next_cursor) = match cursor.map_segment(key) {
                    api_contracts::DecodePathMapSegment::Field(next) => (key.as_str(), next),
                    api_contracts::DecodePathMapSegment::DynamicKey(next) => ("<map-key>", next),
                    api_contracts::DecodePathMapSegment::Unknown(next) => ("<field>", next),
                };
                push_json_path_segment(&mut formatted, segment);
                cursor = next_cursor;
            }
            serde_path_to_error::Segment::Enum { .. } => {
                push_json_path_segment(&mut formatted, "<variant>");
            }
            serde_path_to_error::Segment::Unknown => {
                push_json_path_segment(&mut formatted, "?");
                cursor = cursor.unknown();
            }
        }
    }

    if formatted.is_empty() {
        ".".to_string()
    } else {
        formatted
    }
}

fn push_json_path_segment(formatted: &mut String, segment: &str) {
    if !formatted.is_empty() {
        formatted.push('.');
    }
    formatted.push_str(segment);
}

fn format_json_decode_error(mut path: String, error: &serde_json::Error) -> String {
    let category = match error.classify() {
        serde_json::error::Category::Io => "io",
        serde_json::error::Category::Syntax => "syntax",
        serde_json::error::Category::Data => "data",
        serde_json::error::Category::Eof => "eof",
    };
    let location = format!("line {} column {}", error.line(), error.column());
    let detail = sanitized_json_error_detail(error);
    if detail == "unknown variant" && is_firewall_entry_decode_path(&path) {
        path.push_str(".kind");
    }
    if path == "." {
        format!("failed at <root>: {detail}; {category} error at {location}")
    } else {
        format!("failed at {path}: {detail}; {category} error at {location}")
    }
}

fn is_firewall_entry_decode_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("firewalls[") else {
        return false;
    };
    let Some((index, suffix)) = rest.split_once(']') else {
        return false;
    };
    !index.is_empty() && index.chars().all(|c| c.is_ascii_digit()) && suffix.is_empty()
}

fn sanitized_json_error_detail(error: &serde_json::Error) -> String {
    let message = error.to_string();
    let location_suffix = format!(" at line {} column {}", error.line(), error.column());
    let detail = message
        .strip_suffix(&location_suffix)
        .unwrap_or(message.as_str());
    if detail.starts_with("missing field `") || detail.starts_with("duplicate field `") {
        return detail.to_string();
    }

    if detail.starts_with("unknown field `") {
        return "unknown field".to_string();
    }
    if detail.starts_with("trailing characters") {
        return "trailing characters".to_string();
    }
    if detail.starts_with("invalid type:") {
        return "invalid type".to_string();
    }
    if detail.starts_with("invalid value:") {
        return "invalid value".to_string();
    }
    if detail.starts_with("unknown variant `") {
        return "unknown variant".to_string();
    }
    if detail.starts_with("expected value") {
        return "expected value".to_string();
    }
    if detail.starts_with("EOF while parsing") {
        return "unexpected end of input".to_string();
    }
    "invalid JSON".to_string()
}
