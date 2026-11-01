use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};
use tracing::{info, warn};

use crate::idle_pool::ParkingGate;
use crate::lifecycle::{LifecycleController, RunnerMode, SoftDrainOutcome};
use runner_provider::RunCancellationRegistry;

/// Pre-registered signal streams.
///
/// Tokio's `signal()` installs the process-wide `sigaction` handler on its
/// first call per signal kind; before that call, the default disposition
/// (Term for all four of these) applies. If a drain SIGUSR1 arrives during
/// startup (e.g. `service install` immediately followed by `service drain`
/// while the runner is still warming factories), the default action kills
/// the process and systemd restarts the unit with no one to drain it —
/// the new PID stays `Running` forever. See issue #10416.
///
/// Registering all four streams at the top of `run_start` before any
/// slow work (config load, runtime/factory boot) closes the race: the
/// sigaction handler is in place and the listener exists, so signals
/// arriving at any point after registration are queued in the listener's
/// watch channel and observed by the runtime signal controller as soon as its task
/// is spawned.
pub struct EarlySignals {
    sigterm: tokio::signal::unix::Signal,
    sigint: tokio::signal::unix::Signal,
    sigusr1: tokio::signal::unix::Signal,
    sigusr2: tokio::signal::unix::Signal,
}

impl EarlySignals {
    /// Take ownership of the four streams already registered by executable boot.
    /// Constructing this group performs no registration or task spawning.
    pub fn new(
        sigterm: tokio::signal::unix::Signal,
        sigint: tokio::signal::unix::Signal,
        sigusr1: tokio::signal::unix::Signal,
        sigusr2: tokio::signal::unix::Signal,
    ) -> Self {
        Self {
            sigterm,
            sigint,
            sigusr1,
            sigusr2,
        }
    }
}

/// Signal-driven mode channel shared between the signal handler task and
/// the main run loop.
pub struct SignalController {
    pub(super) mode_rx: tokio::sync::watch::Receiver<RunnerMode>,
    pub(super) lifecycle: LifecycleController,
    /// Spawned signal-handler task. `None` for test overrides where no real
    /// task was spawned. Teardown aborts and awaits this handle so the task
    /// releases its signal stream subscriptions before `run()` returns. If
    /// `run()` is externally cancelled before teardown, dropping this wrapper
    /// still aborts the task so it cannot outlive its runner.
    pub(super) handler_task: Option<SignalHandlerTask>,
}

#[cfg(any(test, feature = "test-support"))]
impl SignalController {
    /// Observe mode changes in the executable's real early-signal regressions.
    pub fn mode_receiver(&self) -> tokio::sync::watch::Receiver<RunnerMode> {
        self.mode_rx.clone()
    }

    /// Drive readiness/drain transitions through the existing lifecycle owner.
    pub fn lifecycle(&self) -> &LifecycleController {
        &self.lifecycle
    }

    /// Transfer the real task to the test caller for explicit abort and join.
    pub fn take_handler_task(&mut self) -> Option<SignalHandlerTask> {
        self.handler_task.take()
    }
}

pub struct SignalHandlerTask {
    handle: AbortOnDropHandle<()>,
}

impl SignalHandlerTask {
    pub(crate) fn new(handle: tokio::task::JoinHandle<()>) -> Self {
        Self {
            handle: AbortOnDropHandle::new(handle),
        }
    }

    pub async fn abort_and_wait(self) -> Result<(), tokio::task::JoinError> {
        self.handle.abort();
        self.handle.await
    }

    async fn wait(&mut self) -> Result<(), String> {
        (&mut self.handle).await.map_err(|error| error.to_string())
    }
}

