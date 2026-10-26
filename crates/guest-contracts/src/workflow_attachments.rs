//! Identity of immutable, attachment-only custom Workflow archives.

/// Recover the expected archive digest from the reserved Workflow cache key.
/// Ordinary Storage versions keep their existing identity and validation.
pub fn archive_sha256<'a>(name: Option<&str>, version: Option<&'a str>) -> Option<&'a str> {
    let identity = name?.strip_prefix("workflow:")?.as_bytes();
    if identity.len() != 36
        || !identity.iter().enumerate().all(|(index, value)| {
            if [8, 13, 18, 23].contains(&index) {
                *value == b'-'
            } else {
                value.is_ascii_hexdigit() && !value.is_ascii_uppercase()
            }
        })
    {
        return None;
    }
    version.filter(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}
