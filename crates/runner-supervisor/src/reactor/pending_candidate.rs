//! Bounded unclaimed preference candidates and generation-aware retry ownership.

#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use runner_provider::{JobCandidate, RunnerPreferenceRemovalReason};
use runner_types::ids::RunId;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tracing::info;

use crate::lifecycle::RunnerMode;

const MAX_PENDING_CANDIDATES: usize = 64;
const INITIAL_RECHECK: Duration = Duration::from_millis(50);
const MAX_RECHECK: Duration = Duration::from_secs(1);

/// Captured before independently scheduled admission, not when its result arrives.
pub(super) struct PendingRetry {
    generation: u64,
    delay: Duration,
    // Keep the metadata slot while a retry is independently scheduled.
    slot: Option<OwnedSemaphorePermit>,
}

impl PendingRetry {
    pub(super) fn supplied() -> Self {
        Self {
            generation: 0,
            delay: INITIAL_RECHECK,
            slot: None,
        }
    }
}

struct Entry {
    candidate: JobCandidate,
    checked: PendingRetry,
    recheck_at: Instant,
    deadline: Instant,
}

pub(super) struct PendingCandidates {
    entries: VecDeque<Entry>,
    generation: u64,
    slots: Arc<Semaphore>,
}

impl PendingCandidates {
    pub(super) fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            generation: 0,
            slots: Arc::new(Semaphore::new(MAX_PENDING_CANDIDATES)),
        }
    }

    pub(super) fn clear_if_inactive(&mut self, mode: RunnerMode) {
        if mode != RunnerMode::Running {
            self.entries.clear();
        }
    }

    pub(super) fn request_retry(&mut self, mode: RunnerMode) {
        if mode == RunnerMode::Running {
            self.generation = self.generation.wrapping_add(1);
        }
    }

    pub(super) fn for_admission(
        &mut self,
        candidate: JobCandidate,
    ) -> (JobCandidate, PendingRetry) {
        if let Some(pending) =
            self.take_matching(|entry| entry.candidate.run_id() == candidate.run_id())
        {
            return pending;
        }
        (
            candidate,
            PendingRetry {
                generation: self.generation,
                delay: INITIAL_RECHECK,
                slot: None,
            },
        )
    }

    pub(super) fn retain(
        &mut self,
        candidate: JobCandidate,
        mode: RunnerMode,
        mut checked: PendingRetry,
    ) {
        if mode != RunnerMode::Running {
            return;
        }
        let Some(preference) = candidate.runner_preference() else {
            return;
        };
        if self
            .entries
            .iter()
            .any(|entry| entry.candidate.run_id() == candidate.run_id())
        {
            return;
        }
        if checked.slot.is_none() {
            let Ok(slot) = Arc::clone(&self.slots).try_acquire_owned() else {
                info!(run_id = %candidate.run_id(), capacity = MAX_PENDING_CANDIDATES,
                    "pending preference capacity reached; backend discovery retains the job");
                return;
            };
            checked.slot = Some(slot);
        }
        let deadline = preference.deadline().into();
        let recheck_at = Instant::now() + checked.delay;
        self.entries.push_back(Entry {
            candidate,
            checked,
            recheck_at,
            deadline,
        });
    }

    pub(super) fn take_retry(
        &mut self,
        mode: RunnerMode,
        has_capacity: bool,
    ) -> Option<(JobCandidate, PendingRetry)> {
        if mode != RunnerMode::Running || !has_capacity {
            return None;
        }
        let now = Instant::now();
        let generation = self.generation;
        self.take_matching(|entry| {
            entry.deadline <= now
                || entry.checked.generation != generation
                || entry.recheck_at <= now
        })
    }

    fn take_matching(
        &mut self,
        predicate: impl FnMut(&Entry) -> bool,
    ) -> Option<(JobCandidate, PendingRetry)> {
        let index = self.entries.iter().position(predicate)?;
        let entry = self.entries.remove(index)?;
        let candidate = if entry.deadline <= Instant::now() {
            entry
                .candidate
                .without_runner_preference(RunnerPreferenceRemovalReason::Expired)
        } else {
            entry.candidate
        };
        Some((
            candidate,
            PendingRetry {
                generation: self.generation,
                delay: (entry.checked.delay * 2).min(MAX_RECHECK),
                slot: entry.checked.slot,
            },
        ))
    }

    /// Expiry releases local protection even when all RPC slots are occupied.
    pub(super) fn release_expired(&mut self) -> Vec<RunId> {
        let mut released = Vec::new();
        let now = Instant::now();
        self.entries.retain(|entry| {
            if entry.deadline <= now {
                released.push(entry.candidate.run_id());
                false
            } else {
                true
            }
        });
        released
    }

    pub(super) fn next_deadline(
        &self,
        mode: RunnerMode,
        has_capacity: bool,
    ) -> Option<std::time::Instant> {
        if mode != RunnerMode::Running {
            return None;
        }
        self.entries
            .iter()
            .map(|entry| {
                if has_capacity {
                    if entry.checked.generation != self.generation {
                        Instant::now()
                    } else {
                        entry.deadline.min(entry.recheck_at)
                    }
                } else {
                    entry.deadline
                }
            })
            .min()
            .map(Instant::into_std)
    }
}
