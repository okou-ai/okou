//! Exactly-once telemetry for Pi startup through first observed CLI output.
//!
//! This is the Pi counterpart of [`super::CodexStartupTiming`]. It keeps the
//! same contract deliberately: a monotonic start captured before any
//! framework-specific setup, one completion per run, and both a success and a
//! failure path so a run that never produces CLI output is still measured.
//!
//! The Pi readiness signal differs from Codex's. Codex completes on the first
//! `turn.started` notification; Pi has no equivalent notification, so this
//! completes on the first projected Pi record, which is the same record that
//! stamps `api_to_cli_init`. The two ops are not redundant: `api_to_cli_init`
//! is wall-clock from the API start timestamp and is only emitted when output
//! arrives, while `pi_startup` is guest-monotonic and is also emitted when the
//! CLI produces nothing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use guest_telemetry::telemetry::record_sandbox_op;

/// Records the complete Pi setup-to-first-output boundary once.
pub struct PiStartupTiming {
    started_at: Instant,
    completed: AtomicBool,
    succeeded_at: Arc<OnceLock<Instant>>,
}

impl PiStartupTiming {
    /// Start a Pi startup observation at the current monotonic time.
    #[must_use]
    pub fn start() -> Self {
        Self {
            started_at: Instant::now(),
            completed: AtomicBool::new(false),
            succeeded_at: Arc::new(OnceLock::new()),
        }
    }

    /// The first-output boundary, set once startup completes successfully.
    /// `pi_first_session_output` measures from this instant.
    pub(super) fn success_boundary(&self) -> Arc<OnceLock<Instant>> {
        Arc::clone(&self.succeeded_at)
    }

    /// Complete startup successfully at the time first output was observed.
    pub fn record_success_at(&self, observed_at: Instant) {
        self.record_at(observed_at, true);
    }

    /// Complete startup as failed at the current monotonic time.
    pub fn record_failure(&self) {
        self.record_at(Instant::now(), false);
    }

    fn record_at(&self, completed_at: Instant, success: bool) {
        if self.completed.swap(true, Ordering::Relaxed) {
            return;
        }
        if success {
            let _ = self.succeeded_at.set(completed_at);
        }

        record_sandbox_op(
            "pi_startup",
            completed_at.saturating_duration_since(self.started_at),
            success,
            None,
        );
    }
}
