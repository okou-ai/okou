//! Real required-saving engine behind typed finalizing custody.

use runner_types::ids::RunId;
use sandbox_mock::{MockBackingProcess, MockLifecycleGate};

use super::*;
use crate::idle_pool::{
    FinalizingHandoffState, GuardedFinalizingHandoffOwner, IdleActivationOwner, IdleParkCandidate,
};

fn delivered(fixture: &mut JobFixture, successor: RunId) -> (GuardedFinalizingHandoffOwner, RunId) {
    let candidate = fixture.candidate();
    let predecessor = candidate
        .resources
        .home_promotion
        .as_ref()
        .unwrap()
        .run_id();
    let mut producer = GuardedFinalizingHandoffOwner::undelivered(
        IdleParkCandidate::Ordinary(candidate),
        predecessor,
    );
    let candidate = producer.take_undelivered_candidate().unwrap();
    (
        GuardedFinalizingHandoffOwner::new(Box::new(
            candidate.into_finalizing_handoff(successor, predecessor),
        )),
        predecessor,
    )
}

#[tokio::test]
async fn finalizing_binding_refusal_retains_original_home_and_full_lease() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:finalizing-binding", Some(backing)).await;
    let run = RunId::new_v4();
    let (mut owner, predecessor) = delivered(&mut fixture, run);
    for (successor, prior) in [(RunId::new_v4(), predecessor), (run, RunId::new_v4())] {
        assert!(owner.activate(successor, prior).await.is_err());
        assert_eq!(owner.state(), FinalizingHandoffState::Parked);
        fixture.untouched().await;
    }
    let activated = owner.activate(run, predecessor).await.unwrap();
    assert_eq!(activated.sandbox.sandbox_id(), fixture.sandbox_id);
    assert_eq!(
        (
            activated.budget_lease.vcpu(),
            activated.budget_lease.memory_mb()
        ),
        (2, 8)
    );
    assert_eq!(owner.state(), FinalizingHandoffState::Transferred);
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
}

struct MutableBacking(Mutex<sandbox::BackingProcessIdentity>);
#[async_trait::async_trait]
impl SandboxBackingProcess for MutableBacking {
    fn identity(&self) -> sandbox::BackingProcessIdentity {
        *self.0.lock().unwrap()
    }
    async fn exit_confirmed(&self) -> bool {
        false
    }
}

#[tokio::test]
async fn finalizing_readiness_does_not_transfer_and_commit_rejects_changed_backing() {
    let backing = Arc::new(MutableBacking(Mutex::new(
        sandbox::BackingProcessIdentity::new_generation(),
    )));
    let mut fixture = JobFixture::new("thread:finalizing-ready", Some(backing.clone())).await;
    let run = RunId::new_v4();
    let (mut owner, predecessor) = delivered(&mut fixture, run);
    owner.prepare_activation(run, predecessor).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(owner.state(), FinalizingHandoffState::Uncertain);
    *backing.0.lock().unwrap() = sandbox::BackingProcessIdentity::new_generation();
    assert!(owner.commit_activation(run, predecessor).is_err());
    assert!(owner.take_cleanup_owner().is_err());
    assert_eq!(fixture.overrides.kill_call_count(), 0);
    assert_eq!(fixture.overrides.destroy_call_count(), 0);
    assert_eq!(
        tokio::fs::read(&fixture.active_image).await.unwrap(),
        test_home_image()
    );
}

#[tokio::test]
async fn finalizing_original_promotion_mismatch_refuses_before_broker_projection() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:finalizing-promotion", Some(backing)).await;
    let mut candidate = fixture.candidate();
    let incorrect = RunId::new_v4();
    candidate.metadata.history_generation_run_id = Some(incorrect);
    let mut owner = GuardedFinalizingHandoffOwner::undelivered(
        IdleParkCandidate::Ordinary(candidate),
        incorrect,
    );
    assert!(matches!(
        owner.take_undelivered_candidate(),
        Err(MemoryOperationError::OwnershipInvariant)
    ));
    assert!(owner.take_cleanup_owner().is_err());
    fixture.untouched().await;
}

