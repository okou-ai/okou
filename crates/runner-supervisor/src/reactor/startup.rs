//! Startup owns its services until ready publication or completed rollback.
//! The running reactor receives the same concrete handles after this boundary.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Semaphore;
use tracing::warn;

use super::error::{ReactorError as RunnerError, ReactorResult as RunnerResult};
use super::factory_lifecycle::{shutdown_factory_instances, start_factories};
use super::signals::{SignalController, handle_stopping_signal};
use super::{
    ProviderState, ProxyState, RunPaths, RunnerInfo, RunnerSharedState, SandboxRuntimeConfig,
    ShutdownHandles, SignalSource, SignalState, WssConfig, abort_signal_handler_task, runner_wss,
};
use crate::SharedFactory;
use crate::executor::ExecutorConfig;
use crate::idle_prune_control::PruneIdleListener;
use crate::lifecycle::RunnerMode;

/// Existing boot resources move together into startup and back to the reactor.
pub(super) struct StartupResources {
    // Drop dependent services before runtime even on an abandoned startup.
    // Their existing wrappers initiate cleanup; Drop is not a completed join.
    pub shutdown: ShutdownHandles,
    pub proxy: ProxyState,
    pub sandbox_runtime: SandboxRuntimeConfig,
}

pub(super) struct StartupContext<'a> {
    pub runner: &'a RunnerInfo,
    pub paths: &'a RunPaths,
    pub shared: &'a RunnerSharedState,
    pub provider: &'a ProviderState,
    pub exec_config: &'a ExecutorConfig,
}

/// Constructed only after all required startup work and ready status succeed.
pub(super) struct StartedRunner {
    pub resources: StartupResources,
    pub signal: SignalController,
    pub wss_task: Option<runner_wss::AcceptTask>,
    pub wss_failed: Option<Arc<AtomicBool>>,
    pub factories: BTreeMap<String, (SharedFactory, bool)>,
    pub prune_listener: PruneIdleListener,
    pub prune_admission: Arc<Semaphore>,
    pub startup_mode: RunnerMode,
}

struct StartupOwner {
    // Keep factory/listener/signal custody ahead of their backing resources
    // in the default field drop order, without adding another cleanup task.
    factories: BTreeMap<String, (SharedFactory, bool)>,
    wss_failed: Option<Arc<AtomicBool>>,
    wss_task: Option<runner_wss::AcceptTask>,
    signal: SignalController,
    resources: StartupResources,
}

impl StartupOwner {
    async fn stop_listener(&mut self) {
        if let Some(task) = self.wss_task.take() {
            task.stop().await;
        }
    }

    fn listener_failed(&self) -> bool {
        self.wss_failed
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
            || self
                .wss_task
                .as_ref()
                .is_some_and(runner_wss::AcceptTask::is_finished)
    }

    /// Consume startup custody only after its dependent work has been joined.
    async fn rollback(mut self, ctx: &StartupContext<'_>, context: &'static str) {
        self.stop_listener().await;
        if !self.factories.is_empty()
            && let Err(error) = shutdown_factory_instances(&mut self.factories, None).await
        {
            if context == "startup_status_persistence_failure" {
                warn!(
                    %error,
                    "failed to shut down factories after startup status persistence failure"
                );
            } else {
                warn!(%error, "failed to shut down factories after WSS startup failure");
            }
        }
        let StartupResources {
            sandbox_runtime: SandboxRuntimeConfig { mut runtime },
            proxy:
                ProxyState {
                    mut mitm,
                    mitm_crash_rx: _mitm_crash_rx,
                },
            shutdown:
                ShutdownHandles {
                    kmsg_handle,
                    dns_handle,
                    mut memory_prefetch,
                },
        } = self.resources;
        memory_prefetch.cancel();
        memory_prefetch.drain().await;
        ctx.provider.provider.shutdown().await;
        if let Err(error) = dns_handle.stop().await {
            warn!(%error, "failed to clean up network-log helper after startup failure");
        }
        runtime.shutdown().await;
        if let Err(e) = mitm.kill_now().await {
            warn!(error = %e, context, "failed to kill proxy after startup failed");
        }
        if let Err(error) = kmsg_handle.stop().await {
            warn!(%error, "failed to clean up network-log helper after startup failure");
        }
        if let Err(error) = ctx.shared.status.set_mode(RunnerMode::Stopped).await {
            warn!(%error, context, "failed to persist stopped status after startup failure");
        }
        if let Some(task) = self.signal.handler_task.take() {
            abort_signal_handler_task(task, context).await;
        }
    }
}

