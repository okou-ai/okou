use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use runner_lifecycle::active_runs::ActiveRuns;
use runner_lifecycle::home_image_cache::snapshot::HomeCacheStateSnapshot;
use runner_lifecycle::lifecycle::RunnerMode;
use runner_types::{ids::RunId, types::ExecutionContext};
use tokio::sync::{Semaphore, watch};
use tokio::time::{Instant, timeout_at};

use crate::home_image_cache::HomeImageCache;
use crate::idle_lifecycle::SharedIdlePool;
use crate::job_acceptance::supplied_finalizing_predecessor;

// Cap the consumer's remaining preference and the single filesystem probe.
pub(super) const MAX_WAIT_MS: u64 = 1_000;
const PROBE_BUDGET: Duration = Duration::from_millis(50);

pub(crate) struct PreferredHomeProbe {
    cache: HomeImageCache,
    snapshot: HomeCacheStateSnapshot,
    sizes_mb: BTreeMap<String, u32>,
    active_runs: ActiveRuns,
    idle_pool: SharedIdlePool,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
    mode: watch::Receiver<RunnerMode>,
    slot: Arc<Semaphore>,
}

impl PreferredHomeProbe {
    pub(crate) fn new(
        cache: HomeImageCache,
        snapshot: HomeCacheStateSnapshot,
        sizes_mb: BTreeMap<String, u32>,
        active_runs: ActiveRuns,
        idle_pool: SharedIdlePool,
        device_rate_limits: Option<sandbox::DeviceRateLimits>,
        mode: watch::Receiver<RunnerMode>,
    ) -> Self {
        Self {
            cache,
            snapshot,
            sizes_mb,
            active_runs,
            idle_pool,
            device_rate_limits,
            mode,
            slot: Arc::new(Semaphore::new(1)),
        }
    }

    pub(super) fn start(
        &self,
        context: &ExecutionContext,
        profile: &str,
        predecessor: RunId,
        wait_until: Instant,
    ) -> Option<impl Future<Output = bool> + use<>> {
        let reuse_key = context.reuse_key()?;
        let image_size = u64::from(*self.sizes_mb.get(profile)?) * 1024 * 1024;
        if image_size == 0
            || Instant::now() >= wait_until
            || *self.mode.borrow() != RunnerMode::Running
        {
            return None;
        }
        // Avoid a probe after the exact source has already been observed. The
        // actual checkout still revalidates it under the entry lock.
        if self
            .snapshot
            .has_source_home_hint(reuse_key, profile, predecessor)
            || supplied_finalizing_predecessor(context, profile, &self.active_runs).is_some()
            || self.idle_pool.try_lock().ok()?.has_reusable(
                reuse_key,
                profile,
                &self.device_rate_limits,
            )
        {
            return None;
        }
        let permit = Arc::new(self.slot.clone().try_acquire_owned().ok()?);
        let worker_permit = Arc::clone(&permit);
        let cache = self.cache.clone();
        let mode = self.mode.clone();
        let profile = profile.to_owned();
        let reuse_key = reuse_key.to_owned();
        Some(async move {
            let _permit = permit;
            let deadline = wait_until.min(Instant::now() + PROBE_BUDGET);
            let probe = tokio::task::spawn_blocking(move || {
                // A timed-out caller must not free the worker's slot.
                let _permit = worker_permit;
                Instant::now() < deadline
                    && cache.checkout_lock_is_contended(&profile, &reuse_key, image_size)
            });
            matches!(timeout_at(deadline, probe).await, Ok(Ok(true)))
                && Instant::now() < deadline
                && *mode.borrow() == RunnerMode::Running
        })
    }
}
