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
mod tests;