/// None means readiness was cancelled without a failed listener, after rollback.
pub(super) async fn start(
    resources: StartupResources,
    ctx: StartupContext<'_>,
    signals: SignalState,
    wss: Option<WssConfig>,
) -> RunnerResult<Option<StartedRunner>> {
    let signal = match signals.signal_source {
        SignalSource::Real(signals) => SignalController::spawn(
            ctx.provider.cancel.clone(),
            ctx.provider.cancel_tokens.clone(),
            signals,
            ctx.shared.parking_gate.clone(),
        ),
        #[cfg(test)]
        SignalSource::Override(controller) => controller,
    };
    let mut startup = StartupOwner {
        resources,
        signal,
        wss_task: None,
        wss_failed: None,
        factories: BTreeMap::new(),
    };

    // Both failures precede WSS and own the same startup resources.
    let prune_listener = match ctx
        .shared
        .status
        .write_initial()
        .await
        .map_err(|error| {
            (
                RunnerError::Internal(format!("persist initial runner status: {error}")),
                "initial_status_persistence_failure",
            )
        })
        .and_then(|()| {
            PruneIdleListener::bind(&ctx.paths.home, &ctx.paths.base_dir, ctx.runner.identity)
                .map_err(|error| (RunnerError::from(error), "prune_control_startup_failure"))
        }) {
        Ok(listener) => listener,
        Err((error, context)) => {
            startup.rollback(&ctx, context).await;
            return Err(error);
        }
    };
    let prune_admission = Arc::new(Semaphore::new(1));

    // Required binding and bounded admission precede readiness and claims.
    let wss_started = match wss {
        Some(config) => match runner_wss::start(
            config,
            ctx.runner.identity.runner_id(),
            ctx.exec_config.guest_duplex.clone(),
            ctx.shared,
            ctx.provider,
            &startup.signal.lifecycle,
        ) {
            Ok(listener) => {
                startup.wss_task = Some(listener.task);
                startup.wss_failed = Some(listener.failed);
                Some(listener.started)
            }
            Err(error) => {
                startup.rollback(&ctx, "wss_socket_startup_failure").await;
                return Err(RunnerError::Internal(format!(
                    "bind required Runner WSS listener: {error}"
                )));
            }
        },
        None => None,
    };
    if let Some(started) = wss_started
        && started.await.is_err()
    {
        startup.rollback(&ctx, "wss_accept_startup_failure").await;
        return Err(RunnerError::Internal(
            "required Runner WSS accept loop failed to start".into(),
        ));
    }

    let readiness: RunnerResult<()> = if let Some(task) = startup.wss_task.as_mut() {
        tokio::select! {
            result = ctx.provider.provider.prepare_startup_readiness() => result.map_err(Into::into),
            result = task.wait() => Err(RunnerError::Internal(format!("required Runner WSS accept loop stopped during startup: {result:?}"))),
        }
    } else {
        ctx.provider
            .provider
            .prepare_startup_readiness()
            .await
            .map_err(Into::into)
    };
    if let Err(error) = readiness {
        let listener_failed = startup.listener_failed();
        startup.stop_listener().await;
        let startup_readiness_cancelled = ctx.provider.cancel.is_cancelled();
        let cleanup_reason = if startup_readiness_cancelled {
            "provider_startup_readiness_cancelled"
        } else {
            "provider_startup_readiness_failure"
        };
        startup.rollback(&ctx, cleanup_reason).await;
        if startup_readiness_cancelled && !listener_failed {
            return Ok(None);
        }
        return Err(error);
    }

    let (factory_result, startup_listener_error) = if let Some(task) = startup.wss_task.as_mut() {
        let factories = start_factories(
            &ctx.runner.profiles,
            startup.resources.sandbox_runtime.runtime.as_mut(),
        );
        tokio::pin!(factories);
        tokio::select! {
            result = &mut factories => (result, None),
            result = task.wait() => {
                let error = RunnerError::Internal(format!(
                    "required Runner WSS accept loop stopped during factory startup: {result:?}"
                ));
                // Listener failure already closes admission and changes lifecycle.
                // Keep external factory work owned until it returns: dropping it
                // bypasses partial-factory cleanup and detaches physical IO over
                // shared runtime resources. Rollback joins every completed factory
                // before runtime teardown.
                (factories.await, Some(error))
            }
        }
    } else {
        (
            start_factories(
                &ctx.runner.profiles,
                startup.resources.sandbox_runtime.runtime.as_mut(),
            )
            .await,
            None,
        )
    };
    startup.factories = match factory_result {
        Ok(factories) => factories,
        Err(error) => {
            startup.rollback(&ctx, "factory_startup_failure").await;
            return Err(error);
        }
    };
    // A dead listener cannot be followed by healthy status, heartbeat or claims.
    if startup_listener_error.is_some() || startup.listener_failed() {
        startup.rollback(&ctx, "wss_accept_startup_failure").await;
        return Err(startup_listener_error.unwrap_or_else(|| {
            RunnerError::Internal("required Runner WSS accept loop exited during startup".into())
        }));
    }
    let startup_mode = startup.signal.lifecycle.mark_startup_ready();
    if let Err(error) = ctx.shared.status.set_mode(startup_mode).await {
        startup.stop_listener().await;
        handle_stopping_signal(
            "startup status persistence failure",
            &ctx.provider.cancel,
            &ctx.provider.cancel_tokens,
            &startup.signal.lifecycle,
        )
        .await;
        startup
            .rollback(&ctx, "startup_status_persistence_failure")
            .await;
        return Err(RunnerError::Internal(format!(
            "persist ready runner status: {error}"
        )));
    }

    let StartupOwner {
        resources,
        signal,
        wss_task,
        wss_failed,
        factories,
    } = startup;
    Ok(Some(StartedRunner {
        resources,
        signal,
        wss_task,
        wss_failed,
        factories,
        prune_listener,
        prune_admission,
        startup_mode,
    }))
}
