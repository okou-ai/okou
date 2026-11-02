use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Debug)]
pub(crate) struct NormalOperationTracker {
    inner: Arc<Mutex<Inner>>,
}

impl NormalOperationTracker {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: TrackerState::Open,
                next_operation_id: 1,
                next_fence_id: 1,
                operations: BTreeMap::new(),
            })),
        }
    }

    #[cfg(test)]
    pub(crate) fn readiness(&self) -> NormalOperationReadiness {
        self.inner().readiness()
    }

    pub(crate) fn reserve(&self) -> Result<NormalOperationToken, NormalOperationRejection> {
        let mut inner = self.inner();
        match inner.state {
            TrackerState::Open => {
                let id = NormalOperationId(inner.next_operation_id);
                inner.next_operation_id += 1;
                inner
                    .operations
                    .insert(id, OperationPhase::ReservedBeforeWrite);
                Ok(NormalOperationToken {
                    id,
                    inner: Arc::clone(&self.inner),
                    released: false,
                })
            }
            TrackerState::Fenced { .. } => Err(NormalOperationRejection::Fenced),
            TrackerState::NotParkable => Err(NormalOperationRejection::NotParkable),
            TrackerState::Closed => Err(NormalOperationRejection::Closed),
        }
    }

    pub(crate) fn try_fence(&self) -> Result<NormalOperationFence, NormalOperationFenceRejection> {
        let mut inner = self.inner();
        match inner.state {
            TrackerState::Open if inner.operations.is_empty() => {
                let id = NormalOperationFenceId(inner.next_fence_id);
                inner.next_fence_id += 1;
                inner.state = TrackerState::Fenced { id };
                Ok(NormalOperationFence {
                    id,
                    inner: Arc::clone(&self.inner),
                })
            }
            TrackerState::Open => Err(NormalOperationFenceRejection::Busy),
            TrackerState::Fenced { .. } => Err(NormalOperationFenceRejection::AlreadyFenced),
            TrackerState::NotParkable => Err(NormalOperationFenceRejection::NotParkable),
            TrackerState::Closed => Err(NormalOperationFenceRejection::Closed),
        }
    }

    pub(crate) fn try_reserve_and_fence(
        &self,
    ) -> Result<(NormalOperationToken, NormalOperationFence), NormalOperationFenceRejection> {
        let mut inner = self.inner();
        match inner.state {
            TrackerState::Open if inner.operations.is_empty() => {
                let operation_id = NormalOperationId(inner.next_operation_id);
                inner.next_operation_id += 1;
                let fence_id = NormalOperationFenceId(inner.next_fence_id);
                inner.next_fence_id += 1;
                inner
                    .operations
                    .insert(operation_id, OperationPhase::ReservedBeforeWrite);
                inner.state = TrackerState::Fenced { id: fence_id };
                Ok((
                    NormalOperationToken {
                        id: operation_id,
                        inner: Arc::clone(&self.inner),
                        released: false,
                    },
                    NormalOperationFence {
                        id: fence_id,
                        inner: Arc::clone(&self.inner),
                    },
                ))
            }
            TrackerState::Open => Err(NormalOperationFenceRejection::Busy),
            TrackerState::Fenced { .. } => Err(NormalOperationFenceRejection::AlreadyFenced),
            TrackerState::NotParkable => Err(NormalOperationFenceRejection::NotParkable),
            TrackerState::Closed => Err(NormalOperationFenceRejection::Closed),
        }
    }

    pub(crate) fn mark_not_parkable(&self) {
        let mut inner = self.inner();
        inner.state = TrackerState::NotParkable;
        inner.operations.clear();
    }

    pub(crate) fn mark_closed(&self) {
        let mut inner = self.inner();
        if inner
            .operations
            .values()
            .any(|phase| *phase == OperationPhase::PossibleGuestWrite)
        {
            inner.state = TrackerState::NotParkable;
            inner.operations.clear();
            return;
        }
        if matches!(
            inner.state,
            TrackerState::Open | TrackerState::Fenced { .. }
        ) {
            inner.state = TrackerState::Closed;
            inner.operations.clear();
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        lock_inner(&self.inner)
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NormalOperationReadiness {
    Idle,
    Busy,
    Fenced,
    NotParkable,
    Closed,
}

/// Admission failure for a normal guest operation, carried by `io::Error`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormalOperationRejection {
    /// A temporary fence excludes new normal operations.
    Fenced,
    /// Prior operation ownership is uncertain; this connection cannot be reused.
    NotParkable,
    /// The connection has closed.
    Closed,
}

impl std::fmt::Display for NormalOperationRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Fenced => "normal operations are currently fenced",
            Self::NotParkable => "normal operations are not available on this connection",
            Self::Closed => "connection closed",
        })
    }
}

