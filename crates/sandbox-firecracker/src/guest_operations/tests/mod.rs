use super::*;
use futures_util::pin_mut;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, Ordering};
use std::task::{Context, Poll};

fn gate_without_guest() -> (GuestOperationStartGate, ParkCoordinator) {
    let coordinator = ParkCoordinator::new();
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    (
        GuestOperationStartGate::new(guest, coordinator.clone()),
        coordinator,
    )
}

fn state_from_atomic(state: &AtomicU8) -> SandboxState {
    match state.load(Ordering::Acquire) {
        value if value == SandboxState::Running as u8 => SandboxState::Running,
        value if value == SandboxState::Crashed as u8 => SandboxState::Crashed,
        value if value == SandboxState::Stopping as u8 => SandboxState::Stopping,
        value if value == SandboxState::Stopped as u8 => SandboxState::Stopped,
        _ => SandboxState::Created,
    }
}

fn assert_pending<F: Future>(future: Pin<&mut F>) {
    let waker = futures_util::task::noop_waker_ref();
    let mut cx = Context::from_waker(waker);
    assert!(matches!(future.poll(&mut cx), Poll::Pending));
}

#[tokio::test]
async fn sandbox_operation_requires_running_state() {
    for state in [
        SandboxState::Created,
        SandboxState::Stopping,
        SandboxState::Stopped,
    ] {
        let (gate, coordinator) = gate_without_guest();
        let result = gate.begin_sandbox_operation(|| state).await;

        assert_eq!(
            result.err(),
            Some(GuestOperationStartError::NotRunning { state })
        );
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }
}

#[tokio::test]
async fn sandbox_operation_reports_backend_crash_before_guest_lookup() {
    let (gate, coordinator) = gate_without_guest();

    let result = gate.begin_sandbox_operation(|| SandboxState::Crashed).await;

    assert_eq!(result.err(), Some(GuestOperationStartError::BackendCrashed));
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

#[tokio::test]
async fn sandbox_operation_without_guest_reports_running_not_available() {
    let (gate, coordinator) = gate_without_guest();

    let result = gate.begin_sandbox_operation(|| SandboxState::Running).await;

    assert_eq!(
        result.err(),
        Some(GuestOperationStartError::NotRunning {
            state: SandboxState::Running
        })
    );
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

#[tokio::test]
async fn sandbox_operation_rechecks_state_after_guest_lock_wait() {
    let coordinator = ParkCoordinator::new();
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let gate = GuestOperationStartGate::new(Arc::clone(&guest), coordinator.clone());
    let locked_guest = guest.lock().await;
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));

    let operation = gate.begin_sandbox_operation(|| state_from_atomic(&state));
    pin_mut!(operation);
    assert_pending(operation.as_mut());
    state.store(SandboxState::Crashed as u8, Ordering::Release);
    drop(locked_guest);

    let result = operation.await;
    assert_eq!(result.err(), Some(GuestOperationStartError::BackendCrashed));
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

#[tokio::test]
async fn sandbox_operation_rechecks_policy_after_guest_lock_wait() {
    let coordinator = ParkCoordinator::new();
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let gate = GuestOperationStartGate::new(Arc::clone(&guest), coordinator.clone());
    let locked_guest = guest.lock().await;
    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));

    let operation = gate.begin_sandbox_operation(|| state_from_atomic(&state));
    pin_mut!(operation);
    assert_pending(operation.as_mut());
    let attempt = coordinator.begin_prepare_park().expect("begin prepare");
    drop(locked_guest);

    let result = operation.await;
    assert!(matches!(
        result,
        Err(GuestOperationStartError::GateClosed {
            state: CoordinatorState::ClosingForPark { .. }
        })
    ));
    coordinator.abort_prepare_park(&attempt).unwrap();
}

#[tokio::test]
async fn control_operation_without_guest_reports_no_guest() {
    let (gate, coordinator) = gate_without_guest();

    let result = gate.begin_control_operation().await;

    assert_eq!(result.err(), Some(GuestOperationStartError::NoGuest));
    assert_eq!(coordinator.state(), CoordinatorState::Open);
}

#[tokio::test]
async fn control_operation_rechecks_policy_after_guest_lock_wait() {
    let coordinator = ParkCoordinator::new();
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let gate = GuestOperationStartGate::new(Arc::clone(&guest), coordinator.clone());
    let locked_guest = guest.lock().await;

    let operation = gate.begin_control_operation();
    pin_mut!(operation);
    assert_pending(operation.as_mut());
    let attempt = coordinator.begin_prepare_park().expect("begin prepare");
    drop(locked_guest);

    let result = operation.await;
    assert!(matches!(
        result,
        Err(GuestOperationStartError::GateClosed {
            state: CoordinatorState::ClosingForPark { .. }
        })
    ));
    coordinator.abort_prepare_park(&attempt).unwrap();
}

#[tokio::test]
async fn closed_policy_gate_rejects_sandbox_and_control_operations() {
    let (gate, coordinator) = gate_without_guest();
    let attempt = coordinator.begin_prepare_park().expect("begin prepare");

    let sandbox_result = gate.begin_sandbox_operation(|| SandboxState::Running).await;
    let control_result = gate.begin_control_operation().await;

    assert!(matches!(
        sandbox_result,
        Err(GuestOperationStartError::GateClosed {
            state: CoordinatorState::ClosingForPark { .. }
        })
    ));
    assert!(matches!(
        control_result,
        Err(GuestOperationStartError::GateClosed {
            state: CoordinatorState::ClosingForPark { .. }
        })
    ));
    coordinator.abort_prepare_park(&attempt).unwrap();
}
