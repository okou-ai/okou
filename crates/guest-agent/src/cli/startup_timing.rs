use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(super) struct StartupTiming {
    started_at: Instant,
    completed: AtomicBool,
}

impl StartupTiming {
    pub(super) fn new(started_at: Instant) -> Self {
        Self {
            started_at,
            completed: AtomicBool::new(false),
        }
    }

    /// Claim startup completion and return the elapsed time to the winner.
    pub(super) fn complete_at(&self, observed_at: Instant) -> Option<Duration> {
        // The bit elects a reporter. Each reporter owns publication of its data.
        if self.completed.swap(true, Ordering::Relaxed) {
            return None;
        }

        Some(observed_at.saturating_duration_since(self.started_at))
    }
}
