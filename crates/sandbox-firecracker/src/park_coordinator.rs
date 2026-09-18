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
    pub(crate) fn reserve_guest_rpc_operation(
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
                "guest RPC assignment unavailable",
            ));
        }
        Ok((
            guest.reserve_external_operation()?,
            inner.assignment_cancel.child_token(),
        ))
    }

    pub(crate) fn guest_rpc_assignment_cancellation(
        &self,
        expected_run_id: &str,
    ) -> std::io::Result<CancellationToken> {
        let inner = self.inner();
        if inner.state != CoordinatorState::Open
            || inner.active_run_id.as_deref() != Some(expected_run_id)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "guest RPC assignment unavailable",
            ));
        }
        Ok(inner.assignment_cancel.child_token())
    }

    pub(crate) fn cancel_guest_rpc_operations(&self) {
        self.inner().assignment_cancel.cancel();
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
}

impl DirtyReason {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
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
        if matches!(
            self.state,
            CoordinatorState::Dirty { .. } | CoordinatorState::Terminating
        ) {
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
mod tests {
    use super::*;

    fn begin_attempt(coordinator: &ParkCoordinator) -> ParkAttempt {
        match coordinator.begin_prepare_park() {
            Ok(attempt) => attempt,
            Err(error) => panic!("begin prepare failed: {error:?}"),
        }
    }

    fn complete_attempt(coordinator: &ParkCoordinator, attempt: &ParkAttempt) {
        if let Err(error) =
            coordinator.complete_prepare_park(attempt, PrepareParkEvidence::AgentQuiesced)
        {
            panic!("complete prepare failed: {error:?}");
        }
    }

    fn dirty_reason(coordinator: &ParkCoordinator) -> DirtyReason {
        match coordinator.state() {
            CoordinatorState::Dirty { reason } => reason,
            state => panic!("expected dirty state, got {state:?}"),
        }
    }

    #[test]
    fn initial_state_is_open() {
        let coordinator = ParkCoordinator::new();

        assert_eq!(coordinator.state(), CoordinatorState::Open);
        assert_eq!(coordinator.ensure_operation_start_allowed(), Ok(()));
    }

    #[test]
    fn run_control_assignment_changes_only_at_successful_park_boundary() {
        let coordinator = ParkCoordinator::new();
        coordinator.bind_run_control("run-a").unwrap();

        assert_eq!(coordinator.ensure_run_control_matches("run-a"), Ok(()));
        assert_eq!(
            coordinator.bind_run_control("run-b"),
            Err(RunControlBindError::AlreadyBound)
        );

        let aborted_attempt = begin_attempt(&coordinator);
        coordinator.abort_prepare_park(&aborted_attempt).unwrap();
        assert_eq!(coordinator.ensure_run_control_matches("run-a"), Ok(()));

        let failed_coordinator = ParkCoordinator::new();
        failed_coordinator.bind_run_control("run-a").unwrap();
        let failed_attempt = begin_attempt(&failed_coordinator);
        complete_attempt(&failed_coordinator, &failed_attempt);
        failed_coordinator.mark_dirty(DirtyReason::new("park failed"));
        assert_eq!(
            failed_coordinator.ensure_run_control_matches("run-a"),
            Ok(())
        );

        let successful_attempt = begin_attempt(&coordinator);
        complete_attempt(&coordinator, &successful_attempt);
        coordinator.mark_parked(&successful_attempt).unwrap();
        assert_eq!(
            coordinator.ensure_run_control_matches("run-a"),
            Err(RunControlMismatch)
        );

        coordinator.bind_run_control("run-b").unwrap();
        assert_eq!(coordinator.ensure_run_control_matches("run-b"), Ok(()));
        coordinator.reopen_after_unpark().unwrap();
        assert_eq!(coordinator.ensure_run_control_matches("run-b"), Ok(()));
    }

    #[test]
    fn guarded_terminate_mismatch_does_not_change_coordinator_state() {
        let coordinator = ParkCoordinator::new();
        coordinator.bind_run_control("run-b").unwrap();

        assert_eq!(
            coordinator.begin_terminate(Some("run-a")),
            TerminateAdmission::RunControlMismatch
        );
        assert_eq!(coordinator.state(), CoordinatorState::Open);
        assert_eq!(
            coordinator.begin_terminate(Some("run-b")),
            TerminateAdmission::Accepted
        );
        assert_eq!(coordinator.state(), CoordinatorState::Terminating);
    }

    #[test]
    fn poisoned_mutex_marks_coordinator_dirty() {
        let coordinator = ParkCoordinator::new();
        let poisoned_coordinator = coordinator.clone();

        let join_result = std::thread::spawn(move || {
            let _guard = poisoned_coordinator.inner();
            panic!("poison coordinator lock");
        })
        .join();

        assert!(join_result.is_err());
        assert_eq!(
            dirty_reason(&coordinator),
            DirtyReason::new("park coordinator mutex poisoned")
        );
        assert!(matches!(
            coordinator.ensure_operation_start_allowed(),
            Err(OperationStartRejection::GateClosed {
                state: CoordinatorState::Dirty { .. }
            })
        ));
    }

    #[test]
    fn operation_start_is_rejected_when_policy_gate_is_not_open() {
        let closing = ParkCoordinator::new();
        let closing_attempt = begin_attempt(&closing);
        assert!(matches!(
            closing.ensure_operation_start_allowed(),
            Err(OperationStartRejection::GateClosed {
                state: CoordinatorState::ClosingForPark { .. }
            })
        ));
        closing.abort_prepare_park(&closing_attempt).unwrap();

        let ready = ParkCoordinator::new();
        let ready_attempt = begin_attempt(&ready);
        complete_attempt(&ready, &ready_attempt);
        assert!(matches!(
            ready.ensure_operation_start_allowed(),
            Err(OperationStartRejection::GateClosed {
                state: CoordinatorState::ReadyForPark { .. }
            })
        ));

        let parked = ParkCoordinator::new();
        let parked_attempt = begin_attempt(&parked);
        complete_attempt(&parked, &parked_attempt);
        parked.mark_parked(&parked_attempt).unwrap();
        assert_eq!(
            parked.ensure_operation_start_allowed(),
            Err(OperationStartRejection::GateClosed {
                state: CoordinatorState::Parked
            })
        );

        let terminating = ParkCoordinator::new();
        assert_eq!(
            terminating.begin_terminate(None),
            TerminateAdmission::Accepted
        );
        assert_eq!(
            terminating.ensure_operation_start_allowed(),
            Err(OperationStartRejection::GateClosed {
                state: CoordinatorState::Terminating
            })
        );

        let dirty = ParkCoordinator::new();
        dirty.mark_dirty(DirtyReason::new("test dirty"));
        assert!(matches!(
            dirty.ensure_operation_start_allowed(),
            Err(OperationStartRejection::GateClosed {
                state: CoordinatorState::Dirty { .. }
            })
        ));
    }

    #[test]
    fn successful_prepare_moves_to_ready_for_park() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);

        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ClosingForPark { .. }
        ));

        complete_attempt(&coordinator, &attempt);

        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ReadyForPark { .. }
        ));
    }

    #[test]
    fn ready_can_mark_parked_and_reopen() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);
        complete_attempt(&coordinator, &attempt);

        assert!(coordinator.mark_parked(&attempt).is_ok());
        assert_eq!(coordinator.state(), CoordinatorState::Parked);

        assert!(coordinator.reopen_after_unpark().is_ok());
        assert_eq!(coordinator.state(), CoordinatorState::Open);
        assert_eq!(coordinator.ensure_operation_start_allowed(), Ok(()));
    }

    #[test]
    fn running_handoff_retires_predecessor_but_keeps_operations_closed() {
        let coordinator = ParkCoordinator::new();
        coordinator.bind_run_control("predecessor").unwrap();
        let old_controls = coordinator
            .guest_rpc_assignment_cancellation("predecessor")
            .unwrap();
        let attempt = begin_attempt(&coordinator);
        complete_attempt(&coordinator, &attempt);
        coordinator.mark_running_handoff(&attempt).unwrap();

        assert!(old_controls.is_cancelled());
        assert!(
            coordinator
                .ensure_run_control_matches("predecessor")
                .is_err()
        );
        assert_eq!(coordinator.state(), CoordinatorState::RunningHandoff);
        assert!(coordinator.ensure_operation_start_allowed().is_err());
        assert!(coordinator.mark_parked(&attempt).is_err());
        coordinator.bind_run_control("successor").unwrap();
        assert!(
            coordinator
                .guest_rpc_assignment_cancellation("successor")
                .is_err()
        );
        assert_eq!(
            coordinator.begin_terminate(Some("predecessor")),
            TerminateAdmission::RunControlMismatch
        );
        coordinator.reopen_after_unpark().unwrap();
        assert!(coordinator.ensure_operation_start_allowed().is_ok());
        assert!(
            coordinator
                .guest_rpc_assignment_cancellation("successor")
                .is_ok()
        );
    }

    #[test]
    fn failed_running_handoff_cannot_reopen_or_bind_another_owner() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);
        complete_attempt(&coordinator, &attempt);
        coordinator.mark_running_handoff(&attempt).unwrap();
        coordinator.mark_dirty(DirtyReason::new("deflation failed"));
        assert!(coordinator.bind_run_control("successor").is_err());
        assert!(coordinator.reopen_after_unpark().is_err());
        assert!(coordinator.ensure_operation_start_allowed().is_err());
    }

    #[test]
    fn dirty_ready_or_parked_sandbox_cannot_continue_park_lifecycle() {
        let ready_coordinator = ParkCoordinator::new();
        let ready_attempt = begin_attempt(&ready_coordinator);
        complete_attempt(&ready_coordinator, &ready_attempt);

        ready_coordinator.mark_dirty(DirtyReason::new("post-prepare failure"));
        assert_eq!(
            ready_coordinator.mark_parked(&ready_attempt),
            Err(PrepareParkError::Dirty {
                reason: DirtyReason::new("post-prepare failure")
            })
        );

        let parked_coordinator = ParkCoordinator::new();
        let parked_attempt = begin_attempt(&parked_coordinator);
        complete_attempt(&parked_coordinator, &parked_attempt);
        assert!(parked_coordinator.mark_parked(&parked_attempt).is_ok());

        parked_coordinator.mark_dirty(DirtyReason::new("unpark unsafe"));
        assert_eq!(
            parked_coordinator.reopen_after_unpark(),
            Err(PrepareParkError::Dirty {
                reason: DirtyReason::new("unpark unsafe")
            })
        );
    }

    #[test]
    fn invalid_ready_and_parked_transitions_fail() {
        let coordinator = ParkCoordinator::new();
        let attempt = ParkAttempt {
            id: ParkAttemptId(999),
        };

        assert!(matches!(
            coordinator.mark_parked(&attempt),
            Err(PrepareParkError::InvalidState {
                state: CoordinatorState::Open
            })
        ));
        assert!(matches!(
            coordinator.reopen_after_unpark(),
            Err(PrepareParkError::InvalidState {
                state: CoordinatorState::Open
            })
        ));
    }

    #[test]
    fn stale_attempt_cannot_enter_ready() {
        let coordinator = ParkCoordinator::new();
        let stale = begin_attempt(&coordinator);
        assert!(coordinator.abort_prepare_park(&stale).is_ok());

        let current = begin_attempt(&coordinator);
        assert_eq!(
            coordinator.complete_prepare_park(&stale, PrepareParkEvidence::AgentQuiesced),
            Err(PrepareParkError::StaleAttempt {
                attempt_id: stale.id,
                state: CoordinatorState::ClosingForPark {
                    attempt_id: current.id
                },
            })
        );
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ClosingForPark { attempt_id } if attempt_id == current.id
        ));
    }

    #[test]
    fn stale_attempt_cannot_abort_current_prepare() {
        let coordinator = ParkCoordinator::new();
        let stale = begin_attempt(&coordinator);
        assert!(coordinator.abort_prepare_park(&stale).is_ok());

        let current = begin_attempt(&coordinator);
        assert_eq!(
            coordinator.abort_prepare_park(&stale),
            Err(PrepareParkError::StaleAttempt {
                attempt_id: stale.id,
                state: CoordinatorState::ClosingForPark {
                    attempt_id: current.id
                },
            })
        );
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ClosingForPark { attempt_id } if attempt_id == current.id
        ));
    }

    #[test]
    fn completed_prepare_cannot_be_aborted() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);
        complete_attempt(&coordinator, &attempt);

        assert_eq!(
            coordinator.abort_prepare_park(&attempt),
            Err(PrepareParkError::StaleAttempt {
                attempt_id: attempt.id,
                state: CoordinatorState::ReadyForPark {
                    attempt_id: attempt.id
                },
            })
        );
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::ReadyForPark { attempt_id } if attempt_id == attempt.id
        ));
    }

    #[test]
    fn aborted_prepare_cannot_later_complete() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);
        assert!(coordinator.abort_prepare_park(&attempt).is_ok());

        assert_eq!(
            coordinator.complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced),
            Err(PrepareParkError::StaleAttempt {
                attempt_id: attempt.id,
                state: CoordinatorState::Open,
            })
        );
        assert_eq!(coordinator.state(), CoordinatorState::Open);
    }

    #[test]
    fn dirty_during_prepare_blocks_completion_and_abort() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);

        coordinator.mark_dirty(DirtyReason::new("driver shutdown"));

        assert_eq!(
            coordinator.complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced),
            Err(PrepareParkError::Dirty {
                reason: DirtyReason::new("driver shutdown")
            })
        );
        assert_eq!(
            coordinator.abort_prepare_park(&attempt),
            Err(PrepareParkError::Dirty {
                reason: DirtyReason::new("driver shutdown")
            })
        );
        assert_eq!(
            dirty_reason(&coordinator),
            DirtyReason::new("driver shutdown")
        );
    }

    #[test]
    fn concurrent_prepare_and_operation_start_admission_are_linearized() {
        for _ in 0..64 {
            let coordinator = ParkCoordinator::new();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

            let prepare_coordinator = coordinator.clone();
            let prepare_barrier = std::sync::Arc::clone(&barrier);
            let prepare_thread = std::thread::spawn(move || {
                prepare_barrier.wait();
                prepare_coordinator.begin_prepare_park()
            });

            let start_coordinator = coordinator.clone();
            let start_barrier = std::sync::Arc::clone(&barrier);
            let start_thread = std::thread::spawn(move || {
                start_barrier.wait();
                start_coordinator.ensure_operation_start_allowed()
            });

            let prepare_result = prepare_thread
                .join()
                .expect("prepare thread should not panic");
            let start_result = start_thread.join().expect("start thread should not panic");

            match (prepare_result, start_result) {
                (Ok(attempt), Err(OperationStartRejection::GateClosed { .. })) => {
                    assert!(coordinator.abort_prepare_park(&attempt).is_ok());
                }
                (Ok(attempt), Ok(())) => {
                    assert!(coordinator.abort_prepare_park(&attempt).is_ok());
                }
                other => panic!("unexpected concurrent prepare/start result: {other:?}"),
            }

            assert_eq!(coordinator.state(), CoordinatorState::Open);
        }
    }

    #[test]
    fn terminate_blocks_future_park_attempts() {
        let coordinator = ParkCoordinator::new();

        assert_eq!(
            coordinator.begin_terminate(None),
            TerminateAdmission::Accepted
        );
        assert_eq!(
            coordinator.begin_terminate(None),
            TerminateAdmission::Accepted
        );
        assert_eq!(coordinator.state(), CoordinatorState::Terminating);

        assert_eq!(
            coordinator.begin_prepare_park(),
            Err(PrepareParkError::InvalidState {
                state: CoordinatorState::Terminating
            })
        );
    }

    #[test]
    fn terminate_preempts_in_progress_park() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);

        assert_eq!(
            coordinator.begin_terminate(None),
            TerminateAdmission::Accepted
        );
        assert_eq!(coordinator.state(), CoordinatorState::Terminating);

        assert_eq!(
            coordinator.complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced),
            Err(PrepareParkError::StaleAttempt {
                attempt_id: attempt.id,
                state: CoordinatorState::Terminating,
            })
        );
    }

    #[test]
    fn terminate_preempts_ready_for_park_before_idle_transfer() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);
        complete_attempt(&coordinator, &attempt);

        assert_eq!(
            coordinator.begin_terminate(None),
            TerminateAdmission::Accepted
        );
        assert_eq!(coordinator.state(), CoordinatorState::Terminating);
        assert_eq!(
            coordinator.mark_parked(&attempt),
            Err(PrepareParkError::InvalidState {
                state: CoordinatorState::Terminating
            })
        );
    }

    #[test]
    fn terminate_refuses_parked_sandbox() {
        let coordinator = ParkCoordinator::new();
        let attempt = begin_attempt(&coordinator);
        complete_attempt(&coordinator, &attempt);
        coordinator.mark_parked(&attempt).unwrap();

        assert_eq!(
            coordinator.begin_terminate(None),
            TerminateAdmission::RefusedIdle
        );
        assert_eq!(coordinator.state(), CoordinatorState::Parked);
    }

    #[test]
    fn terminate_accepts_dirty_policy() {
        let coordinator = ParkCoordinator::new();
        coordinator.mark_dirty(DirtyReason::new("transport failed"));

        assert_eq!(
            coordinator.begin_terminate(None),
            TerminateAdmission::Accepted
        );
        assert_eq!(coordinator.state(), CoordinatorState::Terminating);
    }

    #[test]
    fn dirty_does_not_override_terminating() {
        let coordinator = ParkCoordinator::new();

        assert_eq!(
            coordinator.begin_terminate(None),
            TerminateAdmission::Accepted
        );
        coordinator.mark_dirty(DirtyReason::new("late park failure"));

        assert_eq!(coordinator.state(), CoordinatorState::Terminating);
    }

    #[test]
    fn concurrent_prepare_and_terminate_are_linearized() {
        for _ in 0..64 {
            let coordinator = ParkCoordinator::new();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

            let prepare_coordinator = coordinator.clone();
            let prepare_barrier = std::sync::Arc::clone(&barrier);
            let prepare_thread = std::thread::spawn(move || {
                prepare_barrier.wait();
                prepare_coordinator.begin_prepare_park()
            });

            let terminate_coordinator = coordinator.clone();
            let terminate_barrier = std::sync::Arc::clone(&barrier);
            let terminate_thread = std::thread::spawn(move || {
                terminate_barrier.wait();
                terminate_coordinator.begin_terminate(None)
            });

            let prepare_result = prepare_thread
                .join()
                .expect("prepare thread should not panic");
            let terminate_result = terminate_thread
                .join()
                .expect("terminate thread should not panic");

            match (prepare_result, terminate_result) {
                (Ok(attempt), TerminateAdmission::Accepted) => {
                    assert_eq!(coordinator.state(), CoordinatorState::Terminating);
                    assert_eq!(
                        coordinator
                            .complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced,),
                        Err(PrepareParkError::StaleAttempt {
                            attempt_id: attempt.id,
                            state: CoordinatorState::Terminating,
                        })
                    );
                }
                (
                    Err(PrepareParkError::InvalidState {
                        state: CoordinatorState::Terminating,
                    }),
                    TerminateAdmission::Accepted,
                ) => {
                    assert_eq!(coordinator.state(), CoordinatorState::Terminating);
                }
                other => panic!("unexpected concurrent prepare/terminate result: {other:?}"),
            }
        }
    }

    #[test]
    fn first_dirty_reason_is_preserved() {
        let coordinator = ParkCoordinator::new();

        coordinator.mark_dirty(DirtyReason::new("first cause"));
        coordinator.mark_dirty(DirtyReason::new("second cause"));

        assert_eq!(dirty_reason(&coordinator), DirtyReason::new("first cause"));
    }

    #[test]
    fn independent_coordinators_do_not_share_state() {
        let first = ParkCoordinator::new();
        let second = ParkCoordinator::new();
        let first_attempt = begin_attempt(&first);

        assert!(matches!(
            first.ensure_operation_start_allowed(),
            Err(OperationStartRejection::GateClosed {
                state: CoordinatorState::ClosingForPark { .. }
            })
        ));
        assert_eq!(second.ensure_operation_start_allowed(), Ok(()));

        assert!(first.abort_prepare_park(&first_attempt).is_ok());
        assert_eq!(first.state(), CoordinatorState::Open);
    }
}
