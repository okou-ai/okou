//! Shared name alphabet for guest timezone admission.

/// Whether a nonempty guest timezone name uses the shared ASCII alphabet.
///
/// This checks only the name's characters. It does not verify that a zoneinfo
/// file exists, require a canonical IANA name, or impose a transport length limit.
pub fn is_safe_timezone_name(timezone: &str) -> bool {
    !timezone.is_empty()
        && timezone.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || byte == b'/'
                || byte == b'_'
                || byte == b'-'
                || byte == b'+'
        })
}
