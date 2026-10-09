use std::time::Duration;

/// Convert runtime durations for telemetry, metrics, and structured log fields.
///
/// Timeout/deadline conversions may need different minimum-value or destination
/// type semantics, so keep those paths local to their caller.
pub(crate) fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}
