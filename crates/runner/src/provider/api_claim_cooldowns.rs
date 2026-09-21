//! Bounded runner-local deadlines for failed API claims.
//!
//! [`ApiProvider`](super::api::ApiProvider) owns the claim-to-rediscovery
//! lifecycle. This module only stores its ephemeral cooldown state: per-run
//! deadlines plus an optional provider-wide deadline used when per-run capacity
//! is saturated. It owns no timer or wakeup; the provider routes retry deadlines
//! through [`PollWakeups`](super::api_ably_supervisor::PollWakeups).
//!
//! Recording refreshes an existing run or inserts a new run while capacity is
//! available. It never evicts an unexpired entry: saturation is returned to the
//! provider so it can apply the provider-wide fallback. Reads and records prune
//! expired state. A snapshot exposes sorted per-run exclusions and the earliest
//! effective retry deadline, preferring the provider-wide deadline while it is
//! active.

use std::collections::{BTreeMap, btree_map::Entry};
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::ids::RunId;

pub(super) enum ClaimCooldownRecord {
    Recorded { active_count: usize },
    Saturated { active_count: usize },
}

pub(super) struct ClaimCooldownSnapshot {
    pub(super) run_ids: Vec<RunId>,
    pub(super) retry_after: Option<Duration>,
}

pub(super) struct ClaimCooldowns {
    capacity: usize,
    state: Mutex<ClaimCooldownState>,
}

struct ClaimCooldownState {
    deadlines: BTreeMap<RunId, Instant>,
    global_deadline: Option<Instant>,
}

impl ClaimCooldowns {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            state: Mutex::new(ClaimCooldownState {
                deadlines: BTreeMap::new(),
                global_deadline: None,
            }),
        }
    }

    pub(super) async fn record(&self, run_id: RunId, duration: Duration) -> ClaimCooldownRecord {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        prune_expired(&mut state, now);

        if let Entry::Occupied(mut entry) = state.deadlines.entry(run_id) {
            entry.insert(now + duration);
            return ClaimCooldownRecord::Recorded {
                active_count: state.deadlines.len(),
            };
        }

        if state.deadlines.len() >= self.capacity {
            return ClaimCooldownRecord::Saturated {
                active_count: state.deadlines.len(),
            };
        }

        state.deadlines.insert(run_id, now + duration);
        ClaimCooldownRecord::Recorded {
            active_count: state.deadlines.len(),
        }
    }

    pub(super) async fn block_all(&self, duration: Duration) {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        prune_expired(&mut state, now);
        state.global_deadline = Some(now + duration);
    }

    pub(super) async fn remaining(&self, run_id: RunId) -> Option<Duration> {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        prune_expired(&mut state, now);
        state
            .global_deadline
            .or_else(|| state.deadlines.get(&run_id).copied())
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    pub(super) async fn snapshot(&self) -> ClaimCooldownSnapshot {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        prune_expired(&mut state, now);
        ClaimCooldownSnapshot {
            run_ids: state.deadlines.keys().copied().collect(),
            retry_after: state
                .global_deadline
                .or_else(|| state.deadlines.values().copied().min())
                .map(|deadline| deadline.saturating_duration_since(now)),
        }
    }

    pub(super) async fn remove(&self, run_id: RunId) {
        self.state.lock().await.deadlines.remove(&run_id);
    }
}

fn prune_expired(state: &mut ClaimCooldownState, now: Instant) {
    state.deadlines.retain(|_, deadline| *deadline > now);
    if state
        .global_deadline
        .is_some_and(|deadline| deadline <= now)
    {
        state.global_deadline = None;
    }
}

