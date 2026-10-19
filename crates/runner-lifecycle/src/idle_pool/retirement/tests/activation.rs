//! Public ordinary activation and covered cleanup against real retained home bytes.

use runner_types::ids::RunId;
use sandbox_mock::{ExecMatcher, MockLifecycleGate};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::idle_pool::{
    ActivationCleanupOutcome, IdleActivationOwner, IdleActivationState, IdlePool, IdlePoolConfig,
    ParkResult,
};

use super::*;

fn unpark_error() -> sandbox::SandboxError {
    sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "partially resumed activation rejected".into(),
    }
}

fn owner(fixture: &mut JobFixture) -> IdleActivationOwner {
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    assert!(matches!(pool.park(fixture.candidate()), ParkResult::Parked));
    let reserved = pool.take_reserved(&fixture.reuse_key).unwrap();
    IdleActivationOwner::new(reserved).unwrap_or_else(|_| panic!("ordinary parked reservation"))
}

async fn failed(fixture: &mut JobFixture) -> IdleActivationOwner {
    let mut owner = owner(fixture);
    fixture.overrides.push_unpark_result(Err(unpark_error()));
    assert!(owner.activate(RunId::new_v4()).await.is_err());
    assert_eq!(owner.state(), IdleActivationState::Uncertain);
    owner
}

async fn retained_bytes(fixture: &JobFixture) {
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(fixture.overrides.kill_call_count(), 0);
    assert_eq!(fixture.overrides.destroy_call_count(), 0);
    assert_eq!(
        tokio::fs::read(&fixture.active_image).await.unwrap(),
        test_home_image()
    );
    assert_eq!(
        HomePromotionFixture::checkout_result(&fixture.cache, &fixture.reuse_key).await,
        crate::home_image_cache::HomeCacheCheckoutResult::LockBusy
    );
}

