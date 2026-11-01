use std::sync::Arc;

use tokio::sync::Notify;

use super::*;
use runner_executor::executor::RunnerPreSpawnConcurrency;
use runner_lifecycle::active_runs::{ActiveRunHandoffDeliveryResult, ActiveRuns};
use runner_lifecycle::idle_pool::{
    IdlePool, IdlePoolConfig, test_support::ParkedIdleCandidateBuilder,
};
use runner_provider::RunCancellationRegistry;
use sandbox_mock::{MockSandbox, MockSandboxFactory, MockSandboxOverrides};

#[test]
fn fresh_fallback_home_lock_policy_matches_predecessor_state() {
    let cases = [
        (
            ActiveRunReuseState::Pending,
            HomeImagePreparePolicy::TryCacheWithoutLockWait,
        ),
        (
            ActiveRunReuseState::Finalizing {
                started_at: Instant::now(),
            },
            HomeImagePreparePolicy::TryCacheWithLockWait,
        ),
        (
            ActiveRunReuseState::ExactSandboxPublished,
            HomeImagePreparePolicy::TryCacheWithoutLockWait,
        ),
        (
            ActiveRunReuseState::ExactSandboxHandedOff,
            HomeImagePreparePolicy::TryCacheWithoutLockWait,
        ),
        (
            ActiveRunReuseState::NoExactSandbox,
            HomeImagePreparePolicy::TryCacheWithLockWait,
        ),
        (
            ActiveRunReuseState::Released,
            HomeImagePreparePolicy::TryCacheWithLockWait,
        ),
    ];
    for (state, expected) in cases {
        assert_eq!(
            home_prepare_lock_policy_for_fresh_fallback(state),
            expected,
            "{state:?}"
        );
    }
}

#[test]
fn fresh_fallback_home_lock_policy_reads_live_predecessor() {
    let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
    let predecessor_run_id = RunId::new_v4();
    let guard = active_runs.register(
        predecessor_run_id,
        Some("thread:finalizing-owner".into()),
        "vm0/default".into(),
    );
    let predecessor = active_runs
        .finalizing_predecessor(predecessor_run_id, "thread:finalizing-owner", "vm0/default")
        .expect("predecessor should be registered");
    let admission = FinalizingAdmission {
        predecessor,
        deadline: Instant::now(),
        reuse_key: "thread:finalizing-owner".into(),
        source_run_id: predecessor_run_id,
        native_generation_run_id: Some(predecessor_run_id),
    };
    assert_eq!(
        admission.fresh_fallback_home_prepare_policy(),
        (
            ActiveRunReuseState::Pending,
            HomeImagePreparePolicy::TryCacheWithoutLockWait
        )
    );
    let publisher = guard.reuse_publisher();
    let started_at = Instant::now();
    assert!(publisher.mark_finalizing(started_at));
    assert_eq!(
        admission.fresh_fallback_home_prepare_policy(),
        (
            ActiveRunReuseState::Finalizing { started_at },
            HomeImagePreparePolicy::TryCacheWithLockWait,
        )
    );
    assert!(publisher.publish_exact_sandbox());
    assert_eq!(
        admission.fresh_fallback_home_prepare_policy(),
        (
            ActiveRunReuseState::ExactSandboxPublished,
            HomeImagePreparePolicy::TryCacheWithoutLockWait
        )
    );
    drop(guard);
    assert_eq!(
        admission.fresh_fallback_home_prepare_policy(),
        (
            ActiveRunReuseState::Released,
            HomeImagePreparePolicy::TryCacheWithLockWait
        )
    );
}

fn released_admission() -> FinalizingAdmission {
    let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
    let predecessor_run_id = RunId::new_v4();
    let guard = active_runs.register(
        predecessor_run_id,
        Some("thread:finalizing-owner".into()),
        "vm0/default".into(),
    );
    let predecessor = active_runs
        .finalizing_predecessor(predecessor_run_id, "thread:finalizing-owner", "vm0/default")
        .expect("predecessor should be registered");
    drop(guard);
    assert_eq!(predecessor.state(), ActiveRunReuseState::Released);
    FinalizingAdmission {
        predecessor,
        deadline: Instant::now(),
        reuse_key: "thread:finalizing-owner".into(),
        source_run_id: predecessor_run_id,
        native_generation_run_id: Some(predecessor_run_id),
    }
}

