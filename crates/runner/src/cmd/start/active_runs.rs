use std::collections::{HashMap, HashSet, hash_map};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use sandbox::SandboxFinalExecParkHandoff;
use tokio::sync::{Notify, oneshot, watch};

use crate::idle_pool::{FinalizingHandoffCandidate, IdleParkCandidate};
use crate::ids::RunId;

#[derive(Clone)]
pub(super) struct ActiveRuns {
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
    signal: SandboxFinalExecParkHandoff,
    delivery: Option<ActiveRunHandoffDelivery>,
}

struct ActiveRunHandoffDelivery {
    successor_run_id: RunId,
    sender: oneshot::Sender<Box<FinalizingHandoffCandidate>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ActiveRunReuseState {
    Pending,
    Finalizing { started_at: Instant },
    ExactSandboxPublished,
    ExactSandboxHandedOff,
    NoExactSandbox,
    Released,
}

impl ActiveRunReuseState {
    pub(super) fn can_publish_exact(self) -> bool {
        matches!(self, Self::Pending | Self::Finalizing { .. })
    }
}

pub(super) struct ActiveRunReuseProof {
    reuse_state: watch::Receiver<ActiveRunReuseState>,
    handoff: Arc<Mutex<ActiveRunHandoffBroker>>,
}

impl ActiveRunReuseProof {
    pub(super) fn state(&self) -> ActiveRunReuseState {
        *self.reuse_state.borrow()
    }

    pub(super) async fn changed(&mut self) -> ActiveRunReuseState {
        if self.reuse_state.changed().await.is_err() {
            return ActiveRunReuseState::Released;
        }
        self.state()
    }

