//! Single-flight cache observations with bounded, independently backed-off retries.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use runner_lifecycle::home_image_cache::snapshot::{
    HomeCacheRefreshOutcome, HomeCacheSnapshotRefresh, HomeCacheStateSnapshot,
};
use runner_lifecycle::home_image_cache::{HomeCacheChange, HomeCacheInventory, HomeImageCache};
use runner_types::types::MAX_HELD_HOME_STATES;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::Instrument;

use super::{RunnerError, RunnerResult};
use crate::heartbeat::{HeartbeatProfile, profile_home_sizes};

#[cfg(test)]
mod tests;

const RETRY_INITIAL_DELAY: Duration = Duration::from_millis(50);
const RETRY_MAX_DELAY: Duration = Duration::from_secs(2);
const RETRY_ROUND_INTERVAL: Duration = Duration::from_millis(100);
const RETRY_KEYS_PER_ROUND: usize = 16;

#[derive(Clone)]
struct RefreshContext {
    cache: Option<HomeImageCache>,
    snapshot: HomeCacheStateSnapshot,
    profiles: BTreeMap<String, HeartbeatProfile>,
}

struct RefreshWork {
    change: HomeCacheChange,
    retry_only_keys: BTreeSet<String>,
    full_inventory: bool,
}

struct RefreshResult {
    change: HomeCacheChange,
    outcome: HomeCacheRefreshOutcome,
    busy_keys: BTreeSet<String>,
}

struct BusyKey {
    observed_at: Instant,
    retry_at: Instant,
    delay: Duration,
}