#[tokio::test]
async fn released_predecessor_selects_fresh_capacity_without_double_ownership() {
    let mut admission = released_admission();
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
        IdlePoolConfig::default(),
    )));
    let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let dir = tempfile::tempdir().unwrap();
    let status = StatusTracker::new(dir.path().join("status.json"), 2, None, None);
    status.write_initial().await.unwrap();
    let notify = Arc::new(Notify::new());
    let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
    let run_id = RunId::new_v4();
    let cancellation = RunCancellationRegistry::new()
        .register(run_id)
        .await
        .unwrap();
    let mut timing =
        RunnerPreSpawnTiming::start_at(Instant::now(), None, &RunnerPreSpawnConcurrency::default());
    let mut reserved_exact = None;
    let resource = select_finalizing_resource(
        FinalizingSelectionRequest {
            run_id,
            cancellation: &cancellation,
            admission: &mut admission,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 2048,
            device_rate_limits: &None,
            resources: FinalizingSelectionResources {
                idle_pool: &idle_pool,
                status: &status,
                idle_destroy_tracker: &destroy_tracker,
                budget: &budget,
                reuse_state_notify: &notify,
            },
        },
        &mut timing,
        &mut reserved_exact,
    )
    .await
    .unwrap();
    assert!(reserved_exact.is_none());
    let FinalizingResource::Fresh(lease) = resource else {
        panic!("released predecessor should use fresh capacity");
    };
    assert_eq!(budget.allocated(), (2, 2048, 1));
    assert_eq!(idle_pool.lock().await.len(), 0);
    drop(lease);
    assert_eq!(budget.allocated(), (0, 0, 0));
    cancellation.unregister().await;
}

#[tokio::test]
async fn expired_pre_finalization_deadline_uses_fallback_without_releasing_predecessor() {
    let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
    let predecessor_run_id = RunId::new_v4();
    let guard = active_runs.register(
        predecessor_run_id,
        Some("thread:finalizing-owner".into()),
        "vm0/default".into(),
    );
    let predecessor = active_runs
        .finalizing_predecessor(predecessor_run_id, "thread:finalizing-owner", "vm0/default")
        .unwrap();
    let mut admission = FinalizingAdmission {
        predecessor,
        deadline: Instant::now() - Duration::from_secs(1),
        reuse_key: "thread:finalizing-owner".into(),
        source_run_id: predecessor_run_id,
        native_generation_run_id: Some(predecessor_run_id),
    };
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
        IdlePoolConfig::default(),
    )));
    let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let dir = tempfile::tempdir().unwrap();
    let status = StatusTracker::new(dir.path().join("status.json"), 2, None, None);
    status.write_initial().await.unwrap();
    let notify = Arc::new(Notify::new());
    let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
    let run_id = RunId::new_v4();
    let cancellation = RunCancellationRegistry::new()
        .register(run_id)
        .await
        .unwrap();
    let mut timing =
        RunnerPreSpawnTiming::start_at(Instant::now(), None, &RunnerPreSpawnConcurrency::default());
    let mut reserved_exact = None;
    let selected = select_finalizing_resource(
        FinalizingSelectionRequest {
            run_id,
            cancellation: &cancellation,
            admission: &mut admission,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 2048,
            device_rate_limits: &None,
            resources: FinalizingSelectionResources {
                idle_pool: &idle_pool,
                status: &status,
                idle_destroy_tracker: &destroy_tracker,
                budget: &budget,
                reuse_state_notify: &notify,
            },
        },
        &mut timing,
        &mut reserved_exact,
    )
    .await
    .unwrap();
    let FinalizingResource::Fresh(lease) = selected else {
        panic!("expired pending wait should use fallback capacity");
    };
    assert_eq!(admission.predecessor.state(), ActiveRunReuseState::Pending);
    assert!(reserved_exact.is_none());
    drop(lease);
    assert_eq!(budget.allocated(), (0, 0, 0));
    drop(guard);
    cancellation.unregister().await;
}

#[tokio::test]
async fn cancelled_successor_does_not_reserve_fallback_capacity() {
    let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
    let predecessor_run_id = RunId::new_v4();
    let guard = active_runs.register(
        predecessor_run_id,
        Some("thread:finalizing-owner".into()),
        "vm0/default".into(),
    );
    let predecessor = active_runs
        .finalizing_predecessor(predecessor_run_id, "thread:finalizing-owner", "vm0/default")
        .unwrap();
    let mut admission = FinalizingAdmission {
        predecessor,
        deadline: Instant::now() + Duration::from_secs(60),
        reuse_key: "thread:finalizing-owner".into(),
        source_run_id: predecessor_run_id,
        native_generation_run_id: Some(predecessor_run_id),
    };
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
        IdlePoolConfig::default(),
    )));
    let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let dir = tempfile::tempdir().unwrap();
    let status = StatusTracker::new(dir.path().join("status.json"), 2, None, None);
    status.write_initial().await.unwrap();
    let notify = Arc::new(Notify::new());
    let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
    let run_id = RunId::new_v4();
    let cancellation = RunCancellationRegistry::new()
        .register(run_id)
        .await
        .unwrap();
    cancellation.handle().request_hard_cancellation().await;
    let mut timing =
        RunnerPreSpawnTiming::start_at(Instant::now(), None, &RunnerPreSpawnConcurrency::default());
    let mut reserved_exact = None;
    assert!(
        select_finalizing_resource(
            FinalizingSelectionRequest {
                run_id,
                cancellation: &cancellation,
                admission: &mut admission,
                profile_name: "vm0/default",
                vcpu: 2,
                memory_mb: 2048,
                device_rate_limits: &None,
                resources: FinalizingSelectionResources {
                    idle_pool: &idle_pool,
                    status: &status,
                    idle_destroy_tracker: &destroy_tracker,
                    budget: &budget,
                    reuse_state_notify: &notify,
                },
            },
            &mut timing,
            &mut reserved_exact,
        )
        .await
        .is_err()
    );
    assert!(reserved_exact.is_none());
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert_eq!(idle_pool.lock().await.len(), 0);
    drop(guard);
    cancellation.unregister().await;
}

