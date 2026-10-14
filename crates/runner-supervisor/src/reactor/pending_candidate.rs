//! Coordinate one unclaimed finalizing candidate with retained retry eligibility.

use std::time::Instant;

use runner_provider::JobCandidate;

use crate::lifecycle::RunnerMode;
use crate::pre_claim_admission::PendingFinalizingCandidate;

pub(super) struct PendingCandidate {
    candidate: PendingFinalizingCandidate,
    retry_requested: bool,
}

impl PendingCandidate {
    pub(super) fn new() -> Self {
        Self {
            candidate: PendingFinalizingCandidate::new(),
            retry_requested: false,
        }
    }

    pub(super) fn clear_if_inactive(&mut self, mode: RunnerMode) {
        if mode != RunnerMode::Running {
            self.candidate.clear();
            self.retry_requested = false;
        }
    }

    pub(super) fn request_retry(&mut self, mode: RunnerMode) {
        if mode == RunnerMode::Running {
            self.retry_requested = true;
        }
    }

    /// Keep a wakeup across full admission slots and an empty pending slot.
    /// Only an actual eligible take consumes it.
    pub(super) fn take_retry(
        &mut self,
        mode: RunnerMode,
        has_capacity: bool,
    ) -> Option<JobCandidate> {
        if !self.retry_requested || mode != RunnerMode::Running || !has_capacity {
            return None;
        }
        let candidate = self.candidate.take()?;
        self.retry_requested = false;
        Some(candidate)
    }

    pub(super) fn for_admission(&mut self, candidate: JobCandidate) -> JobCandidate {
        self.candidate.for_admission(candidate)
    }

    pub(super) fn retain(&mut self, candidate: JobCandidate, mode: RunnerMode) {
        if mode == RunnerMode::Running {
            self.candidate.retain(candidate);
        }
    }

    pub(super) fn expiry_deadline(&self, mode: RunnerMode, has_capacity: bool) -> Option<Instant> {
        if mode != RunnerMode::Running || !has_capacity {
            return None;
        }
        self.candidate.deadline()
    }

    /// Discovery and expiry keep any unused wakeup for a later pending result.
    /// Admission remains authoritative for the original preference and expiry.
    pub(super) fn take_expired(&mut self) -> Option<JobCandidate> {
        self.candidate.take_expired()
    }
}
