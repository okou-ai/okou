//! Credential authority response admission with bounded secret ownership.

use serde::de::DeserializeOwned;
use zeroize::Zeroizing;

const MAX_API_BYTES: usize = 512 * 1024;

/// Admit a credential response without exposing its body or transport errors.
/// The protocol owner maps every rejection to its existing authority failure.
pub(super) async fn decode<T: DeserializeOwned>(
    mut response: reqwest::Response,
    created_at_header: &str,
) -> Result<(T, Option<chrono::DateTime<chrono::Utc>>), ()> {
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|length| length > MAX_API_BYTES as u64)
    {
        return Err(());
    }
    let created_at = response
        .headers()
        .get(created_at_header)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Utc));
    // Fixed capacity avoids leaving reallocated plaintext response buffers behind.
    let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_API_BYTES));
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > MAX_API_BYTES - bytes.len() {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map(|body| (body, created_at))
        .map_err(|_| ())
}

#[cfg(test)]
pub(crate) mod tests;
