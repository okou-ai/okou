//! Executable early registration policy; the runtime owns stream consumption.

use runner_supervisor::reactor::EarlySignals;

/// Subscribe before configuration/home/runtime work. Each preceding receiver
/// drops if a subsequent subscription fails, preserving the startup error path.
pub(super) fn register_early_signals() -> std::io::Result<EarlySignals> {
    use tokio::signal::unix::{SignalKind, signal};
    let sigterm = signal(SignalKind::terminate())?;
    let sigint = signal(SignalKind::interrupt())?;
    let sigusr1 = signal(SignalKind::user_defined1())?;
    let sigusr2 = signal(SignalKind::user_defined2())?;
    Ok(EarlySignals::new(sigterm, sigint, sigusr1, sigusr2))
}

#[cfg(test)]
mod tests {
    use runner_lifecycle::idle_pool::ParkingGate;
    use runner_lifecycle::lifecycle::{RunnerMode, SoftDrainOutcome};
    use runner_provider::RunCancellationRegistry;
    use runner_supervisor::test_support::SignalController;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    use super::*;
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
        let signals = register_early_signals().expect("register");

        nix::sys::signal::raise(scenario.signal()).expect("raise lifecycle signal");

        let cancel = CancellationToken::new();
        let mut controller = SignalController::spawn(
            cancel.clone(),
            RunCancellationRegistry::new(),
            signals,
            ParkingGate::new_open(),
        );
        let mut mode_rx = controller.mode_receiver();

        if matches!(scenario, EarlySignalScenario::Resume) {
            assert_eq!(
                controller.lifecycle().enter_soft_drain(),
                SoftDrainOutcome::EnteredDraining
            );
            assert_eq!(
                controller.lifecycle().mark_startup_ready(),
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
            .take_handler_task()
            .expect("real signal controller should own a handler task");
        let result = handler_task
            .abort_and_wait()
            .await
            .expect_err("signal handler should be cancelled");
        assert!(result.is_cancelled());
    }
}
