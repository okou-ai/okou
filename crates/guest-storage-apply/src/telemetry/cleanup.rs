//! Bounded attribution for the synchronous cleanup phases before downloads.
//!
//! `reason` buckets requested plan entries, not removed files. Wall rows expose
//! CPU-clock availability in `outcome`; CPU rows exist only for measured samples
//! and their `duration_ms` is thread CPU time, not wall latency. Zero is a valid
//! measured duration. Missing/backwards clock samples never fabricate a zero.
//!
//! Capture both phases before recording the legacy combined cleanup total, then
//! emit these rows. This keeps diagnostic writes out of all cleanup timers.

use guest_telemetry::telemetry::{SandboxOpDimensions, record_sandbox_op_with_dimensions};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(crate) enum CleanupPhase {
    StalePaths,
    Instructions,
}

impl CleanupPhase {
    pub(crate) fn measure(
        self,
        requested: usize,
        cleanup: impl FnOnce() -> bool,
    ) -> CleanupObservation {
        let started = Instant::now();
        let cpu_started = thread_cpu_time();
        let success = cleanup();
        let cpu = cpu_elapsed(cpu_started, thread_cpu_time());
        CleanupObservation {
            phase: self,
            wall: started.elapsed(),
            cpu,
            requested,
            success,
        }
    }

    pub(super) fn wall_action(self) -> &'static str {
        match self {
            Self::StalePaths => "guest_storage_apply_stale_cleanup",
            Self::Instructions => "guest_storage_apply_instruction_cleanup",
        }
    }

    pub(super) fn cpu_action(self) -> &'static str {
        match self {
            Self::StalePaths => "guest_storage_apply_stale_cleanup_cpu",
            Self::Instructions => "guest_storage_apply_instruction_cleanup_cpu",
        }
    }
}

pub(crate) struct CleanupObservation {
    phase: CleanupPhase,
    wall: Duration,
    cpu: Option<Duration>,
    requested: usize,
    success: bool,
}

impl CleanupObservation {
    pub(crate) fn success(&self) -> bool {
        self.success
    }

    pub(crate) fn record(&self) {
        let reason = Some(requested_bucket(self.requested));
        record_sandbox_op_with_dimensions(
            self.phase.wall_action(),
            self.wall,
            self.success,
            None,
            SandboxOpDimensions {
                outcome: Some(if self.cpu.is_some() {
                    "cpu_measured"
                } else {
                    "cpu_unavailable"
                }),
                reason,
            },
        );
        if let Some(cpu) = self.cpu {
            record_sandbox_op_with_dimensions(
                self.phase.cpu_action(),
                cpu,
                self.success,
                None,
                SandboxOpDimensions {
                    outcome: None,
                    reason,
                },
            );
        }
    }
}

fn requested_bucket(count: usize) -> &'static str {
    match count {
        0 => "requested_0",
        1 => "requested_1",
        2 => "requested_2",
        3 | 4 => "requested_3_4",
        5..=8 => "requested_5_8",
        9..=16 => "requested_9_16",
        _ => "requested_17_plus",
    }
}

fn cpu_elapsed(start: Option<Duration>, end: Option<Duration>) -> Option<Duration> {
    end?.checked_sub(start?)
}

fn thread_cpu_time() -> Option<Duration> {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: time points to a writable timespec. This clock measures only the
    // calling thread; cleanup is synchronous and has not started download workers.
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) } != 0 {
        return None;
    }
    Some(Duration::new(
        time.tv_sec.try_into().ok()?,
        time.tv_nsec.try_into().ok()?,
    ))
}

#[cfg(test)]
mod tests;
