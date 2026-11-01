//! Explicit timer phases for tests that also own real HTTP or background tasks.

use std::future::{Future, poll_fn};
use std::time::Duration;

use tokio::time::{self, Instant};

/// Advance an already-armed timer without scheduling other tasks while paused.
///
/// Call only on a running current-thread Tokio runtime, after observing the
/// operation's request or timer admission. Tokio advances its clock before
/// yielding; poll that step inline and resume before allowing awakened tasks to
/// perform real I/O. This does not replace a real process or socket timeout test.
pub async fn advance_timer_phase(duration: Duration) {
    time::pause();
    let before = Instant::now();
    let mut advance = std::pin::pin!(time::advance(duration));
    let advanced = poll_fn(|cx| std::task::Poll::Ready(advance.as_mut().poll(cx))).await;
    let elapsed = before.elapsed();
    time::resume();
    assert_eq!(
        elapsed, duration,
        "the timer phase must advance before yielding"
    );
    if advanced.is_pending() {
        advance.await;
    }
}

#[cfg(test)]
mod tests;
