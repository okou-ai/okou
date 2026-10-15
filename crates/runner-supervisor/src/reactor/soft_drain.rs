//! Observe one soft-drain batch without owning its physical cleanup.
//! Accepted work stays with IdleDestroyTracker through resume and teardown.

use std::sync::Arc;

use tokio::sync::oneshot;

use crate::idle_lifecycle::{IdleCleanupTask, IdleDestroyTracker, SharedIdlePool};
use crate::lifecycle::{LifecycleController, RunnerMode};
use crate::status::StatusTracker;

pub(super) struct SoftDrain {
    state: State,
}

enum State {
    NeedsBatch,
    InFlight {
        task: IdleCleanupTask<()>,
        current: bool,
    },
    BatchCompleted,
}

impl SoftDrain {
    pub(super) fn new() -> Self {
        Self {
            state: State::NeedsBatch,
        }
    }

    /// Called in Draining only after in-flight claims have settled.
    pub(super) async fn start_if_needed(
        &mut self,
        tracker: &IdleDestroyTracker,
        pool: &SharedIdlePool,
        status: &Arc<StatusTracker>,
    ) {
        if matches!(self.state, State::NeedsBatch) {
            let task = tracker
                .start_drain(Arc::clone(pool), Arc::clone(status), "draining")
                .await;
            self.state = State::InFlight {
                task,
                current: true,
            };
        }
    }

    /// Resume invalidates this batch but never retracts accepted cleanup.
    pub(super) fn resume(&mut self) {
        match &mut self.state {
            State::InFlight { current, .. } => *current = false,
            _ => self.state = State::NeedsBatch,
        }
    }

    pub(super) fn is_in_flight(&self) -> bool {
        matches!(self.state, State::InFlight { .. })
    }

    /// A completed batch still requires the reactor's pool-locked recheck.
    pub(super) fn batch_completed(&self) -> bool {
        matches!(self.state, State::BatchCompleted)
    }

    pub(super) fn inventory_changed(&mut self) {
        if self.batch_completed() {
            self.state = State::NeedsBatch;
        }
    }

    pub(super) async fn join(&mut self) -> Result<(), oneshot::error::RecvError> {
        match &mut self.state {
            State::InFlight { task, .. } => task.join().await,
            _ => std::future::pending().await,
        }
    }

    /// Apply the selected result after retiring its receiver, then read live mode.
    pub(super) fn complete(
        &mut self,
        result: Result<(), oneshot::error::RecvError>,
        lifecycle: &LifecycleController,
    ) -> Result<(), oneshot::error::RecvError> {
        let current = matches!(self.state, State::InFlight { current: true, .. });
        self.state = State::NeedsBatch;
        if result.is_ok() && current && lifecycle.current_mode() == RunnerMode::Draining {
            self.state = State::BatchCompleted;
        }
        result
    }
}
