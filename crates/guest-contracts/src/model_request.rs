//! Content-free model request shape and strictly bounded upstream correlation.

use serde::{Deserialize, Deserializer, Serialize};

/// Effective SDK payload counts and actual final-attempt wire bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestEvidence {
    /// Known model API dialect, never a URL or arbitrary model name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<ModelRequestApi>,
    /// Responses input items or Chat Completions messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_items: Option<u64>,
    /// Declared tools, excluding their names, schemas and arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<u64>,
    /// UTF-8 bytes of the Responses instructions field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions_bytes: Option<u64>,
    /// Known effective reasoning effort.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ModelReasoningEffort>,
    /// Body bytes passed to fetch; these may already be compressed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire_body_bytes: Option<u64>,
    /// Encoding of those wire bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_encoding: Option<ModelRequestEncoding>,
}

/// Only known upstream correlation formats may be retained or logged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponseEvidence {
    #[serde(
        default,
        deserialize_with = "deserialize_request_id",
        skip_serializing_if = "Option::is_none"
    )]
    request_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_cf_ray",
        skip_serializing_if = "Option::is_none"
    )]
    cf_ray: Option<String>,
}

impl ModelResponseEvidence {
    /// Validated OpenAI request ID or canonical UUID from x-request-id.
    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        self.request_id
            .as_deref()
            .filter(|value| valid_request_id(value))
    }

    /// Validated Cloudflare ray identifier from cf-ray.
    #[must_use]
    pub fn cf_ray(&self) -> Option<&str> {
        self.cf_ray.as_deref().filter(|value| valid_cf_ray(value))
    }
}

fn valid_request_id(value: &str) -> bool {
    if let Some(hex) = value.strip_prefix("req_") {
        return hex.len() == 32 && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn valid_cf_ray(value: &str) -> bool {
    let (hex, colo) = value
        .split_once('-')
        .map_or((value, None), |(hex, colo)| (hex, Some(colo)));
    hex.len() == 16
        && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        && colo.is_none_or(|colo| {
            colo.len() == 3 && colo.bytes().all(|byte| byte.is_ascii_uppercase())
        })
}

fn deserialize_request_id<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_str()
        .filter(|value| valid_request_id(value))
        .map(str::to_owned))
}

fn deserialize_cf_ray<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_str()
        .filter(|value| valid_cf_ray(value))
        .map(str::to_owned))
}

macro_rules! finite_values {
    ($name:ident, $doc:literal, $( $variant:ident => $value:literal ),+ $(,)?) => {
        #[doc = $doc]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $(#[doc = $value] #[serde(rename = $value)] $variant,)+
            /// Unknown external metadata is never copied into telemetry.
            #[serde(other)]
            Unknown,
        }
        impl $name {
            /// Return only recognized, content-free values.
            #[must_use]
            pub const fn as_str(self) -> Option<&'static str> {
                match self { $(Self::$variant => Some($value),)+ Self::Unknown => None }
            }
        }
    };
}

finite_values!(
    ModelRequestApi, "Known model API dialects.",
    CodexResponses => "openai-codex-responses",
    Responses => "openai-responses",
    Completions => "openai-completions",
);
finite_values!(
    ModelRequestEncoding, "Encoding of the observed wire body.",
    Identity => "identity",
    Zstd => "zstd",
    Gzip => "gzip",
    Br => "br",
    Deflate => "deflate",
    Other => "other",
);
finite_values!(
    ModelReasoningEffort, "Known effective reasoning values.",
    None => "none",
    Minimal => "minimal",
    Low => "low",
    Medium => "medium",
    High => "high",
    Xhigh => "xhigh",
    Max => "max",
);

#[cfg(test)]
mod tests;
