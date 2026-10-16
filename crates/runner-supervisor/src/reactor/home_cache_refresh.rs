//! Accepted inventory work is independent of heartbeat delivery and joined at shutdown.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use runner_lifecycle::home_image_cache::snapshot::{
    HomeCacheRefreshOutcome, HomeCacheSnapshotRefresh, HomeCacheStateSnapshot,
};
use runner_lifecycle::home_image_cache::{HomeCacheChange, HomeCacheInventory, HomeImageCache};
use tokio::task::JoinHandle;
use tracing::Instrument;

use super::{RunnerError, RunnerResult};
use crate::heartbeat::{HeartbeatProfile, profile_home_sizes};

const HOME_CACHE_COMMIT_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct RefreshContext {
    cache: Option<HomeImageCache>,
    snapshot: HomeCacheStateSnapshot,
    profiles: BTreeMap<String, HeartbeatProfile>,
}

struct RefreshResult {
    change: HomeCacheChange,
    outcome: HomeCacheRefreshOutcome,
    busy_keys: BTreeSet<String>,
}

pub(super) struct HomeCacheRefresh {
    context: RefreshContext,
    task: Option<JoinHandle<RefreshResult>>,
    full_refresh_in_flight: bool,
    pending: Option<HomeCacheChange>,
    busy_keys: BTreeSet<String>,
}

impl HomeCacheRefresh {
    pub(super) fn new(
        cache: Option<HomeImageCache>,
        snapshot: HomeCacheStateSnapshot,
        profiles: BTreeMap<String, HeartbeatProfile>,
    ) -> Self {
        Self {
            context: RefreshContext {
                cache,
                snapshot,
                profiles,
            },
            task: None,
            full_refresh_in_flight: false,
            pending: None,
            busy_keys: BTreeSet::new(),
        }
    }

    pub(super) fn request(&mut self, change: HomeCacheChange) {
        self.context.snapshot.note_home_cache_change(&change);
        self.enqueue(change);
    }

    pub(super) fn request_reconciliation(&mut self) {
        // A timer is not evidence of a new mutation. Do not invalidate a scan
        // that takes longer than one reconciliation period or duplicate it.
        if self.full_refresh_in_flight {
            return;
        }
        self.enqueue(HomeCacheChange {
            observed_at: tokio::time::Instant::now(),
            dirty_cache_keys: BTreeSet::new(),
            requires_full_reconcile: true,
        });
    }

    fn enqueue(&mut self, mut change: HomeCacheChange) {
        if self.context.cache.is_none() {
            return;
        }
        if change.requires_full_reconcile {
            change.merge(HomeCacheChange {
                observed_at: change.observed_at,
                dirty_cache_keys: std::mem::take(&mut self.busy_keys),
                requires_full_reconcile: true,
            });
        }
        if self.task.is_some() {
            match &mut self.pending {
                Some(pending) => pending.merge(change),
                None => self.pending = Some(change),
            }
        } else {
            self.start(change);
        }
    }

    /// Watch loss invalidates older results without changing the existing
    /// periodic recovery cadence when no refresh has already been accepted.
    pub(super) fn invalidate(&self) {
        self.context
            .snapshot
            .note_home_cache_change(&HomeCacheChange {
                observed_at: tokio::time::Instant::now(),
                dirty_cache_keys: BTreeSet::new(),
                requires_full_reconcile: true,
            });
    }

    fn start(&mut self, change: HomeCacheChange) {
        let context = self.context.clone();
        self.full_refresh_in_flight =
            change.requires_full_reconcile || !context.snapshot.home_cache_loaded();
        let token = context.snapshot.begin_home_cache_refresh();
        self.task = Some(tokio::spawn(
            async move { refresh(&context, token, change).await }.in_current_span(),
        ));
    }

    pub(super) async fn wait(&mut self) -> RunnerResult<Option<HomeCacheChange>> {
        let result = match &mut self.task {
            Some(task) => task.await,
            None => std::future::pending().await,
        };
        self.task = None;
        self.full_refresh_in_flight = false;
        let result = result.map_err(|error| {
            RunnerError::Internal(format!("home cache refresh task failed: {error}"))
        })?;
        self.busy_keys
            .retain(|key| !result.change.dirty_cache_keys.contains(key));
        let mut busy_overflow = false;
        for key in result.busy_keys {
            if self.busy_keys.len() < runner_types::types::MAX_HELD_HOME_STATES
                || self.busy_keys.contains(&key)
            {
                self.busy_keys.insert(key);
            } else {
                busy_overflow = true;
            }
        }
        if result.outcome.needs_reconcile || busy_overflow {
            let full = HomeCacheChange {
                observed_at: tokio::time::Instant::now(),
                dirty_cache_keys: BTreeSet::new(),
                requires_full_reconcile: true,
            };
            match &mut self.pending {
                Some(pending) => pending.merge(full),
                None => self.pending = Some(full),
            }
        }
        if let Some(pending) = self.pending.take() {
            self.start(pending);
        }
        Ok(result.outcome.changed.then_some(result.change))
    }

    pub(super) async fn drain(&mut self) -> RunnerResult<()> {
        self.pending = None;
        if let Some(task) = self.task.take() {
            task.await.map_err(|error| {
                RunnerError::Internal(format!("home cache refresh task failed: {error}"))
            })?;
        }
        Ok(())
    }
}

async fn refresh(
    context: &RefreshContext,
    token: HomeCacheSnapshotRefresh,
    change: HomeCacheChange,
) -> RefreshResult {
    let profiles = profile_home_sizes(&context.profiles);
    let deadline = change.observed_at + HOME_CACHE_COMMIT_WAIT;
    let (outcome, busy_keys) = match &context.cache {
        Some(cache) if change.requires_full_reconcile || !context.snapshot.home_cache_loaded() => {
            let inventory = cache
                .home_cache_inventory_after_change(&profiles, &change.dirty_cache_keys, deadline)
                .await;
            let busy_keys = inventory.locked_keys.clone();
            (
                context.snapshot.finish_home_cache_refresh(token, inventory),
                busy_keys,
            )
        }
        Some(cache) => {
            let updates = cache
                .revalidate_home_cache_keys(&profiles, &change.dirty_cache_keys, deadline)
                .await;
            let busy_keys = updates.busy_keys.clone();
            (
                context
                    .snapshot
                    .finish_home_cache_key_updates(token, updates),
                busy_keys,
            )
        }
        None => (
            context
                .snapshot
                .finish_home_cache_refresh(token, HomeCacheInventory::default()),
            BTreeSet::new(),
        ),
    };
    RefreshResult {
        change,
        outcome,
        busy_keys,
    }
}

pub(super) async fn refresh_bootstrap_change(
    cache: Option<HomeImageCache>,
    snapshot: HomeCacheStateSnapshot,
    profiles: BTreeMap<String, HeartbeatProfile>,
    change: HomeCacheChange,
) {
    snapshot.note_home_cache_change(&change);
    let token = snapshot.begin_home_cache_refresh();
    let context = RefreshContext {
        cache,
        snapshot,
        profiles,
    };
    refresh(&context, token, change).await;
}
