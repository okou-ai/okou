use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::idle_pool::ParkingGate;
use crate::lifecycle::{LifecycleController, RunnerMode, SoftDrainOutcome};
use crate::run_cancellation::RunCancellationRegistry;

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
/// watch channel and observed by [`SignalController`] as soon as its task
/// is spawned.
pub(super) struct EarlySignals {
    sigterm: tokio::signal::unix::Signal,
    sigint: tokio::signal::unix::Signal,
    sigusr1: tokio::signal::unix::Signal,
    sigusr2: tokio::signal::unix::Signal,
}

impl EarlySignals {
    /// Register the four lifecycle signals (SIGTERM/SIGINT/SIGUSR1/SIGUSR2)
    /// so they don't fall to their default Term disposition during startup.
    ///
    /// Each `signal()` both installs the process-wide `sigaction` handler
    /// (idempotent via `OnceCell`) and subscribes a fresh watch receiver.
    /// Bind them via `let` rather than a struct literal so that if a later
    /// call fails with `?`, the already-subscribed earlier receivers are
    /// dropped (and unsubscribed) on the error path — obvious at a glance.
    pub(super) fn register() -> std::io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        let sigterm = signal(SignalKind::terminate())?;
        let sigint = signal(SignalKind::interrupt())?;
        let sigusr1 = signal(SignalKind::user_defined1())?;
        let sigusr2 = signal(SignalKind::user_defined2())?;
        Ok(Self {
            sigterm,
            sigint,
            sigusr1,
            sigusr2,
        })
    }
}

/// Signal-driven mode channel shared between the signal handler task and
/// the main run loop.
pub(crate) struct SignalController {
    pub mode_rx: tokio::sync::watch::Receiver<RunnerMode>,
    pub lifecycle: LifecycleController,
    /// Spawned signal-handler task. `None` for test overrides where no real
    /// task was spawned. Teardown aborts and awaits this handle so the task
    /// releases its signal stream subscriptions before `run()` returns. If
    /// `run()` is externally cancelled before teardown, dropping this wrapper
    /// still aborts the task so it cannot outlive its runner.
    pub handler_task: Option<SignalHandlerTask>,
}

