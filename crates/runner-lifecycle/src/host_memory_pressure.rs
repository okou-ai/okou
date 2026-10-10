//! Current-only pressure scheduling, not physical admission or memory relief.
//!
//! The independent owner supplies observations and measured policy. Wave and
//! optional-start opportunities never replace `HostMemoryOperations`, real work
//! ownership, saving, exact backing exit or phase settlement. No production
//! consumer or numerical policy is selected by this component.

use std::num::NonZeroUsize;
use std::time::Duration;

use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};
use tokio::time::Instant;
use uuid::Uuid;

use crate::host_memory_policy::{HostMemoryBounds, HostMemoryBoundsError};

/// Immutable supplied scheduling bounds, with no defaults or public config.
#[derive(Clone, Copy, Debug)]
pub struct HostPressurePolicy {
    pub bounds: HostMemoryBounds,
    pub max_sample_age: Duration,
    pub recovery_sustain: Duration,
    pub wave_cooldown: Duration,
    pub optional_start_interval: Duration,
    pub max_wave_entries: NonZeroUsize,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum HostPressurePolicyError {
    #[error(transparent)]
    Bounds(#[from] HostMemoryBoundsError),
    #[error("pressure freshness, sustain and scheduling intervals must be positive")]
    ZeroInterval,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostPressureUnknown {
    Observation(HostMemoryUnknown),
    ExceedsHostTotal,
    OutOfOrder,
    BeforeWaveCompletion,
}

/// Observation state, not an Off/Observe/Enforce runtime selector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostPressureState {
    Unknown,
    Critical,
    Constrained,
    Recovering,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostPressureDecision {
    pub state: HostPressureState,
    pub available_bytes: Option<u64>,
    pub unknown: Option<HostPressureUnknown>,
    pub wave_inflight: bool,
    pub wave_ready: bool,
    pub optional_start_ready: bool,
}

/// Exact scheduling ownership only. Losing this token never finishes its wave.
/// The entry bound is not export coverage or an instruction to detach resources.
#[derive(Debug)]
#[must_use = "retain until positive wave completion; dropping leaves the wave unresolved"]
pub struct HostPressureWave {
    owner: Uuid,
    generation: Uuid,
    max_entries: NonZeroUsize,
}

impl HostPressureWave {
    pub fn max_entries(&self) -> NonZeroUsize {
        self.max_entries
    }
}

/// One process-local owner's synchronous decision state. No I/O or provider work
/// runs here. Callers serialize access and run actual work independently.
pub struct HostMemoryPressure {
    owner: Uuid,
    policy: HostPressurePolicy,
    latest: Option<HostMemoryObservation>,
    last_read_start: Option<Instant>,
    unknown: Option<HostPressureUnknown>,
    recovered: bool,
    recovery_since: Option<Instant>,
    wave: Option<Uuid>,
    wave_finished_at: Option<Instant>,
    optional_started_at: Option<Instant>,
    optional_read_start: Option<Instant>,
}

impl HostMemoryPressure {
    pub fn new(policy: HostPressurePolicy) -> Result<Self, HostPressurePolicyError> {
        policy.bounds.validate()?;
        if policy.max_sample_age.is_zero()
            || policy.recovery_sustain.is_zero()
            || policy.wave_cooldown.is_zero()
            || policy.optional_start_interval.is_zero()
        {
            return Err(HostPressurePolicyError::ZeroInterval);
        }
        Ok(Self {
            owner: Uuid::new_v4(),
            policy,
            latest: None,
            last_read_start: None,
            unknown: Some(HostPressureUnknown::Observation(
                HostMemoryUnknown::NotObserved,
            )),
            recovered: false,
            recovery_since: None,
            wave: None,
            wave_finished_at: None,
            optional_started_at: None,
            optional_read_start: None,
        })
    }

    /// Accept a read, not a renewed cache timestamp. Distinct ordered reads and
    /// bounded gaps are required to accumulate sustained recovery evidence.
    pub fn observe(&mut self, observation: HostMemoryObservation) -> HostPressureDecision {
        let now = Instant::now();
        let started = observation.age_at(now).and_then(|age| now.checked_sub(age));
        let available = observation.available_bytes_at(now, self.policy.max_sample_age);
        let Some(started) = started else {
            self.invalidate(HostPressureUnknown::Observation(
                HostMemoryUnknown::InvalidTiming,
            ));
            return self.decision();
        };
        if self.last_read_start.is_some_and(|last| started < last) {
            self.invalidate(HostPressureUnknown::OutOfOrder);
            return self.decision();
        }
        let bytes = match available {
            Ok(bytes) if bytes <= self.policy.bounds.host_total_bytes => bytes,
            Ok(_) => {
                self.last_read_start = Some(started);
                self.invalidate(HostPressureUnknown::ExceedsHostTotal);
                return self.decision();
            }
            Err(error) => {
                self.last_read_start = Some(started);
                self.invalidate(HostPressureUnknown::Observation(error));
                return self.decision();
            }
        };
        if self
            .wave_finished_at
            .is_some_and(|finished| started <= finished)
        {
            self.last_read_start = Some(started);
            self.invalidate(HostPressureUnknown::BeforeWaveCompletion);
            return self.decision();
        }
        if self.last_read_start == Some(started) {
            // Replaying the same read neither restarts nor advances recovery.
            return self.decision();
        }
        if self
            .last_read_start
            .is_some_and(|last| started.duration_since(last) >= self.policy.max_sample_age)
        {
            self.reset_recovery();
        }
        self.last_read_start = Some(started);
        self.unknown = None;
        if bytes <= self.policy.bounds.critical_available_bytes {
            self.reset_recovery();
        } else if bytes >= self.policy.bounds.recovery_available_bytes {
            let since = *self.recovery_since.get_or_insert(started);
            if started.duration_since(since) >= self.policy.recovery_sustain
                && self.wave.is_none()
                && elapsed(now, self.wave_finished_at, self.policy.wave_cooldown)
            {
                self.recovered = true;
            }
        } else {
            // A recovered owner stays recovered in the hysteresis band, but
            // optional starts still require the higher recovery watermark.
            self.recovery_since = None;
        }
        self.latest = Some(observation);
        self.decision()
    }

    /// Cached scheduling readiness expires at use. It is never growth admission.
    pub fn decision(&mut self) -> HostPressureDecision {
        let now = Instant::now();
        let available = match self.latest.as_ref() {
            Some(observation) => {
                match observation.available_bytes_at(now, self.policy.max_sample_age) {
                    Ok(bytes) => Some(bytes),
                    Err(error) => {
                        self.invalidate(HostPressureUnknown::Observation(error));
                        None
                    }
                }
            }
            None => None,
        };
        let state = match available {
            None => HostPressureState::Unknown,
            Some(bytes) if bytes <= self.policy.bounds.critical_available_bytes => {
                HostPressureState::Critical
            }
            Some(_) if self.recovered => HostPressureState::Ready,
            Some(bytes) if bytes >= self.policy.bounds.recovery_available_bytes => {
                HostPressureState::Recovering
            }
            Some(_) => HostPressureState::Constrained,
        };
        HostPressureDecision {
            state,
            available_bytes: available,
            unknown: self.unknown.clone(),
            wave_inflight: self.wave.is_some(),
            wave_ready: state == HostPressureState::Critical
                && self.wave.is_none()
                && elapsed(now, self.wave_finished_at, self.policy.wave_cooldown),
            optional_start_ready: state == HostPressureState::Ready
                && available
                    .is_some_and(|bytes| bytes >= self.policy.bounds.recovery_available_bytes)
                && self.wave.is_none()
                && self.last_read_start != self.optional_read_start
                && elapsed(
                    now,
                    self.optional_started_at,
                    self.policy.optional_start_interval,
                ),
        }
    }

    pub fn try_begin_wave(&mut self) -> Option<HostPressureWave> {
        if !self.decision().wave_ready {
            return None;
        }
        let generation = Uuid::new_v4();
        self.wave = Some(generation);
        Some(HostPressureWave {
            owner: self.owner,
            generation,
            max_entries: self.policy.max_wave_entries,
        })
    }

    /// Report positive completion of the accepted wave's real work, not caller
    /// cancellation, timeout, kill or pool removal. The owner must establish that
    /// evidence; this method proves no saving, backing exit or released bytes.
    /// No P2 allowance is settled here. A foreign token is returned unchanged.
    pub fn complete_wave(&mut self, wave: HostPressureWave) -> Result<(), HostPressureWave> {
        if wave.owner != self.owner || self.wave != Some(wave.generation) {
            return Err(wave);
        }
        self.wave = None;
        self.wave_finished_at = Some(Instant::now());
        self.invalidate(HostPressureUnknown::Observation(
            HostMemoryUnknown::NotObserved,
        ));
        Ok(())
    }

    /// Consume one paced optional-start opportunity. Consumers still need a
    /// separate fresh P2 permit and ownership before any actual physical work.
    pub fn take_optional_start(&mut self) -> bool {
        if !self.decision().optional_start_ready {
            return false;
        }
        self.optional_started_at = Some(Instant::now());
        self.optional_read_start = self.last_read_start;
        true
    }

    fn reset_recovery(&mut self) {
        self.recovered = false;
        self.recovery_since = None;
    }

    fn invalidate(&mut self, reason: HostPressureUnknown) {
        self.latest = None;
        self.unknown = Some(reason);
        self.reset_recovery();
    }
}

fn elapsed(now: Instant, since: Option<Instant>, interval: Duration) -> bool {
    since.is_none_or(|since| {
        now.checked_duration_since(since)
            .is_some_and(|age| age >= interval)
    })
}

#[cfg(test)]
mod tests;
