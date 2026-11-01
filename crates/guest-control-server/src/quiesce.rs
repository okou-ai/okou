//! Guest-operation admission and quiesce state for one host connection.
//!
//! An [`OperationState`] starts open. Each successful
//! [`OperationState::acquire`] admits one logical operation and increments its
//! pending count. [`OperationState::enter_quiescing`] atomically closes
//! admission before inspecting that count, so both [`QuiesceResult::Quiesced`]
//! and [`QuiesceResult::Busy`] leave new operations fenced.
//!
//! Entering quiescing does not wait for pending operations, register a waiter,
//! or send a later notification. A busy result is a point-in-time count; the
//! existing operations finish independently. Once they finish, the host must
//! retry the quiesce request to receive a quiesced acknowledgement. If the
//! attempt is abandoned instead, [`OperationState::resume`] explicitly reopens
//! admission, including while previously admitted operations remain pending.
//!
//! One acquire creates one shared [`OperationGuard`]. Cloning the guard shares
//! ownership of that logical operation and does not increment the pending
//! count. The count is released by [`OperationGuard::release`] or, if it is not
//! released explicitly, when the final guard clone drops.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Shared operation-admission state owned by one connection dispatcher.
///
/// Clones refer to the same mode and pending-operation count.
#[derive(Clone, Default)]
pub(crate) struct OperationState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Open,
    Quiescing,
}

struct Inner {
    mode: Mode,
    pending: usize,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            mode: Mode::Open,
            pending: 0,
        }
    }
}

/// Reason a new guest operation cannot be admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcquireOperationError {
    /// The connection has fenced new operations for quiescing.
    Quiescing,
}

/// Result of fencing new operations and observing the pending count.
///
/// Both variants leave the state quiescing until [`OperationState::resume`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuiesceResult {
    /// Admission is fenced and no operations are pending.
    Quiesced,
    /// Admission is fenced, but previously admitted operations remain active.
    Busy {
        /// Point-in-time number of pending logical operations.
        pending: usize,
    },
}

/// Shared ownership token for one admitted logical operation.
///
/// A successful [`OperationState::acquire`] increments the pending count once.
/// Cloning this guard does not increment it again. Unless any clone calls
/// [`Self::release`], the count is decremented when the final clone drops.
#[derive(Clone)]
pub(crate) struct OperationGuard {
    inner: Arc<OperationGuardInner>,
}

struct OperationGuardInner {
    state: OperationState,
    released: AtomicBool,
}

impl OperationState {
    /// Admit one logical operation and increment the pending count.
    ///
    /// The mode check and increment share the same lock as
    /// [`Self::enter_quiescing`], so an operation is either admitted before the
    /// quiescing fence or rejected after it; it cannot cross the transition.
    pub(crate) fn acquire(&self) -> Result<OperationGuard, AcquireOperationError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.mode == Mode::Quiescing {
            return Err(AcquireOperationError::Quiescing);
        }
        inner.pending += 1;
        Ok(OperationGuard {
            inner: Arc::new(OperationGuardInner {
                state: self.clone(),
                released: AtomicBool::new(false),
            }),
        })
    }

    /// Fence new operations and report the current pending count.
    ///
    /// The state is latched to quiescing before the count is inspected. A
    /// [`QuiesceResult::Busy`] result therefore does not roll back admission,
    /// wait for the reported operations, or arrange a later notification. The
    /// caller must retry after they finish or call [`Self::resume`] to reopen
    /// admission.
    pub(crate) fn enter_quiescing(&self) -> QuiesceResult {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.mode = Mode::Quiescing;
        if inner.pending == 0 {
            QuiesceResult::Quiesced
        } else {
            QuiesceResult::Busy {
                pending: inner.pending,
            }
        }
    }

    /// Reopen operation admission without changing the pending count.
    ///
    /// This is the explicit recovery transition after a completed, failed, or
    /// aborted quiesce attempt.
    pub(crate) fn resume(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).mode = Mode::Open;
    }

    /// Return whether new operations are currently fenced.
    ///
    /// This is only a snapshot; unlike [`Self::acquire`], it does not reserve
    /// admission for a new operation.
    pub(crate) fn is_quiescing(&self) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).mode == Mode::Quiescing
    }

    /// Return whether admission is fenced and no operations remain pending.
    pub(crate) fn is_quiesced(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.mode == Mode::Quiescing && inner.pending == 0
    }

    fn release_one(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.pending = inner.pending.saturating_sub(1);
    }

    #[cfg(test)]
    pub(crate) fn pending(&self) -> usize {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).pending
    }
}

impl OperationGuard {
    /// Release this logical operation before the final guard clone drops.
    ///
    /// Release is shared by all clones and idempotent: the first call
    /// decrements the pending count, and later calls or drops do nothing.
    pub(crate) fn release(&self) {
        if !self.inner.released.swap(true, Ordering::AcqRel) {
            self.inner.state.release_one();
        }
    }
}

impl Drop for OperationGuardInner {
    fn drop(&mut self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.state.release_one();
        }
    }
}

#[cfg(test)]
mod tests;
