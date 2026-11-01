//! Policy-only admission gate for guest operations.
//!
//! `sandbox-firecracker` decides whether an operation may attempt to start. The
//! authoritative normal-operation lifetime begins only when `guest-control-client`
//! acquires its normal-operation token.

use std::sync::Arc;

use guest_control_client::GuestControlClient;

use crate::park_coordinator::{
    CoordinatorState, OperationStartRejection, ParkCoordinator, RunControlMismatch,
};
use crate::sandbox::SandboxState;

#[derive(Clone)]
pub(crate) struct GuestOperationStartGate {
    guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    coordinator: ParkCoordinator,
    terminal_unpark: Option<uuid::Uuid>,
}

impl GuestOperationStartGate {
    pub(crate) fn new(
        guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
        coordinator: ParkCoordinator,
    ) -> Self {
        Self {
            guest,
            coordinator,
            terminal_unpark: None,
        }
    }

    pub(crate) fn for_terminal_unpark(mut self, attempt: uuid::Uuid) -> Self {
        self.terminal_unpark = Some(attempt);
        self
    }

    pub(crate) async fn begin_sandbox_operation(
        &self,
        current_state: impl Fn() -> SandboxState,
    ) -> Result<Arc<GuestControlClient>, GuestOperationStartError> {
        match current_state() {
            SandboxState::Crashed => return Err(GuestOperationStartError::BackendCrashed),
            SandboxState::Running => {}
            state => return Err(GuestOperationStartError::NotRunning { state }),
        }

        self.ensure_policy_open()?;
        let guest = self.guest.lock().await.as_ref().cloned();

        match current_state() {
            SandboxState::Crashed => return Err(GuestOperationStartError::BackendCrashed),
            SandboxState::Running => {}
            state => return Err(GuestOperationStartError::NotRunning { state }),
        }

        self.ensure_policy_open()?;
        guest.ok_or(GuestOperationStartError::NotRunning {
            state: SandboxState::Running,
        })
    }

    pub(crate) async fn begin_control_operation(
        &self,
    ) -> Result<Arc<GuestControlClient>, GuestOperationStartError> {
        self.ensure_policy_open()?;
        let guest = self.guest.lock().await.as_ref().cloned();
        self.ensure_policy_open()?;
        guest.ok_or(GuestOperationStartError::NoGuest)
    }

    pub(crate) fn ensure_run_control_matches(
        &self,
        expected_run_id: &str,
    ) -> Result<(), RunControlMismatch> {
        self.coordinator.ensure_run_control_matches(expected_run_id)
    }

    pub(crate) fn ensure_policy_open(&self) -> Result<(), GuestOperationStartError> {
        let admission = match self.terminal_unpark {
            Some(attempt) => self.coordinator.ensure_terminal_unpark_allowed(attempt),
            None => self.coordinator.ensure_operation_start_allowed(),
        };
        admission.map_err(|error| match error {
            OperationStartRejection::GateClosed { state } => {
                GuestOperationStartError::GateClosed { state }
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GuestOperationStartError {
    BackendCrashed,
    NotRunning { state: SandboxState },
    NoGuest,
    GateClosed { state: CoordinatorState },
}

#[cfg(test)]
mod tests;
