//! Single accepted pressure worker with bounded observers and joined physical IO.

use std::os::unix::fs::MetadataExt;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use tokio_util::task::TaskTracker;

use super::background::BackgroundGcActivity;
use super::gc_pressure::{
    GcContinuation, GcTarget, HomeCacheReclaimOutcome, HomeCacheReclaimStatus,
};
use super::{FsStats, HomeCachePressureThresholds, HomeImageCache};
use crate::error::{LifecycleError, LifecycleResult};

type ReclaimResult = Result<HomeCacheReclaimOutcome, String>;

struct PressureWork {
    demand: Mutex<PressureDemand>,
    completion: watch::Receiver<Option<ReclaimResult>>,
}

#[derive(Default)]
struct PressureDemand {
    foreground: Option<u64>,
    background: Option<(u64, BackgroundGcActivity)>,
}

impl PressureDemand {
    fn merge(&mut self, required: u64, background: Option<BackgroundGcActivity>) {
        if let Some(activity) = background {
            if !activity.is_active() {
                return;
            }
            let required = self
                .background
                .as_ref()
                .filter(|(_, previous)| previous.is_active())
                .map_or(required, |(previous, _)| required.max(*previous));
            self.background = Some((required, activity));
        } else {
            self.foreground = Some(self.foreground.map_or(required, |old| old.max(required)));
        }
    }

    fn required(&self) -> Option<u64> {
        self.foreground.max(
            self.background
                .as_ref()
                .filter(|(_, activity)| activity.is_active())
                .map(|(required, _)| *required),
        )
    }
}

impl PressureWork {
    fn required(&self) -> Option<u64> {
        self.demand
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .required()
    }
}

pub(super) struct PressureReclamation {
    accepted: Mutex<Option<Arc<PressureWork>>>,
    io: TaskTracker,
}

impl PressureReclamation {
    pub(super) fn new() -> Self {
        Self {
            accepted: Mutex::new(None),
            io: TaskTracker::new(),
        }
    }
}

struct CachePressurePolicy(HomeImageCache);

impl sandbox::HomeDrivePressurePolicy for CachePressurePolicy {
    fn reclaim(
        &self,
        device: u64,
        required: u64,
        deadline: tokio::time::Instant,
    ) -> sandbox::HomeDrivePressureFuture<'_> {
        Box::pin(async move {
            if let Err(error) = self
                .0
                .reclaim_home_image_headroom(device, required, deadline)
                .await
            {
                tracing::warn!(%error, "home image demand reclamation failed; destination must recheck space");
            }
        })
    }
}

impl HomeImageCache {
    pub(super) fn pressure_thresholds(&self, stats: FsStats) -> HomeCachePressureThresholds {
        #[cfg(test)]
        if let Some(reserve) = self.pressure_reserve_override {
            return HomeCachePressureThresholds::with_reserve(stats, reserve);
        }
        HomeCachePressureThresholds::from_fs_stats(stats)
    }

