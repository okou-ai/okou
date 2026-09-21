pub(super) fn status_field_preview(value: &str) -> String {
    const MAX_CHARS: usize = 128;
    let mut chars = value.chars();
    let preview = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...[truncated]")
    } else {
        preview
    }
}

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_field_preview_bounds_long_values_on_char_boundary() {
        let exact = "x".repeat(128);
        assert_eq!(status_field_preview(&exact), exact);

        let long_ascii = "x".repeat(129);
        assert_eq!(
            status_field_preview(&long_ascii),
            format!("{}...[truncated]", "x".repeat(128))
        );

        let long_unicode = "界".repeat(129);
        assert_eq!(
            status_field_preview(&long_unicode),
            format!("{}...[truncated]", "界".repeat(128))
        );
    }
});
