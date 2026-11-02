//! Active-run reuse state, exact sandbox handoff, and release ownership.

use std::collections::{HashMap, HashSet, hash_map};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use sandbox::SandboxFinalExecParkHandoff;
use tokio::sync::{Notify, oneshot, watch};

use crate::idle_pool::{FinalizingHandoffCandidate, IdleParkCandidate};
use runner_types::ids::RunId;
use runner_types::types::{ActiveReuseProducer, MAX_ACTIVE_REUSE_PRODUCERS};

#[derive(Clone)]
pub struct ActiveRuns {
    entries: Arc<Mutex<HashMap<RunId, ActiveRunEntry>>>,
    reuse_state_notify: Arc<Notify>,
}

struct ActiveRunEntry {
    reuse_key: Option<String>,
    profile_name: String,
    reuse_state: watch::Sender<ActiveRunReuseState>,
    handoff: Arc<Mutex<ActiveRunHandoffBroker>>,
}

struct ActiveRunHandoffBroker {
    predecessor_run_id: Option<RunId>,
    signal: SandboxFinalExecParkHandoff,
    delivery: Option<ActiveRunHandoffDelivery>,
}

struct ActiveRunHandoffDelivery {
    successor_run_id: RunId,
    sender: oneshot::Sender<Box<FinalizingHandoffCandidate>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveRunReuseState {
    Pending,
    Finalizing { started_at: Instant },
    ExactSandboxPublished,
    ExactSandboxHandedOff,
    NoExactSandbox,
    Released,
}

impl ActiveRunReuseState {
    pub fn can_publish_exact(self) -> bool {
        matches!(self, Self::Pending | Self::Finalizing { .. })
    }
}

pub struct ActiveRunReuseProof {
    reuse_state: watch::Receiver<ActiveRunReuseState>,
    handoff: Arc<Mutex<ActiveRunHandoffBroker>>,
}

impl ActiveRunReuseProof {
    pub fn state(&self) -> ActiveRunReuseState {
        *self.reuse_state.borrow()
    }

    pub async fn changed(&mut self) -> ActiveRunReuseState {
        if self.reuse_state.changed().await.is_err() {
            return ActiveRunReuseState::Released;
        }
        self.state()
    }

    pub fn request_handoff(&self, successor_run_id: RunId) -> Option<ActiveRunHandoffRequest> {
        let mut broker = lock_handoff(&self.handoff);
        if !self.state().can_publish_exact() || broker.delivery.is_some() {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        broker.delivery = Some(ActiveRunHandoffDelivery {
            successor_run_id,
            sender,
        });
        if !broker.signal.request() {
            broker.delivery = None;
            return None;
        }
        Some(ActiveRunHandoffRequest {
            successor_run_id,
            signal: broker.signal.clone(),
            receiver,
            broker: Arc::clone(&self.handoff),
        })
    }
}

pub struct ActiveRunHandoffRequest {
    successor_run_id: RunId,
    signal: SandboxFinalExecParkHandoff,
    receiver: oneshot::Receiver<Box<FinalizingHandoffCandidate>>,
    broker: Arc<Mutex<ActiveRunHandoffBroker>>,
}

impl ActiveRunHandoffRequest {
    pub async fn accepted(&self) -> bool {
        self.signal.wait_for_acceptance().await
    }

    pub async fn receive(
        &mut self,
    ) -> Result<Box<FinalizingHandoffCandidate>, oneshot::error::RecvError> {
        (&mut self.receiver).await
    }

    pub fn cancel_and_recover_delivery(&mut self) -> Option<Box<FinalizingHandoffCandidate>> {
        self.close_delivery();
        self.receiver.try_recv().ok()
    }

    pub fn expire_if_unaccepted(&mut self) -> bool {
        let mut broker = lock_handoff(&self.broker);
        if !self.signal.cancel() && self.signal.is_accepted() {
            return false;
        }
        self.receiver.close();
        if broker
            .delivery
            .as_ref()
            .is_some_and(|delivery| delivery.successor_run_id == self.successor_run_id)
        {
            broker.delivery = None;
        }
        true
    }

    fn close_delivery(&mut self) {
        let mut broker = lock_handoff(&self.broker);
        self.receiver.close();
        self.signal.cancel();
        if broker
            .delivery
            .as_ref()
            .is_some_and(|delivery| delivery.successor_run_id == self.successor_run_id)
        {
            broker.delivery = None;
        }
    }
}

impl Drop for ActiveRunHandoffRequest {
    fn drop(&mut self) {
        self.close_delivery();
    }
}

#[derive(Clone)]
pub struct ActiveRunReusePublisher {
    reuse_state: watch::Sender<ActiveRunReuseState>,
    handoff: Arc<Mutex<ActiveRunHandoffBroker>>,
}

pub enum ActiveRunHandoffDeliveryResult {
    Delivered,
    NotRequested(IdleParkCandidate),
    Failed(IdleParkCandidate),
}

/// Actual binding survives a failed send. No cleanup/provider callback occurs
/// while the broker lock is held; callers retain every rejected candidate.
pub enum RetainedActiveRunHandoffDeliveryResult {
    Delivered,
    NotRequested(IdleParkCandidate),
    Undelivered(IdleParkCandidate),
    Failed(Box<FinalizingHandoffCandidate>),
}

impl ActiveRunReusePublisher {
    pub fn predecessor_run_id(&self) -> Option<RunId> {
        lock_handoff(&self.handoff).predecessor_run_id
    }
    pub fn mark_finalizing(&self, started_at: Instant) -> bool {
        self.reuse_state.send_if_modified(|state| {
            if *state != ActiveRunReuseState::Pending {
                return false;
            }
            *state = ActiveRunReuseState::Finalizing { started_at };
            true
        })
    }