    /// Factory policy shares cache ownership, never a running factory reference.
    pub fn home_drive_pressure_policy(&self) -> Arc<dyn sandbox::HomeDrivePressurePolicy> {
        Arc::new(CachePressurePolicy(self.clone()))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn with_actual_fs_stats_for_test(mut self) -> Self {
        self.use_actual_fs_stats = true;
        self
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn set_fs_stats_for_test(&self, stats: FsStats) {
        *self
            .inner
            .fs_stats_override
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = stats;
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn with_pressure_turn_test_gate(
        mut self,
        gate: super::HomeImagePrepareLockTestGate,
    ) -> Self {
        self.pressure_turn_test_gate = Some(gate);
        self
    }

    /// Observe reclamation until the caller's deadline; accepted work survives a
    /// timeout or cancellation, and only the destination's reread grants growth.
    pub async fn reclaim_home_image_headroom(
        &self,
        destination_device: u64,
        required: u64,
        deadline: tokio::time::Instant,
    ) -> LifecycleResult<HomeCacheReclaimOutcome> {
        match tokio::time::timeout_at(deadline, async {
            let path = self.home_image_cache_fs_stats_path();
            let device = tokio::fs::metadata(path).await?.dev();
            if device != destination_device {
                return Ok(HomeCacheReclaimOutcome::observed(
                    HomeCacheReclaimStatus::DifferentFilesystem,
                    self.fs_stats().await?.available_bytes,
                ));
            }
            let mut completion = self.accept_pressure(required, None);
            #[cfg(test)]
            self.inner.pressure_demand_accepted.notify_one();
            Self::observe_pressure(&mut completion).await
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Ok(HomeCacheReclaimOutcome {
                status: HomeCacheReclaimStatus::ObserverTimedOut,
                available_before: None,
                available_after: None,
                removed_allocated_bytes: 0,
                victim_attempts: 0,
            }),
        }
    }

    pub(super) async fn gc_for_publication(
        &self,
        additional_peak_bytes: u64,
        deadline: tokio::time::Instant,
    ) -> LifecycleResult<bool> {
        let stats = self.fs_stats().await?;
        let required = self
            .pressure_thresholds(stats)
            .reserve_bytes
            .saturating_add(additional_peak_bytes);
        let mut completion = self.accept_pressure(required, None);
        #[cfg(test)]
        self.inner.pressure_demand_accepted.notify_one();
        // Share accepted demand instead of losing a try-only collector race.
        // Another publisher may consume its result before our IO reentry.
        match tokio::time::timeout_at(deadline, Self::observe_pressure(&mut completion)).await {
            Ok(result) => {
                result.map(|outcome| outcome.status == HomeCacheReclaimStatus::TargetSatisfied)
            }
            // Record expiry through ordinary admission; accepted IO stays owned.
            Err(_) => Ok(true),
        }
    }

    /// A cheap background probe. It never marks invalid/temp maintenance done.
    pub async fn probe_home_cache_pressure(&self) -> LifecycleResult<()> {
        if !self.background_gc.is_active() {
            return Ok(());
        }
        let stats = self.fs_stats().await?;
        let policy = self.pressure_thresholds(stats);
        if !policy.reserve_feasible {
            tracing::info!(
                available_bytes = stats.available_bytes,
                reserve_bytes = policy.reserve_bytes,
                reason = "infeasible",
                "home cache pressure probe"
            );
            return Ok(());
        }
        if stats.available_bytes < policy.low_free_bytes && self.background_gc.is_active() {
            let mut completion =
                self.accept_pressure(policy.high_free_bytes, Some(self.background_gc.clone()));
            Self::observe_pressure(&mut completion).await?;
        }
        Ok(())
    }

    fn accept_pressure(
        &self,
        required: u64,
        background: Option<BackgroundGcActivity>,
    ) -> watch::Receiver<Option<ReclaimResult>> {
        let owner = &self.inner.pressure_reclamation;
        let mut accepted = owner
            .accepted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(work) = accepted.as_ref()
            && work.completion.borrow().is_none()
            && work.completion.has_changed().is_ok()
        {
            work.demand
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .merge(required, background);
            return work.completion.clone();
        }
        let (sender, completion) = watch::channel(None);
        let mut demand = PressureDemand::default();
        demand.merge(required, background);
        let work = Arc::new(PressureWork {
            demand: Mutex::new(demand),
            completion: completion.clone(),
        });
        *accepted = Some(work.clone());
        let cache = self.clone();
        owner.io.spawn(async move {
            loop {
                let result = cache.run_pressure_reclamation(&work).await;
                #[cfg(test)]
                if let Some(gate) = &cache.pressure_completion_test_gate {
                    gate.enter_and_wait().await;
                }
                // Admission and completion share this short lock. A request
                // cannot merge a higher target into work already being retired.
                let accepted = cache.inner.pressure_reclamation.accepted.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if result.as_ref().is_ok_and(|outcome| {
                    work.required().is_some_and(|required| {
                        outcome.status == HomeCacheReclaimStatus::BackgroundStopped
                            || (outcome.status == HomeCacheReclaimStatus::TargetSatisfied
                                && outcome.available_after.is_some_and(|available| available < required))
                    })
                }) {
                    drop(accepted);
                    continue;
                }
                match &result {
                    Ok(outcome) => tracing::info!(reason = ?outcome.status, available_before = outcome.available_before,
                        available_after = outcome.available_after,
                        removed_allocated_bytes = outcome.removed_allocated_bytes,
                        victim_attempts = outcome.victim_attempts, "home cache pressure reclamation completed"),
                    Err(error) => tracing::warn!(%error, "accepted home cache reclamation failed"),
                }
                sender.send_replace(Some(result.map_err(|error| error.to_string())));
                break;
            }
        });
        completion
    }

    async fn observe_pressure(
        completion: &mut watch::Receiver<Option<ReclaimResult>>,
    ) -> LifecycleResult<HomeCacheReclaimOutcome> {
        loop {
            if let Some(result) = completion.borrow_and_update().clone() {
                return result.map_err(LifecycleError::Internal);
            }
            completion.changed().await.map_err(|error| {
                LifecycleError::Internal(format!("home cache pressure worker lost: {error}"))
            })?;
        }
    }

    async fn run_pressure_reclamation(
        &self,
        work: &PressureWork,
    ) -> LifecycleResult<HomeCacheReclaimOutcome> {
        let mut continuation = None;
        let mut removed = 0_u64;
        let mut attempts = 0;
        let mut initial_available = None;
        loop {
            let Some(required) = work.required() else {
                return Ok(HomeCacheReclaimOutcome {
                    status: HomeCacheReclaimStatus::BackgroundStopped,
                    available_before: initial_available,
                    available_after: None,
                    removed_allocated_bytes: removed,
                    victim_attempts: attempts,
                });
            };
            // Every collector uses the same try-only routine owner.
            let routine = match runner_host::lock::try_acquire_or_busy(self.routine_gc_lock_path())
                .await?
            {
                runner_host::lock::TryLock::Acquired(lock) => lock,
                runner_host::lock::TryLock::Busy => {
                    return Ok(HomeCacheReclaimOutcome::observed(
                        HomeCacheReclaimStatus::Contended,
                        self.fs_stats().await?.available_bytes,
                    )
                    .with_progress(initial_available, removed, attempts));
                }
            };
            let current_continuation = match &mut continuation {
                Some(cursor) => cursor,
                empty @ None => {
                    let stats = self.fs_stats().await?;
                    if stats.available_bytes >= required || required > stats.total_bytes {
                        return Ok(HomeCacheReclaimOutcome::observed(
                            if required > stats.total_bytes {
                                HomeCacheReclaimStatus::Infeasible
                            } else {
                                HomeCacheReclaimStatus::TargetSatisfied
                            },
                            stats.available_bytes,
                        ));
                    }
                    // Discovery owns no mutation authority. Entry acquisition
                    // revalidates every candidate before eviction.
                    let Some(candidates) = self.gc_candidates(|| work.required().is_some()).await?
                    else {
                        // Expiry can race a new foreground request. A partial
                        // inventory cannot establish complete LRU/no-progress;
                        // release the owner and restart discovery if still needed.
                        continue;
                    };
                    empty.insert(GcContinuation::new(candidates, 0))
                }
            };
            #[cfg(any(test, feature = "test-support"))]
            if let Some(gate) = &self.pressure_turn_test_gate {
                gate.enter_and_wait().await;
            }
            let mut outcome = self
                .reclaim_gc_turn(
                    current_continuation,
                    || {
                        work.required()
                            .map_or(GcTarget::Inactive, GcTarget::FreeBytes)
                    },
                    false,
                    "filesystem_pressure",
                )
                .await?;
            initial_available = initial_available.or(outcome.available_before);
            removed = removed.saturating_add(outcome.removed_allocated_bytes);
            attempts += outcome.victim_attempts;
            drop(routine);
            if outcome.status == HomeCacheReclaimStatus::BudgetExhausted {
                tracing::info!(
                    victim_attempts = outcome.victim_attempts,
                    available_after = outcome.available_after,
                    reason = "cooperative_budget",
                    "home cache pressure continuation retained"
                );
                tokio::task::yield_now().await;
                continue;
            }
            if outcome.status == HomeCacheReclaimStatus::TargetSatisfied
                && outcome.available_after.is_some_and(|available| {
                    work.required().is_some_and(|required| available < required)
                })
            {
                continue;
            }
            outcome.available_before = initial_available;
            outcome.removed_allocated_bytes = removed;
            outcome.victim_attempts = attempts;
            return Ok(outcome);
        }
    }

    /// Call after producers and factory-owned creation tails have stopped.
    pub async fn drain_pressure_reclamation(&self) {
        self.inner.pressure_reclamation.io.close();
        self.inner.pressure_reclamation.io.wait().await;
    }
}
