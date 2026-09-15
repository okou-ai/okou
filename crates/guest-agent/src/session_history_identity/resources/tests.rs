use super::*;

#[test]
fn resource_deltas_preserve_measured_zero_and_unavailability() {
    let start = SessionHistorySidecarResourceUsage {
        user_cpu_us: 11,
        system_cpu_us: 22,
        minor_faults: 33,
        major_faults: 44,
        input_blocks: 55,
        output_blocks: 66,
        voluntary_context_switches: 77,
        involuntary_context_switches: 88,
    };
    let end = SessionHistorySidecarResourceUsage {
        user_cpu_us: 12,
        system_cpu_us: 24,
        minor_faults: 36,
        major_faults: 48,
        input_blocks: 60,
        output_blocks: 72,
        voluntary_context_switches: 84,
        involuntary_context_switches: 96,
    };
    assert_eq!(
        delta(Some(start), Some(end)),
        Some(SessionHistorySidecarResourceUsage {
            user_cpu_us: 1,
            system_cpu_us: 2,
            minor_faults: 3,
            major_faults: 4,
            input_blocks: 5,
            output_blocks: 6,
            voluntary_context_switches: 7,
            involuntary_context_switches: 8,
        })
    );
    assert_eq!(delta(Some(start), Some(start)), Some(Default::default()));
    assert_eq!(delta(None, Some(end)), None);
    assert_eq!(delta(Some(start), None), None);
    assert_eq!(delta(Some(end), Some(start)), None);
}

#[cfg(target_os = "linux")]
#[test]
fn cpu_time_conversion_rejects_invalid_or_overflowing_values() {
    assert_eq!(
        timeval_us(libc::timeval {
            tv_sec: 2,
            tv_usec: 123,
        }),
        Some(2_000_123)
    );
    for (tv_sec, tv_usec) in [(-1, 0), (0, -1), (0, 1_000_000), (i64::MAX, 0)] {
        assert_eq!(timeval_us(libc::timeval { tv_sec, tv_usec }), None);
    }
}
