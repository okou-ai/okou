//! Volatile discovery exclusions for unclaimed local preference waits.

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use api_contracts::generated::constants::runners::RUNNER_POLL_EXCLUDED_RUN_IDS_MAX;
use runner_types::ids::RunId;
use tokio::sync::watch;
use tokio::time::Instant;

pub(super) struct AdmissionDeferrals {
    deadlines: Mutex<BTreeMap<RunId, Instant>>,
    changed: watch::Sender<()>,
}

pub(super) struct AdmissionDeferralSnapshot {
    pub(super) run_ids: Vec<RunId>,
    pub(super) next_deadline: Option<Instant>,
}

pub(super) enum AdmissionDeferralRecord {
    Changed,
    Unchanged,
    Saturated,
}

impl AdmissionDeferrals {
    pub(super) fn new() -> Self {
        Self {
            deadlines: Mutex::new(BTreeMap::new()),
            changed: watch::channel(()).0,
        }
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<RunId, Instant>> {
        let mut deadlines = self
            .deadlines
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        deadlines.retain(|_, deadline| *deadline > Instant::now());
        deadlines
    }

    /// Duplicates preserve the first deadline and do not rearm unrelated polling.
    pub(super) fn defer(
        &self,
        run_id: RunId,
        until: std::time::Instant,
    ) -> AdmissionDeferralRecord {
        let mut deadlines = self.lock();
        let until = Instant::from_std(until);
        if until <= Instant::now() {
            return AdmissionDeferralRecord::Unchanged;
        }
        if let Some(deadline) = deadlines.get_mut(&run_id) {
            if *deadline <= until {
                return AdmissionDeferralRecord::Unchanged;
            }
            *deadline = (*deadline).min(until);
        } else {
            if deadlines.len() >= RUNNER_POLL_EXCLUDED_RUN_IDS_MAX as usize {
                return AdmissionDeferralRecord::Saturated;
            }
            deadlines.insert(run_id, until);
        }
        drop(deadlines);
        self.changed.send_replace(());
        AdmissionDeferralRecord::Changed
    }

    pub(super) fn contains(&self, run_id: RunId) -> bool {
        self.lock().contains_key(&run_id)
    }

    pub(super) fn snapshot(&self) -> AdmissionDeferralSnapshot {
        let deadlines = self.lock();
        AdmissionDeferralSnapshot {
            run_ids: deadlines.keys().copied().collect(),
            next_deadline: deadlines.values().copied().min(),
        }
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<()> {
        self.changed.subscribe()
    }

    pub(super) fn release(&self, run_id: RunId) -> bool {
        let removed = self.lock().remove(&run_id).is_some();
        if removed {
            self.changed.send_replace(());
        }
        removed
    }

    pub(super) fn clear(&self) -> bool {
        let mut deadlines = self.lock();
        let changed = !deadlines.is_empty();
        deadlines.clear();
        drop(deadlines);
        if changed {
            self.changed.send_replace(());
        }
        changed
    }
}
