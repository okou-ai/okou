use super::*;

use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;
use crate::resource_budget::ResourceBudget;

#[tokio::test]
async fn retained_failed_delivery_preserves_the_actual_successor_binding() {
    let active = ActiveRuns::new(Arc::new(Notify::new()));
    let predecessor = RunId::new_v4();
    let successor = RunId::new_v4();
    let guard = active.register(
        predecessor,
        Some("thread:retained-send".into()),
        "vm0/default".into(),
    );
    let proof = active
        .finalizing_predecessor(predecessor, "thread:retained-send", "vm0/default")
        .unwrap();
    let mut request = proof.request_handoff(successor).unwrap();
    // Close the actual channel receiver while the broker still owns its
    // accepted sender, forcing the send-failure ownership return.
    request.receiver.close();
    let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
    let candidate = ParkedIdleCandidateBuilder::new(
        "thread:retained-send",
        ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap(),
    )
    .with_source_run_id(predecessor)
    .with_native_generation_run_id(predecessor)
    .build();
    let RetainedActiveRunHandoffDeliveryResult::Failed(candidate) = guard
        .reuse_publisher()
        .deliver_exact_handoff_retained(IdleParkCandidate::Ordinary(candidate), predecessor)
    else {
        panic!("closed receiver must return the actual bound candidate");
    };
    let candidate = candidate
        .into_reservation(RunId::new_v4(), predecessor)
        .err()
        .expect("wrong successor must retain the candidate");
    let reservation = candidate
        .into_reservation(successor, predecessor)
        .unwrap_or_else(|_| panic!("original binding must survive failed delivery"));
    assert_eq!(budget.allocated(), (2, 8, 1));
    drop(reservation);
}

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
    assert_eq!(active_runs.active_reuse_producers().len(), 2);
    assert_eq!(
        active_runs.active_reuse_producers()[0].run_id,
        first_run_id.min(second_run_id)
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
    assert_eq!(active_runs.active_reuse_producers().len(), 1);
    assert!(active_runs.reuse_keys().contains("thread:shared"));
    drop(second);
    assert!(active_runs.reuse_keys().is_empty());
    assert!(!active_runs.has_reusable_run());
    assert!(active_runs.active_reuse_producers().is_empty());

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
    assert_eq!(active_runs.active_reuse_producers()[0].run_id, run_id);
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
    assert!(active_runs.active_reuse_producers().is_empty());
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
    assert!(active_runs.active_reuse_producers().is_empty());
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
        .with_source_run_id(predecessor_run_id)
        .with_native_generation_run_id(predecessor_run_id)
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
        .with_source_run_id(predecessor_run_id)
        .with_native_generation_run_id(predecessor_run_id)
        .build();
    assert!(matches!(
        publisher.deliver_exact_handoff(IdleParkCandidate::Ordinary(candidate), predecessor_run_id),
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
        .with_source_run_id(predecessor_run_id)
        .with_native_generation_run_id(predecessor_run_id)
        .build();
    assert!(matches!(
        publisher.deliver_exact_handoff(IdleParkCandidate::Ordinary(candidate), predecessor_run_id),
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
