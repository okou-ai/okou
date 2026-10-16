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

    let mut end = MAX_MODEL_ERROR_BYTES - TRUNCATED_SUFFIX.len();
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATED_SUFFIX}", &message[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    const ERROR_PAGE: &str = concat!(
        "<html>\n  <head><style global>body{font-family:Arial}",
        ".logo{color:#8e8ea0}</style></head>\n  <body>\n",
        "    <svg viewBox=\"0 0 41 41\"><path d=\"M37.5324 16.8707\" /></svg>\n",
        "  </body>\n</html>"
    );

    #[test]
    fn markup_document_is_replaced_by_a_content_free_description() {
        let projected = project_model_error_text(ERROR_PAGE);

        assert!(projected.starts_with(UPSTREAM_NON_API_RESPONSE_MARKER));
        assert!(projected.contains("status=unknown"));
        assert!(projected.contains("content_type=unknown"));
        assert!(projected.contains(&format!("bytes={}", ERROR_PAGE.len())));
        assert!(!projected.contains("<html"));
        assert!(!projected.contains("<svg"));
        assert!(!projected.contains("8e8ea0"));
        assert!(projected.len() < 128);
    }

    #[test]
    fn identical_pages_share_a_digest_and_different_pages_do_not() {
        let repeat = project_model_error_text(ERROR_PAGE);
        let other = project_model_error_text(&format!("{ERROR_PAGE}<!-- other -->"));

        assert_eq!(project_model_error_text(ERROR_PAGE), repeat);
        assert_ne!(repeat, other);
    }

    #[test]
    fn genuine_provider_errors_keep_their_exact_text() {
        for message in [
            "API Error: Overloaded",
            "You've hit your usage limit. Try again in ~13 min.",
            "OpenAI API error (400): {\"error\":{\"message\":\"<html> inside text\"}}",
            "",
        ] {
            assert_eq!(project_model_error_text(message), message);
        }
    }

    #[test]
    fn oversized_plain_errors_are_truncated_on_a_character_boundary() {
        let oversized = "é".repeat(MAX_MODEL_ERROR_BYTES);

        let projected = project_model_error_text(&oversized);

        assert!(projected.len() <= MAX_MODEL_ERROR_BYTES);
        assert!(projected.ends_with(TRUNCATED_SUFFIX));
    }

    #[test]
    fn status_is_read_from_the_runtime_marker_on_every_route() {
        // The Codex route reports the marker as the whole message; the public
        // Responses route wraps it in the provider's own error envelope.
        for (message, expected) in [
            (
                "upstream_non_api_response status=502 content_type=html bytes=4711 digest=1a2b3c4d"
                    .to_string(),
                Some(502),
            ),
            (
                concat!(
                    "OpenAI API error (525): {\"error\":{\"type\":\"upstream_non_api_response\",",
                    "\"message\":\"upstream_non_api_response status=525 content_type=html ",
                    "bytes=812 digest=deadbeef\"}}"
                )
                .to_string(),
                Some(525),
            ),
            (project_model_error_text(ERROR_PAGE), None),
            ("API Error: Overloaded".to_string(), None),
            ("status=502 without any marker".to_string(), None),
        ] {
            assert_eq!(upstream_non_api_response_status(&message), expected);
        }
    }

    #[test]
    fn status_requires_the_runtime_marker_and_its_exact_status_field() {
        for message in [
            "not_upstream_non_api_response status=502 content_type=html bytes=4711 digest=1a2b3c4d",
            "upstream_non_api_response detail status=502 content_type=html bytes=4711 digest=1a2b3c4d",
            "upstream_non_api_response status=502unexpected content_type=html bytes=4711 digest=1a2b3c4d",
        ] {
            assert_eq!(upstream_non_api_response_status(message), None);
        }
    }

    #[test]
    fn markup_detection_ignores_markup_quoted_inside_a_payload() {
        assert!(is_markup_document_body("<!DOCTYPE html><html></html>"));
        assert!(is_markup_document_body("\n  <html><body>x</body></html>"));
        assert!(is_markup_document_body(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" />"
        ));
        assert!(!is_markup_document_body(
            "{\"error\":{\"message\":\"<html> in text\"}}"
        ));
        assert!(!is_markup_document_body("<Error><Code>x</Code></Error>"));
        assert!(!is_markup_document_body("Overloaded"));
    }
}
