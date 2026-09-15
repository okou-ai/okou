//! Best-effort resource observations; never change the result of an export.

use guest_contracts::session_history_identity::SessionHistorySidecarResourceUsage;

#[cfg(target_os = "linux")]
pub(super) fn snapshot() -> Option<SessionHistorySidecarResourceUsage> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage writes the entire rusage on success; the pointer is valid.
    if unsafe { libc::getrusage(libc::RUSAGE_THREAD, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: the successful call above initialized usage.
    let usage = unsafe { usage.assume_init() };
    Some(SessionHistorySidecarResourceUsage {
        user_cpu_us: timeval_us(usage.ru_utime)?,
        system_cpu_us: timeval_us(usage.ru_stime)?,
        minor_faults: usage.ru_minflt.try_into().ok()?,
        major_faults: usage.ru_majflt.try_into().ok()?,
        input_blocks: usage.ru_inblock.try_into().ok()?,
        output_blocks: usage.ru_oublock.try_into().ok()?,
        voluntary_context_switches: usage.ru_nvcsw.try_into().ok()?,
        involuntary_context_switches: usage.ru_nivcsw.try_into().ok()?,
    })
}

#[cfg(target_os = "linux")]
fn timeval_us(value: libc::timeval) -> Option<u64> {
    let seconds = u64::try_from(value.tv_sec).ok()?;
    let micros = u64::try_from(value.tv_usec).ok()?;
    if micros >= 1_000_000 {
        return None;
    }
    seconds.checked_mul(1_000_000)?.checked_add(micros)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn snapshot() -> Option<SessionHistorySidecarResourceUsage> {
    None
}

pub(super) fn delta(
    start: Option<SessionHistorySidecarResourceUsage>,
    end: Option<SessionHistorySidecarResourceUsage>,
) -> Option<SessionHistorySidecarResourceUsage> {
    let start = start?;
    let end = end?;
    Some(SessionHistorySidecarResourceUsage {
        user_cpu_us: end.user_cpu_us.checked_sub(start.user_cpu_us)?,
        system_cpu_us: end.system_cpu_us.checked_sub(start.system_cpu_us)?,
        minor_faults: end.minor_faults.checked_sub(start.minor_faults)?,
        major_faults: end.major_faults.checked_sub(start.major_faults)?,
        input_blocks: end.input_blocks.checked_sub(start.input_blocks)?,
        output_blocks: end.output_blocks.checked_sub(start.output_blocks)?,
        voluntary_context_switches: end
            .voluntary_context_switches
            .checked_sub(start.voluntary_context_switches)?,
        involuntary_context_switches: end
            .involuntary_context_switches
            .checked_sub(start.involuntary_context_switches)?,
    })
}

#[cfg(test)]
mod tests;