impl std::error::Error for NormalOperationRejection {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NormalOperationFenceRejection {
    Busy,
    AlreadyFenced,
    NotParkable,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NormalOperationTransitionError {
    UnknownOperation {
        operation_id: NormalOperationId,
    },
    InvalidTransition {
        operation_id: NormalOperationId,
        from: OperationPhase,
        to: OperationPhase,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct NormalOperationId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NormalOperationFenceId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OperationPhase {
    ReservedBeforeWrite,
    PossibleGuestWrite,
    GuestWriteCompleted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrackerState {
    Open,
    Fenced { id: NormalOperationFenceId },
    NotParkable,
    Closed,
}

#[derive(Debug)]
struct Inner {
    state: TrackerState,
    next_operation_id: u64,
    next_fence_id: u64,
    operations: BTreeMap<NormalOperationId, OperationPhase>,
}

impl Inner {
    #[cfg(test)]
    fn readiness(&self) -> NormalOperationReadiness {
        match self.state {
            TrackerState::Open if self.operations.is_empty() => NormalOperationReadiness::Idle,
            TrackerState::Open => NormalOperationReadiness::Busy,
            TrackerState::Fenced { .. } => NormalOperationReadiness::Fenced,
            TrackerState::NotParkable => NormalOperationReadiness::NotParkable,
            TrackerState::Closed => NormalOperationReadiness::Closed,
        }
    }
}

#[derive(Debug)]
pub(crate) struct NormalOperationToken {
    id: NormalOperationId,
    inner: Arc<Mutex<Inner>>,
    released: bool,
}

impl NormalOperationToken {
    pub(crate) fn transition_handle(&self) -> NormalOperationTransitionHandle {
        NormalOperationTransitionHandle {
            id: self.id,
            inner: Arc::clone(&self.inner),
        }
    }

    pub(crate) fn mark_possible_guest_write_started(
        &mut self,
    ) -> Result<(), NormalOperationTransitionError> {
        self.transition_handle().mark_possible_guest_write_started()
    }

    pub(crate) fn complete(mut self) -> Result<(), NormalOperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(_phase) = inner.operations.remove(&self.id) else {
            if matches!(inner.state, TrackerState::NotParkable) {
                // A possible guest write can fail closed and clear all tracked
                // operations before an independent terminal event completes an
                // older token. The connection is already not parkable, so late
                // completion only needs to release this token.
                self.released = true;
                return Ok(());
            }
            return Err(NormalOperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };
        self.released = true;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(crate) struct NormalOperationTransitionHandle {
    id: NormalOperationId,
    inner: Arc<Mutex<Inner>>,
}

impl NormalOperationTransitionHandle {
    pub(crate) fn mark_possible_guest_write_started(
        &self,
    ) -> Result<(), NormalOperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(phase) = inner.operations.get_mut(&self.id) else {
            return Err(NormalOperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };
        match *phase {
            OperationPhase::ReservedBeforeWrite | OperationPhase::GuestWriteCompleted => {
                *phase = OperationPhase::PossibleGuestWrite;
                Ok(())
            }
            OperationPhase::PossibleGuestWrite => {
                Err(NormalOperationTransitionError::InvalidTransition {
                    operation_id: self.id,
                    from: OperationPhase::PossibleGuestWrite,
                    to: OperationPhase::PossibleGuestWrite,
                })
            }
        }
    }

    pub(crate) fn mark_possible_guest_write_completed(
        &self,
    ) -> Result<(), NormalOperationTransitionError> {
        let mut inner = lock_inner(&self.inner);
        let Some(phase) = inner.operations.get_mut(&self.id) else {
            return Err(NormalOperationTransitionError::UnknownOperation {
                operation_id: self.id,
            });
        };
        match *phase {
            OperationPhase::PossibleGuestWrite => {
                *phase = OperationPhase::GuestWriteCompleted;
                Ok(())
            }
            OperationPhase::ReservedBeforeWrite | OperationPhase::GuestWriteCompleted => {
                Err(NormalOperationTransitionError::InvalidTransition {
                    operation_id: self.id,
                    from: *phase,
                    to: OperationPhase::GuestWriteCompleted,
                })
            }
        }
    }
}

impl Drop for NormalOperationToken {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let mut inner = lock_inner(&self.inner);
        match inner.operations.remove(&self.id) {
            Some(OperationPhase::ReservedBeforeWrite) | None => {}
            Some(OperationPhase::PossibleGuestWrite | OperationPhase::GuestWriteCompleted) => {
                if !matches!(inner.state, TrackerState::Closed) {
                    inner.state = TrackerState::NotParkable;
                    inner.operations.clear();
                }
            }
        }
    }
}

#[derive(Debug)]
pub(crate) struct NormalOperationFence {
    id: NormalOperationFenceId,
    inner: Arc<Mutex<Inner>>,
}

impl Drop for NormalOperationFence {
    fn drop(&mut self) {
        let mut inner = lock_inner(&self.inner);
        if matches!(inner.state, TrackerState::Fenced { id } if id == self.id) {
            inner.state = TrackerState::Open;
        }
    }
}

fn lock_inner(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests;
