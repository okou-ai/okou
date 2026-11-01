use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serde::Serialize;

use crate::idle_pool::ParkingGate;

/// Runner lifecycle state.
///
/// - `Starting`: startup/readiness work is still in progress. The process is
///   alive, but must not discover or claim new jobs.
/// - `Running`: normal operation — discover and claim new jobs.
/// - `Draining`: soft drain. No new jobs claimed; in-flight jobs keep
///   running; idle pool destroyed. **Resumable** via SIGUSR2.
/// - `Stopping`: irreversible teardown in progress — discovery released,
///   per-job tokens cancelled, factories/proxy/kmsg/dns shutting down.
///   Reached via SIGTERM/SIGINT, or automatically from `Draining` once
///   `jobs.is_empty()`.
/// - `Stopped`: teardown complete. The process exits immediately after
///   writing this state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunnerMode {
    Starting,
    Running,
    Draining,
    Stopping,
    Stopped,
}

/// Ordered lifecycle transition handle shared by signal adapters and the main
/// run loop.
///
/// Parking state is updated before publishing the externally visible mode so a
/// task that observes `Running` can also rely on parking already being open.
#[derive(Clone)]
pub struct LifecycleController {
    mode_tx: tokio::sync::watch::Sender<RunnerMode>,
    parking_gate: ParkingGate,
    startup_ready: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoftDrainOutcome {
    EnteredDraining,
    AlreadyDraining,
    Ignored(RunnerMode),
}

impl LifecycleController {
    pub fn new(mode_tx: tokio::sync::watch::Sender<RunnerMode>, parking_gate: ParkingGate) -> Self {
        let startup_ready = *mode_tx.borrow() != RunnerMode::Starting;
        Self {
            mode_tx,
            parking_gate,
            startup_ready: Arc::new(AtomicBool::new(startup_ready)),
        }
    }

    pub fn current_mode(&self) -> RunnerMode {
        *self.mode_tx.borrow()
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn mode_tx(&self) -> &tokio::sync::watch::Sender<RunnerMode> {
        &self.mode_tx
    }

    pub fn enter_soft_drain(&self) -> SoftDrainOutcome {
        let gate = self.parking_gate.clone();
        let mut outcome = SoftDrainOutcome::Ignored(self.current_mode());
        let _ = self.mode_tx.send_if_modified(|mode| match *mode {
            RunnerMode::Starting | RunnerMode::Running => {
                let original_mode = *mode;
                if gate.soft_drain() {
                    *mode = RunnerMode::Draining;
                    outcome = SoftDrainOutcome::EnteredDraining;
                    true
                } else {
                    outcome = SoftDrainOutcome::Ignored(original_mode);
                    false
                }
            }
            RunnerMode::Draining => {
                outcome = SoftDrainOutcome::AlreadyDraining;
                false
            }
            mode => {
                outcome = SoftDrainOutcome::Ignored(mode);
                false
            }
        });
        outcome
    }

    pub fn resume_from_soft_drain(&self) -> bool {
        if !self.startup_ready.load(Ordering::SeqCst) {
            return false;
        }
        let gate = self.parking_gate.clone();
        let mut transitioned = false;
        let _ = self.mode_tx.send_if_modified(|mode| {
            if *mode == RunnerMode::Draining && gate.open_after_soft_drain() {
                *mode = RunnerMode::Running;
                transitioned = true;
                true
            } else {
                false
            }
        });
        transitioned
    }

    pub fn mark_startup_ready(&self) -> RunnerMode {
        self.startup_ready.store(true, Ordering::SeqCst);
        let mut current = self.current_mode();
        let _ = self.mode_tx.send_if_modified(|mode| {
            current = *mode;
            if *mode == RunnerMode::Starting {
                *mode = RunnerMode::Running;
                current = RunnerMode::Running;
                true
            } else {
                false
            }
        });
        current
    }

    pub fn hard_stop(&self) -> bool {
        let gate = self.parking_gate.clone();
        let mut transitioned = false;
        let _ = self.mode_tx.send_if_modified(|mode| {
            if *mode != RunnerMode::Stopping {
                gate.close();
                *mode = RunnerMode::Stopping;
                transitioned = true;
                true
            } else {
                false
            }
        });
        transitioned
    }

    pub fn stop_after_natural_drain(&self) -> bool {
        let gate = self.parking_gate.clone();
        let mut transitioned = false;
        let _ = self.mode_tx.send_if_modified(|mode| {
            if *mode == RunnerMode::Draining {
                gate.close();
                *mode = RunnerMode::Stopping;
                transitioned = true;
                true
            } else {
                false
            }
        });
        transitioned
    }

    pub fn close_parking(&self) {
        self.parking_gate.close();
    }
}

#[cfg(test)]
mod tests;
