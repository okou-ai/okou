use super::*;

#[test]
fn bounded_output_truncates_at_utf8_boundary() {
    let output = "a".repeat(LOG_OUTPUT_LIMIT_BYTES - 1) + "界";

    let bounded = bounded_output(output);

    assert!(bounded.is_char_boundary(LOG_OUTPUT_LIMIT_BYTES - 1));
    assert!(bounded.starts_with(&"a".repeat(LOG_OUTPUT_LIMIT_BYTES - 1)));
    assert!(bounded.ends_with("\n[output truncated]"));
    assert!(!bounded.contains('界'));
}