    pub fn publish_exact_sandbox(&self) -> bool {
        self.publish_without_handoff(ActiveRunReuseState::ExactSandboxPublished)
    }

    pub fn publish_no_exact_sandbox(&self) -> bool {
        self.publish_without_handoff(ActiveRunReuseState::NoExactSandbox)
    }

    pub fn handoff_signal(&self) -> SandboxFinalExecParkHandoff {
        lock_handoff(&self.handoff).signal.clone()
    }

    pub fn deliver_exact_handoff(
        &self,
        candidate: IdleParkCandidate,
        predecessor_run_id: RunId,
    ) -> ActiveRunHandoffDeliveryResult {
        match self.deliver_exact_handoff_retained(candidate, predecessor_run_id) {
            RetainedActiveRunHandoffDeliveryResult::Delivered => {
                ActiveRunHandoffDeliveryResult::Delivered
            }
            RetainedActiveRunHandoffDeliveryResult::NotRequested(candidate) => {
                ActiveRunHandoffDeliveryResult::NotRequested(candidate)
            }
            RetainedActiveRunHandoffDeliveryResult::Undelivered(candidate) => {
                ActiveRunHandoffDeliveryResult::Failed(candidate)
            }
            RetainedActiveRunHandoffDeliveryResult::Failed(candidate) => {
                ActiveRunHandoffDeliveryResult::Failed(candidate.into_candidate())
            }
        }
    }

    pub fn deliver_exact_handoff_retained(
        &self,
        candidate: IdleParkCandidate,
        predecessor_run_id: RunId,
    ) -> RetainedActiveRunHandoffDeliveryResult {
        let mut broker = lock_handoff(&self.handoff);
        if broker
            .predecessor_run_id
            .is_some_and(|actual| actual != predecessor_run_id)
        {
            return RetainedActiveRunHandoffDeliveryResult::Undelivered(candidate);
        }
        if !broker.signal.accept_if_requested() {
            return RetainedActiveRunHandoffDeliveryResult::NotRequested(candidate);
        }
        let Some(delivery) = broker.delivery.take() else {
            return RetainedActiveRunHandoffDeliveryResult::Undelivered(candidate);
        };
        let candidate = Box::new(
            candidate.into_finalizing_handoff(delivery.successor_run_id, predecessor_run_id),
        );
        match delivery.sender.send(candidate) {
            Ok(()) => {
                self.resolve_publishable(ActiveRunReuseState::ExactSandboxHandedOff);
                RetainedActiveRunHandoffDeliveryResult::Delivered
            }
            Err(candidate) => RetainedActiveRunHandoffDeliveryResult::Failed(candidate),
        }
    }

    fn resolve_publishable(&self, next: ActiveRunReuseState) -> bool {
        self.reuse_state.send_if_modified(|state| {
            if !state.can_publish_exact() {
                return false;
            }
            *state = next;
            true
        })
    }

    fn publish_without_handoff(&self, next: ActiveRunReuseState) -> bool {
        let mut broker = lock_handoff(&self.handoff);
        let resolved = self.resolve_publishable(next);
        if resolved {
            broker.signal.cancel();
            broker.delivery = None;
        }
        resolved
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn detached() -> Self {
        let (reuse_state, _reuse_state_rx) = watch::channel(ActiveRunReuseState::Pending);
        Self {
            reuse_state,
            handoff: Arc::new(Mutex::new(ActiveRunHandoffBroker {
                predecessor_run_id: None,
                signal: SandboxFinalExecParkHandoff::new(),
                delivery: None,
            })),
        }
    }
}

pub struct ActiveRunGuard {
    active_runs: ActiveRuns,
    run_id: Option<RunId>,
    has_reuse_key: bool,
    reuse_state: watch::Sender<ActiveRunReuseState>,
    handoff: Arc<Mutex<ActiveRunHandoffBroker>>,
}

impl ActiveRuns {
    pub fn new(reuse_state_notify: Arc<Notify>) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            reuse_state_notify,
        }
    }

