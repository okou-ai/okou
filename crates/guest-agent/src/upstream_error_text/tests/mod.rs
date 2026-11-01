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