#[tokio::test]
async fn finalizing_uncaptured_delivery_never_adopts_a_later_generation() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:finalizing-unproven", Some(backing)).await;
    let mut candidate = fixture.candidate();
    let predecessor = candidate
        .resources
        .home_promotion
        .as_ref()
        .unwrap()
        .run_id();
    candidate.metadata.history_generation_run_id = Some(predecessor);
    let successor = RunId::new_v4();
    let mut owner = GuardedFinalizingHandoffOwner::new(Box::new(
        candidate.into_finalizing_handoff(successor, predecessor),
    ));
    assert_eq!(
        owner.capture_backing(),
        Err(MemoryOperationError::MissingBacking)
    );
    assert!(owner.activate(successor, predecessor).await.is_err());
    assert!(matches!(
        owner.take_cleanup_owner(),
        Err(MemoryOperationError::MissingBacking)
    ));
    fixture.untouched().await;
}

#[tokio::test]
async fn finalizing_unpark_error_panic_and_cancel_keep_required_cleanup() {
    for fault in ["error", "panic", "cancel"] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:finalizing-unpark", Some(backing)).await;
        let gate = MockLifecycleGate::new();
        match fault {
            "error" => fixture
                .overrides
                .push_unpark_result(Err(sandbox::SandboxError::Start {
                    message: fault.into(),
                })),
            "panic" => fixture.overrides.push_unpark_panic(fault),
            _ => fixture.overrides.set_unpark_lifecycle_gate(gate.clone()),
        }
        let run = RunId::new_v4();
        let (mut owner, predecessor) = delivered(&mut fixture, run);
        if fault == "cancel" {
            let mut pending = Box::pin(owner.activate(run, predecessor));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            gate.wait_entered(1, WAIT).await.unwrap();
            drop(pending);
        } else {
            assert!(owner.activate(run, predecessor).await.is_err());
        }
        assert_eq!(owner.state(), FinalizingHandoffState::Uncertain);
        assert!(owner.activate(run, predecessor).await.is_err());
        let mut required = owner.take_cleanup_owner().unwrap();
        let env = Env::new(0).await;
        assert!(matches!(
            required.grant_cleanup(&env.operations, envelope()).await,
            Err(MemoryOperationError::InsufficientHeadroom { .. })
        ));
        assert_eq!(fixture.budget.allocated(), (2, 8, 1));
        assert_eq!(fixture.overrides.kill_call_count(), 0);
        assert_eq!(fixture.overrides.destroy_call_count(), 0);
        assert_eq!(
            tokio::fs::read(&fixture.active_image).await.unwrap(),
            test_home_image()
        );
    }
}

#[tokio::test]
async fn finalizing_cancelled_coverage_wait_keeps_original_capsule() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:finalizing-admission", Some(backing)).await;
    let (mut owner, _) = delivered(&mut fixture, RunId::new_v4());
    let mut required = owner.take_cleanup_owner().unwrap();
    assert!(required.activate(RunId::new_v4()).await.is_err());
    let env = Env::new(64).await;
    let (seen, release) = env.source.gate_read();
    let mut pending = Box::pin(required.grant_cleanup(&env.operations, envelope()));
    tokio::select! {
        result = &mut pending => panic!("coverage unexpectedly completed: {result:?}"),
        result = seen => result.unwrap(),
    }
    drop(pending);
    drop(release);
    fixture.untouched().await;
    assert_eq!(env.operations.snapshot().unwrap().started, 0);
}

#[tokio::test]
async fn finalizing_covered_cleanup_saves_original_home_and_retains_completed_lease() {
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:finalizing-save", Some(backing)).await;
    let (mut owner, _) = delivered(&mut fixture, RunId::new_v4());
    let mut required = Some(owner.take_cleanup_owner().unwrap());
    let env = Env::new(64).await;
    required
        .as_mut()
        .unwrap()
        .grant_cleanup(&env.operations, envelope())
        .await
        .unwrap();
    let accepted = IdleActivationOwner::start_cleanup(&mut required, "finalizing test").unwrap();
    assert!(required.is_none());
    let (task, retained) = accepted.into_parts();
    exit.confirm_exit();
    assert!(matches!(
        task.join().await.unwrap(),
        crate::idle_pool::ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    fixture.saved().await;
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    let lease = retained.take_completed_lease().unwrap();
    assert_eq!((lease.vcpu(), lease.memory_mb()), (2, 8));
}