#[tokio::test]
async fn fallback_capacity_wait_wakes_when_budget_is_released() {
    let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let held = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
    let entered = Arc::new(Notify::new());
    let budget_for_task = Arc::clone(&budget);
    let entered_for_task = Arc::clone(&entered);
    let task = tokio::spawn(async move {
        let mut admission = released_admission();
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
            IdlePoolConfig::default(),
        )));
        let dir = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(dir.path().join("status.json"), 2, None, None);
        status.write_initial().await.unwrap();
        let notify = Arc::new(Notify::new());
        let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
        let run_id = RunId::new_v4();
        let cancellation = RunCancellationRegistry::new()
            .register(run_id)
            .await
            .unwrap();
        let mut timing = RunnerPreSpawnTiming::start_at(
            Instant::now(),
            None,
            &RunnerPreSpawnConcurrency::default(),
        );
        let mut reserved_exact = None;
        let selected = select_finalizing_resource_inner(
            FinalizingSelectionRequest {
                run_id,
                cancellation: &cancellation,
                admission: &mut admission,
                profile_name: "vm0/default",
                vcpu: 2,
                memory_mb: 2048,
                device_rate_limits: &None,
                resources: FinalizingSelectionResources {
                    idle_pool: &idle_pool,
                    status: &status,
                    idle_destroy_tracker: &destroy_tracker,
                    budget: &budget_for_task,
                    reuse_state_notify: &notify,
                },
            },
            &mut timing,
            &mut reserved_exact,
            FinalizingSelectionTestHooks {
                on_capacity_wait: Some(Arc::new(move |_| {
                    entered_for_task.notify_one();
                })),
            },
        )
        .await
        .unwrap();
        assert!(reserved_exact.is_none());
        let FinalizingResource::Fresh(lease) = selected else {
            panic!("free capacity should be selected after wakeup");
        };
        drop(lease);
        cancellation.unregister().await;
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .expect("selector should enter capacity wait");
    drop(held);
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("selector should wake with capacity")
        .unwrap();
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn fallback_budget_wakeup_reuses_exact_published_while_waiting() {
    assert_fallback_budget_wakeup_reuses_published(true, true).await;
}

#[tokio::test]
async fn fallback_budget_wakeup_reuses_generic_published_while_waiting() {
    assert_fallback_budget_wakeup_reuses_published(false, true).await;
}

#[tokio::test]
async fn history_free_budget_wakeup_keeps_generationless_publication_generic() {
    assert_fallback_budget_wakeup_reuses_published(false, false).await;
}

