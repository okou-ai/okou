//! Request-owned exclusions while an API claim has not settled.
//!
//! A queued run may remain visible during its claim transaction. Polling must
//! exclude that run without treating it as a failed claim or starting a cooldown.
//! Each request owns one registration; dropping it wakes the existing poll
//! scheduler, including when an excluded poll found no other work.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard};

use api_contracts::generated::constants::runners::RUNNER_POLL_EXCLUDED_RUN_IDS_MAX;
use runner_types::ids::RunId;

use super::api_ably_supervisor::PollWakeups;

#[derive(Default)]
pub(super) struct InFlightClaims {
    registrations: Mutex<Vec<Arc<RunId>>>,
}

impl InFlightClaims {
    fn lock(&self) -> MutexGuard<'_, Vec<Arc<RunId>>> {
        self.registrations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn register<'a>(
        &'a self,
        run_id: RunId,
        wakeups: &'a PollWakeups,
    ) -> ClaimInFlight<'a> {
        let registration = Arc::new(run_id);
        self.lock().push(Arc::clone(&registration));
        ClaimInFlight {
            claims: self,
            registration,
            wakeups,
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    pub(super) fn contains(&self, run_id: RunId) -> bool {
        self.lock().iter().any(|registered| **registered == run_id)
    }

    pub(super) fn poll_exclusions(&self, cooldowns: &[RunId]) -> Vec<RunId> {
        let mut known: BTreeSet<_> = self.lock().iter().map(|registered| **registered).collect();
        // Keep pending requests first so a full cooldown inventory cannot
        // reintroduce the still-queued claim at network-round-trip cadence.
        // Omitted cooldowns remain authoritative in the existing local filter.
        let mut exclusions: Vec<_> = known.iter().copied().collect();
        exclusions.extend(
            cooldowns
                .iter()
                .copied()
                .filter(|run_id| known.insert(*run_id)),
        );
        exclusions.truncate(RUNNER_POLL_EXCLUDED_RUN_IDS_MAX as usize);
        exclusions
    }
}

pub(super) struct ClaimInFlight<'a> {
    claims: &'a InFlightClaims,
    registration: Arc<RunId>,
    wakeups: &'a PollWakeups,
}

impl Drop for ClaimInFlight<'_> {
    fn drop(&mut self) {
        // Identity, not Run ID alone, retires this request's registration.
        self.claims
            .lock()
            .retain(|registered| !Arc::ptr_eq(registered, &self.registration));
        self.wakeups.request_immediate_poll();
    }
}
