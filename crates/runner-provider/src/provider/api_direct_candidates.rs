use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant as StdInstant};

use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use tracing::warn;

#[cfg(test)]
use super::ActiveRunnerPreference;
use super::{JobCandidate, JobDiscoverySource, RunnerPreferenceContext};
use runner_types::ids::RunId;

pub(super) const DIRECT_CANDIDATE_STALE_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub(super) struct DirectJobCandidate {
    run_id: RunId,
    profile_name: String,
    discovered_at: StdInstant,
    enqueued_at: Option<StdInstant>,
    reuse_key: Option<String>,
    runner_preference_context: Option<RunnerPreferenceContext>,
}

impl DirectJobCandidate {
    #[cfg(test)]
    pub(super) fn new(run_id: RunId, profile_name: String) -> Self {
        Self::new_with_discovered_at(run_id, profile_name, StdInstant::now())
    }

    #[cfg(test)]
    pub(super) fn new_with_discovered_at(
        run_id: RunId,
        profile_name: String,
        discovered_at: StdInstant,
    ) -> Self {
        Self::new_with_routing_metadata(run_id, profile_name, discovered_at, None, None)
    }

    #[cfg(test)]
    pub(super) fn new_with_enqueued_at(
        run_id: RunId,
        profile_name: String,
        discovered_at: StdInstant,
        enqueued_at: StdInstant,
    ) -> Self {
        let mut candidate =
            Self::new_with_routing_metadata(run_id, profile_name, discovered_at, None, None);
        candidate.enqueued_at = Some(enqueued_at);
        candidate
    }

    pub(super) fn new_with_routing_metadata(
        run_id: RunId,
        profile_name: String,
        discovered_at: StdInstant,
        reuse_key: Option<String>,
        runner_preference_context: Option<RunnerPreferenceContext>,
    ) -> Self {
        Self {
            run_id,
            profile_name,
            discovered_at,
            enqueued_at: None,
            reuse_key,
            runner_preference_context,
        }
    }

    pub(super) fn run_id(&self) -> RunId {
        self.run_id
    }

    pub(super) fn profile_name(&self) -> &str {
        &self.profile_name
    }

    #[cfg(test)]
    pub(super) fn discovered_at(&self) -> StdInstant {
        self.discovered_at
    }

    #[cfg(test)]
    pub(super) fn enqueued_at(&self) -> Option<StdInstant> {
        self.enqueued_at
    }

    fn mark_enqueued_at(&mut self, enqueued_at: StdInstant) {
        if self.enqueued_at.is_none() {
            self.enqueued_at = Some(enqueued_at);
        }
    }

    pub(super) fn into_job_candidate(self) -> JobCandidate {
        let dequeued_at = StdInstant::now();
        let notification_to_enqueue_elapsed = self
            .enqueued_at
            .map(|enqueued_at| enqueued_at.saturating_duration_since(self.discovered_at));
        let inbox_wait_elapsed = self
            .enqueued_at
            .map(|enqueued_at| dequeued_at.saturating_duration_since(enqueued_at));
        JobCandidate::new_with_discovered_at(self.run_id, self.profile_name, self.discovered_at)
            .with_reuse_key(self.reuse_key)
            .with_parsed_runner_preference_context(self.runner_preference_context)
            .with_discovery_source(JobDiscoverySource::Ably)
            .with_direct_candidate_timing(notification_to_enqueue_elapsed, inbox_wait_elapsed)
    }