async fn assert_fallback_budget_wakeup_reuses_published(exact: bool, native_history: bool) {
    let mut admission = released_admission();
    if !native_history {
        admission.native_generation_run_id = None;
    }
    let budget = Arc::new(ResourceBudget::new(5, 4096, 1.0, 0));
    let held = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
    let exact_lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
    let exact_id = sandbox::SandboxId::new_v4();
    let builder = ParkedIdleCandidateBuilder::new(&admission.reuse_key, exact_lease)
        .with_source_run_id(admission.source_run_id)
        .with_sandbox_id(exact_id);
    let candidate = if exact {
        builder
            .with_native_generation_run_id(admission.source_run_id)
            .build()
    } else {
        builder.build()
    };
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(
        IdlePoolConfig::default(),
    )));
    let entered = Arc::new(Notify::new());
    let budget_for_task = Arc::clone(&budget);
    let pool_for_task = Arc::clone(&idle_pool);
    let entered_for_task = Arc::clone(&entered);
    let task = tokio::spawn(async move {
        let dir = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(dir.path().join("status.json"), 5, None, None);
        status.write_initial().await.unwrap();
        let notify = Arc::new(Notify::new());
        let destroy_tracker = IdleDestroyTracker::new(Arc::clone(&notify));
        let run_id = RunId::new_v4();
        let cancellation = RunCancellationRegistry::new()
            .register(run_id)
            .await
            .unwrap();
        let mut timing = RunnerPreSpawnTiming::start_at(
            Instant::now(),
            None,
            &RunnerPreSpawnConcurrency::default(),
        );
        let mut reserved_exact = None;
        let selected = select_finalizing_resource_with_test_hooks(
            FinalizingSelectionRequest {
                run_id,
                cancellation: &cancellation,
                admission: &mut admission,
                profile_name: "vm0/default",
                vcpu: 2,
                memory_mb: 2048,
                device_rate_limits: &None,
                resources: FinalizingSelectionResources {
                    idle_pool: &pool_for_task,
                    status: &status,
                    idle_destroy_tracker: &destroy_tracker,
                    budget: &budget_for_task,
                    reuse_state_notify: &notify,
                },
            },
            &mut timing,
            &mut reserved_exact,
            FinalizingSelectionTestHooks {
                on_capacity_wait: Some(Arc::new(move |_| {
                    entered_for_task.notify_one();
                })),
            },
        )
        .await
        .unwrap();
        assert!(reserved_exact.is_none());
        cancellation.unregister().await;
        selected
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .expect("selector should wait with the full budget retained");
    assert_eq!(budget.allocated(), (4, 4096, 2));
    {
        let mut pool = idle_pool.lock().await;
        assert!(matches!(
            pool.park(candidate),
            runner_lifecycle::idle_pool::ParkResult::Parked
        ));
        // Make both wakeups ready before the selector resumes. Its budget
        // branch must still recheck the newly published exact generation.
        drop(held);
    }
    let selected = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("selector should accept the published sandbox")
        .unwrap();
    let reservation = match (exact, selected) {
        (true, FinalizingResource::Exact(reservation))
        | (false, FinalizingResource::Reusable(reservation)) => reservation,
        _ => panic!("published reuse should win over the newly available fresh capacity"),
    };
    assert_eq!(reservation.sandbox_id(), exact_id);
    assert_eq!(idle_pool.lock().await.len(), 0);
    assert_eq!(budget.allocated(), (2, 2048, 1));
    let (reservation, _) = reservation.into_parts();
    reservation.into_destroy_job().run().await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

fn delivered_handoff_request() -> (
    ActiveRunHandoffRequest,
    Arc<ResourceBudget>,
    Arc<MockSandboxOverrides>,
) {
    let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
    let predecessor_run_id = RunId::new_v4();
    let successor_run_id = RunId::new_v4();
    let guard = active_runs.register(
        predecessor_run_id,
        Some("thread:finalizing-wait-race".into()),
        "vm0/default".into(),
    );
    let publisher = guard.reuse_publisher();
    let proof = active_runs
        .finalizing_predecessor(
            predecessor_run_id,
            "thread:finalizing-wait-race",
            "vm0/default",
        )
        .expect("registered predecessor should remain finalizing");
    let request = proof
        .request_handoff(successor_run_id)
        .expect("exact successor should register a handoff");
    assert!(publisher.handoff_signal().accept_if_requested());

    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096)
        .expect("handoff candidate should reserve the test budget");
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = Box::new(MockSandbox::with_overrides(
        "finalizing-wait-race",
        Arc::clone(&overrides),
    ));
    let factory = Arc::new(
        Box::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)))
            as Box<dyn sandbox::SandboxFactory>,
    );
    let candidate = ParkedIdleCandidateBuilder::new("thread:finalizing-wait-race", lease)
        .with_source_run_id(predecessor_run_id)
        .with_sandbox(sandbox)
        .with_factory(factory)
        .build();
    assert!(matches!(
        publisher.deliver_exact_handoff(
            runner_lifecycle::idle_pool::IdleParkCandidate::Ordinary(candidate),
            predecessor_run_id,
        ),
        ActiveRunHandoffDeliveryResult::Delivered
    ));

    (request, budget, overrides)
}

#[tokio::test]
async fn cancellation_before_acceptance_branch_recovers_delivered_handoff() {
    let (mut request, budget, overrides) = delivered_handoff_request();

    let candidate = match FinalizingWaitOutcome::cancelled(Some(&mut request)) {
        FinalizingWaitOutcome::Cancelled(Some(candidate)) => candidate,
        _ => panic!("cancellation should retain an already delivered handoff candidate"),
    };
    candidate.into_destroy_job().run().await;

    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn deadline_race_prefers_an_already_delivered_handoff() {
    let (mut request, budget, overrides) = delivered_handoff_request();

    assert!(!request.expire_if_unaccepted());
    let candidate = request
        .receive()
        .await
        .expect("deadline should not discard a handoff that already won delivery");
    candidate.into_destroy_job().run().await;

    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
}
