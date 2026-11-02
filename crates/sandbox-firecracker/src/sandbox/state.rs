use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, MutexGuard};

use tokio::sync::watch;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxState {
    Created = 0,
    Running = 1,
    Stopping = 2,
    Stopped = 3,
    Crashed = 4,
}

impl SandboxState {
    pub(super) fn from_u8(v: u8) -> Self {
        debug_assert!(v <= 4, "invalid SandboxState: {v}");
        match v {
            0 => Self::Created,
            1 => Self::Running,
            2 => Self::Stopping,
            3 => Self::Stopped,
            4 => Self::Crashed,
            _ => Self::Stopped,
        }
    }
}

impl std::fmt::Display for SandboxState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Created => f.write_str("created"),
            Self::Running => f.write_str("running"),
            Self::Stopping => f.write_str("stopping"),
            Self::Stopped => f.write_str("stopped"),
            Self::Crashed => f.write_str("crashed"),
        }
    }
}

/// Wait until the durable lifecycle stream observes the backend process exit.
pub(super) async fn wait_for_process_exit(
    mut state_rx: watch::Receiver<SandboxState>,
) -> SandboxState {
    loop {
        let state = *state_rx.borrow_and_update();
        if matches!(state, SandboxState::Stopped | SandboxState::Crashed) {
            return state;
        }
        if state_rx.changed().await.is_err() {
            return *state_rx.borrow();
        }
    }
}

/// Wait until the durable lifecycle stream observes an unexpected backend exit.
pub(super) async fn wait_for_backend_crash(mut state_rx: watch::Receiver<SandboxState>) {
    loop {
        if *state_rx.borrow_and_update() == SandboxState::Crashed {
            return;
        }
        if state_rx.changed().await.is_err() {
            return;
        }
    }
}

pub(super) fn state_publish_guard(state_publish_lock: &Mutex<()>) -> MutexGuard<'_, ()> {
    state_publish_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn publish_watch_state(state_tx: &watch::Sender<SandboxState>, state: SandboxState) {
    let _ = state_tx.send_replace(state);
}

pub(super) fn publish_process_state(
    state: &AtomicU8,
    state_publish_lock: &Mutex<()>,
    state_tx: &watch::Sender<SandboxState>,
    next: SandboxState,
) {
    let _guard = state_publish_guard(state_publish_lock);
    state.store(next as u8, Ordering::Release);
    publish_watch_state(state_tx, next);
}

pub(super) fn transition_process_state(
    state: &AtomicU8,
    state_publish_lock: &Mutex<()>,
    state_tx: &watch::Sender<SandboxState>,
    from: SandboxState,
    to: SandboxState,
) -> bool {
    let _guard = state_publish_guard(state_publish_lock);
    let transitioned = state
        .compare_exchange(from as u8, to as u8, Ordering::AcqRel, Ordering::Acquire)
        .is_ok();
    if transitioned {
        publish_watch_state(state_tx, to);
    }
    transitioned
}

#[cfg(test)]
mod tests;