    fn merge_metadata_from(&mut self, candidate: Self) {
        if self.profile_name != candidate.profile_name {
            warn!(
                run_id = %self.run_id,
                existing_profile = %self.profile_name,
                candidate_profile = %candidate.profile_name,
                "ably: duplicate direct candidate profile mismatch, keeping first profile"
            );
            return;
        }
        if self.runner_preference_context.is_some() {
            return;
        }
        self.reuse_key = candidate.reuse_key;
        self.runner_preference_context = candidate.runner_preference_context;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DirectCandidateInsertOutcome {
    Inserted {
        snapshot: DirectCandidateInboxSnapshot,
        pruned: Option<DirectCandidatePruneSnapshot>,
    },
    Updated {
        snapshot: DirectCandidateInboxSnapshot,
        pruned: Option<DirectCandidatePruneSnapshot>,
    },
    Overflow {
        snapshot: DirectCandidateInboxSnapshot,
        coalesced_count: u64,
        should_wake_poll: bool,
        pruned: Option<DirectCandidatePruneSnapshot>,
    },
}

impl DirectCandidateInsertOutcome {
    #[cfg(test)]
    pub(super) fn snapshot(self) -> DirectCandidateInboxSnapshot {
        match self {
            Self::Inserted { snapshot, .. } | Self::Updated { snapshot, .. } => snapshot,
            Self::Overflow { snapshot, .. } => snapshot,
        }
    }

    pub(super) fn pruned(self) -> Option<DirectCandidatePruneSnapshot> {
        match self {
            Self::Inserted { pruned, .. }
            | Self::Updated { pruned, .. }
            | Self::Overflow { pruned, .. } => pruned,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DirectCandidateInboxSnapshot {
    pub(super) depth: usize,
    pub(super) capacity: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DirectCandidatePruneSnapshot {
    pub(super) pruned_count: usize,
    pub(super) depth: usize,
    pub(super) capacity: usize,
    pub(super) stale_after: Duration,
    pub(super) oldest_pruned_wait_elapsed: Duration,
}

#[derive(Debug)]
pub(super) struct DirectCandidatePopOutcome {
    pub(super) candidate: Option<DirectJobCandidate>,
    pub(super) pruned: Option<DirectCandidatePruneSnapshot>,
}

#[derive(Debug)]
struct DirectCandidateInboxInner {
    order: VecDeque<RunId>,
    candidates: HashMap<RunId, DirectJobCandidate>,
    /// Zero means there is no active overflow episode.
    overflow_count: u64,
}

#[derive(Debug)]
pub(super) struct DirectCandidateInbox {
    capacity: usize,
    stale_after: Duration,
    inner: Mutex<DirectCandidateInboxInner>,
    notify: Notify,
}

impl DirectCandidateInbox {
    pub(super) fn new(capacity: usize, stale_after: Duration) -> Arc<Self> {
        Arc::new(Self {
            capacity,
            stale_after,
            inner: Mutex::new(DirectCandidateInboxInner {
                order: VecDeque::new(),
                candidates: HashMap::new(),
                overflow_count: 0,
            }),
            notify: Notify::new(),
        })
    }

    pub(super) async fn push(&self, candidate: DirectJobCandidate) -> DirectCandidateInsertOutcome {
        let mut inner = self.inner.lock().await;
        let now = StdInstant::now();
        let pruned = prune_stale_candidates(&mut inner, now, self.capacity, self.stale_after);
        let run_id = candidate.run_id();
        if let Some(existing) = inner.candidates.get_mut(&run_id) {
            existing.merge_metadata_from(candidate);
            return DirectCandidateInsertOutcome::Updated {
                snapshot: snapshot(inner.order.len(), self.capacity),
                pruned,
            };
        }

        if inner.order.len() >= self.capacity {
            let should_wake_poll = inner.overflow_count == 0;
            inner.overflow_count = inner.overflow_count.saturating_add(1);
            return DirectCandidateInsertOutcome::Overflow {
                snapshot: snapshot(inner.order.len(), self.capacity),
                coalesced_count: inner.overflow_count,
                should_wake_poll,
                pruned,
            };
        }

        let mut candidate = candidate;
        candidate.mark_enqueued_at(now);
        inner.order.push_back(run_id);
        inner.candidates.insert(run_id, candidate);
        let snapshot = snapshot(inner.order.len(), self.capacity);
        drop(inner);
        self.notify.notify_one();
        DirectCandidateInsertOutcome::Inserted { snapshot, pruned }
    }

    #[cfg(test)]
    pub(super) async fn try_pop(&self) -> Option<DirectJobCandidate> {
        self.try_pop_with_prune().await.candidate
    }

    pub(super) async fn try_pop_with_prune(&self) -> DirectCandidatePopOutcome {
        let mut inner = self.inner.lock().await;
        let pruned = prune_stale_candidates(
            &mut inner,
            StdInstant::now(),
            self.capacity,
            self.stale_after,
        );
        let candidate = pop_candidate(&mut inner);
        if (candidate.is_some() || pruned.is_some()) && inner.order.len() < self.capacity {
            inner.overflow_count = 0;
        }
        DirectCandidatePopOutcome { candidate, pruned }
    }

    #[cfg(test)]
    pub(super) async fn wait_pop(&self, cancel: &CancellationToken) -> Option<DirectJobCandidate> {
        loop {
            if let Some(candidate) = self.try_pop().await {
                return Some(candidate);
            }

            tokio::select! {
                biased;
                () = cancel.cancelled() => return None,
                () = self.notify.notified() => {}
            }
        }
    }

    pub(super) async fn wait_for_notification(&self, cancel: &CancellationToken) -> bool {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        tokio::select! {
            biased;
            () = cancel.cancelled() => false,
            () = &mut notified => true,
        }
    }
}

fn prune_stale_candidates(
    inner: &mut DirectCandidateInboxInner,
    now: StdInstant,
    capacity: usize,
    stale_after: Duration,
) -> Option<DirectCandidatePruneSnapshot> {
    let mut pruned_count = 0;
    let mut oldest_pruned_wait_elapsed = Duration::ZERO;

    while let Some(run_id) = inner.order.front().copied() {
        let Some(candidate) = inner.candidates.get(&run_id) else {
            inner.order.pop_front();
            continue;
        };
        let queued_at = candidate.enqueued_at.unwrap_or(candidate.discovered_at);
        let wait_elapsed = now.saturating_duration_since(queued_at);
        if wait_elapsed < stale_after {
            break;
        }

        inner.order.pop_front();
        inner.candidates.remove(&run_id);
        pruned_count += 1;
        oldest_pruned_wait_elapsed = oldest_pruned_wait_elapsed.max(wait_elapsed);
    }

    if pruned_count == 0 {
        return None;
    }
    if inner.order.len() < capacity {
        inner.overflow_count = 0;
    }
    Some(DirectCandidatePruneSnapshot {
        pruned_count,
        depth: inner.order.len(),
        capacity,
        stale_after,
        oldest_pruned_wait_elapsed,
    })
}

fn pop_candidate(inner: &mut DirectCandidateInboxInner) -> Option<DirectJobCandidate> {
    while let Some(run_id) = inner.order.pop_front() {
        if let Some(candidate) = inner.candidates.remove(&run_id) {
            return Some(candidate);
        }
    }
    None
}

fn snapshot(depth: usize, capacity: usize) -> DirectCandidateInboxSnapshot {
    DirectCandidateInboxSnapshot { depth, capacity }
}

#[cfg(test)]
mod tests;
