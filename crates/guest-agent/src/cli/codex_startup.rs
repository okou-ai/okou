//! Exactly-once telemetry for Codex startup through primary turn readiness.

use std::time::Instant;

use guest_telemetry::telemetry::record_sandbox_op;

use super::startup_timing::StartupTiming;

/// Records the complete Codex setup-to-turn-readiness boundary once.
pub struct CodexStartupTiming {
    timing: StartupTiming,
}

impl CodexStartupTiming {
    /// Start a Codex startup observation at the current monotonic time.
    #[must_use]
    pub fn start() -> Self {
        Self {
            timing: StartupTiming::new(Instant::now()),
        }
    }

    /// Complete startup successfully at the time readiness was observed.
    pub fn record_success_at(&self, observed_at: Instant) {
        self.record_at(observed_at, true);
    }

    /// Complete startup as failed at the current monotonic time.
    pub fn record_failure(&self) {
        self.record_at(Instant::now(), false);
    }

    fn record_at(&self, completed_at: Instant, success: bool) {
        if let Some(duration) = self.timing.complete_at(completed_at) {
            record_sandbox_op("codex_startup", duration, success, None);
        }
    }
}
