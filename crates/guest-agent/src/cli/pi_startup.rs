//! Exactly-once telemetry for Pi startup through first observed CLI output.
//!
//! The original guest-monotonic boundary and success/failure ownership stay
//! unchanged. Additive segments partition that same interval. Child milestones
//! use stderr receipt times, not subtraction of unrelated process clocks.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use guest_telemetry::telemetry::record_sandbox_op;

/// Records the complete Pi setup-to-first-output boundary once.
pub struct PiStartupTiming {
    started_at: Instant,
    completed: AtomicBool,
    succeeded_at: Arc<OnceLock<Instant>>,
    segments: PiStartupSegments,
}

/// Bounded diagnostic-only checkpoints shared with the stderr collector.
#[derive(Clone)]
pub(super) struct PiStartupSegments(Arc<Mutex<SegmentState>>);

struct SegmentState {
    started_at: Instant,
    phase: Option<&'static str>,
    checkpoints: Vec<(&'static str, Instant, &'static str)>,
}

impl PiStartupSegments {
    fn advance(&self, expected: &'static str, next: &'static str) {
        let observed_at = Instant::now();
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        if state.phase != Some(expected) {
            return;
        }
        state.checkpoints.push((expected, observed_at, next));
        state.phase = Some(next);
    }

    pub(super) fn observe_child_phase(&self, op_type: &str, success: bool) {
        if !success {
            return;
        }
        match op_type {
            "pi_prepare_cli_node_bootstrap" => {
                self.advance("pi_startup_spawn_to_cli_entry", "pi_startup_cli_initialize")
            }
            "pi_prepare_session_manager" => {
                self.advance("pi_startup_cli_initialize", "pi_startup_session_prepare")
            }
            "pi_prepare_runtime_initialize" => {
                self.advance("pi_startup_session_prepare", "pi_startup_runtime_ready")
            }
            _ => {}
        }
    }

    fn finish(&self, observed_at: Instant, success: bool) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        if state.phase.take().is_none() {
            return;
        }
        let checkpoints = std::mem::take(&mut state.checkpoints);
        let mut started_at = state.started_at;
        drop(state);
        let mut phase = "pi_startup_guest_setup";
        for (completed_phase, boundary, next) in checkpoints {
            // The stdout success boundary can precede a delayed stderr read.
            if boundary > observed_at {
                break;
            }
            record_sandbox_op(
                completed_phase,
                boundary.saturating_duration_since(started_at),
                true,
                None,
            );
            started_at = boundary;
            phase = next;
        }
        record_sandbox_op(
            phase,
            observed_at.saturating_duration_since(started_at),
            success,
            None,
        );
    }
}

impl PiStartupTiming {
    /// Start a Pi startup observation at the current monotonic time.
    #[must_use]
    pub fn start() -> Self {
        let started_at = Instant::now();
        Self {
            started_at,
            completed: AtomicBool::new(false),
            succeeded_at: Arc::new(OnceLock::new()),
            segments: PiStartupSegments(Arc::new(Mutex::new(SegmentState {
                started_at,
                phase: Some("pi_startup_guest_setup"),
                checkpoints: Vec::with_capacity(5),
            }))),
        }
    }

    pub(super) fn before_spawn(&self) {
        self.segments
            .advance("pi_startup_guest_setup", "pi_startup_process_spawn");
    }

    pub(super) fn after_spawn(&self) {
        self.segments
            .advance("pi_startup_process_spawn", "pi_startup_spawn_to_cli_entry");
    }

    pub(super) fn segment_observer(&self) -> PiStartupSegments {
        self.segments.clone()
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
        self.segments.finish(completed_at, success);
        record_sandbox_op(
            "pi_startup",
            completed_at.saturating_duration_since(self.started_at),
            success,
            None,
        );
    }
}