pub(crate) struct SignalHandlerTask {
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl SignalHandlerTask {
    pub(crate) fn new(handle: tokio::task::JoinHandle<()>) -> Self {
        Self {
            handle: Some(handle),
        }
    }

    pub(super) async fn abort_and_wait(mut self) -> Result<(), tokio::task::JoinError> {
        let Some(handle) = self.handle.take() else {
            return Ok(());
        };
        handle.abort();
        handle.await
    }

    async fn wait(&mut self) -> Result<(), String> {
        match self.handle.as_mut() {
            Some(handle) => handle.await.map_err(|error| error.to_string()),
            None => Err("signal handler task handle missing".to_string()),
        }
    }
}

impl Drop for SignalHandlerTask {
    fn drop(&mut self) {
        if let Some(handle) = &self.handle {
            handle.abort();
        }
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
    pub(super) fn spawn(
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
        crate::ids::RunId,
        crate::run_cancellation::RunCancellationHandle,
    )>,
) {
    futures_util::future::join_all(handles.into_iter().map(|(run_id, handle)| async move {
        info!(run_id = %run_id, "cancelling active job for hard shutdown");
        handle.request_hard_cancellation().await;
    }))
    .await;
}

runner_test_group!(cmd_start; #[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::ids::RunId;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };

    const EARLY_SIGNAL_CHILD_ENV: &str = "OKOU_RUNNER_EARLY_SIGNAL_TEST";
    const EARLY_SIGTERM_CHILD: &str =
        "cmd::start::signals::tests::early_sigterm_buffered_before_spawn_child";
    const EARLY_SIGINT_CHILD: &str =
        "cmd::start::signals::tests::early_sigint_buffered_before_spawn_child";
    const EARLY_SIGUSR1_CHILD: &str =
        "cmd::start::signals::tests::early_sigusr1_buffered_before_spawn_child";
    const EARLY_SIGUSR2_CHILD: &str =
        "cmd::start::signals::tests::early_sigusr2_buffered_before_spawn_child";

    #[tokio::test]
    async fn hard_cancellation_dispatch_does_not_serialize_transfer_gate_waits() {
        let blocked_run_id = RunId::new_v4();
        let ready_run_id = RunId::new_v4();
        let blocked = crate::run_cancellation::RunCancellationHandle::new();
        let ready = crate::run_cancellation::RunCancellationHandle::new();
        let transfer_guard = blocked.transfer_guard().await;
        let ready_token = ready.token();
        let blocked_token = blocked.token();
        let dispatch = tokio::spawn(dispatch_hard_cancellations(vec![
            (blocked_run_id, blocked),
            (ready_run_id, ready),
        ]));

        tokio::time::timeout(Duration::from_secs(1), ready_token.cancelled())
            .await
            .expect("an unrelated transfer gate must not delay hard cancellation");
        assert!(!blocked_token.is_cancelled());

        drop(transfer_guard);
        dispatch.await.unwrap();
        assert!(blocked_token.is_cancelled());
    }

    #[derive(Clone, Copy)]
    enum EarlySignalScenario {
        Terminate,
        Interrupt,
        Drain,
        Resume,
    }

    impl EarlySignalScenario {
        fn signal(self) -> nix::sys::signal::Signal {
            match self {
                Self::Terminate => nix::sys::signal::Signal::SIGTERM,
                Self::Interrupt => nix::sys::signal::Signal::SIGINT,
                Self::Drain => nix::sys::signal::Signal::SIGUSR1,
                Self::Resume => nix::sys::signal::Signal::SIGUSR2,
            }
        }

        fn expected_mode(self) -> RunnerMode {
            match self {
                Self::Terminate | Self::Interrupt => RunnerMode::Stopping,
                Self::Drain => RunnerMode::Draining,
                Self::Resume => RunnerMode::Running,
            }
        }
    }

    /// Regression coverage for issues #10416 and #25211: every lifecycle
    /// signal raised after registration but before the consumer starts must
    /// reach its controller branch. Each signal runs in a separate child
    /// because a missing registration restores its terminating disposition.
    #[tokio::test]
    async fn early_lifecycle_signals_buffer_before_spawn() {
        for (child_test, scenario) in [
            (EARLY_SIGTERM_CHILD, "sigterm"),
            (EARLY_SIGINT_CHILD, "sigint"),
            (EARLY_SIGUSR1_CHILD, "sigusr1"),
            (EARLY_SIGUSR2_CHILD, "sigusr2"),
        ] {
            run_ignored_child_test(
                child_test,
                (EARLY_SIGNAL_CHILD_ENV, scenario),
                &[],
                Duration::from_secs(5),
            )
            .await;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "spawned by early_lifecycle_signals_buffer_before_spawn"]
    async fn early_sigterm_buffered_before_spawn_child() {
        if !ignored_child_test_env_guard_enabled((EARLY_SIGNAL_CHILD_ENV, "sigterm")) {
            return;
        }
        assert_early_signal_buffered(EarlySignalScenario::Terminate).await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "spawned by early_lifecycle_signals_buffer_before_spawn"]
    async fn early_sigint_buffered_before_spawn_child() {
        if !ignored_child_test_env_guard_enabled((EARLY_SIGNAL_CHILD_ENV, "sigint")) {
            return;
        }
        assert_early_signal_buffered(EarlySignalScenario::Interrupt).await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "spawned by early_lifecycle_signals_buffer_before_spawn"]
    async fn early_sigusr1_buffered_before_spawn_child() {
        if !ignored_child_test_env_guard_enabled((EARLY_SIGNAL_CHILD_ENV, "sigusr1")) {
            return;
        }
        assert_early_signal_buffered(EarlySignalScenario::Drain).await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "spawned by early_lifecycle_signals_buffer_before_spawn"]
    async fn early_sigusr2_buffered_before_spawn_child() {
        if !ignored_child_test_env_guard_enabled((EARLY_SIGNAL_CHILD_ENV, "sigusr2")) {
            return;
        }
        assert_early_signal_buffered(EarlySignalScenario::Resume).await;
    }

    async fn assert_early_signal_buffered(scenario: EarlySignalScenario) {
        let signals = EarlySignals::register().expect("register");

        nix::sys::signal::raise(scenario.signal()).expect("raise lifecycle signal");

        let cancel = CancellationToken::new();
        let controller = SignalController::spawn(
            cancel.clone(),
            RunCancellationRegistry::new(),
            signals,
            ParkingGate::new_open(),
        );
        let mut mode_rx = controller.mode_rx;

        if matches!(scenario, EarlySignalScenario::Resume) {
            assert_eq!(
                controller.lifecycle.enter_soft_drain(),
                SoftDrainOutcome::EnteredDraining
            );
            assert_eq!(
                controller.lifecycle.mark_startup_ready(),
                RunnerMode::Draining
            );
            assert_eq!(*mode_rx.borrow_and_update(), RunnerMode::Draining);
        }

        match scenario {
            EarlySignalScenario::Terminate | EarlySignalScenario::Interrupt => {
                tokio::time::timeout(Duration::from_secs(2), cancel.cancelled())
                    .await
                    .expect("buffered stopping signal should cancel within 2s");
            }
            EarlySignalScenario::Drain | EarlySignalScenario::Resume => {
                tokio::time::timeout(Duration::from_secs(2), mode_rx.changed())
                    .await
                    .expect("buffered lifecycle signal should change mode within 2s")
                    .expect("mode channel closed");
            }
        }
        assert_eq!(*mode_rx.borrow(), scenario.expected_mode());

        let handler_task = controller
            .handler_task
            .expect("real signal controller should own a handler task");
        let result = handler_task
            .abort_and_wait()
            .await
            .expect_err("signal handler should be cancelled");
        assert!(result.is_cancelled());
    }

    #[tokio::test]
    async fn recv_handler_task_clears_completed_task() {
        let mut handler_task = Some(SignalHandlerTask::new(tokio::spawn(async {})));

        recv_handler_task(&mut handler_task)
            .await
            .expect("completed handler task");

        assert!(handler_task.is_none());
    }

    #[tokio::test]
    async fn recv_handler_task_reports_cancelled_task() {
        let task = tokio::spawn(std::future::pending::<()>());
        task.abort();
        let mut handler_task = Some(SignalHandlerTask::new(task));

        let result = recv_handler_task(&mut handler_task)
            .await
            .expect_err("cancelled handler task should be reported");

        assert!(result.contains("cancelled"));
        assert!(handler_task.is_none());
    }

    #[tokio::test]
    async fn dropping_handler_task_aborts_task() {
        struct NotifyOnDrop(Arc<tokio::sync::Notify>);

        impl Drop for NotifyOnDrop {
            fn drop(&mut self) {
                self.0.notify_one();
            }
        }

        let started = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(tokio::sync::Notify::new());
        let task = {
            let started = Arc::clone(&started);
            let dropped = Arc::clone(&dropped);
            tokio::spawn(async move {
                let _guard = NotifyOnDrop(dropped);
                started.notify_one();
                std::future::pending::<()>().await;
            })
        };
        let handler_task = SignalHandlerTask::new(task);
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .expect("signal handler test task should start");

        drop(handler_task);

        tokio::time::timeout(Duration::from_secs(2), dropped.notified())
            .await
            .expect("dropping signal handler task should abort the task");
    }

    /// `handle_stopping_signal` idempotency: a repeat invocation takes the
    /// "already Stopping" guard and returns without re-entering the registry's
    /// hard-stop barrier or re-cancelling `cancel`.
    #[tokio::test]
    async fn stopping_signal_repeat_is_idempotent() {
        use crate::idle_pool::ParkingState;

        let gate = ParkingGate::new_open();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        let cancel = CancellationToken::new();
        let tokens = RunCancellationRegistry::new();

        // First call: transitions, cancels main cancel.
        handle_stopping_signal("SIGTERM", &cancel, &tokens, &lifecycle).await;
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);
        assert!(cancel.is_cancelled());

        // A registration after the first hard-stop barrier is cancelled by
        // registration itself; repeat-signal handling need not rescan it.
        let registration = tokens.register(RunId::new_v4()).await.unwrap();
        assert!(registration.is_cancelled());

        // Repeat call: must early-return on the already-Stopping guard.
        handle_stopping_signal("SIGTERM", &cancel, &tokens, &lifecycle).await;
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);
        assert!(cancel.is_cancelled());
    }
});
