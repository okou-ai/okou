//! Non-default test observation of the actual startup reader, not cache residency.

use std::io;
use std::sync::{Arc, Mutex};

use super::{MemoryPrefetchTasks, PrefetchOutcome};

/// Concrete reader outcomes. Only a separate positive drain proves producer joins.
#[derive(Clone, Debug, Default)]
pub struct StartupPrefetchSnapshot {
    pub accepted: usize,
    pub completed: usize,
    pub cancelled: usize,
    pub failed: usize,
    pub read_bytes: u64,
    pub last_error: Option<String>,
}

#[derive(Clone, Default)]
pub(super) struct Observer(Arc<Mutex<StartupPrefetchSnapshot>>);

impl Observer {
    pub(super) fn started(&self) {
        let mut report = self.0.lock().expect("startup reader observer poisoned");
        report.accepted += 1;
    }

    pub(super) fn finished(&self, outcome: &PrefetchOutcome) {
        let mut report = self.0.lock().expect("startup reader observer poisoned");
        match outcome {
            PrefetchOutcome::Complete { bytes } => {
                report.completed += 1;
                report.read_bytes += bytes;
            }
            PrefetchOutcome::Cancelled { bytes } => {
                report.cancelled += 1;
                report.read_bytes += bytes;
            }
            PrefetchOutcome::OpenFailed { error } => {
                report.failed += 1;
                report.last_error = Some(error.to_string());
            }
            PrefetchOutcome::ReadFailed { bytes, error } => {
                report.failed += 1;
                report.read_bytes += bytes;
                report.last_error = Some(error.to_string());
            }
        }
    }
}

impl MemoryPrefetchTasks {
    /// Test-only evidence from `spawn`'s actual reader; never a physical-memory credit.
    pub fn startup_snapshot(&self) -> io::Result<StartupPrefetchSnapshot> {
        self.startup_observer
            .as_ref()
            .ok_or_else(|| io::Error::other("this owner has no startup reader observer"))?
            .0
            .lock()
            .map(|report| report.clone())
            .map_err(|_| io::Error::other("startup reader observer poisoned"))
    }
}

#[cfg(test)]
mod tests;
