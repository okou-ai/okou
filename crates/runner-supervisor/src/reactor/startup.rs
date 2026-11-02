//! Startup owns its services until ready publication or completed rollback.
//! The running reactor receives the same concrete handles after this boundary.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tracing::warn;

use super::error::{ReactorError as RunnerError, ReactorResult as RunnerResult};
use super::factory_lifecycle::{shutdown_factory_instances, start_factories};
use super::home_cache_observation::{
    HomeCacheObservation, InitialHomeCacheObservation, InitialHomeCacheTask,
};
use super::signals::{SignalController, handle_stopping_signal};
use super::{
    ProviderState, ProxyState, RunPaths, RunnerInfo, RunnerSharedState, SandboxRuntimeConfig,
    ShutdownHandles, SignalSource, SignalState, abort_signal_handler_task,
};
use crate::SharedFactory;
use crate::executor::ExecutorConfig;
use crate::heartbeat::{HeartbeatContext, HeartbeatController, HeartbeatProfile};
use crate::idle_prune_control::PruneIdleListener;
use crate::lifecycle::RunnerMode;
use runner_lifecycle::home_image_cache::snapshot::HomeCacheStateSnapshot;
use runner_storage::SandboxOpReporter;

const INITIAL_HOME_CACHE_READINESS_TIMEOUT: Duration = Duration::from_secs(60);

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

pub(super) struct StartupInventory<'a> {
    pub heartbeat: HeartbeatContext,
    pub snapshot: &'a HomeCacheStateSnapshot,
    pub profiles: &'a BTreeMap<String, HeartbeatProfile>,
    pub reporter: Option<&'a SandboxOpReporter>,
    #[cfg(test)]
    pub test_hooks: &'a super::RunTestHooks,
}

/// Constructed only after all required startup work and ready status succeed.
pub(super) struct StartedRunner {
    pub resources: StartupResources,
    pub signal: SignalController,
    pub factories: BTreeMap<String, (SharedFactory, bool)>,
    pub prune_listener: PruneIdleListener,
    pub prune_admission: Arc<Semaphore>,
    pub startup_mode: RunnerMode,
    pub home_cache_observation: HomeCacheObservation,
    pub heartbeat: HeartbeatController,
}

struct StartupOwner {
    // Keep factory/signal custody ahead of their backing resources
    // in the default field drop order, without adding another cleanup task.
    factories: BTreeMap<String, (SharedFactory, bool)>,
    initial_inventory: Option<InitialHomeCacheTask>,
    home_cache_observation: Option<HomeCacheObservation>,
    heartbeat: Option<HeartbeatController>,
    signal: SignalController,
    resources: StartupResources,
}

impl StartupOwner {
    /// Consume startup custody only after its dependent work has been joined.
    async fn rollback(mut self, ctx: &StartupContext<'_>, context: &'static str) {
        if let Some(task) = self.initial_inventory.take() {
            task.abort();
            match task.await {
                Ok((observation, _)) => self.home_cache_observation = Some(observation),
                Err(error) if error.is_cancelled() => {}
                Err(error) => warn!(%error, "failed to join initial home-cache inventory"),
            }
        }
        if let Some(mut observation) = self.home_cache_observation.take() {
            observation.stop_watching();
            if let Err(error) = observation.drain().await {
                warn!(%error, "failed to drain startup home-cache refresh");
            }
        }
        if let Some(mut heartbeat) = self.heartbeat.take() {
            if let Err(error) = heartbeat.drain().await {
                warn!(%error, "failed to drain startup heartbeat");
            }
            // A cancelled request may already have reached the API. Fence it
            // with a later sequence before shutting down its provider.
            heartbeat.into_terminal_heartbeat().send().await;
        }
        if !self.factories.is_empty()
            && let Err(error) = shutdown_factory_instances(&mut self.factories, None).await
        {
            if context == "startup_status_persistence_failure" {
                warn!(
                    %error,
                    "failed to shut down factories after startup status persistence failure"
                );
            } else {
                warn!(%error, context, "failed to shut down factories after startup failure");
            }
        }
        if let Some(cache) = ctx.exec_config.home_cache.as_ref() {
            cache.drain_pressure_reclamation().await;
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
                },
        } = self.resources;
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

/// None means readiness was cancelled, after rollback.
pub(super) async fn start(
    resources: StartupResources,
    ctx: StartupContext<'_>,
    signals: SignalState,
    inventory: StartupInventory<'_>,
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
        factories: BTreeMap::new(),
        initial_inventory: None,
        home_cache_observation: None,
        heartbeat: None,
    };

    // Both early failures own the same startup resources.
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

