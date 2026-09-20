//! Read a frozen run's cumulative MITM observations without waiting for billing.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::time::Instant;

use super::control::{self, ControlHandle, ControlTarget};
use crate::ids::RunId;

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_QUANTITY: u64 = (1 << 53) - 1;
const MAX_RESPONSES: u64 = 4096;

/// Freezes the addon generation and run identity before execution starts.
#[derive(Clone)]
pub struct MitmUsageHandle {
    control: ControlHandle,
}

#[derive(Clone)]
pub struct MitmRunUsage {
    target: Option<ControlTarget>,
    run_id: RunId,
    admission: Arc<Semaphore>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenTotals {
    pub input: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub output: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoverageReason {
    HistoryLost,
    RetentionLost,
    MissingUsage,
    MissingCategories,
    ParseError,
    AmbiguousResponse,
    UnsupportedProtocol,
    Interrupted,
    Overflow,
    InFlight,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunUsageSnapshot {
    pub run_id: RunId,
    pub revision: u64,
    pub sampled_at_ms: u64,
    pub observed_responses: u64,
    pub outstanding_responses: u64,
    pub complete: bool,
    pub reasons: Vec<CoverageReason>,
    pub totals: TokenTotals,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunUsageObservation {
    Available(RunUsageSnapshot),
    Unavailable {
        #[serde(rename = "runId")]
        run_id: RunId,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    run_id: RunId,
}

impl MitmUsageHandle {
    pub(super) fn new(control: ControlHandle) -> Self {
        Self { control }
    }

    pub fn for_run(&self, run_id: RunId) -> MitmRunUsage {
        MitmRunUsage {
            target: self.control.target(),
            run_id,
            admission: self.control.usage_admission.clone(),
        }
    }
}

impl MitmRunUsage {
    pub fn generation(&self) -> Option<&str> {
        self.target
            .as_ref()
            .map(|target| target.generation.as_str())
    }

    /// One bounded, cancellation-safe read. Saturation fails immediately; there
    /// is no queued work and dropping this future closes its socket and permit.
    /// A missing/stale launch is an error, never a fabricated zero snapshot.
    pub async fn snapshot(&self) -> io::Result<RunUsageObservation> {
        let _permit = self
            .admission
            .try_acquire()
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "MITM usage reads saturated"))?;
        let target = self.target.as_ref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotConnected, "MITM usage launch unavailable")
        })?;
        let observation: RunUsageObservation = control::exchange(
            &target.directory,
            &target.generation,
            "usage.snapshot",
            Params {
                run_id: self.run_id,
            },
            Instant::now() + TIMEOUT,
        )
        .await?;
        let valid = match &observation {
            RunUsageObservation::Unavailable { run_id } => *run_id == self.run_id,
            RunUsageObservation::Available(snapshot) => {
                snapshot.run_id == self.run_id && snapshot.is_valid()
            }
        };
        if !valid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "incoherent MITM usage observation",
            ));
        }
        Ok(observation)
    }
}

impl RunUsageSnapshot {
    fn is_valid(&self) -> bool {
        let totals = &self.totals;
        let sum = [
            totals.input,
            totals.cache_read,
            totals.cache_creation,
            totals.output,
        ]
        .into_iter()
        .try_fold(0_u64, u64::checked_add);
        self.sampled_at_ms > 0
            && self.sampled_at_ms <= MAX_QUANTITY
            && self.revision <= MAX_QUANTITY
            && self.observed_responses <= MAX_RESPONSES
            && self.outstanding_responses <= MAX_RESPONSES
            && totals.total <= MAX_QUANTITY
            && (self.observed_responses > 0 || totals.total == 0)
            && sum == Some(totals.total)
            && self.complete == self.reasons.is_empty()
            && self.reasons.contains(&CoverageReason::InFlight) == (self.outstanding_responses > 0)
            && self.reasons.iter().enumerate().all(|(index, reason)| {
                !self.reasons.iter().take(index).any(|prior| prior == reason)
            })
    }
}

#[cfg(test)]
mod tests;
