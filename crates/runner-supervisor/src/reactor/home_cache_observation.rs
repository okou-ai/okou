//! Own subscribe-before-scan bootstrap and each retained watcher continuation.
//!
//! This owner supplies advisory observations only. Reactor retains live-mode
//! sampling, heartbeat requests, periodic reconciliation and shutdown ordering.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::home_observation::{HomeObservation, HomeObservationKind, HomeObservationOutcome};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_lifecycle::home_image_cache::snapshot::HomeCacheStateSnapshot;
use runner_storage::{SandboxOpRecord, SandboxOpReporter};
use tracing::warn;

use super::{RunnerError, RunnerResult};
use crate::heartbeat::{HeartbeatProfile, refresh_initial_home_cache_snapshot};
use crate::home_image_cache::{HomeCacheChange, HomeCacheWatcher, HomeImageCache};

type HomeCacheChangeFuture = BoxFuture<'static, (HomeCacheWatcher, RunnerResult<HomeCacheChange>)>;

pub(super) struct HomeCacheObservation {
    next_change: Option<HomeCacheChangeFuture>,
}

pub(super) enum InitialHomeCacheObservation {
    Change(HomeCacheChange),
    LoadedSnapshot,
    Empty,
}

pub(super) enum HomeCacheObservationEvent {
    Change(HomeCacheChange),
    Unavailable(RunnerError),
}

impl HomeCacheObservation {
    pub(super) async fn initialize(
        home_cache: Option<&HomeImageCache>,
        snapshot: &HomeCacheStateSnapshot,
        profiles: &BTreeMap<String, HeartbeatProfile>,
        identity: RunnerProcessIdentity,
        reporter: Option<&SandboxOpReporter>,
        #[cfg(test)] test_hooks: &super::RunTestHooks,
    ) -> (Self, InitialHomeCacheObservation) {
        let mut home_cache_watcher = match home_cache {
            Some(cache) => match HomeCacheWatcher::new(cache.clone()).await {
                Ok(watcher) => Some(watcher),
                Err(error) => {
                    warn!(error = %error, "home cache watcher unavailable; using periodic reconciliation");
                    None
                }
            },
            None => None,
        };
        #[cfg(test)]
        if let Some(gate) = &test_hooks.before_initial_home_cache_scan {
            gate.enter_and_wait().await;
        }
        if home_cache.is_some()
            && let Some(reporter) = reporter
        {
            let mut observation = HomeObservation::new(
                HomeObservationKind::Inventory,
                HomeObservationOutcome::Loading,
            );
            observation.runner_id = Some(identity.runner_id().to_string());
            observation.runner_heartbeat_generation = Some(identity.heartbeat_generation());
            observation.inventory_loaded = Some(false);
            observation.reason = Some("initial_scan".into());
            let mut record =
                SandboxOpRecord::new("runner_home_inventory", Duration::ZERO, true, None);
            record.home = Some(observation);
            reporter.record(record);
        }
        let initial = refresh_initial_home_cache_snapshot(snapshot, home_cache, profiles).await;
        #[cfg(test)]
        if let Some(gate) = &test_hooks.after_initial_home_cache_scan {
            gate.enter_and_wait().await;
        }
        debug_assert!(snapshot.home_cache_loaded());
        let mut relevant_keys = initial.loaded_cache_keys;
        relevant_keys.extend(initial.locked_commit_keys.iter().cloned());
        let mut change = match home_cache_watcher.as_mut() {
            Some(watcher) => match watcher
                .reconcile_initial_relevant_entries(&relevant_keys)
                .await
            {
                Ok(change) => change,
                Err(error) => {
                    warn!(error = %error, "home cache watcher failed during startup reconciliation; using periodic reconciliation");
                    home_cache_watcher = None;
                    Some(HomeCacheChange {
                        observed_at: tokio::time::Instant::now(),
                        committed_cache_keys: BTreeSet::new(),
                    })
                }
            },
            None => None,
        };
        if !initial.locked_commit_keys.is_empty() {
            let locked_change = HomeCacheChange {
                observed_at: tokio::time::Instant::now(),
                committed_cache_keys: initial.locked_commit_keys,
            };
            match change.as_mut() {
                Some(change) => change.merge(locked_change),
                None => change = Some(locked_change),
            }
        }
        let observation = Self {
            next_change: home_cache_watcher.map(home_cache_change_future),
        };
        let initialized = match change {
            Some(change) => InitialHomeCacheObservation::Change(change),
            None if !initial.states.is_empty() => InitialHomeCacheObservation::LoadedSnapshot,
            None => InitialHomeCacheObservation::Empty,
        };
        (observation, initialized)
    }

    /// Borrow the retained continuation: losing select turns must not discard
    /// kernel events already drained before asynchronous metadata classification.
    pub(super) async fn wait(&mut self) -> HomeCacheObservationEvent {
        let (watcher, result) = match self.next_change.as_mut() {
            Some(future) => future.await,
            None => std::future::pending().await,
        };
        // No await between completion and rearm/retirement. An unavailable
        // observer stays pending; Reactor reconciles independently.
        match result {
            Ok(change) => {
                self.next_change = Some(home_cache_change_future(watcher));
                HomeCacheObservationEvent::Change(change)
            }
            Err(error) => {
                self.next_change = None;
                HomeCacheObservationEvent::Unavailable(error)
            }
        }
    }
}

fn home_cache_change_future(mut watcher: HomeCacheWatcher) -> HomeCacheChangeFuture {
    Box::pin(async move {
        let result = watcher.next_change().await;
        (watcher, result.map_err(Into::into))
    })
}