    pub fn register(
        &self,
        run_id: RunId,
        reuse_key: Option<String>,
        profile_name: String,
    ) -> ActiveRunGuard {
        let (reuse_state, _reuse_state_rx) = watch::channel(ActiveRunReuseState::Pending);
        let handoff = Arc::new(Mutex::new(ActiveRunHandoffBroker {
            predecessor_run_id: Some(run_id),
            signal: SandboxFinalExecParkHandoff::new(),
            delivery: None,
        }));
        let has_reuse_key = reuse_key.is_some();
        let mut entries = lock_entries(&self.entries);
        let entry = entries.entry(run_id);
        assert!(
            matches!(&entry, hash_map::Entry::Vacant(_)),
            "active run registered twice: {run_id}"
        );
        if let hash_map::Entry::Vacant(entry) = entry {
            entry.insert(ActiveRunEntry {
                reuse_key,
                profile_name,
                reuse_state: reuse_state.clone(),
                handoff: Arc::clone(&handoff),
            });
        }
        drop(entries);
        if has_reuse_key {
            self.reuse_state_notify.notify_one();
        }
        ActiveRunGuard {
            active_runs: self.clone(),
            run_id: Some(run_id),
            has_reuse_key,
            reuse_state,
            handoff,
        }
    }

    pub fn finalizing_predecessor(
        &self,
        run_id: RunId,
        reuse_key: &str,
        profile_name: &str,
    ) -> Option<ActiveRunReuseProof> {
        let entries = lock_entries(&self.entries);
        let entry = entries.get(&run_id)?;
        if entry.reuse_key.as_deref() != Some(reuse_key) || entry.profile_name != profile_name {
            return None;
        }
        let proof = ActiveRunReuseProof {
            reuse_state: entry.reuse_state.subscribe(),
            handoff: Arc::clone(&entry.handoff),
        };
        proof.state().can_publish_exact().then_some(proof)
    }

    pub fn active_reuse_producers(&self) -> Vec<ActiveReuseProducer> {
        let entries = lock_entries(&self.entries);
        let mut producers: Vec<_> = entries
            .iter()
            .filter(|(_, entry)| entry.reuse_state.borrow().can_publish_exact())
            .filter_map(|(run_id, entry)| {
                Some(ActiveReuseProducer {
                    run_id: *run_id,
                    reuse_key: entry.reuse_key.clone()?,
                    profile: entry.profile_name.clone(),
                })
            })
            .collect();
        producers.sort_unstable_by_key(|entry| entry.run_id);
        producers.truncate(MAX_ACTIVE_REUSE_PRODUCERS);
        producers
    }

    pub fn reuse_keys(&self) -> HashSet<String> {
        lock_entries(&self.entries)
            .values()
            .filter(|entry| entry.reuse_state.borrow().can_publish_exact())
            .filter_map(|entry| entry.reuse_key.clone())
            .collect()
    }

    pub fn has_reusable_run(&self) -> bool {
        lock_entries(&self.entries).values().any(|entry| {
            entry.reuse_key.is_some() && entry.reuse_state.borrow().can_publish_exact()
        })
    }

    /// A process-local liveness fence, not proof that a sandbox is running.
    /// The receiver becomes Released (or closes) when the guard leaves this
    /// process; consumers must also verify the exact live sandbox assignment.
    pub fn watch_live_run(&self, run_id: RunId) -> Option<watch::Receiver<ActiveRunReuseState>> {
        let entries = lock_entries(&self.entries);
        let entry = entries.get(&run_id)?;
        let receiver = entry.reuse_state.subscribe();
        if *receiver.borrow() == ActiveRunReuseState::Released {
            return None;
        }
        Some(receiver)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn contains(&self, run_id: RunId) -> bool {
        lock_entries(&self.entries).contains_key(&run_id)
    }
}

impl ActiveRunGuard {
    pub fn reuse_publisher(&self) -> ActiveRunReusePublisher {
        ActiveRunReusePublisher {
            reuse_state: self.reuse_state.clone(),
            handoff: Arc::clone(&self.handoff),
        }
    }

    pub fn release(mut self) -> bool {
        self.release_inner()
    }

    fn release_inner(&mut self) -> bool {
        let Some(run_id) = self.run_id.take() else {
            return false;
        };
        lock_entries(&self.active_runs.entries).remove(&run_id);
        let was_publishable = {
            let mut handoff = lock_handoff(&self.handoff);
            handoff.signal.cancel();
            handoff.delivery = None;
            self.reuse_state
                .send_replace(ActiveRunReuseState::Released)
                .can_publish_exact()
        };
        if self.has_reuse_key && was_publishable {
            self.active_runs.reuse_state_notify.notify_one();
        }
        self.has_reuse_key
    }
}

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        self.release_inner();
    }
}

fn lock_entries(
    entries: &Mutex<HashMap<RunId, ActiveRunEntry>>,
) -> MutexGuard<'_, HashMap<RunId, ActiveRunEntry>> {
    entries
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_handoff(handoff: &Mutex<ActiveRunHandoffBroker>) -> MutexGuard<'_, ActiveRunHandoffBroker> {
    handoff
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
