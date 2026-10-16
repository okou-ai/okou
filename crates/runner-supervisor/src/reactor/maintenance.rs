//! Own accepted maintenance observations from single-flight admission to drain.
//!
//! Plain task handles detach on abnormal reactor drop: accepted filesystem and
//! persistence work retains its locks until completion. Normal shutdown joins
//! status retry before GC instead of aborting work that may outlive its future.

use std::sync::Arc;

use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::{Instrument, error, info, warn};

use super::{HOME_CACHE_GC_PERIOD, RunnerError, RunnerResult};
use crate::home_image_cache::HomeImageCache;
use crate::lifecycle::RunnerMode;
use crate::status::StatusTracker;

pub(super) struct MaintenanceTasks {
    home_cache_gc: Option<JoinHandle<()>>,
    home_cache_pressure: Option<JoinHandle<()>>,
    status_retry: Option<JoinHandle<()>>,
}

pub(super) enum MaintenanceCompletion {
    HomeCacheGc(RunnerResult<()>),
    HomeCachePressure(RunnerResult<()>),
    StatusRetry(RunnerResult<()>),
}

impl MaintenanceTasks {
    pub(super) fn new() -> Self {
        Self {
            home_cache_gc: None,
            home_cache_pressure: None,
            status_retry: None,
        }
    }

    pub(super) fn request_home_cache_gc(
        &mut self,
        cache: Option<&HomeImageCache>,
        mode: &watch::Receiver<RunnerMode>,
    ) {
        if self.home_cache_gc.is_none()
            && *mode.borrow() == RunnerMode::Running
            && let Some(cache) = cache
        {
            self.home_cache_gc = Some(home_cache_gc_task(
                cache.clone().with_background_gc_lifecycle(mode.clone()),
            ));
        }
    }

    pub(super) fn request_status_retry(&mut self, status: &Arc<StatusTracker>) {
        if self.status_retry.is_none() {
            self.status_retry = Some(status_retry_task(Arc::clone(status)));
        }
    }

    pub(super) fn request_home_cache_pressure(
        &mut self,
        cache: Option<&HomeImageCache>,
        mode: &watch::Receiver<RunnerMode>,
    ) {
        if self.home_cache_pressure.is_none()
            && *mode.borrow() == RunnerMode::Running
            && let Some(cache) = cache
        {
            let cache = cache.clone().with_background_gc_lifecycle(mode.clone());
            self.home_cache_pressure = Some(tokio::spawn(
                async move {
                    if let Err(error) = cache.probe_home_cache_pressure().await {
                        warn!(%error, "home cache pressure probe failed");
                    }
                }
                .in_current_span(),
            ));
        }
    }

    /// Losing an outer select race preserves both observers. A selected join
    /// retires its observer synchronously before the reactor handles the result.
    pub(super) async fn wait(&mut self) -> MaintenanceCompletion {
        tokio::select! {
            result = next_maintenance_task(&mut self.home_cache_gc, "home cache GC") => {
                self.home_cache_gc = None;
                MaintenanceCompletion::HomeCacheGc(result)
            }
            result = next_maintenance_task(&mut self.home_cache_pressure, "home cache pressure") => {
                self.home_cache_pressure = None;
                MaintenanceCompletion::HomeCachePressure(result)
            }
            result = next_maintenance_task(&mut self.status_retry, "status retry") => {
                self.status_retry = None;
                MaintenanceCompletion::StatusRetry(result)
            }
        }
    }

    /// Observe both joins in order even if one fails, retaining the first error.
    pub(super) async fn drain(&mut self) -> RunnerResult<()> {
        let mut first_error = None;
        for (name, task) in [
            ("status retry", &mut self.status_retry),
            ("home cache pressure", &mut self.home_cache_pressure),
            ("home cache GC", &mut self.home_cache_gc),
        ] {
            if task.is_some()
                && let Err(error) = next_maintenance_task(task, name).await
            {
                error!(%error, "failed to drain maintenance task");
                first_error.get_or_insert(error);
            }
            *task = None;
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn home_cache_gc_task(cache: HomeImageCache) -> JoinHandle<()> {
    tokio::spawn(
        async move {
            match cache.try_routine_gc(HOME_CACHE_GC_PERIOD).await {
                Ok(Some(freed_bytes)) if freed_bytes > 0 => {
                    info!(freed_bytes, "periodic home image cache GC completed");
                }
                Ok(Some(_) | None) => {}
                Err(error) => warn!(%error, "periodic home image cache GC failed"),
            }
        }
        .in_current_span(),
    )
}

fn status_retry_task(status: Arc<StatusTracker>) -> JoinHandle<()> {
    tokio::spawn(
        async move {
            if let Err(error) = status.retry_unpublished_snapshot().await {
                warn!(%error, "failed to retry unpublished runner status");
            }
        }
        .in_current_span(),
    )
}

async fn next_maintenance_task(task: &mut Option<JoinHandle<()>>, name: &str) -> RunnerResult<()> {
    match task {
        Some(task) => task
            .await
            .map_err(|error| RunnerError::Internal(format!("{name} task failed: {error}"))),
        None => std::future::pending().await,
    }
}