#[tokio::test]
async fn ordinary_activation_transfers_the_original_resource_and_full_lease_only_on_success() {
    let (_, backing) = sandbox_mock::MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:ordinary-success", Some(backing)).await;
    let mut owner = owner(&mut fixture);
    let (reused, lease) = owner.activate(RunId::new_v4()).await.unwrap();
    assert_eq!(reused.sandbox_id(), fixture.sandbox_id);
    assert_eq!(owner.state(), IdleActivationState::Reused);
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert!(owner.activate(RunId::new_v4()).await.is_err());
    drop(lease);
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn cancelled_or_panicked_unpark_preserves_uncertain_exclusive_owner_and_home() {
    for panic in [false, true] {
        let (_, backing) = sandbox_mock::MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:activation-interrupted", Some(backing)).await;
        let mut owner = owner(&mut fixture);
        if panic {
            fixture
                .overrides
                .push_unpark_panic("ordinary provider activation panic");
            assert!(owner.activate(RunId::new_v4()).await.is_err());
        } else {
            let gate = MockLifecycleGate::new();
            fixture.overrides.set_unpark_lifecycle_gate(gate.clone());
            let mut activation = Box::pin(owner.activate(RunId::new_v4()));
            assert!(futures_util::poll!(activation.as_mut()).is_pending());
            gate.wait_entered(1, WAIT).await.unwrap();
            drop(activation);
        }
        assert_eq!(owner.state(), IdleActivationState::Uncertain);
        assert!(owner.activate(RunId::new_v4()).await.is_err());
        retained_bytes(&fixture).await;
    }
}

#[tokio::test]
async fn no_or_unknown_headroom_preserves_failed_activation_without_terminal_work() {
    for unknown in [false, true] {
        let env = Env::new(0).await;
        if unknown {
            tokio::fs::write(&env.source.path, "invalid meminfo\n")
                .await
                .unwrap();
        }
        let (_, backing) = sandbox_mock::MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:activation-no-headroom", Some(backing)).await;
        let mut owner = failed(&mut fixture).await;
        assert!(
            owner
                .grant_cleanup(&env.operations, envelope())
                .await
                .is_err()
        );
        assert_eq!(owner.sandbox_id(), fixture.sandbox_id);
        assert!(fixture.overrides.exec_calls().is_empty());
        assert_eq!(fixture.overrides.terminal_unpark_call_count(), 0);
        retained_bytes(&fixture).await;
    }
}

#[tokio::test]
async fn cancelled_and_panicked_memory_observation_keep_the_same_cleanup_capsule() {
    for panic in [false, true] {
        let env = Env::new(64).await;
        let (_, backing) = sandbox_mock::MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:activation-observer", Some(backing)).await;
        let mut owner = failed(&mut fixture).await;
        let (observed, release) = env.source.gate_read();
        let mut admission = Box::pin(owner.grant_cleanup(&env.operations, envelope()));
        assert!(futures_util::poll!(admission.as_mut()).is_pending());
        tokio::select! {
            _ = observed => {},
            result = admission.as_mut() => panic!("observation did not hold: {result:?}"),
        }
        if panic {
            drop(release);
            assert_eq!(
                admission.await.unwrap_err(),
                MemoryOperationError::ProducerLost
            );
        } else {
            drop(admission);
            drop(release);
        }
        assert_eq!(owner.state(), IdleActivationState::Uncertain);
        retained_bytes(&fixture).await;
    }
}

#[tokio::test]
async fn required_preparation_error_or_panic_retains_promotion_and_full_lease() {
    for phase in ["terminal_unpark", "prepare", "freeze", "panic"] {
        let env = Env::new(64).await;
        let (_, backing) = sandbox_mock::MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:required-caller-prepare", Some(backing)).await;
        let mut owner = failed(&mut fixture).await;
        match phase {
            "terminal_unpark" => fixture.overrides.push_unpark_result(Err(unpark_error())),
            "panic" => fixture
                .overrides
                .add_exec_panic_matcher("--freeze", "required freeze panic"),
            phase => fixture.overrides.add_exec_matcher(ExecMatcher {
                pattern: if phase == "prepare" {
                    "prepare-for-cache"
                } else {
                    "--freeze"
                }
                .into(),
                exit_code: 64,
                stdout: Vec::new(),
                stderr: b"required saving failed".to_vec(),
            }),
        }
        owner
            .grant_cleanup(&env.operations, envelope())
            .await
            .unwrap();
        let mut slot = Some(owner);
        let (task, retained) =
            IdleActivationOwner::start_cleanup(&mut slot, "required_caller_prepare")
                .unwrap()
                .into_parts();
        assert!(slot.is_none());
        assert!(matches!(
            tokio::time::timeout(WAIT, task.join())
                .await
                .unwrap()
                .unwrap(),
            ActivationCleanupOutcome::NoProgress(_)
        ));
        assert!(retained.has_owner());
        retained_bytes(&fixture).await;
        let recovered = retained.take_owner().unwrap();
        assert_eq!(recovered.sandbox_id(), fixture.sandbox_id);
        assert_eq!(env.operations.snapshot().unwrap().uncertain, 2);
        assert_eq!(
            env.operations.snapshot().unwrap().cleanup_growth_bytes,
            9 * MIB
        );
    }
}

#[tokio::test]
async fn failed_or_lost_exit_keeps_frozen_home_and_never_publishes_or_destroys() {
    for lost in [false, true] {
        let env = Env::new(64).await;
        let (exit, backing) = sandbox_mock::MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:required-caller-exit", Some(backing)).await;
        let mut owner = failed(&mut fixture).await;
        owner
            .grant_cleanup(&env.operations, envelope())
            .await
            .unwrap();
        let (task, retained) =
            IdleActivationOwner::start_cleanup(&mut Some(owner), "required_caller_exit")
                .unwrap()
                .into_parts();
        if lost {
            drop(exit);
        } else {
            exit.fail_wait();
        }
        assert!(matches!(
            tokio::time::timeout(WAIT, task.join())
                .await
                .unwrap()
                .unwrap(),
            ActivationCleanupOutcome::NoProgress(_)
        ));
        let recovered = retained.take_owner().unwrap();
        assert_eq!(recovered.state(), IdleActivationState::Frozen);
        assert_eq!(fixture.overrides.kill_call_count(), 1);
        assert_eq!(fixture.overrides.destroy_call_count(), 0);
        assert_eq!(fixture.budget.allocated(), (2, 8, 1));
        assert_eq!(
            tokio::fs::read(&fixture.active_image).await.unwrap(),
            test_home_image()
        );
        assert_eq!(
            HomePromotionFixture::checkout_result(&fixture.cache, &fixture.reuse_key).await,
            crate::home_image_cache::HomeCacheCheckoutResult::LockBusy
        );
        assert_eq!(env.operations.snapshot().unwrap().uncertain, 2);
    }
}

#[tokio::test]
async fn receiver_loss_keeps_required_saving_and_exact_exit_tail_joined() {
    let env = Env::new(64).await;
    let (exit, backing) = sandbox_mock::MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:caller-receiver-loss", Some(backing)).await;
    let mut owner = failed(&mut fixture).await;
    let destroy = MockLifecycleGate::new();
    fixture
        .overrides
        .set_destroy_lifecycle_gate(destroy.clone());
    owner
        .grant_cleanup(&env.operations, envelope())
        .await
        .unwrap();
    let (task, retained) =
        IdleActivationOwner::start_cleanup(&mut Some(owner), "caller_receiver_loss")
            .unwrap()
            .into_parts();
    drop(task);
    exit.confirm_exit();
    destroy.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(env.operations.snapshot().unwrap().cleanup_growth_bytes, MIB);
    let mut shutdown = Box::pin(env.operations.close_and_wait());
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    destroy.release_one();
    assert_eq!(
        tokio::time::timeout(WAIT, shutdown)
            .await
            .unwrap()
            .unwrap()
            .registered_operations,
        0
    );
    assert!(retained.needs_retention());
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    let lease = retained.take_completed_lease().unwrap();
    assert_eq!((lease.vcpu(), lease.memory_mb()), (2, 8));
    drop(lease);
    assert!(!retained.needs_retention());
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    fixture.saved().await;
}

#[tokio::test]
async fn atomic_start_rejection_returns_the_original_owner_and_both_unused_grants() {
    let env = Env::new(64).await;
    let (_, backing) = sandbox_mock::MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:caller-start-rejection", Some(backing)).await;
    let mut owner = failed(&mut fixture).await;
    owner
        .grant_cleanup(&env.operations, envelope())
        .await
        .unwrap();
    env.operations.close_and_wait().await.unwrap();
    let mut slot = Some(owner);
    assert!(IdleActivationOwner::start_cleanup(&mut slot, "caller_start_rejection").is_err());
    assert_eq!(slot.as_ref().unwrap().sandbox_id(), fixture.sandbox_id);
    retained_bytes(&fixture).await;
    assert_eq!(
        env.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
}

#[tokio::test]
async fn missing_backing_or_invalid_supplied_phase_preserves_original_required_data() {
    for missing in [false, true] {
        let env = Env::new(64).await;
        let (_, backing) = sandbox_mock::MockBackingProcess::channel();
        let mut fixture = JobFixture::new(
            "thread:caller-invalid-capture",
            if missing { None } else { Some(backing) },
        )
        .await;
        let mut owner = failed(&mut fixture).await;
        let supplied = if missing {
            envelope()
        } else {
            IdleRetirementEnvelope {
                live_growth_bytes: 0,
                tail_growth_bytes: MIB,
            }
        };
        assert!(
            owner
                .grant_cleanup(&env.operations, supplied)
                .await
                .is_err()
        );
        retained_bytes(&fixture).await;
        assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
    }
}

struct FaultBacking {
    identity: Mutex<BackingProcessIdentity>,
    panic: AtomicBool,
}

#[async_trait::async_trait]
impl SandboxBackingProcess for FaultBacking {
    fn identity(&self) -> BackingProcessIdentity {
        assert!(
            !self.panic.load(Ordering::Relaxed),
            "external backing observer lost"
        );
        *self.identity.lock().unwrap()
    }

    async fn exit_confirmed(&self) -> bool {
        false
    }
}

#[tokio::test]
async fn stale_or_panicked_backing_after_observation_prevents_acceptance_without_owner_loss() {
    for panic in [false, true] {
        let env = Env::new(64).await;
        let backing = Arc::new(FaultBacking {
            identity: Mutex::new(BackingProcessIdentity::new_generation()),
            panic: AtomicBool::new(false),
        });
        let mut fixture =
            JobFixture::new("thread:caller-backing-fault", Some(backing.clone())).await;
        let mut owner = failed(&mut fixture).await;
        owner
            .grant_cleanup(&env.operations, envelope())
            .await
            .unwrap();
        if panic {
            backing.panic.store(true, Ordering::Relaxed);
        } else {
            *backing.identity.lock().unwrap() = BackingProcessIdentity::new_generation();
        }
        let mut slot = Some(owner);
        assert!(IdleActivationOwner::start_cleanup(&mut slot, "caller_backing_fault").is_err());
        assert_eq!(slot.as_ref().unwrap().sandbox_id(), fixture.sandbox_id);
        retained_bytes(&fixture).await;
        assert_eq!(env.operations.snapshot().unwrap().started, 0);
    }
}

#[tokio::test]
async fn admission_retry_cannot_switch_runner_authority_or_the_supplied_envelope() {
    let env = Env::new(64).await;
    let foreign = Env::new(64).await;
    let (_, backing) = sandbox_mock::MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:caller-authority", Some(backing)).await;
    let mut owner = failed(&mut fixture).await;
    owner
        .grant_cleanup(&env.operations, envelope())
        .await
        .unwrap();
    assert_eq!(
        owner
            .grant_cleanup(&foreign.operations, envelope())
            .await
            .unwrap_err(),
        MemoryOperationError::OwnershipInvariant
    );
    assert_eq!(
        owner
            .grant_cleanup(
                &env.operations,
                IdleRetirementEnvelope {
                    live_growth_bytes: 16 * MIB,
                    tail_growth_bytes: MIB
                }
            )
            .await
            .unwrap_err(),
        MemoryOperationError::OwnershipInvariant
    );
    retained_bytes(&fixture).await;
    assert_eq!(
        foreign.operations.snapshot().unwrap().registered_operations,
        0
    );
}

#[tokio::test]
async fn kill_error_or_panic_preserves_frozen_required_home_and_full_logical_lease() {
    for panic in [false, true] {
        let env = Env::new(64).await;
        let (_, backing) = sandbox_mock::MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:caller-kill-fault", Some(backing)).await;
        let mut owner = failed(&mut fixture).await;
        if panic {
            fixture
                .overrides
                .push_kill_panic("required kill producer panic");
        } else {
            fixture
                .overrides
                .push_kill_result(Err(sandbox::SandboxError::Start {
                    message: "kill failed".into(),
                }));
        }
        owner
            .grant_cleanup(&env.operations, envelope())
            .await
            .unwrap();
        let (task, retained) =
            IdleActivationOwner::start_cleanup(&mut Some(owner), "caller_kill_fault")
                .unwrap()
                .into_parts();
        assert!(matches!(
            tokio::time::timeout(WAIT, task.join())
                .await
                .unwrap()
                .unwrap(),
            ActivationCleanupOutcome::NoProgress(_)
        ));
        let mut owner = retained.take_owner().unwrap();
        assert_eq!(owner.state(), IdleActivationState::Frozen);
        assert!(owner.cleanup_error().is_some());
        assert!(!owner.cleanup_completed());
        assert!(owner.take_completed_lease().is_err());
        assert_eq!(fixture.budget.allocated(), (2, 8, 1));
        assert_eq!(fixture.overrides.destroy_call_count(), 0);
        assert_eq!(
            tokio::fs::read(&fixture.active_image).await.unwrap(),
            test_home_image()
        );
        assert_eq!(env.operations.snapshot().unwrap().uncertain, 2);
    }
}

#[tokio::test]
async fn accepted_home_less_kill_failure_cannot_be_reactivated_or_readmitted() {
    use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;

    for panic in [false, true] {
        let env = Env::new(64).await;
        let (_, backing) = sandbox_mock::MockBackingProcess::channel();
        let overrides = Arc::new(MockSandboxOverrides::new());
        let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new("thread:home-less-cancel", lease)
            .with_sandbox(Box::new(
                MockSandbox::with_overrides("home-less-backing", overrides.clone())
                    .with_backing_process(backing),
            ))
            .with_factory(Arc::new(Box::new(MockSandboxFactory::with_overrides(
                overrides.clone(),
            ))))
            .build();
        let mut pool = IdlePool::new(IdlePoolConfig::default());
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let mut owner =
            IdleActivationOwner::new(pool.take_reserved("thread:home-less-cancel").unwrap())
                .unwrap_or_else(|_| panic!("ordinary home-less parked reservation"));
        if panic {
            overrides.push_kill_panic("home-less kill panic");
        } else {
            overrides.push_kill_result(Err(sandbox::SandboxError::Start {
                message: "home-less kill failed".into(),
            }));
        }
        owner
            .grant_cleanup(&env.operations, envelope())
            .await
            .unwrap();
        let (task, retained) =
            IdleActivationOwner::start_cleanup(&mut Some(owner), "home_less_cancellation")
                .unwrap()
                .into_parts();
        assert!(matches!(
            tokio::time::timeout(WAIT, task.join())
                .await
                .unwrap()
                .unwrap(),
            ActivationCleanupOutcome::NoProgress(_)
        ));
        let mut owner = retained.take_owner().unwrap();
        assert_eq!(owner.state(), IdleActivationState::Uncertain);
        assert!(owner.activate(RunId::new_v4()).await.is_err());
        assert_eq!(
            owner
                .grant_cleanup(&env.operations, envelope())
                .await
                .unwrap_err(),
            MemoryOperationError::Consumed
        );
        assert!(owner.take_completed_lease().is_err());
        assert_eq!(overrides.unpark_call_count(), 0);
        assert_eq!(overrides.destroy_call_count(), 0);
        assert_eq!(budget.allocated(), (2, 8, 1));
        assert_eq!(env.operations.close_and_wait().await.unwrap().uncertain, 2);
    }
}

#[tokio::test]
async fn factory_panic_keeps_saved_home_logical_lease_and_uncertain_tail_owner() {
    let env = Env::new(64).await;
    let (exit, backing) = sandbox_mock::MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:caller-factory-panic", Some(backing)).await;
    let mut owner = failed(&mut fixture).await;
    fixture
        .overrides
        .push_destroy_panic("external factory producer lost");
    exit.confirm_exit();
    owner
        .grant_cleanup(&env.operations, envelope())
        .await
        .unwrap();
    let (task, retained) =
        IdleActivationOwner::start_cleanup(&mut Some(owner), "caller_factory_panic")
            .unwrap()
            .into_parts();
    assert!(matches!(
        tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::NoProgress(_)
    ));
    assert!(retained.take_completed_lease().is_err());
    let owner = retained.take_owner().unwrap();
    assert_eq!(owner.state(), IdleActivationState::Exited);
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(env.operations.snapshot().unwrap().uncertain, 1);
    assert_eq!(env.operations.snapshot().unwrap().cleanup_growth_bytes, MIB);
    assert_eq!(
        HomePromotionFixture::checkout_result(&fixture.cache, &fixture.reuse_key).await,
        crate::home_image_cache::HomeCacheCheckoutResult::LockBusy
    );
    drop(owner);
    fixture.saved().await;
}

#[tokio::test]
async fn lost_tail_observation_never_releases_full_lease_after_successful_physical_destroy() {
    let env = Env::new(64).await;
    let (exit, backing) = sandbox_mock::MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:caller-tail-observation", Some(backing)).await;
    let mut owner = failed(&mut fixture).await;
    let destroy = MockLifecycleGate::new();
    fixture
        .overrides
        .set_destroy_lifecycle_gate(destroy.clone());
    exit.confirm_exit();
    owner
        .grant_cleanup(&env.operations, envelope())
        .await
        .unwrap();
    let (task, retained) =
        IdleActivationOwner::start_cleanup(&mut Some(owner), "caller_tail_observation")
            .unwrap()
            .into_parts();
    destroy.wait_entered(1, WAIT).await.unwrap();
    tokio::fs::write(&env.source.path, "invalid final observation\n")
        .await
        .unwrap();
    destroy.release_one();
    assert!(matches!(
        tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::NoProgress(_)
    ));
    let mut owner = retained.take_owner().unwrap();
    assert_eq!(owner.state(), IdleActivationState::Destroyed);
    assert!(!owner.cleanup_completed());
    assert!(owner.take_completed_lease().is_err());
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(env.operations.snapshot().unwrap().cleanup_growth_bytes, MIB);
}

#[tokio::test]
async fn resource_backing_change_during_a_held_grant_preserves_owner_before_terminal_work() {
    let env = Env::new(64).await;
    let backing = Arc::new(FaultBacking {
        identity: Mutex::new(BackingProcessIdentity::new_generation()),
        panic: AtomicBool::new(false),
    });
    let mut fixture = JobFixture::new("thread:caller-held-backing", Some(backing.clone())).await;
    let mut owner = failed(&mut fixture).await;
    let (observed, release) = env.source.gate_read();
    let mut grant = Box::pin(owner.grant_cleanup(&env.operations, envelope()));
    assert!(futures_util::poll!(grant.as_mut()).is_pending());
    tokio::select! { _ = observed => {}, result = grant.as_mut() => panic!("grant unexpectedly completed {result:?}") }
    *backing.identity.lock().unwrap() = BackingProcessIdentity::new_generation();
    release.send(()).unwrap();
    assert!(grant.await.is_err());
    retained_bytes(&fixture).await;
    assert_eq!(env.operations.snapshot().unwrap().started, 0);
}

#[tokio::test]
async fn publication_refusal_preserves_required_image_and_full_lease_after_exit() {
    let env = Env::new(64).await;
    let (exit, backing) = sandbox_mock::MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:caller-publication-refusal", Some(backing)).await;
    // An infeasible filesystem reserve refuses publication without changing source bytes.
    fixture
        .cache
        .set_fs_stats_for_test(crate::home_image_cache::FsStats {
            total_bytes: 1,
            available_bytes: 0,
            ..Default::default()
        });
    let mut owner = failed(&mut fixture).await;
    exit.confirm_exit();
    owner
        .grant_cleanup(&env.operations, envelope())
        .await
        .unwrap();
    let (task, retained) =
        IdleActivationOwner::start_cleanup(&mut Some(owner), "caller_publication_refusal")
            .unwrap()
            .into_parts();
    assert!(matches!(
        tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::NoProgress(_)
    ));
    let mut owner = retained.take_owner().unwrap();
    assert_eq!(owner.state(), IdleActivationState::Exited);
    assert!(owner.take_completed_lease().is_err());
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(fixture.overrides.kill_call_count(), 1);
    assert_eq!(fixture.overrides.destroy_call_count(), 0);
    assert_eq!(
        tokio::fs::read(&fixture.active_image).await.unwrap(),
        test_home_image()
    );
    assert_eq!(env.operations.snapshot().unwrap().uncertain, 1);
    assert_eq!(env.operations.snapshot().unwrap().cleanup_growth_bytes, MIB);
}
