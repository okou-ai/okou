//! Complete LRU continuations; actual filesystem observations authorize recovery.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use runner_host::home_observation::HomeObservationOutcome;
use runner_types::types::MAX_HELD_HOME_STATES;

use super::HomeImageCache;
use super::gc::GcCandidate;
use crate::error::LifecycleResult;

const MAX_VICTIM_ATTEMPTS: usize = 16;
const MUTATION_TURN: Duration = Duration::from_secs(1);

/// Why an observed reclaim turn stopped. Deleted allocation is not free space.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HomeCacheReclaimStatus {
    TargetSatisfied,
    NoEligibleProgress,
    AuthorityChanged,
    Contended,
    Infeasible,
    BudgetExhausted,
    DifferentFilesystem,
    ObserverTimedOut,
}

/// A caller-visible physical-space observation, independent of cache quotas.
#[derive(Clone, Debug)]
pub struct HomeCacheReclaimOutcome {
    pub status: HomeCacheReclaimStatus,
    pub available_before: Option<u64>,
    pub available_after: Option<u64>,
    pub removed_allocated_bytes: u64,
    pub victim_attempts: usize,
}

impl HomeCacheReclaimOutcome {
    pub(super) fn with_progress(
        mut self,
        before: Option<u64>,
        removed: u64,
        attempts: usize,
    ) -> Self {
        self.available_before = before.or(self.available_before);
        self.removed_allocated_bytes = removed;
        self.victim_attempts = attempts;
        self
    }

    pub(super) fn observed(status: HomeCacheReclaimStatus, available: u64) -> Self {
        Self {
            status,
            available_before: Some(available),
            available_after: Some(available),
            removed_allocated_bytes: 0,
            victim_attempts: 0,
        }
    }
}

pub(super) struct GcContinuation {
    candidates: VecDeque<GcCandidate>,
    entry_count: usize,
    prospective_released_bytes: u64,
}

impl GcContinuation {
    pub(super) fn new(mut candidates: Vec<GcCandidate>, prospective_released_bytes: u64) -> Self {
        candidates.sort_by(|left, right| {
            left.last_used_at
                .cmp(&right.last_used_at)
                .then_with(|| left.cache_key.cmp(&right.cache_key))
        });
        Self {
            entry_count: candidates.len(),
            candidates: candidates.into(),
            prospective_released_bytes,
        }
    }

    fn satisfied(&self, required: Option<u64>, available: u64) -> bool {
        self.entry_count <= MAX_HELD_HOME_STATES
            && required.is_none_or(|required| available >= required)
    }
}

impl HomeImageCache {
    /// Caller holds exclusive capacity. No entry acquisition waits, and no
    /// accepted physical operation is cancelled to enforce the soft turn.
    pub(super) async fn reclaim_gc_turn(
        &self,
        continuation: &mut GcContinuation,
        required: Option<u64>,
        dry_run: bool,
        reason: &'static str,
    ) -> LifecycleResult<HomeCacheReclaimOutcome> {
        let started = Instant::now();
        let stats = self.fs_stats().await?;
        let mut outcome = HomeCacheReclaimOutcome::observed(
            HomeCacheReclaimStatus::BudgetExhausted,
            stats.available_bytes,
        );
        if required.is_some_and(|required| required > stats.total_bytes) {
            outcome.status = HomeCacheReclaimStatus::Infeasible;
            return Ok(outcome);
        }
        let mut authority_changed = false;
        let mut available_after = stats.available_bytes;
        loop {
            let available = available_after
                .saturating_add(continuation.prospective_released_bytes)
                .min(stats.total_bytes);
            if continuation.satisfied(required, available) {
                outcome.status = HomeCacheReclaimStatus::TargetSatisfied;
                return Ok(outcome);
            }
            if !continuation.candidates.is_empty()
                && (outcome.victim_attempts == MAX_VICTIM_ATTEMPTS
                    || started.elapsed() >= MUTATION_TURN)
            {
                return Ok(outcome);
            }
            let Some(candidate) = continuation.candidates.pop_front() else {
                outcome.status = if authority_changed {
                    HomeCacheReclaimStatus::AuthorityChanged
                } else {
                    HomeCacheReclaimStatus::NoEligibleProgress
                };
                return Ok(outcome);
            };
            outcome.victim_attempts += 1;
            let Ok(runner_host::lock::TryLock::Acquired(_entry)) =
                runner_host::lock::try_acquire_or_busy(self.entry_lock_path(&candidate.cache_key))
                    .await
            else {
                continue;
            };
            let Some(current) = self.gc_candidate(candidate.cache_key.clone()).await else {
                authority_changed = true;
                continue;
            };
            if !current.same_current_image(&candidate) {
                authority_changed = true;
                continue;
            }
            if dry_run {
                continuation.prospective_released_bytes = continuation
                    .prospective_released_bytes
                    .saturating_add(current.allocated_bytes);
            } else {
                if let Err(error) =
                    tokio::fs::remove_dir_all(self.home_image_cache_entry_dir(&current.cache_key))
                        .await
                {
                    tracing::warn!(cache_key = current.cache_key, %error, "home cache victim removal failed");
                    self.observe_removal(
                        &current.cache_key,
                        Some(&current.image_generation),
                        current.allocated_bytes,
                        HomeObservationOutcome::Failed,
                        reason,
                    );
                    continue;
                }
                self.observe_removal(
                    &current.cache_key,
                    Some(&current.image_generation),
                    current.allocated_bytes,
                    HomeObservationOutcome::Deleted,
                    reason,
                );
                // Unlink can leave an open image allocated. Never credit its
                // old st_blocks toward a live free-space target.
                available_after = self.fs_stats().await?.available_bytes;
                outcome.available_after = Some(available_after);
            }
            continuation.entry_count = continuation.entry_count.saturating_sub(1);
            outcome.removed_allocated_bytes = outcome
                .removed_allocated_bytes
                .saturating_add(current.allocated_bytes);
        }
    }
}