pub(super) struct HomeCacheRefresh {
    context: RefreshContext,
    task: Option<JoinHandle<RefreshResult>>,
    full_refresh_in_flight: bool,
    pending: Option<HomeCacheChange>,
    busy_keys: BTreeMap<String, BusyKey>,
    retry_not_before: Instant,
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
            busy_keys: BTreeMap::new(),
            retry_not_before: Instant::now(),
        }
    }

    pub(super) fn request(&mut self, change: HomeCacheChange) {
        self.context.snapshot.note_home_cache_change(&change);
        // Repeated events for an unresolved entry stay inside the retry
        // budget. They reprioritize only that key without delaying its timer.
        let now = Instant::now();
        for key in &change.dirty_cache_keys {
            if let Some(busy) = self.busy_keys.get_mut(key) {
                busy.delay = RETRY_INITIAL_DELAY;
                busy.retry_at = busy.retry_at.min(now + RETRY_INITIAL_DELAY);
            }
        }
        self.enqueue(change);
    }

    pub(super) fn request_reconciliation(&mut self) {
        if !self.full_refresh_in_flight {
            self.enqueue(HomeCacheChange {
                observed_at: Instant::now(),
                dirty_cache_keys: BTreeSet::new(),
                requires_full_reconcile: true,
            });
        }
    }

    fn enqueue(&mut self, change: HomeCacheChange) {
        if self.context.cache.is_none() {
            return;
        }
        match &mut self.pending {
            Some(pending) => pending.merge(change),
            None => self.pending = Some(change),
        }
        self.start_next();
    }

    pub(super) fn invalidate(&self) {
        self.context
            .snapshot
            .note_home_cache_change(&HomeCacheChange {
                observed_at: Instant::now(),
                dirty_cache_keys: BTreeSet::new(),
                requires_full_reconcile: true,
            });
    }

    fn retry_deadline(&self) -> Option<Instant> {
        self.busy_keys
            .values()
            .map(|key| key.retry_at)
            .min()
            .map(|at| at.max(self.retry_not_before))
    }

    fn start_next(&mut self) {
        if self.task.is_some() {
            return;
        }
        let now = Instant::now();
        let mut due = if now >= self.retry_not_before {
            self.busy_keys
                .iter()
                .filter(|(_, key)| key.retry_at <= now)
                .map(|(name, key)| (key.retry_at, name, key.observed_at))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        due.sort_unstable();
        due.truncate(RETRY_KEYS_PER_ROUND);
        let retry_observed_at = due.iter().map(|(_, _, observed_at)| *observed_at).min();
        let mut change = match self.pending.take() {
            Some(change) => change,
            None => match retry_observed_at {
                Some(observed_at) => HomeCacheChange {
                    observed_at,
                    dirty_cache_keys: BTreeSet::new(),
                    requires_full_reconcile: false,
                },
                None => return,
            },
        };
        let due_keys = due
            .into_iter()
            .map(|(_, key, _)| key.clone())
            .collect::<BTreeSet<_>>();
        // A retry can validate a known hint while the global view is still
        // unknown. It must not turn each budgeted round into a new root scan.
        let full = change.requires_full_reconcile
            || (!self.context.snapshot.home_cache_loaded()
                && change
                    .dirty_cache_keys
                    .iter()
                    .any(|key| !self.busy_keys.contains_key(key)));
        if !full {
            let mut deferred = BTreeSet::new();
            change.dirty_cache_keys.retain(|key| {
                if self.busy_keys.contains_key(key) && !due_keys.contains(key) {
                    deferred.insert(key.clone());
                    false
                } else {
                    true
                }
            });
            if !deferred.is_empty() {
                self.pending = Some(HomeCacheChange {
                    observed_at: change.observed_at,
                    dirty_cache_keys: deferred,
                    requires_full_reconcile: false,
                });
            }
            if change.dirty_cache_keys.is_empty() && due_keys.is_empty() {
                return;
            }
        }
        let mut retry_only_keys = due_keys.clone();
        if full {
            // Full scans already enumerate the cache. Explicitly carry old
            // hints so lock-free scope classification cannot lose their retry.
            retry_only_keys.extend(self.busy_keys.keys().cloned());
        }
        retry_only_keys.retain(|key| !change.dirty_cache_keys.contains(key));
        if !due_keys.is_empty() || (full && !retry_only_keys.is_empty()) {
            self.retry_not_before = now + RETRY_ROUND_INTERVAL;
        }
        if !retry_only_keys.is_empty() {
            change.merge(HomeCacheChange {
                observed_at: retry_observed_at.unwrap_or(change.observed_at),
                dirty_cache_keys: retry_only_keys.clone(),
                requires_full_reconcile: false,
            });
        }
        let context = self.context.clone();
        self.full_refresh_in_flight = full || change.requires_full_reconcile;
        let token = context.snapshot.begin_home_cache_refresh();
        let work = RefreshWork {
            change,
            retry_only_keys,
            full_inventory: self.full_refresh_in_flight,
        };
        self.task = Some(tokio::spawn(
            async move { refresh(&context, token, work).await }.in_current_span(),
        ));
    }

    pub(super) async fn wait(&mut self) -> RunnerResult<Option<HomeCacheChange>> {
        loop {
            if let Some(task) = &mut self.task {
                let result = task.await;
                self.task = None;
                self.full_refresh_in_flight = false;
                let result = result.map_err(|error| {
                    RunnerError::Internal(format!("home cache refresh task failed: {error}"))
                })?;
                return Ok(self.complete(result));
            }
            match self.retry_deadline() {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending::<()>().await,
            }
            self.start_next();
        }
    }

    fn complete(&mut self, result: RefreshResult) -> Option<HomeCacheChange> {
        let pending = self.pending.as_ref();
        let superseded =
            |key: &String| pending.is_some_and(|pending| pending.dirty_cache_keys.contains(key));
        for key in &result.change.dirty_cache_keys {
            if !superseded(key) && !result.busy_keys.contains(key) {
                self.busy_keys.remove(key);
            }
        }
        let now = Instant::now();
        let mut overflow = false;
        for key in result.busy_keys {
            if let Some(busy) = self.busy_keys.get_mut(&key) {
                if !superseded(&key) {
                    busy.delay = (busy.delay * 2).min(RETRY_MAX_DELAY);
                    busy.retry_at = now + busy.delay;
                }
            } else if self.busy_keys.len() < MAX_HELD_HOME_STATES {
                // Keep contention knowledge even when a newer event is queued.
                // Otherwise an event stream can bypass the retry budget before
                // this key ever acquires a retained receipt.
                self.busy_keys.insert(
                    key,
                    BusyKey {
                        observed_at: result.change.observed_at,
                        retry_at: now + RETRY_INITIAL_DELAY,
                        delay: RETRY_INITIAL_DELAY,
                    },
                );
            } else {
                overflow = true;
            }
        }
        if result.outcome.needs_reconcile || overflow {
            self.enqueue(HomeCacheChange {
                observed_at: now,
                dirty_cache_keys: BTreeSet::new(),
                requires_full_reconcile: true,
            });
        }
        self.start_next();
        result.outcome.changed.then_some(result.change)
    }

    pub(super) async fn bootstrap(&mut self, change: HomeCacheChange) {
        self.context.snapshot.note_home_cache_change(&change);
        let token = self.context.snapshot.begin_home_cache_refresh();
        let full_inventory =
            change.requires_full_reconcile || !self.context.snapshot.home_cache_loaded();
        let result = refresh(
            &self.context,
            token,
            RefreshWork {
                change,
                retry_only_keys: BTreeSet::new(),
                full_inventory,
            },
        )
        .await;
        self.complete(result);
    }

    pub(super) async fn drain(&mut self) -> RunnerResult<()> {
        self.pending = None;
        self.busy_keys.clear();
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
    work: RefreshWork,
) -> RefreshResult {
    let RefreshWork {
        change,
        retry_only_keys,
        full_inventory,
    } = work;
    let profiles = profile_home_sizes(&context.profiles);
    let (outcome, busy_keys) = match &context.cache {
        Some(cache) if full_inventory => {
            let inventory = cache
                .home_cache_inventory_after_change(&profiles, &change.dirty_cache_keys)
                .await;
            let mut busy_keys = inventory.locked_keys.clone();
            if inventory.incomplete {
                // No full result will commit. Keep known observations owned
                // for a bounded retry instead of retiring their positive reads.
                busy_keys.extend(change.dirty_cache_keys.iter().cloned());
            }
            (
                context.snapshot.finish_home_cache_refresh(token, inventory),
                busy_keys,
            )
        }
        Some(cache) => {
            let mut updates = cache
                .revalidate_home_cache_keys(&profiles, &change.dirty_cache_keys)
                .await;
            // A retry timer is not a new mutation. Repeated Busy must neither
            // invalidate a newer publication nor repeatedly refill a capped view.
            for key in retry_only_keys.intersection(&updates.busy_keys) {
                updates.entries.remove(key);
            }
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
