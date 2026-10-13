//! One current scheduling owner and revocable optional-start capabilities.

use std::sync::{Arc, Mutex};

use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};
use tokio::sync::{Notify, futures::OwnedNotified};
use tokio_util::sync::CancellationToken;

use super::{
    HostMemoryPressure, HostPressureDecision, HostPressurePolicy, HostPressurePolicyError,
    HostPressureState, HostPressureUnknown, HostPressureWave,
};
use crate::host_memory_operations::{HostMemoryOperations, MemoryOperationError};

struct State {
    pressure: HostMemoryPressure,
    epoch: u64,
    ready: bool,
    published: HostPressureDecision,
}

struct Shared {
    state: Mutex<State>,
    policy: HostPressurePolicy,
    operations: HostMemoryOperations,
    changed: Arc<Notify>,
    stop: CancellationToken,
}

/// The independent pressure controller owns this driver. Losing it revokes
/// optional starts, without aborting accepted IO or settling P2 allowances.
pub struct HostPressureCoordinator {
    shared: Arc<Shared>,
}

/// Restricted access to the same current pressure state and original P2 owner.
#[derive(Clone)]
pub struct OptionalPressureControl {
    shared: Arc<Shared>,
}

/// One consumed scheduling opportunity, not physical memory coverage.
#[must_use = "revalidate after outside-lock waits and acquire separate P2 coverage"]
pub struct OptionalPressureOpportunity {
    shared: Arc<Shared>,
    epoch: u64,
}

impl HostPressureCoordinator {
    pub fn new(
        policy: HostPressurePolicy,
        operations: HostMemoryOperations,
    ) -> Result<Self, MemoryOperationError> {
        let admission = operations.policy();
        if policy.bounds != admission.bounds || policy.max_sample_age != admission.max_sample_age {
            return Err(MemoryOperationError::InvalidLimits);
        }
        let mut pressure = HostMemoryPressure::new(policy).map_err(|error| match error {
            HostPressurePolicyError::Bounds(error) => MemoryOperationError::Bounds(error),
            HostPressurePolicyError::ZeroInterval => MemoryOperationError::InvalidLimits,
        })?;
        let published = pressure.decision();
        Ok(Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    pressure,
                    epoch: 0,
                    ready: false,
                    published,
                }),
                policy,
                operations,
                changed: Arc::new(Notify::new()),
                stop: CancellationToken::new(),
            }),
        })
    }

    pub fn optional_control(&self) -> OptionalPressureControl {
        OptionalPressureControl {
            shared: self.shared.clone(),
        }
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.shared.stop.clone()
    }

    pub fn observe(&mut self, observation: HostMemoryObservation) -> HostPressureDecision {
        self.shared
            .with_state(|state| state.pressure.observe(observation))
            .unwrap_or_else(|_| unavailable())
    }

    pub fn decision(&self) -> HostPressureDecision {
        self.shared.decision()
    }

    pub fn try_begin_wave(&mut self) -> Option<HostPressureWave> {
        if self.shared.stop.is_cancelled() {
            return None;
        }
        self.shared
            .with_state(|state| {
                if self.shared.stop.is_cancelled() {
                    None
                } else {
                    state.pressure.try_begin_wave()
                }
            })
            .ok()
            .flatten()
    }

    pub fn complete_wave(&mut self, wave: HostPressureWave) -> Result<(), HostPressureWave> {
        let mut wave = Some(wave);
        match self.shared.with_state(|state| {
            let Some(owned) = wave.take() else {
                return;
            };
            wave = state.pressure.complete_wave(owned).err();
        }) {
            Ok(()) => match wave {
                Some(wave) => Err(wave),
                None => Ok(()),
            },
            Err(_) => match wave {
                Some(wave) => Err(wave),
                // The exact token was positively consumed before an advisory
                // publication failure. No P2 allowance is settled here.
                None => Ok(()),
            },
        }
    }
}

impl Drop for HostPressureCoordinator {
    fn drop(&mut self) {
        self.shared.stop.cancel();
    }
}

impl OptionalPressureControl {
    pub fn policy(&self) -> HostPressurePolicy {
        self.shared.policy
    }

    /// This clone is always the exact accepting authority supplied to the driver.
    pub fn operations(&self) -> HostMemoryOperations {
        self.shared.operations.clone()
    }

    pub fn stopped(&self) -> CancellationToken {
        self.shared.stop.clone()
    }

    /// Register the notification before checking current state. This carries no
    /// cached permission or retained channel borrow that can block the driver.
    pub fn changed(&self) -> OwnedNotified {
        self.shared.changed.clone().notified_owned()
    }

    pub fn decision(&self) -> HostPressureDecision {
        if self.shared.stop.is_cancelled() {
            unavailable()
        } else {
            self.shared.decision()
        }
    }

    pub fn take_optional_start(
        &self,
    ) -> Result<Option<OptionalPressureOpportunity>, MemoryOperationError> {
        let epoch = self.shared.with_state(|state| {
            if self.shared.stop.is_cancelled() {
                Err(MemoryOperationError::Closed)
            } else {
                Ok(state.pressure.take_optional_start().then_some(state.epoch))
            }
        })??;
        Ok(epoch.map(|epoch| OptionalPressureOpportunity {
            shared: self.shared.clone(),
            epoch,
        }))
    }
}

impl OptionalPressureOpportunity {
    /// A Critical/Unknown/stale/wave/stop transition revokes the original offer,
    /// even if the owner subsequently recovers before the capacity wait ends.
    pub fn revalidate(&self) -> Result<bool, MemoryOperationError> {
        self.shared.with_state(|state| {
            let decision = state.pressure.decision();
            !self.shared.stop.is_cancelled() && self.epoch == state.epoch && ready(&decision)
        })
    }
}

impl Shared {
    fn decision(&self) -> HostPressureDecision {
        self.with_state(|state| state.pressure.decision())
            .unwrap_or_else(|_| unavailable())
    }

    fn with_state<T>(
        &self,
        update: impl FnOnce(&mut State) -> T,
    ) -> Result<T, MemoryOperationError> {
        let result = (|| {
            let mut state = self
                .state
                .lock()
                .map_err(|_| MemoryOperationError::AccountingPoisoned)?;
            refresh_epoch(&mut state)?;
            let value = update(&mut state);
            let decision = refresh_epoch(&mut state)?;
            let changed = state.published != decision;
            state.published = decision;
            Ok((value, changed))
        })();
        let (value, changed) = match result {
            Ok(result) => result,
            Err(error) => {
                // Wake owners only after the state lock has been released.
                self.stop.cancel();
                return Err(error);
            }
        };
        if changed {
            self.changed.notify_waiters();
        }
        Ok(value)
    }
}

fn refresh_epoch(state: &mut State) -> Result<HostPressureDecision, MemoryOperationError> {
    let decision = state.pressure.decision();
    let current = ready(&decision);
    if state.ready && !current {
        state.epoch = state
            .epoch
            .checked_add(1)
            .ok_or(MemoryOperationError::AccountingOverflow)?;
    }
    state.ready = current;
    Ok(decision)
}

fn ready(decision: &HostPressureDecision) -> bool {
    decision.state == HostPressureState::Ready && !decision.wave_inflight
}

fn unavailable() -> HostPressureDecision {
    HostPressureDecision {
        state: HostPressureState::Unknown,
        available_bytes: None,
        unknown: Some(HostPressureUnknown::Observation(
            HostMemoryUnknown::ObserverStopped,
        )),
        wave_inflight: true,
        wave_ready: false,
        optional_start_ready: false,
    }
}
