//! A private, memory-only receipt survives the startup future and weak node entry.

use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicU8, Ordering},
};

use super::Failure;

enum State {
    NotDispatched,
    Creating,
    Captured(String),
    PossiblyConsumed,
    Confirmed,
    Deleting,
    Cleaned,
}

pub(crate) struct Journal {
    state: Mutex<State>,
    physical: AtomicU8,
    evidence: OnceLock<Arc<crate::diagnostics::NativeEvidence>>,
}

pub(super) enum Cleanup {
    None,
    Unused(String),
}

impl Journal {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(State::NotDispatched),
            physical: AtomicU8::new(0),
            evidence: OnceLock::new(),
        }
    }

    // Pure source facts survive weak-node removal; this holds no physical owner.
    pub(super) fn retain_evidence(&self, evidence: Arc<crate::diagnostics::NativeEvidence>) {
        self.evidence.get_or_init(|| evidence);
    }

    pub(super) fn evidence(&self) -> Option<Arc<crate::diagnostics::NativeEvidence>> {
        self.evidence.get().cloned()
    }

    pub(super) fn retry_safe(&self) -> bool {
        self.physical.load(Ordering::Acquire) == 1
            && matches!(
                *self.state.lock().unwrap_or_else(|p| p.into_inner()),
                State::NotDispatched | State::Cleaned | State::Confirmed
            )
    }

    /// Only the actual worker join (or an allocation that never started work)
    /// can make a safely reconciled attempt eligible for another startup.
    pub(super) fn finished(&self, result: Result<(), Failure>) {
        self.physical
            .store(if result.is_ok() { 1 } else { 2 }, Ordering::Release);
    }

    pub(super) fn physical_failed(&self) -> bool {
        self.physical.load(Ordering::Acquire) == 2
    }

    /// Called immediately before the first possible plaintext create write.
    pub(super) fn creating(&self) -> Result<(), Failure> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !matches!(*state, State::NotDispatched) {
            return Err(Failure::DomainFailed);
        }
        *state = State::Creating;
        Ok(())
    }

    pub(super) fn captured(&self, id: &str) -> Result<(), Failure> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !matches!(*state, State::Creating)
            || id.is_empty()
            || id.len() > 256
            || !id.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err(Failure::DomainFailed);
        }
        *state = State::Captured(id.to_owned());
        Ok(())
    }

    /// Mark before registration can possibly consume the one-use key. A failed
    /// registration response is never treated as proof that it stayed unused.
    pub(super) fn consuming(&self) -> Result<(), Failure> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !matches!(*state, State::Captured(_)) {
            return Err(Failure::DomainFailed);
        }
        *state = State::PossiblyConsumed;
        Ok(())
    }

    pub(super) fn cleanup(&self, established: bool) -> Result<Cleanup, Failure> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match &*state {
            State::NotDispatched | State::Cleaned | State::Confirmed => Ok(Cleanup::None),
            State::PossiblyConsumed => {
                if established {
                    *state = State::Confirmed;
                }
                Ok(Cleanup::None)
            }
            State::Captured(id) => {
                let id = id.clone();
                *state = State::Deleting;
                Ok(Cleanup::Unused(id))
            }
            // No request correlation exists for an unknown-ID create. Neither
            // list matching nor another create/delete can reconcile it safely.
            State::Creating | State::Deleting => Err(Failure::DomainFailed),
        }
    }

    pub(super) fn cleaned(&self) -> Result<(), Failure> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !matches!(*state, State::Deleting) {
            return Err(Failure::DomainFailed);
        }
        *state = State::Cleaned;
        Ok(())
    }
}