runner_test_group!(provider; #[cfg(test)]
mod tests {
    use super::*;

    fn run_id(value: u128) -> RunId {
        RunId::from(uuid::Uuid::from_u128(value))
    }

    #[tokio::test(start_paused = true)]
    async fn records_refreshes_and_saturates_without_eviction() {
        let cooldowns = ClaimCooldowns::new(2);
        let first_run_id = run_id(1);
        let second_run_id = run_id(2);
        let overflow_run_id = run_id(3);

        assert!(matches!(
            cooldowns
                .record(second_run_id, Duration::from_secs(30))
                .await,
            ClaimCooldownRecord::Recorded { active_count: 1 }
        ));
        assert!(matches!(
            cooldowns
                .record(first_run_id, Duration::from_secs(20))
                .await,
            ClaimCooldownRecord::Recorded { active_count: 2 }
        ));
        let snapshot = cooldowns.snapshot().await;
        assert_eq!(snapshot.run_ids, vec![first_run_id, second_run_id]);
        assert_eq!(snapshot.retry_after, Some(Duration::from_secs(20)));

        tokio::time::advance(Duration::from_secs(5)).await;
        assert!(matches!(
            cooldowns
                .record(second_run_id, Duration::from_secs(30))
                .await,
            ClaimCooldownRecord::Recorded { active_count: 2 }
        ));
        assert!(matches!(
            cooldowns
                .record(overflow_run_id, Duration::from_secs(30))
                .await,
            ClaimCooldownRecord::Saturated { active_count: 2 }
        ));
        let snapshot = cooldowns.snapshot().await;
        assert_eq!(snapshot.run_ids, vec![first_run_id, second_run_id]);
        assert_eq!(snapshot.retry_after, Some(Duration::from_secs(15)));

        tokio::time::advance(Duration::from_secs(15)).await;
        let snapshot = cooldowns.snapshot().await;
        assert_eq!(snapshot.run_ids, vec![second_run_id]);
        assert_eq!(snapshot.retry_after, Some(Duration::from_secs(15)));
    }

    #[tokio::test(start_paused = true)]
    async fn global_deadline_precedes_per_run_deadline_until_expiry() {
        let cooldowns = ClaimCooldowns::new(1);
        let first_run_id = run_id(1);
        let next_run_id = run_id(2);

        assert!(matches!(
            cooldowns
                .record(first_run_id, Duration::from_secs(30))
                .await,
            ClaimCooldownRecord::Recorded { active_count: 1 }
        ));
        cooldowns.block_all(Duration::from_secs(5)).await;

        let snapshot = cooldowns.snapshot().await;
        assert_eq!(snapshot.run_ids, vec![first_run_id]);
        assert_eq!(snapshot.retry_after, Some(Duration::from_secs(5)));
        assert_eq!(
            cooldowns.remaining(first_run_id).await,
            Some(Duration::from_secs(5))
        );
        assert_eq!(
            cooldowns.remaining(next_run_id).await,
            Some(Duration::from_secs(5))
        );

        tokio::time::advance(Duration::from_secs(5)).await;
        let snapshot = cooldowns.snapshot().await;
        assert_eq!(snapshot.run_ids, vec![first_run_id]);
        assert_eq!(snapshot.retry_after, Some(Duration::from_secs(25)));
        assert_eq!(
            cooldowns.remaining(first_run_id).await,
            Some(Duration::from_secs(25))
        );
        assert_eq!(cooldowns.remaining(next_run_id).await, None);

        tokio::time::advance(Duration::from_secs(25)).await;
        assert!(matches!(
            cooldowns.record(next_run_id, Duration::from_secs(10)).await,
            ClaimCooldownRecord::Recorded { active_count: 1 }
        ));
        let snapshot = cooldowns.snapshot().await;
        assert_eq!(snapshot.run_ids, vec![next_run_id]);
        assert_eq!(snapshot.retry_after, Some(Duration::from_secs(10)));
    }

    #[tokio::test(start_paused = true)]
    async fn remove_clears_only_requested_run_and_updates_retry_deadline() {
        let cooldowns = ClaimCooldowns::new(2);
        let first_run_id = run_id(1);
        let second_run_id = run_id(2);

        assert!(matches!(
            cooldowns
                .record(first_run_id, Duration::from_secs(10))
                .await,
            ClaimCooldownRecord::Recorded { active_count: 1 }
        ));
        assert!(matches!(
            cooldowns
                .record(second_run_id, Duration::from_secs(20))
                .await,
            ClaimCooldownRecord::Recorded { active_count: 2 }
        ));

        cooldowns.remove(first_run_id).await;

        let snapshot = cooldowns.snapshot().await;
        assert_eq!(snapshot.run_ids, vec![second_run_id]);
        assert_eq!(snapshot.retry_after, Some(Duration::from_secs(20)));
        assert_eq!(cooldowns.remaining(first_run_id).await, None);
        assert_eq!(
            cooldowns.remaining(second_run_id).await,
            Some(Duration::from_secs(20))
        );
    }
});
