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