    startup.initial_inventory = Some(HomeCacheObservation::begin_initialization(
        ctx.exec_config.home_cache.as_ref(),
        inventory.snapshot,
        inventory.profiles,
        ctx.runner.identity,
        inventory.reporter,
        #[cfg(test)]
        inventory.test_hooks,
    ));

    let readiness: RunnerResult<()> = async {
        ctx.provider.provider.prepare_startup_readiness().await?;
        tokio::select! {
            biased;
            () = ctx.provider.cancel.cancelled() => Err(RunnerError::Internal("catalog initialization cancelled".into())),
            result = startup.resources.proxy.mitm.prepare_catalog() => result.map_err(Into::into),
        }
    }
    .await;
    if let Err(error) = readiness {
        let startup_readiness_cancelled = ctx.provider.cancel.is_cancelled();
        let cleanup_reason = if startup_readiness_cancelled {
            "provider_startup_readiness_cancelled"
        } else {
            "provider_startup_readiness_failure"
        };
        startup.rollback(&ctx, cleanup_reason).await;
        if startup_readiness_cancelled {
            return Ok(None);
        }
        return Err(error);
    }

    startup.factories = match start_factories(
        &ctx.runner.profiles,
        startup.resources.sandbox_runtime.runtime.as_mut(),
        ctx.exec_config.home_cache.as_ref(),
    )
    .await
    {
        Ok(factories) => factories,
        Err(error) => {
            startup.rollback(&ctx, "factory_startup_failure").await;
            return Err(error);
        }
    };
    let readiness = {
        let cache_readiness = finish_initial_inventory(
            &mut startup.initial_inventory,
            &mut startup.home_cache_observation,
            &mut startup.heartbeat,
            &startup.signal.lifecycle,
            &inventory,
        );
        let cache_readiness =
            tokio::time::timeout(INITIAL_HOME_CACHE_READINESS_TIMEOUT, cache_readiness);
        tokio::pin!(cache_readiness);
        tokio::select! {
            biased;
            () = ctx.provider.cancel.cancelled() => Err(RunnerError::Internal("initial home-cache readiness cancelled".into())),
            result = &mut cache_readiness => result.unwrap_or_else(|_| Err(RunnerError::Internal("initial home-cache readiness timed out after 60s".into()))),
        }
    };
    if let Err(error) = readiness {
        let cancelled = ctx.provider.cancel.is_cancelled();
        startup
            .rollback(&ctx, "initial_home_cache_readiness_failure")
            .await;
        return if cancelled { Ok(None) } else { Err(error) };
    }
    let startup_mode = startup.signal.lifecycle.mark_startup_ready();
    if let Err(error) = ctx.shared.status.set_mode(startup_mode).await {
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

    match startup {
        StartupOwner {
            resources,
            signal,
            factories,
            initial_inventory: None,
            home_cache_observation: Some(home_cache_observation),
            heartbeat: Some(heartbeat),
        } => Ok(Some(StartedRunner {
            resources,
            signal,
            factories,
            prune_listener,
            prune_admission,
            startup_mode,
            home_cache_observation,
            heartbeat,
        })),
        startup => {
            startup
                .rollback(&ctx, "missing_startup_inventory_owner")
                .await;
            Err(RunnerError::Internal(
                "startup inventory ownership missing after readiness".into(),
            ))
        }
    }
}

async fn finish_initial_inventory(
    task: &mut Option<InitialHomeCacheTask>,
    observation: &mut Option<HomeCacheObservation>,
    heartbeat: &mut Option<HeartbeatController>,
    lifecycle: &crate::lifecycle::LifecycleController,
    inventory: &StartupInventory<'_>,
) -> RunnerResult<()> {
    let initialized = task
        .as_mut()
        .ok_or_else(|| RunnerError::Internal("initial home-cache inventory task missing".into()))?
        .await;
    // Retire even a failed completed handle before rollback can join it again.
    *task = None;
    let (initialized, initial) = initialized.map_err(|error| {
        RunnerError::Internal(format!("initial home-cache inventory task failed: {error}"))
    })?;
    *observation = Some(initialized);
    if !inventory.snapshot.home_cache_loaded() {
        return Err(RunnerError::Internal(
            "initial home-cache inventory scan incomplete".into(),
        ));
    }
    let mode = match lifecycle.current_mode() {
        RunnerMode::Starting => RunnerMode::Running,
        mode => mode,
    };
    let change = match initial {
        InitialHomeCacheObservation::Change(change) => Some(change),
        InitialHomeCacheObservation::LoadedSnapshot | InitialHomeCacheObservation::Empty => None,
    };
    let controller = heartbeat.insert(HeartbeatController::new(inventory.heartbeat.clone()));
    controller.report_initial_home_cache(mode, change).await?;
    Ok(())
}
