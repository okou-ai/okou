//! Passive diagnostics; these observers never own entry, Guest or admission custody.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, Instant};

use runner_host::home_observation::{HomeObservation, HomeObservationKind, HomeObservationOutcome};
use runner_storage::{SandboxOpRecord, SandboxOpReporter};
use runner_types::ids::RunId;

use super::HomeImageCache;

#[derive(Clone, Copy)]
pub(crate) enum HomePhase {
    EntryLockLifetime,
    IdleReclamationAdmission,
    TerminalUnpark,
    TerminalMount,
    TerminalPreparation,
    TerminalFreeze,
    SandboxStop,
    Publication,
    PublicationAdmission,
    DurableCommit,
}

impl HomePhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::EntryLockLifetime => "entry_lock_lifetime",
            Self::IdleReclamationAdmission => "idle_reclamation_admission",
            Self::TerminalUnpark => "terminal_unpark",
            Self::TerminalMount => "terminal_mount",
            Self::TerminalPreparation => "terminal_preparation",
            Self::TerminalFreeze => "terminal_freeze",
            Self::SandboxStop => "sandbox_stop",
            Self::Publication => "publication",
            Self::PublicationAdmission => "publication_admission",
            Self::DurableCommit => "durable_commit",
        }
    }
}

/// Origin of one physical custody, which may outlive its acquiring Run.
/// Do not allocate a diagnostic identity or emit a record at acquisition.
pub(super) struct HomeEntryLockTiming {
    acquired_at: Instant,
    acquiring_run_id: RunId,
    is_first_run: Option<bool>,
    reporter: Option<SandboxOpReporter>,
}

impl HomeEntryLockTiming {
    pub fn new(cache: &HomeImageCache, acquiring_run_id: RunId) -> Self {
        Self {
            acquired_at: Instant::now(),
            acquiring_run_id,
            is_first_run: cache.is_first_run,
            reporter: cache.telemetry.clone(),
        }
    }

    /// Called only after the last custody has dropped the actual flock.
    pub fn released(&self, cache_key: &str) {
        record_timing(
            self.reporter.as_ref(),
            self.acquiring_run_id,
            self.is_first_run,
            cache_key,
            HomePhase::EntryLockLifetime,
            self.acquired_at.elapsed(),
            HomeObservationOutcome::Released,
        );
    }
}

pub(crate) struct HomePhaseTimer {
    started: Instant,
    run_id: RunId,
    is_first_run: Option<bool>,
    cache_key: String,
    phase: HomePhase,
    outcome: HomeObservationOutcome,
    reporter: Option<SandboxOpReporter>,
}

impl HomePhaseTimer {
    pub(super) fn new(
        cache: &HomeImageCache,
        run_id: RunId,
        cache_key: &str,
        phase: HomePhase,
    ) -> Self {
        Self {
            started: Instant::now(),
            run_id,
            is_first_run: cache.is_first_run,
            cache_key: cache_key.to_owned(),
            phase,
            outcome: HomeObservationOutcome::Incomplete,
            reporter: cache.telemetry.clone(),
        }
    }

    pub fn finish(mut self, outcome: HomeObservationOutcome) {
        self.outcome = outcome;
    }
}

impl Drop for HomePhaseTimer {
    fn drop(&mut self) {
        record_timing(
            self.reporter.as_ref(),
            self.run_id,
            self.is_first_run,
            &self.cache_key,
            self.phase,
            self.started.elapsed(),
            self.outcome,
        );
    }
}

fn record_timing(
    reporter: Option<&SandboxOpReporter>,
    run_id: RunId,
    is_first_run: Option<bool>,
    cache_key: &str,
    phase: HomePhase,
    duration: Duration,
    outcome: HomeObservationOutcome,
) {
    // Optional diagnostics must not interrupt cleanup or double-panic during an
    // existing unwind. This boundary surrounds reporting only, never resource work.
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let kind = HomeObservationKind::LifecycleTiming;
        if let Some(reporter) = reporter {
            let mut observation = HomeObservation::new(kind, outcome);
            observation.run_id = Some(run_id);
            observation.is_first_run = is_first_run;
            observation.cache_key = Some(cache_key.to_owned());
            observation.reason = Some(phase.as_str().to_owned());
            let mut record = SandboxOpRecord::new(
                "runner_home_lifecycle_timing",
                duration,
                !matches!(
                    outcome,
                    HomeObservationOutcome::Failed | HomeObservationOutcome::Incomplete
                ),
                None,
            );
            record.home = Some(observation);
            reporter.record(record);
        }
    }));
}
