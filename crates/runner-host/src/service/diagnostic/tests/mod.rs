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
