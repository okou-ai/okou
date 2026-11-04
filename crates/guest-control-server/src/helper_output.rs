//! Diagnostic projection shared by fixed-purpose guest helper results.

/// Bound an owned diagnostic to its caller's byte budget without a suffix.
pub(crate) fn truncate_utf8(mut value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let end = value.floor_char_boundary(limit);
    value.truncate(end);
    value
}
