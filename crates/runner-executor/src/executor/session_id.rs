use guest_contracts::cli_agent_session_id::MAX_CLI_AGENT_SESSION_ID_BYTES;

pub(super) fn invalid_session_id_diagnostic_preview(id: &str) -> String {
    let mut end = id.len().min(MAX_CLI_AGENT_SESSION_ID_BYTES);
    while !id.is_char_boundary(end) {
        end -= 1;
    }
    let preview: String = id[..end].chars().flat_map(char::escape_default).collect();
    if end == id.len() {
        preview
    } else {
        format!("{preview}...[truncated {} bytes]", id.len() - end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_session_id_preview_keeps_short_safe_text() {
        assert_eq!(
            invalid_session_id_diagnostic_preview("../session"),
            "../session"
        );
    }

    #[test]
    fn invalid_session_id_preview_escapes_control_characters() {
        assert_eq!(
            invalid_session_id_diagnostic_preview("bad\nsession"),
            "bad\\nsession"
        );
    }

    #[test]
    fn invalid_session_id_preview_truncates_overlong_values() {
        let id = "a".repeat(MAX_CLI_AGENT_SESSION_ID_BYTES + 2);

        assert_eq!(
            invalid_session_id_diagnostic_preview(&id),
            format!(
                "{}...[truncated 2 bytes]",
                "a".repeat(MAX_CLI_AGENT_SESSION_ID_BYTES)
            )
        );
    }

    #[test]
    fn invalid_session_id_preview_escapes_and_truncates_overlong_values() {
        let id = format!("bad\n{}", "a".repeat(200));
        let preview = invalid_session_id_diagnostic_preview(&id);

        assert!(preview.contains("bad\\n"), "got: {preview}");
        assert!(preview.contains("[truncated 76 bytes]"), "got: {preview}");
        assert!(
            !preview.contains(&id),
            "preview should not contain the full invalid id: {preview}"
        );
    }

    #[test]
    fn invalid_session_id_preview_truncates_at_char_boundary() {
        let id = "€".repeat(50);
        let preview = invalid_session_id_diagnostic_preview(&id);

        assert!(preview.contains("\\u{20ac}"), "got: {preview}");
        assert!(
            preview.ends_with("...[truncated 24 bytes]"),
            "got: {preview}"
        );
        assert!(
            !preview.contains(&id),
            "preview should not contain the full invalid id: {preview}"
        );
    }
}
