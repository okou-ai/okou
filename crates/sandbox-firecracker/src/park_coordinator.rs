//! Host-side park policy gate for same-session idle park.
//!
//! `AgentQuiesced` is guest evidence that guest-agent-managed operations are
//! fenced and settled. The host coordinator owns the stronger `ReadyForPark`
//! state and is the only boundary that can authorize pausing this same
//! sandbox/session.
//!
//! This is not a clean-VM certificate. Same-session park intentionally
//! preserves guest/session state, and `ReadyForPark` must not be used to
//! authorize cross-run reuse or snapshot publication.
//!
//! Invariants:
//! - `sandbox-firecracker` owns park policy and operation-start admission only.
//! - `guest-control-client` owns normal guest operation lifetime. Its normal-operation
//!   token acquisition is the authoritative operation lifetime linearization
//!   point.
//! - `ReadyForPark` means the host policy gate is closed, guest lifecycle
//!   quiesce has completed, and the caller owns the authoritative `guest-control-client`
//!   normal-operation fence.
//! - Coordinator locks are never held across `.await`.
use std::sync::{Arc, Mutex, MutexGuard};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub(crate) struct ParkCoordinator {
    inner: Arc<Mutex<Inner>>,
}

impl ParkCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: CoordinatorState::Open,
                next_attempt_id: 1,
                active_run_id: None,
                assignment_cancel: CancellationToken::new(),
            })),
        }
    }

    pub(crate) fn state(&self) -> CoordinatorState {
        self.inner().state.clone()
    }

    pub(crate) fn ensure_operation_start_allowed(&self) -> Result<(), OperationStartRejection> {
        match self.inner().state.clone() {
            CoordinatorState::Open => Ok(()),
            state => Err(OperationStartRejection::GateClosed { state }),
        }
    }

    /// Authorize only the original Sandbox's joined terminal recovery.
    /// Ordinary controls never receive this attempt capability.
    pub(crate) fn ensure_terminal_unpark_allowed(
        &self,
        attempt: uuid::Uuid,
    ) -> Result<(), OperationStartRejection> {
        match self.inner().state.clone() {
            CoordinatorState::Dirty { ref reason } if reason.terminal_unpark == Some(attempt) => {
                Ok(())
            }
            state => Err(OperationStartRejection::GateClosed { state }),
        }
    }

    /// Bind the full run identity before this assignment can admit controls.
    pub(crate) fn bind_run_control(&self, run_id: &str) -> Result<(), RunControlBindError> {
        let mut inner = self.inner();
        if inner.active_run_id.is_some() {
            return Err(RunControlBindError::AlreadyBound);
        }

        match inner.state.clone() {
            CoordinatorState::Open
            | CoordinatorState::Parked
            | CoordinatorState::RunningHandoff => {
                inner.active_run_id = Some(run_id.to_owned());
                inner.assignment_cancel = CancellationToken::new();
                Ok(())
            }
            state => Err(RunControlBindError::InvalidState { state }),
        }
    }

    /// Verify a guarded control target without revealing the current owner.
    pub(crate) fn ensure_run_control_matches(
        &self,
        expected_run_id: &str,
    ) -> Result<(), RunControlMismatch> {
        if self.inner().active_run_id.as_deref() == Some(expected_run_id) {
            Ok(())
        } else {
            Err(RunControlMismatch)
        }
    }

    /// Validate assignment and acquire the authoritative reservation while the
    /// policy lock excludes park/termination admission. Never await here.
    pub(crate) fn reserve_guest_operation(
        &self,
        expected_run_id: &str,
        guest: &guest_control_client::GuestControlClient,
    ) -> std::io::Result<(
        guest_control_client::ExternalOperationReservation,
        CancellationToken,
    )> {
        let inner = self.inner();
        if inner.state != CoordinatorState::Open
            || inner.active_run_id.as_deref() != Some(expected_run_id)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "guest assignment unavailable",
            ));
        }
        Ok((
            guest.reserve_external_operation()?,
            inner.assignment_cancel.child_token(),
        ))
    }

    pub(crate) fn guest_assignment_cancellation(
        &self,
        expected_run_id: &str,
    ) -> std::io::Result<CancellationToken> {
        let inner = self.inner();
        if inner.state != CoordinatorState::Open
            || inner.active_run_id.as_deref() != Some(expected_run_id)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "guest assignment unavailable",
            ));
        }
        Ok(inner.assignment_cancel.child_token())
    }

    pub(crate) fn begin_prepare_park(&self) -> Result<ParkAttempt, PrepareParkError> {
        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::Open => {}
            CoordinatorState::Dirty { reason } => {
                return Err(PrepareParkError::Dirty { reason });
            }
            state => {
                return Err(PrepareParkError::InvalidState { state });
            }
        }

        let attempt_id = ParkAttemptId(inner.next_attempt_id);
        inner.next_attempt_id += 1;
        inner.state = CoordinatorState::ClosingForPark { attempt_id };

        Ok(ParkAttempt { id: attempt_id })
    }

    pub(crate) fn complete_prepare_park(
        &self,
        attempt: &ParkAttempt,
        evidence: PrepareParkEvidence,
    ) -> Result<(), PrepareParkError> {
        let PrepareParkEvidence::AgentQuiesced = evidence;

        self.inner()
            .resolve_prepare_park(attempt, PrepareParkResolution::Complete)
    }

    pub(crate) fn abort_prepare_park(&self, attempt: &ParkAttempt) -> Result<(), PrepareParkError> {
        self.inner()
            .resolve_prepare_park(attempt, PrepareParkResolution::Abort)
    }

    pub(crate) fn mark_parked(&self, attempt: &ParkAttempt) -> Result<(), PrepareParkError> {
        self.complete_transfer(attempt, CoordinatorState::Parked)
    }

    /// Transfer a quiesced, still-running sandbox without reopening operations.
    pub(crate) fn mark_running_handoff(
        &self,
        attempt: &ParkAttempt,
    ) -> Result<(), PrepareParkError> {
        self.complete_transfer(attempt, CoordinatorState::RunningHandoff)
    }

    fn complete_transfer(
        &self,
        attempt: &ParkAttempt,
        destination: CoordinatorState,
    ) -> Result<(), PrepareParkError> {
        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::ReadyForPark { attempt_id } if attempt_id == attempt.id => {
                inner.state = destination;
                inner.assignment_cancel.cancel();
                inner.active_run_id = None;
                Ok(())
            }
            CoordinatorState::Dirty { reason } => Err(PrepareParkError::Dirty { reason }),
            state => Err(PrepareParkError::InvalidState { state }),
        }
    }

    pub(crate) fn reopen_after_unpark(&self) -> Result<(), PrepareParkError> {
        let mut inner = self.inner();
        match inner.state.clone() {
            CoordinatorState::Parked | CoordinatorState::RunningHandoff => {
                inner.state = CoordinatorState::Open;
                Ok(())
            }
            CoordinatorState::Dirty { reason } => Err(PrepareParkError::Dirty { reason }),
            state => Err(PrepareParkError::InvalidState { state }),
        }
    }

    /// Linearize host-side termination against idle parking.
    ///
    /// Once this moves the policy to `Terminating`, future or in-flight park
    /// attempts cannot reach `Parked`, so a terminate request cannot race with
    /// the active job finalizer transferring ownership to the idle pool.
    pub(crate) fn begin_terminate(&self, expected_run_id: Option<&str>) -> TerminateAdmission {
        let mut inner = self.inner();
        if expected_run_id.is_some() && inner.active_run_id.as_deref() != expected_run_id {
            return TerminateAdmission::RunControlMismatch;
        }

        match inner.state {
            CoordinatorState::Parked | CoordinatorState::RunningHandoff => {
                TerminateAdmission::RefusedIdle
            }
            CoordinatorState::Terminating => TerminateAdmission::Accepted,
            _ => {
                inner.state = CoordinatorState::Terminating;
                inner.assignment_cancel.cancel();
                TerminateAdmission::Accepted
            }
        }
    }

    pub(crate) fn mark_dirty(&self, reason: DirtyReason) {
        self.inner().mark_dirty(reason);
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        lock_inner(&self.inner)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CoordinatorState {
    Open,
    ClosingForPark {
        attempt_id: ParkAttemptId,
    },
    ReadyForPark {
        attempt_id: ParkAttemptId,
    },
    Parked,
    /// An exact successor owns a running VM with Guest operations still fenced.
    RunningHandoff,
    Terminating,
    Dirty {
        reason: DirtyReason,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirtyReason {
    message: String,
    terminal_unpark: Option<uuid::Uuid>,
}

impl DirtyReason {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            terminal_unpark: None,
        }
    }

    pub(crate) fn abandoned_native_transition(
        message: impl Into<String>,
        attempt: Option<uuid::Uuid>,
    ) -> Self {
        Self {
            message: message.into(),
            terminal_unpark: attempt,
        }
    }
}

impl std::fmt::Display for DirtyReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ParkAttemptId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ParkAttempt {
    id: ParkAttemptId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrepareParkEvidence {
    AgentQuiesced,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OperationStartRejection {
    GateClosed { state: CoordinatorState },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RunControlBindError {
    AlreadyBound,
    InvalidState { state: CoordinatorState },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RunControlMismatch;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TerminateAdmission {
    Accepted,
    RefusedIdle,
    RunControlMismatch,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PrepareParkError {
    Dirty {
        reason: DirtyReason,
    },
    InvalidState {
        state: CoordinatorState,
    },
    StaleAttempt {
        attempt_id: ParkAttemptId,
        state: CoordinatorState,
    },
}

enum PrepareParkResolution {
    Complete,
    Abort,
}

impl PrepareParkResolution {
    fn next_state(self, attempt_id: ParkAttemptId) -> CoordinatorState {
        match self {
            Self::Complete => CoordinatorState::ReadyForPark { attempt_id },
            Self::Abort => CoordinatorState::Open,
        }
    }
}

#[derive(Debug)]
struct Inner {
    state: CoordinatorState,
    next_attempt_id: u64,
    active_run_id: Option<String>,
    assignment_cancel: CancellationToken,
}

impl Inner {
    fn resolve_prepare_park(
        &mut self,
        attempt: &ParkAttempt,
        resolution: PrepareParkResolution,
    ) -> Result<(), PrepareParkError> {
        match self.state.clone() {
            CoordinatorState::ClosingForPark { attempt_id } if attempt_id == attempt.id => {
                self.state = resolution.next_state(attempt_id);
                Ok(())
            }
            CoordinatorState::Dirty { reason } => Err(PrepareParkError::Dirty { reason }),
            state => Err(PrepareParkError::StaleAttempt {
                attempt_id: attempt.id,
                state,
            }),
        }
    }

    fn mark_dirty(&mut self, reason: DirtyReason) {
        if let CoordinatorState::Dirty { reason: first } = &mut self.state {
            // Preserve the first diagnostic, but an unrelated failure revokes
            // the narrowly scoped terminal recovery authority.
            if first.terminal_unpark != reason.terminal_unpark {
                first.terminal_unpark = None;
            }
            return;
        }
        if matches!(self.state, CoordinatorState::Terminating) {
            return;
        }

        self.state = CoordinatorState::Dirty { reason };
        self.assignment_cancel.cancel();
    }
}

fn lock_inner(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    match inner.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            guard.mark_dirty(DirtyReason::new("park coordinator mutex poisoned"));
            guard
        }
    }
}

#[cfg(test)]
mod tests;
