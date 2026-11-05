//! Absolute-deadline observation of threads owned by synchronous fixtures.

use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Observe completion until `deadline`, joining only a completed thread.
///
/// Completion takes precedence over an expired deadline. A completed thread's
/// return value or original panic payload is returned unchanged. `None` means
/// the deadline expired while the thread was unfinished: dropping its handle
/// detaches the thread and does not cancel it. Callers retain their own timeout,
/// error and panic policy. Sleeps are clamped to the remaining budget.
pub fn join_until<T>(
    handle: JoinHandle<T>,
    deadline: Instant,
    poll_interval: Duration,
) -> Option<thread::Result<T>> {
    while !handle.is_finished() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        thread::sleep(std::cmp::min(remaining, poll_interval));
    }
    Some(handle.join())
}

#[cfg(test)]
mod tests;
