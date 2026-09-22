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
    history_generation_run_id: Option<RunId>,
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
            history_generation_run_id: None,
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

    pub(super) fn with_history_generation_run_id(
        mut self,
        history_generation_run_id: Option<RunId>,
    ) -> Self {
        self.history_generation_run_id = history_generation_run_id;
        self
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
            .with_history_generation_run_id(self.history_generation_run_id)
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
        self.history_generation_run_id = candidate.history_generation_run_id;
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
    overflow_active: bool,
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
                overflow_active: false,
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
            inner.overflow_count = inner.overflow_count.saturating_add(1);
            let should_wake_poll = !inner.overflow_active;
            inner.overflow_active = true;
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
            inner.overflow_active = false;
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
        inner.overflow_active = false;
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
mod tests {
    use std::time::Duration;

    use super::super::{RunnerNoPreferenceReason, RunnerPreference, RunnerPreferenceTier};
    use super::*;
    use crate::runner_process_identity::RunnerProcessIdentity;

    fn run_id(value: u128) -> RunId {
        RunId::from(uuid::Uuid::from_u128(value))
    }

    fn direct_candidate_inbox(capacity: usize) -> Arc<DirectCandidateInbox> {
        DirectCandidateInbox::new(capacity, DIRECT_CANDIDATE_STALE_AFTER)
    }

    fn direct_candidate_inbox_with_stale_after(
        capacity: usize,
        stale_after: Duration,
    ) -> Arc<DirectCandidateInbox> {
        DirectCandidateInbox::new(capacity, stale_after)
    }

    fn ranked_preference_context(
        runner_id: u128,
        tier: RunnerPreferenceTier,
        deadline: StdInstant,
    ) -> RunnerPreferenceContext {
        RunnerPreferenceContext::for_test(ActiveRunnerPreference::ranked_for_test(
            RunnerProcessIdentity::new(uuid::Uuid::from_u128(runner_id), 7).unwrap(),
            tier,
            deadline,
        ))
    }

    fn candidate_with_enqueued_at(run_id: RunId, enqueued_at: StdInstant) -> DirectJobCandidate {
        let mut candidate = DirectJobCandidate::new_with_discovered_at(
            run_id,
            "vm0/default".to_string(),
            enqueued_at,
        );
        candidate.enqueued_at = Some(enqueued_at);
        candidate
    }

    #[tokio::test]
    async fn duplicate_run_id_accepts_first_decision_and_preserves_first_discovery_time() {
        let inbox = direct_candidate_inbox(4);
        let first_discovered_at = StdInstant::now() - Duration::from_secs(5);
        let second_discovered_at = StdInstant::now();
        let history_generation_run_id = run_id(2);
        let run_id = run_id(1);

        let inserted = inbox
            .push(DirectJobCandidate::new_with_routing_metadata(
                run_id,
                "vm0/default".to_string(),
                first_discovered_at,
                Some("session:sess-1".to_string()),
                None,
            ))
            .await;
        assert_eq!(
            inserted.snapshot(),
            DirectCandidateInboxSnapshot {
                depth: 1,
                capacity: 4,
            }
        );

        let exact_deadline = StdInstant::now() + Duration::from_secs(8);
        let updated = inbox
            .push(
                DirectJobCandidate::new_with_routing_metadata(
                    run_id,
                    "vm0/default".to_string(),
                    second_discovered_at,
                    Some("session:sess-2".to_string()),
                    Some(ranked_preference_context(
                        20,
                        RunnerPreferenceTier::ExactSandbox,
                        exact_deadline,
                    )),
                )
                .with_history_generation_run_id(Some(history_generation_run_id)),
            )
            .await;
        assert!(matches!(
            updated,
            DirectCandidateInsertOutcome::Updated {
                snapshot: DirectCandidateInboxSnapshot {
                    depth: 1,
                    capacity: 4,
                },
                pruned: None,
            }
        ));

        let renewed = inbox
            .push(DirectJobCandidate::new_with_routing_metadata(
                run_id,
                "vm0/default".to_string(),
                second_discovered_at,
                Some("session:must-not-renew".to_string()),
                Some(ranked_preference_context(
                    30,
                    RunnerPreferenceTier::WorkspaceCache,
                    StdInstant::now() + Duration::from_secs(30),
                )),
            ))
            .await;
        assert!(matches!(
            renewed,
            DirectCandidateInsertOutcome::Updated { .. }
        ));

        let candidate = inbox.try_pop().await.expect("direct candidate");
        assert_eq!(candidate.discovered_at(), first_discovered_at);
        assert!(candidate.enqueued_at().is_some());
        let candidate = candidate.into_job_candidate();
        assert_eq!(candidate.reuse_key(), Some("session:sess-2"));
        assert_eq!(
            candidate.history_generation_run_id(),
            Some(history_generation_run_id)
        );
        let preference = candidate
            .runner_preference()
            .expect("updated canonical preference");
        assert_eq!(preference.tier(), RunnerPreferenceTier::ExactSandbox);
        assert_eq!(preference.deadline(), exact_deadline);
        assert!(
            preference.targets(RunnerProcessIdentity::new(uuid::Uuid::from_u128(20), 7).unwrap())
        );
        let telemetry = candidate
            .runner_preference_claim_telemetry()
            .expect("canonical preference telemetry");
        assert!(matches!(
            telemetry.runner_preference,
            RunnerPreference::Preference {
                tier: RunnerPreferenceTier::ExactSandbox,
                ..
            }
        ));
        assert_eq!(
            telemetry.state,
            Some(super::super::RunnerPreferenceClaimState::Active)
        );
        assert!(
            candidate
                .direct_candidate_notification_to_enqueue_elapsed()
                .is_some_and(|elapsed| elapsed >= Duration::from_secs(5))
        );
        assert!(candidate.direct_candidate_inbox_wait_elapsed().is_some());
        assert!(inbox.try_pop().await.is_none());
    }

    #[tokio::test]
    async fn duplicate_retains_first_decision_snapshot_and_deadline() {
        let inbox = direct_candidate_inbox(1);
        let candidate_run_id = run_id(5);
        let first_history_generation = run_id(6);
        let first_deadline = StdInstant::now() + Duration::from_secs(5);
        inbox
            .push(
                DirectJobCandidate::new_with_routing_metadata(
                    candidate_run_id,
                    "vm0/default".to_string(),
                    StdInstant::now(),
                    Some("session:first-decision".to_string()),
                    Some(ranked_preference_context(
                        10,
                        RunnerPreferenceTier::WorkspaceCache,
                        first_deadline,
                    )),
                )
                .with_history_generation_run_id(Some(first_history_generation)),
            )
            .await;

        inbox
            .push(
                DirectJobCandidate::new_with_routing_metadata(
                    candidate_run_id,
                    "vm0/default".to_string(),
                    StdInstant::now(),
                    Some("session:must-not-replace".to_string()),
                    Some(ranked_preference_context(
                        20,
                        RunnerPreferenceTier::ExactSandbox,
                        StdInstant::now() + Duration::from_secs(30),
                    )),
                )
                .with_history_generation_run_id(Some(run_id(7))),
            )
            .await;

        inbox
            .push(DirectJobCandidate::new_with_routing_metadata(
                candidate_run_id,
                "vm0/default".to_string(),
                StdInstant::now(),
                None,
                Some(RunnerPreferenceContext::no_preference_for_test(
                    RunnerNoPreferenceReason::NoViableHolder,
                )),
            ))
            .await;

        let candidate = inbox
            .try_pop()
            .await
            .expect("retained direct candidate")
            .into_job_candidate();
        assert_eq!(candidate.reuse_key(), Some("session:first-decision"));
        assert_eq!(
            candidate.history_generation_run_id(),
            Some(first_history_generation)
        );
        let preference = candidate.runner_preference().expect("runner preference");
        assert_eq!(preference.tier(), RunnerPreferenceTier::WorkspaceCache);
        assert_eq!(preference.deadline(), first_deadline);
        assert!(
            preference.targets(RunnerProcessIdentity::new(uuid::Uuid::from_u128(10), 7).unwrap())
        );
        let telemetry = candidate
            .runner_preference_claim_telemetry()
            .expect("retained canonical preference telemetry");
        assert!(matches!(
            telemetry.runner_preference,
            RunnerPreference::Preference {
                tier: RunnerPreferenceTier::WorkspaceCache,
                ..
            }
        ));
        assert_eq!(
            telemetry.state,
            Some(super::super::RunnerPreferenceClaimState::Active)
        );
    }

    #[tokio::test]
    async fn overflow_is_coalesced_until_capacity_makes_progress() {
        let inbox = direct_candidate_inbox(1);
        let _ = inbox
            .push(DirectJobCandidate::new(
                run_id(1),
                "vm0/default".to_string(),
            ))
            .await;

        let first_overflow = inbox
            .push(DirectJobCandidate::new(
                run_id(2),
                "vm0/default".to_string(),
            ))
            .await;
        assert!(matches!(
            first_overflow,
            DirectCandidateInsertOutcome::Overflow {
                snapshot: DirectCandidateInboxSnapshot {
                    depth: 1,
                    capacity: 1,
                },
                coalesced_count: 1,
                should_wake_poll: true,
                pruned: None,
            }
        ));

        let second_overflow = inbox
            .push(DirectJobCandidate::new(
                run_id(3),
                "vm0/default".to_string(),
            ))
            .await;
        assert!(matches!(
            second_overflow,
            DirectCandidateInsertOutcome::Overflow {
                snapshot: DirectCandidateInboxSnapshot {
                    depth: 1,
                    capacity: 1,
                },
                coalesced_count: 2,
                should_wake_poll: false,
                pruned: None,
            }
        ));

        assert_eq!(
            inbox.try_pop().await.expect("first candidate").run_id(),
            run_id(1)
        );
        let _ = inbox
            .push(DirectJobCandidate::new(
                run_id(4),
                "vm0/default".to_string(),
            ))
            .await;
        let reset_overflow = inbox
            .push(DirectJobCandidate::new(
                run_id(5),
                "vm0/default".to_string(),
            ))
            .await;
        assert!(matches!(
            reset_overflow,
            DirectCandidateInsertOutcome::Overflow {
                coalesced_count: 1,
                should_wake_poll: true,
                pruned: None,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn stale_candidates_are_pruned_before_push_and_reset_overflow_state() {
        let stale_after = Duration::from_secs(60);
        let inbox = direct_candidate_inbox_with_stale_after(1, stale_after);
        let stale_enqueued_at = StdInstant::now() - Duration::from_secs(120);
        let _ = inbox
            .push(candidate_with_enqueued_at(run_id(1), stale_enqueued_at))
            .await;

        let inserted_after_prune = inbox
            .push(DirectJobCandidate::new(
                run_id(2),
                "vm0/default".to_string(),
            ))
            .await;

        assert!(matches!(
            inserted_after_prune,
            DirectCandidateInsertOutcome::Inserted {
                snapshot: DirectCandidateInboxSnapshot {
                    depth: 1,
                    capacity: 1,
                },
                pruned: Some(DirectCandidatePruneSnapshot {
                    pruned_count: 1,
                    depth: 0,
                    capacity: 1,
                    stale_after: pruned_stale_after,
                    oldest_pruned_wait_elapsed,
                }),
            } if pruned_stale_after == stale_after
                && oldest_pruned_wait_elapsed >= stale_after
        ));

        let overflow_after_prune = inbox
            .push(DirectJobCandidate::new(
                run_id(3),
                "vm0/default".to_string(),
            ))
            .await;
        assert!(matches!(
            overflow_after_prune,
            DirectCandidateInsertOutcome::Overflow {
                coalesced_count: 1,
                should_wake_poll: true,
                pruned: None,
                ..
            }
        ));
        assert_eq!(
            inbox.try_pop().await.expect("fresh candidate").run_id(),
            run_id(2)
        );
        assert!(inbox.try_pop().await.is_none());
    }

    #[tokio::test]
    async fn stale_candidates_are_pruned_before_pop() {
        let stale_after = Duration::from_secs(60);
        let inbox = direct_candidate_inbox_with_stale_after(1, stale_after);
        let stale_enqueued_at = StdInstant::now() - Duration::from_secs(120);
        let _ = inbox
            .push(candidate_with_enqueued_at(run_id(1), stale_enqueued_at))
            .await;

        let outcome = inbox.try_pop_with_prune().await;

        assert!(outcome.candidate.is_none());
        assert!(matches!(
            outcome.pruned,
            Some(DirectCandidatePruneSnapshot {
                pruned_count: 1,
                depth: 0,
                capacity: 1,
                stale_after: pruned_stale_after,
                oldest_pruned_wait_elapsed,
            }) if pruned_stale_after == stale_after
                && oldest_pruned_wait_elapsed >= stale_after
        ));
        assert!(inbox.try_pop().await.is_none());
    }

    #[tokio::test]
    async fn fresh_candidates_are_preserved_before_pop() {
        let stale_after = Duration::from_secs(60);
        let inbox = direct_candidate_inbox_with_stale_after(1, stale_after);
        let fresh_enqueued_at = StdInstant::now() - Duration::from_secs(5);
        let _ = inbox
            .push(candidate_with_enqueued_at(run_id(1), fresh_enqueued_at))
            .await;

        let outcome = inbox.try_pop_with_prune().await;

        assert!(outcome.pruned.is_none());
        assert_eq!(
            outcome.candidate.expect("fresh candidate").run_id(),
            run_id(1)
        );
        assert!(inbox.try_pop().await.is_none());
    }

    #[tokio::test]
    async fn wait_pop_exits_on_cancel() {
        let inbox = direct_candidate_inbox(1);
        let cancel = CancellationToken::new();
        cancel.cancel();

        assert!(inbox.wait_pop(&cancel).await.is_none());
    }
}