impl SignalController {
    /// Spawn the signal-handler task and return a controller handle.
    ///
    /// Signal semantics:
    /// - **SIGUSR1** (drain): from `Starting` or `Running`, close parking for
    ///   soft drain, then send `Draining`. From `Draining`, treat as an
    ///   idempotent no-op. Ignored from `Stopping` / `Stopped`.
    /// - **SIGUSR2** (resume): after startup readiness, from `Draining`,
    ///   reopen parking, then send `Running` (resume normal discovery).
    ///   Ignored from `Starting` / `Running` / `Stopping` / `Stopped`.
    /// - **SIGTERM / SIGINT** (hard): close parking, send `Stopping`, cancel
    ///   every in-flight job's token, cancel the discovery token. Bypasses the
    ///   soft drain so `systemctl stop` exits promptly rather than waiting up
    ///   to `JOB_TIMEOUT = 2h` for jobs to finish naturally.
    ///
    /// ## Race handling
    ///
    /// `handle_stopping_signal` closes parking and sends Stopping **before**
    /// entering the cancellation registry's hard-stop barrier. Registrations
    /// before the barrier are included in its snapshot; registrations after
    /// the barrier are returned already cancelled. The main loop also re-reads
    /// `mode_rx` after registration so Stopping cancellation precedes claim.
    ///
    /// ## Lifetime
    ///
    /// The spawned task owns the registered signal streams and normally runs
    /// until `run()` teardown aborts and awaits `handler_task`. Test overrides
    /// construct a controller with no real handler task.
    pub fn spawn(
        cancel: CancellationToken,
        cancel_tokens: RunCancellationRegistry,
        signals: EarlySignals,
        parking_gate: ParkingGate,
    ) -> Self {
        let (mode_tx, mode_rx) = tokio::sync::watch::channel(RunnerMode::Starting);
        let lifecycle = LifecycleController::new(mode_tx, parking_gate);
        let lifecycle_for_task = lifecycle.clone();
        let EarlySignals {
            mut sigterm,
            mut sigint,
            mut sigusr1,
            mut sigusr2,
        } = signals;
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = sigterm.recv() => {
                        handle_stopping_signal("SIGTERM", &cancel, &cancel_tokens, &lifecycle_for_task).await;
                    }
                    _ = sigint.recv() => {
                        handle_stopping_signal("SIGINT", &cancel, &cancel_tokens, &lifecycle_for_task).await;
                    }
                    _ = sigusr1.recv() => {
                        handle_drain_signal(&lifecycle_for_task);
                    }
                    _ = sigusr2.recv() => {
                        handle_resume_signal(&lifecycle_for_task);
                    }
                }
            }
        });
        Self {
            mode_rx,
            lifecycle,
            handler_task: Some(SignalHandlerTask::new(handle)),
        }
    }
}

/// Await a signal-handler task, or pend forever when tests supply no task.
///
/// This mirrors the retry-task helper used by the main loop: keeping the
/// `Option` outside the future lets `tokio::select!` watch the task without
/// taking ownership unless it actually completes.
pub(super) async fn recv_handler_task(
    handler_task: &mut Option<SignalHandlerTask>,
) -> Result<(), String> {
    match handler_task {
        Some(task) => {
            let result = task.wait().await;
            *handler_task = None;
            result
        }
        None => std::future::pending().await,
    }
}

pub(super) fn handle_drain_signal(lifecycle: &LifecycleController) {
    match lifecycle.enter_soft_drain() {
        SoftDrainOutcome::EnteredDraining => {
            info!("received SIGUSR1, entering Draining (soft drain)");
        }
        SoftDrainOutcome::AlreadyDraining => {
            info!("received SIGUSR1 while already Draining");
        }
        SoftDrainOutcome::Ignored(mode) => {
            warn!(mode = ?mode, "SIGUSR1 ignored — soft drain is no longer actionable");
        }
    }
}

pub(super) fn handle_resume_signal(lifecycle: &LifecycleController) {
    let current = lifecycle.current_mode();
    if !lifecycle.resume_from_soft_drain() {
        warn!(mode = ?current, "SIGUSR2 ignored — only valid from ready Draining");
        return;
    }
    info!("received SIGUSR2, resuming to Running");
}

pub(super) async fn handle_stopping_signal(
    name: &str,
    cancel: &CancellationToken,
    cancel_tokens: &RunCancellationRegistry,
    lifecycle: &LifecycleController,
) {
    if lifecycle.current_mode() == RunnerMode::Stopping {
        lifecycle.close_parking();
        warn!(signal = name, "already Stopping, ignoring repeat");
        return;
    }
    info!(signal = name, "initiating hard shutdown");
    // Publish Stopping before entering the registry's hard-stop barrier.
    // Registrations before the barrier are included in its snapshot; later
    // registrations are returned already cancelled. The discovery path also
    // rechecks mode after registration so cancellation still precedes claim.
    lifecycle.hard_stop();
    let handles = cancel_tokens.begin_hard_stop().await;
    let count = handles.len();
    dispatch_hard_cancellations(handles).await;
    info!(active_jobs = count, "dispatched per-job cancellations");
    cancel.cancel();
}

async fn dispatch_hard_cancellations(
    handles: Vec<(
        runner_types::ids::RunId,
        runner_provider::RunCancellationHandle,
    )>,
) {
    futures_util::future::join_all(handles.into_iter().map(|(run_id, handle)| async move {
        info!(run_id = %run_id, "cancelling active job for hard shutdown");
        handle.request_hard_cancellation().await;
    }))
    .await;
}

#[cfg(test)]
mod tests;
