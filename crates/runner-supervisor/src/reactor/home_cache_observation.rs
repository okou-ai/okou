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
use tokio_util::task::AbortOnDropHandle;
use tracing::{Instrument, warn};

use super::home_cache_refresh::HomeCacheRefresh;
use super::{RunnerError, RunnerResult};
use crate::heartbeat::{HeartbeatProfile, refresh_initial_home_cache_snapshot};
use crate::home_image_cache::{HomeCacheChange, HomeCacheWatcher, HomeImageCache};

type HomeCacheChangeFuture = BoxFuture<'static, (HomeCacheWatcher, RunnerResult<HomeCacheChange>)>;

pub(super) struct HomeCacheObservation {
    next_change: Option<HomeCacheChangeFuture>,
    refresh: HomeCacheRefresh,
}

pub(super) enum InitialHomeCacheObservation {
    Change(HomeCacheChange),
    LoadedSnapshot,
    Empty,
}

pub(super) enum HomeCacheObservationEvent {
    Change(HomeCacheChange),
    Refreshed(HomeCacheChange),
    Unavailable(RunnerError),
    RefreshFailed(RunnerError),
}

pub(super) type InitialHomeCacheTask =
    AbortOnDropHandle<(HomeCacheObservation, InitialHomeCacheObservation)>;

#[cfg(test)]
struct InitialScanTestHooks {
    before_initial_home_cache_scan: Option<super::StartLoopTestGate>,
    after_initial_home_cache_scan: Option<super::StartLoopTestGate>,
}

impl HomeCacheObservation {
    /// Read-only bootstrap overlaps provider/factory startup. Its caller owns
    /// cancellation and joins any observation returned before rollback.
    pub(super) fn begin_initialization(
        home_cache: Option<&HomeImageCache>,
        snapshot: &HomeCacheStateSnapshot,
        profiles: &BTreeMap<String, HeartbeatProfile>,
        identity: RunnerProcessIdentity,
        reporter: Option<&SandboxOpReporter>,
        #[cfg(test)] test_hooks: &super::RunTestHooks,
    ) -> InitialHomeCacheTask {
        let home_cache = home_cache.cloned();
        let snapshot = snapshot.clone();
        let profiles = profiles.clone();
        let reporter = reporter.cloned();
        #[cfg(test)]
        let test_hooks = InitialScanTestHooks {
            before_initial_home_cache_scan: test_hooks.before_initial_home_cache_scan.clone(),
            after_initial_home_cache_scan: test_hooks.after_initial_home_cache_scan.clone(),
        };
        AbortOnDropHandle::new(tokio::spawn(
            async move {
                Self::initialize(
                    home_cache.as_ref(),
                    &snapshot,
                    &profiles,
                    identity,
                    reporter.as_ref(),
                    #[cfg(test)]
                    &test_hooks,
                )
                .await
            }
            .in_current_span(),
        ))
    }

    async fn initialize(
        home_cache: Option<&HomeImageCache>,
        snapshot: &HomeCacheStateSnapshot,
        profiles: &BTreeMap<String, HeartbeatProfile>,
        identity: RunnerProcessIdentity,
        reporter: Option<&SandboxOpReporter>,
        #[cfg(test)] test_hooks: &InitialScanTestHooks,
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
                        dirty_cache_keys: BTreeSet::new(),
                        requires_full_reconcile: true,
                    })
                }
            },
            None => None,
        };
        if !initial.locked_commit_keys.is_empty() {
            let locked_change = HomeCacheChange {
                observed_at: tokio::time::Instant::now(),
                dirty_cache_keys: initial.locked_commit_keys,
                requires_full_reconcile: true,
            };
            match change.as_mut() {
                Some(change) => change.merge(locked_change),
                None => change = Some(locked_change),
            }
        }
        let mut refresh =
            HomeCacheRefresh::new(home_cache.cloned(), snapshot.clone(), profiles.clone());
        if let Some(change) = &change {
            refresh.bootstrap(change.clone()).await;
        }
        let observation = Self {
            next_change: home_cache_watcher.map(home_cache_change_future),
            refresh,
        };
        let initialized = match change {
            Some(change) => InitialHomeCacheObservation::Change(change),
            None if !initial.states.is_empty() => InitialHomeCacheObservation::LoadedSnapshot,
            None => InitialHomeCacheObservation::Empty,
        };
        (observation, initialized)
    }

    pub(super) fn request_refresh(&mut self, change: HomeCacheChange) {
        self.refresh.request(change);
    }

    pub(super) fn request_reconciliation(&mut self) {
        self.refresh.request_reconciliation();
    }

    pub(super) fn stop_watching(&mut self) {
        self.next_change = None;
    }

    pub(super) async fn drain(&mut self) -> RunnerResult<()> {
        self.refresh.drain().await
    }

    /// Both observers survive losing reactor turns. No await separates a
    /// selected completion from its rearm/retirement.
    pub(super) async fn wait(&mut self) -> HomeCacheObservationEvent {
        loop {
            tokio::select! {
                result = self.refresh.wait() => match result {
                    Ok(Some(change)) => return HomeCacheObservationEvent::Refreshed(change),
                    Ok(None) => continue,
                    Err(error) => return HomeCacheObservationEvent::RefreshFailed(error),
                },
                result = next_watch(&mut self.next_change) => {
                    let (watcher, result) = result;
                    match result {
                        Ok(change) => {
                            self.next_change = Some(home_cache_change_future(watcher));
                            return HomeCacheObservationEvent::Change(change);
                        }
                        Err(error) => {
                            self.next_change = None;
                            self.refresh.invalidate();
                            return HomeCacheObservationEvent::Unavailable(error);
                        }
                    }
                }
            }
        }
    }
}

async fn next_watch(
    next: &mut Option<HomeCacheChangeFuture>,
) -> (HomeCacheWatcher, RunnerResult<HomeCacheChange>) {
    match next {
        Some(future) => future.await,
        None => std::future::pending().await,
    }
}

fn home_cache_change_future(mut watcher: HomeCacheWatcher) -> HomeCacheChangeFuture {
    Box::pin(async move {
        let result = watcher.next_change().await;
        (watcher, result.map_err(Into::into))
    })
}
