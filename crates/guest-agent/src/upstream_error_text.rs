//! Bounded projection for a model error that carries an upstream document.
//!
//! The Pi runtime already replaces a markup error body at its provider
//! boundary (`turbo/packages/pi-agent-runtime/src/upstream-error-body.ts`), so
//! a current CLI reports the observed status and content type. This module
//! reads that status back out of the marker the Pi runtime produced, and bounds
//! any model error that still arrives as a whole document.
//!
//! # Terminal error boundary
//!
//! Pi uses the CLI installed from the same Runner artifact. Its HTTP response
//! guard handles markup error bodies, while terminal `errorMessage` values
//! remain upstream-controlled text. [`project_model_error_text`] bounds that
//! text before it becomes the public result, event, or failure diagnostic.
//!
//! It reports `status=unknown content_type=unknown` rather than claiming
//! transport evidence the guest never observed, so an unproven failure stays
//! unclassified and keeps its error-level report.

use sha2::{Digest, Sha256};

/// Stable token marking a model error whose upstream body was a document.
///
/// Keep this in sync with `UPSTREAM_NON_API_RESPONSE_MARKER` in
/// `turbo/packages/pi-agent-runtime/src/upstream-error-body.ts`.
pub(crate) const UPSTREAM_NON_API_RESPONSE_MARKER: &str = "upstream_non_api_response";

/// Only the leading characters decide whether a body is a markup document.
const MARKUP_PROBE_CHARS: usize = 512;

/// Enough to group repeated pages in logs without republishing any of one.
const DIGEST_CHARS: usize = 8;

/// Upper bound for a model error that survives as the terminal result text.
const MAX_MODEL_ERROR_BYTES: usize = 4096;

const TRUNCATED_SUFFIX: &str = "...[truncated]";

/// Recognize a markup document from the body itself.
///
/// A gateway, captive portal or branded status page can serve markup under any
/// declared content type, and the guest never sees the response headers, so
/// only the text can decide.
pub(crate) fn is_markup_document_body(body: &str) -> bool {
    let head = body
        .trim_start()
        .chars()
        .take(MARKUP_PROBE_CHARS)
        .collect::<String>()
        .to_ascii_lowercase();
    if !head.starts_with('<') {
        return false;
    }
    head.contains("<!doctype html")
        || head.contains("<html")
        || head.contains("<body")
        || head.contains("<svg")
}

/// Select the terminal text for a model error message.
///
/// A markup document is replaced by a content-free description; the status and
/// content type are unknown here because only the Pi runtime observed them.
/// Any other message keeps its exact text under a size bound, so a genuine
/// provider error stays classifiable and readable.
pub(crate) fn project_model_error_text(raw: &str) -> String {
    if is_markup_document_body(raw) {
        return format!(
            "{UPSTREAM_NON_API_RESPONSE_MARKER} status=unknown content_type=unknown bytes={} digest={}",
            raw.len(),
            body_digest(raw)
        );
    }
    truncate_model_error_text(raw)
}

/// Read the upstream status the Pi runtime recorded in its marker.
///
/// Returns `None` when the message carries no marker or no parsable status, so
/// an unproven failure is never given a semantic reason.
pub(crate) fn upstream_non_api_response_status(message: &str) -> Option<u16> {
    const STATUS_PREFIX: &str = " status=";

    message
        .match_indices(UPSTREAM_NON_API_RESPONSE_MARKER)
        .find_map(|(index, _)| {
            if message[..index]
                .chars()
                .next_back()
                .is_some_and(is_marker_identifier_char)
            {
                return None;
            }
            let status = message[index + UPSTREAM_NON_API_RESPONSE_MARKER.len()..]
                .strip_prefix(STATUS_PREFIX)?;
            let status_len = status
                .find(|character: char| !character.is_ascii_digit())
                .unwrap_or(status.len());
            let (digits, suffix) = status.split_at(status_len);
            if digits.is_empty()
                || suffix
                    .chars()
                    .next()
                    .is_some_and(|character| !character.is_ascii_whitespace())
            {
                return None;
            }
            digits.parse().ok()
        })
}

fn is_marker_identifier_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
}

fn body_digest(body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    hex::encode(hasher.finalize())
        .chars()
        .take(DIGEST_CHARS)
        .collect()
}

fn truncate_model_error_text(message: &str) -> String {
    if message.len() <= MAX_MODEL_ERROR_BYTES {
        return message.to_string();
    }

    let end = message.floor_char_boundary(MAX_MODEL_ERROR_BYTES - TRUNCATED_SUFFIX.len());
    format!("{}{TRUNCATED_SUFFIX}", &message[..end])
}

#[cfg(test)]
mod tests;
