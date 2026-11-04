pub fn status_field_preview(value: &str) -> String {
    const MAX_CHARS: usize = 128;
    let mut chars = value.chars();
    let preview = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...[truncated]")
    } else {
        preview
    }
}

#[cfg(test)]
mod tests;
