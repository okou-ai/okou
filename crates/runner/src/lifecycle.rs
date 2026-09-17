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
pub(crate) struct LifecycleController {
    mode_tx: tokio::sync::watch::Sender<RunnerMode>,
    parking_gate: ParkingGate,
    startup_ready: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SoftDrainOutcome {
    EnteredDraining,
    AlreadyDraining,
    Ignored(RunnerMode),
}

impl LifecycleController {
    pub(crate) fn new(
        mode_tx: tokio::sync::watch::Sender<RunnerMode>,
        parking_gate: ParkingGate,
    ) -> Self {
        let startup_ready = *mode_tx.borrow() != RunnerMode::Starting;
        Self {
            mode_tx,
            parking_gate,
            startup_ready: Arc::new(AtomicBool::new(startup_ready)),
        }
    }

    pub(crate) fn current_mode(&self) -> RunnerMode {
        *self.mode_tx.borrow()
    }

    #[cfg(test)]
    pub(crate) fn mode_tx(&self) -> &tokio::sync::watch::Sender<RunnerMode> {
        &self.mode_tx
    }

    pub(crate) fn enter_soft_drain(&self) -> SoftDrainOutcome {
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

    pub(crate) fn resume_from_soft_drain(&self) -> bool {
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

    pub(crate) fn mark_startup_ready(&self) -> RunnerMode {
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

    pub(crate) fn hard_stop(&self) -> bool {
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

    pub(crate) fn stop_after_natural_drain(&self) -> bool {
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

    pub(crate) fn close_parking(&self) {
        self.parking_gate.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::idle_pool::ParkingState;

    #[test]
    fn natural_stop_preserves_resumed_running_state() {
        let gate = ParkingGate::new_open();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert_eq!(
            lifecycle.enter_soft_drain(),
            SoftDrainOutcome::EnteredDraining
        );
        assert!(lifecycle.resume_from_soft_drain());

        assert!(!lifecycle.stop_after_natural_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Running);
        assert_eq!(gate.state(), ParkingState::Open);
    }

    #[test]
    fn natural_stop_closes_parking_after_drain() {
        let gate = ParkingGate::new_open();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert_eq!(
            lifecycle.enter_soft_drain(),
            SoftDrainOutcome::EnteredDraining
        );

        assert!(lifecycle.stop_after_natural_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);
    }

    /// Soft drain transitions from Starting or Running; repeated drain in
    /// Draining is an idempotent no-op, while teardown modes stay ignored.
    #[test]
    fn soft_drain_state_guards() {
        // Starting -> Draining (startup drain intent must not be lost).
        let gate = ParkingGate::new_open();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Starting);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert_eq!(
            lifecycle.enter_soft_drain(),
            SoftDrainOutcome::EnteredDraining
        );
        assert_eq!(lifecycle.current_mode(), RunnerMode::Draining);
        assert_eq!(gate.state(), ParkingState::SoftDraining);

        // Running → Draining (sanity: the steady-state legal transition).
        let gate = ParkingGate::new_open();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert_eq!(
            lifecycle.enter_soft_drain(),
            SoftDrainOutcome::EnteredDraining
        );
        assert_eq!(lifecycle.current_mode(), RunnerMode::Draining);
        assert_eq!(gate.state(), ParkingState::SoftDraining);

        // Draining → idempotent no-op.
        let gate = ParkingGate::new_open();
        gate.soft_drain();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Draining);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert_eq!(
            lifecycle.enter_soft_drain(),
            SoftDrainOutcome::AlreadyDraining
        );
        assert_eq!(lifecycle.current_mode(), RunnerMode::Draining);
        assert_eq!(gate.state(), ParkingState::SoftDraining);

        // Stopping → ignored (cannot reverse teardown).
        let gate = ParkingGate::new_open();
        gate.close();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopping);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert_eq!(
            lifecycle.enter_soft_drain(),
            SoftDrainOutcome::Ignored(RunnerMode::Stopping)
        );
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);

        // Stopped → ignored (runner has exited its loop).
        let gate = ParkingGate::new_open();
        gate.close();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopped);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert_eq!(
            lifecycle.enter_soft_drain(),
            SoftDrainOutcome::Ignored(RunnerMode::Stopped)
        );
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopped);
        assert_eq!(gate.state(), ParkingState::Closed);
    }

    /// Resume is honored only from Draining after startup is ready.
    #[test]
    fn resume_state_guards() {
        // Draining → Running (sanity: the one legal transition).
        let gate = ParkingGate::new_open();
        gate.soft_drain();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Draining);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert!(lifecycle.resume_from_soft_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Running);
        assert_eq!(gate.state(), ParkingState::Open);

        // Draining entered during startup cannot resume until startup is ready.
        let gate = ParkingGate::new_open();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Starting);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert_eq!(
            lifecycle.enter_soft_drain(),
            SoftDrainOutcome::EnteredDraining
        );
        assert!(!lifecycle.resume_from_soft_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Draining);
        assert_eq!(gate.state(), ParkingState::SoftDraining);

        assert_eq!(lifecycle.mark_startup_ready(), RunnerMode::Draining);
        assert!(lifecycle.resume_from_soft_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Running);
        assert_eq!(gate.state(), ParkingState::Open);

        // Starting → ignored (nothing to resume from).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Starting);
        let gate = ParkingGate::new_open();
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert!(!lifecycle.resume_from_soft_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Starting);
        assert_eq!(gate.state(), ParkingState::Open);

        // Running → ignored (nothing to resume from).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let gate = ParkingGate::new_open();
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert!(!lifecycle.resume_from_soft_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Running);
        assert_eq!(gate.state(), ParkingState::Open);

        // Stopping → ignored (too late).
        let gate = ParkingGate::new_open();
        gate.close();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopping);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert!(!lifecycle.resume_from_soft_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);

        // Stopped → ignored.
        let gate = ParkingGate::new_open();
        gate.close();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopped);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        assert!(!lifecycle.resume_from_soft_drain());
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopped);
        assert_eq!(gate.state(), ParkingState::Closed);
    }
}