    pub(super) fn request_handoff(
        &self,
        successor_run_id: RunId,
    ) -> Option<ActiveRunHandoffRequest> {
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

pub(super) struct ActiveRunHandoffRequest {
    successor_run_id: RunId,
    signal: SandboxFinalExecParkHandoff,
    receiver: oneshot::Receiver<Box<FinalizingHandoffCandidate>>,
    broker: Arc<Mutex<ActiveRunHandoffBroker>>,
}

impl ActiveRunHandoffRequest {
    pub(super) async fn accepted(&self) -> bool {
        self.signal.wait_for_acceptance().await
    }

    pub(super) async fn receive(
        &mut self,
    ) -> Result<Box<FinalizingHandoffCandidate>, oneshot::error::RecvError> {
        (&mut self.receiver).await
    }

    pub(super) fn cancel_and_recover_delivery(
        &mut self,
    ) -> Option<Box<FinalizingHandoffCandidate>> {
        self.close_delivery();
        self.receiver.try_recv().ok()
    }

    pub(super) fn expire_if_unaccepted(&mut self) -> bool {
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
pub(super) struct ActiveRunReusePublisher {
    reuse_state: watch::Sender<ActiveRunReuseState>,
    handoff: Arc<Mutex<ActiveRunHandoffBroker>>,
}

pub(super) enum ActiveRunHandoffDeliveryResult {
    Delivered,
    NotRequested(IdleParkCandidate),
    Failed(IdleParkCandidate),
}

impl ActiveRunReusePublisher {
    pub(super) fn mark_finalizing(&self, started_at: Instant) -> bool {
        self.reuse_state.send_if_modified(|state| {
            if *state != ActiveRunReuseState::Pending {
                return false;
            }
            *state = ActiveRunReuseState::Finalizing { started_at };
            true
        })
    }

    pub(super) fn publish_exact_sandbox(&self) -> bool {
        self.publish_without_handoff(ActiveRunReuseState::ExactSandboxPublished)
    }

    pub(super) fn publish_no_exact_sandbox(&self) -> bool {
        self.publish_without_handoff(ActiveRunReuseState::NoExactSandbox)
    }

    pub(super) fn handoff_signal(&self) -> SandboxFinalExecParkHandoff {
        lock_handoff(&self.handoff).signal.clone()
    }

    pub(super) fn deliver_exact_handoff(
        &self,
        candidate: IdleParkCandidate,
        predecessor_run_id: RunId,
    ) -> ActiveRunHandoffDeliveryResult {
        let mut broker = lock_handoff(&self.handoff);
        if !broker.signal.accept_if_requested() {
            return ActiveRunHandoffDeliveryResult::NotRequested(candidate);
        }
        let Some(delivery) = broker.delivery.take() else {
            return ActiveRunHandoffDeliveryResult::Failed(candidate);
        };
        let candidate = Box::new(
            candidate.into_finalizing_handoff(delivery.successor_run_id, predecessor_run_id),
        );
        match delivery.sender.send(candidate) {
            Ok(()) => {
                self.resolve_publishable(ActiveRunReuseState::ExactSandboxHandedOff);
                ActiveRunHandoffDeliveryResult::Delivered
            }
            Err(candidate) => ActiveRunHandoffDeliveryResult::Failed(candidate.into_candidate()),
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

    #[cfg(test)]
    pub(super) fn detached() -> Self {
        let (reuse_state, _reuse_state_rx) = watch::channel(ActiveRunReuseState::Pending);
        Self {
            reuse_state,
            handoff: Arc::new(Mutex::new(ActiveRunHandoffBroker {
                signal: SandboxFinalExecParkHandoff::new(),
                delivery: None,
            })),
        }
    }
}

pub(super) struct ActiveRunGuard {
    active_runs: ActiveRuns,
    run_id: Option<RunId>,
    has_reuse_key: bool,
    reuse_state: watch::Sender<ActiveRunReuseState>,
    handoff: Arc<Mutex<ActiveRunHandoffBroker>>,
}

impl ActiveRuns {
    pub(super) fn new(reuse_state_notify: Arc<Notify>) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            reuse_state_notify,
        }
    }

    pub(super) fn register(
        &self,
        run_id: RunId,
        reuse_key: Option<String>,
        profile_name: String,
    ) -> ActiveRunGuard {
        let (reuse_state, _reuse_state_rx) = watch::channel(ActiveRunReuseState::Pending);
        let handoff = Arc::new(Mutex::new(ActiveRunHandoffBroker {
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
        ActiveRunGuard {
            active_runs: self.clone(),
            run_id: Some(run_id),
            has_reuse_key,
            reuse_state,
            handoff,
        }
    }

    pub(super) fn finalizing_predecessor(
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

    pub(super) fn reuse_keys(&self) -> HashSet<String> {
        lock_entries(&self.entries)
            .values()
            .filter(|entry| entry.reuse_state.borrow().can_publish_exact())
            .filter_map(|entry| entry.reuse_key.clone())
            .collect()
    }

    pub(super) fn has_reusable_run(&self) -> bool {
        lock_entries(&self.entries).values().any(|entry| {
            entry.reuse_key.is_some() && entry.reuse_state.borrow().can_publish_exact()
        })
    }

    #[cfg(test)]
    pub(super) fn contains(&self, run_id: RunId) -> bool {
        lock_entries(&self.entries).contains_key(&run_id)
    }
}

impl ActiveRunGuard {
    pub(super) fn reuse_publisher(&self) -> ActiveRunReusePublisher {
        ActiveRunReusePublisher {
            reuse_state: self.reuse_state.clone(),
            handoff: Arc::clone(&self.handoff),
        }
    }

    pub(super) fn release(mut self) -> bool {
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
mod tests {
    use super::*;

    use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;
    use crate::resource_budget::ResourceBudget;

    #[tokio::test]
    async fn active_runs_prove_exact_predecessor_and_preserve_shared_reuse_key() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let first_run_id = RunId::new_v4();
        let second_run_id = RunId::new_v4();
        let first = active_runs.register(
            first_run_id,
            Some("thread:shared".into()),
            "vm0/default".into(),
        );
        let second = active_runs.register(
            second_run_id,
            Some("thread:shared".into()),
            "vm0/default".into(),
        );

        assert_eq!(
            active_runs.reuse_keys(),
            HashSet::from(["thread:shared".to_string()])
        );
        assert!(active_runs.has_reusable_run());
        assert!(
            active_runs
                .finalizing_predecessor(first_run_id, "thread:shared", "vm0/default")
                .is_some()
        );
        assert!(
            active_runs
                .finalizing_predecessor(first_run_id, "thread:other", "vm0/default")
                .is_none()
        );
        assert!(
            active_runs
                .finalizing_predecessor(first_run_id, "thread:shared", "vm0/large")
                .is_none()
        );

        drop(first);
        assert!(active_runs.reuse_keys().contains("thread:shared"));
        drop(second);
        assert!(active_runs.reuse_keys().is_empty());
        assert!(!active_runs.has_reusable_run());

        let no_reuse = active_runs.register(first_run_id, None, "vm0/default".into());
        assert!(!no_reuse.release());
    }

    #[tokio::test]
    async fn proof_observes_exact_publication_then_release() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let run_id = RunId::new_v4();
        let guard = active_runs.register(
            run_id,
            Some("thread:finalizing".into()),
            "vm0/default".into(),
        );
        let publisher = guard.reuse_publisher();
        let mut proof = active_runs
            .finalizing_predecessor(run_id, "thread:finalizing", "vm0/default")
            .unwrap();

        let started_at = Instant::now();
        assert!(publisher.mark_finalizing(started_at));
        assert_eq!(
            proof.changed().await,
            ActiveRunReuseState::Finalizing { started_at }
        );
        assert!(!publisher.mark_finalizing(Instant::now()));
        assert_eq!(
            active_runs.reuse_keys(),
            HashSet::from(["thread:finalizing".to_string()])
        );
        assert!(active_runs.has_reusable_run());
        assert!(
            active_runs
                .finalizing_predecessor(run_id, "thread:finalizing", "vm0/default")
                .is_some()
        );

        assert!(publisher.publish_exact_sandbox());
        assert_eq!(
            proof.changed().await,
            ActiveRunReuseState::ExactSandboxPublished
        );
        assert!(active_runs.reuse_keys().is_empty());
        assert!(!active_runs.has_reusable_run());
        assert!(
            active_runs
                .finalizing_predecessor(run_id, "thread:finalizing", "vm0/default")
                .is_none()
        );
        drop(guard);
        assert_eq!(proof.changed().await, ActiveRunReuseState::Released);
        assert!(!active_runs.contains(run_id));
    }

    #[tokio::test]
    async fn proof_observes_no_exact_and_direct_release_outcomes() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let no_exact_run_id = RunId::new_v4();
        let no_exact_guard = active_runs.register(
            no_exact_run_id,
            Some("thread:no-exact".into()),
            "vm0/default".into(),
        );
        let no_exact_publisher = no_exact_guard.reuse_publisher();
        let mut no_exact_proof = active_runs
            .finalizing_predecessor(no_exact_run_id, "thread:no-exact", "vm0/default")
            .unwrap();

        assert!(no_exact_publisher.mark_finalizing(Instant::now()));
        assert!(no_exact_publisher.publish_no_exact_sandbox());
        assert_eq!(
            no_exact_proof.changed().await,
            ActiveRunReuseState::NoExactSandbox
        );
        assert!(!no_exact_publisher.publish_exact_sandbox());
        drop(no_exact_guard);
        assert_eq!(
            no_exact_proof.changed().await,
            ActiveRunReuseState::Released
        );

        let released_run_id = RunId::new_v4();
        let released_guard = active_runs.register(
            released_run_id,
            Some("thread:released".into()),
            "vm0/default".into(),
        );
        let mut released_proof = active_runs
            .finalizing_predecessor(released_run_id, "thread:released", "vm0/default")
            .unwrap();
        drop(released_guard);
        assert_eq!(
            released_proof.changed().await,
            ActiveRunReuseState::Released
        );
    }

    #[test]
    fn resolved_predecessor_rejects_late_handoff_requests() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let published_run_id = RunId::new_v4();
        let published_guard = active_runs.register(
            published_run_id,
            Some("thread:published".into()),
            "vm0/default".into(),
        );
        let published_proof = active_runs
            .finalizing_predecessor(published_run_id, "thread:published", "vm0/default")
            .unwrap();

        assert!(published_guard.reuse_publisher().publish_exact_sandbox());
        assert!(published_proof.request_handoff(RunId::new_v4()).is_none());

        let released_run_id = RunId::new_v4();
        let released_guard = active_runs.register(
            released_run_id,
            Some("thread:released-late".into()),
            "vm0/default".into(),
        );
        let released_proof = active_runs
            .finalizing_predecessor(released_run_id, "thread:released-late", "vm0/default")
            .unwrap();
        drop(released_guard);

        assert!(released_proof.request_handoff(RunId::new_v4()).is_none());
    }

    #[test]
    fn predecessor_accepts_only_one_live_handoff_request() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let run_id = RunId::new_v4();
        let _guard = active_runs.register(
            run_id,
            Some("thread:single-handoff".into()),
            "vm0/default".into(),
        );
        let proof = active_runs
            .finalizing_predecessor(run_id, "thread:single-handoff", "vm0/default")
            .unwrap();
        let request = proof
            .request_handoff(RunId::new_v4())
            .expect("first exact successor should register");

        assert!(proof.request_handoff(RunId::new_v4()).is_none());
        drop(request);
        assert!(
            proof.request_handoff(RunId::new_v4()).is_none(),
            "a cancelled one-shot request must not transfer to another successor"
        );
    }

    #[test]
    fn closed_accepted_handoff_receiver_returns_candidate_to_publisher() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let predecessor_run_id = RunId::new_v4();
        let successor_run_id = RunId::new_v4();
        let guard = active_runs.register(
            predecessor_run_id,
            Some("thread:closed-handoff".into()),
            "vm0/default".into(),
        );
        let publisher = guard.reuse_publisher();
        assert!(publisher.mark_finalizing(Instant::now()));
        let proof = active_runs
            .finalizing_predecessor(predecessor_run_id, "thread:closed-handoff", "vm0/default")
            .unwrap();
        let mut request = proof
            .request_handoff(successor_run_id)
            .expect("exact successor should register a handoff");
        assert!(publisher.handoff_signal().accept_if_requested());
        request.receiver.close();

        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new("thread:closed-handoff", lease)
            .with_history_generation_run_id(predecessor_run_id)
            .build();
        let recovered = match publisher
            .deliver_exact_handoff(IdleParkCandidate::Ordinary(candidate), predecessor_run_id)
        {
            ActiveRunHandoffDeliveryResult::Failed(candidate) => candidate,
            ActiveRunHandoffDeliveryResult::Delivered => {
                panic!("closed receiver must not take sandbox ownership")
            }
            ActiveRunHandoffDeliveryResult::NotRequested(_) => {
                panic!("provider already accepted the handoff request")
            }
        };

        assert!(matches!(
            proof.state(),
            ActiveRunReuseState::Finalizing { .. }
        ));
        let (payload, lease) = recovered.into_active_destroy_parts();
        drop(payload);
        drop(lease);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[test]
    fn cancelled_accepted_handoff_recovers_already_sent_candidate() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let predecessor_run_id = RunId::new_v4();
        let successor_run_id = RunId::new_v4();
        let guard = active_runs.register(
            predecessor_run_id,
            Some("thread:cancelled-handoff".into()),
            "vm0/default".into(),
        );
        let publisher = guard.reuse_publisher();
        let proof = active_runs
            .finalizing_predecessor(
                predecessor_run_id,
                "thread:cancelled-handoff",
                "vm0/default",
            )
            .unwrap();
        let mut request = proof
            .request_handoff(successor_run_id)
            .expect("exact successor should register a handoff");
        assert!(publisher.handoff_signal().accept_if_requested());

        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new("thread:cancelled-handoff", lease)
            .with_history_generation_run_id(predecessor_run_id)
            .build();
        assert!(matches!(
            publisher
                .deliver_exact_handoff(IdleParkCandidate::Ordinary(candidate), predecessor_run_id),
            ActiveRunHandoffDeliveryResult::Delivered
        ));

        let recovered = request
            .cancel_and_recover_delivery()
            .expect("cancellation must recover a candidate sent before receiver closure");
        let (payload, lease) = recovered.into_candidate().into_active_destroy_parts();
        drop(payload);
        drop(lease);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[tokio::test]
    async fn deadline_preserves_accepted_handoff_before_delivery() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let predecessor_run_id = RunId::new_v4();
        let successor_run_id = RunId::new_v4();
        let guard = active_runs.register(
            predecessor_run_id,
            Some("thread:deadline-handoff".into()),
            "vm0/default".into(),
        );
        let publisher = guard.reuse_publisher();
        let proof = active_runs
            .finalizing_predecessor(predecessor_run_id, "thread:deadline-handoff", "vm0/default")
            .unwrap();
        let mut request = proof
            .request_handoff(successor_run_id)
            .expect("exact successor should register a handoff");
        assert!(publisher.handoff_signal().accept_if_requested());

        assert!(!request.expire_if_unaccepted());

        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new("thread:deadline-handoff", lease)
            .with_history_generation_run_id(predecessor_run_id)
            .build();
        assert!(matches!(
            publisher
                .deliver_exact_handoff(IdleParkCandidate::Ordinary(candidate), predecessor_run_id),
            ActiveRunHandoffDeliveryResult::Delivered
        ));
        let candidate = request
            .receive()
            .await
            .expect("accepted handoff should remain deliverable after its deadline");
        let (payload, lease) = candidate.into_candidate().into_active_destroy_parts();
        drop(payload);
        drop(lease);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }
}
