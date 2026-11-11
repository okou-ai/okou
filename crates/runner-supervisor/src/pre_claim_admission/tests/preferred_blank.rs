use super::super::*;
use crate::blank_pool::BlankPoolReplenisher;
use crate::provider_test_support::MockJobProvider;
use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::idle_pool::{IdlePool, IdlePoolConfig};
use runner_provider::{ActiveRunnerPreference, RunnerPreferenceTarget};
use sandbox_mock::{MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides};
use std::{collections::BTreeMap, time::Duration};
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(5);

#[tokio::test]
async fn preferred_blank_claim_loss_retires_the_same_vm_and_admission() {
    exercise_preferred_blank(true, false, false, false).await;
}

#[tokio::test]
async fn preferred_blank_cancellation_joins_started_preparation_before_releasing_capacity() {
    exercise_preferred_blank(true, false, true, false).await;
}

#[tokio::test]
async fn fallback_or_expired_advice_does_not_start_speculative_vms() {
    for (selected, expired) in [(false, false), (true, true)] {
        exercise_preferred_blank(selected, expired, false, false).await;
    }
}

#[tokio::test]
async fn preferred_advice_expiring_at_cpu_admission_does_not_start_a_vm() {
    exercise_preferred_blank(true, false, false, true).await;
}

#[tokio::test]
async fn failed_blank_preparation_returns_capacity_only_after_confirmed_cleanup() {
    exercise_failed_preparation(false).await;
}

#[tokio::test]
async fn uncertain_blank_cleanup_keeps_capacity_charged_through_shutdown() {
    exercise_failed_preparation(true).await;
}

async fn exercise_failed_preparation(uncertain: bool) {
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 1));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_result(Err(sandbox::SandboxError::Start {
        message: "boot failed".into(),
    }));
    if uncertain {
        overrides.push_destroy_panic("unconfirmed cleanup");
    }
    let factory: crate::SharedFactory = Arc::new(Box::new(MockSandboxFactory::with_overrides(
        overrides.clone(),
    )));
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    let preference = ActiveRunnerPreference::new(
        RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap(),
        RunnerPreferenceTarget::HomeCache,
        Instant::now() + Duration::from_secs(30),
    );
    let prepared = fresh::prepare(
        fresh::FreshProfile {
            factory: &factory,
            rootfs_hash: "fixture-rootfs",
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            home_disk_mb: 1,
            device_rate_limits: &None,
        },
        lease,
        preference,
        &PreSpawnAdmission::new(2).unwrap(),
        &CancellationToken::new(),
        &tracker,
    )
    .await;
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    if uncertain {
        assert!(matches!(prepared, fresh::Preparation::Uncertain(_)));
    } else {
        assert!(matches!(prepared, fresh::Preparation::Unprepared(_)));
    }
    drop(prepared);
    tracker.close_and_wait().await;
    assert_eq!(
        budget.allocated(),
        if uncertain { (2, 4096, 1) } else { (0, 0, 0) }
    );
    drop(tracker);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

async fn exercise_preferred_blank(selected: bool, expired: bool, cancelled: bool, contended: bool) {
    let directory = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        directory.path().join("status.json"),
        1,
        None,
        None,
    ));
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 1));
    let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 0,
    })));
    let overrides = Arc::new(MockSandboxOverrides::new());
    let mounting = MockLifecycleGate::new();
    if cancelled {
        overrides.set_home_drive_mount_lifecycle_gate(mounting.clone());
    }
    let factory: crate::SharedFactory = Arc::new(Box::new(MockSandboxFactory::with_overrides(
        overrides.clone(),
    )));
    let (provider, handle) = MockJobProvider::new(CancellationToken::new());
    let run_id = RunId::new_v4();
    handle.block_claim(run_id);
    let (_mode, mode_rx) = watch::channel(RunnerMode::Running);
    let cancellation = RunCancellationRegistry::new();
    let notify = Arc::new(Notify::new());
    let tracker = IdleDestroyTracker::new(notify.clone());
    let active = ActiveRuns::new(notify.clone());
    let home = HomeCacheStateSnapshot::new();
    let gate = PreSpawnAdmission::new(2).unwrap();
    let blocker_cancel = CancellationToken::new();
    let blocker = if contended {
        Some(gate.acquire(2, &blocker_cancel).await.unwrap())
    } else {
        None
    };
    let diagnostics =
        BlankPoolReplenisher::new(&BTreeMap::new(), &BTreeMap::new(), &budget, 0, None)
            .diagnostics();
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 7).unwrap();
    // Same host ID with a stale process generation must not speculate.
    let advised = if selected {
        identity
    } else {
        RunnerProcessIdentity::new(identity.runner_id(), 6).unwrap()
    };
    let deadline = if expired {
        Instant::now() - Duration::from_secs(1)
    } else if contended {
        Instant::now() + Duration::from_millis(50)
    } else {
        Instant::now() + Duration::from_secs(30)
    };
    let candidate = JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(Some("thread:preferred-blank".into()))
        .with_runner_preference(ActiveRunnerPreference::new(
            advised,
            RunnerPreferenceTarget::HomeCache,
            deadline,
        ));
    let resources = PreClaimResources {
        runner_identity: identity,
        idle_pool: &pool,
        status: &status,
        mode_rx: &mode_rx,
        cancel_tokens: &cancellation,
        provider: provider.as_ref(),
        budget: &budget,
        active_runs: &active,
        home_cache_snapshot: &home,
        sandbox_op_reporter: None,
        home_cache: None,
        idle_destroy_tracker: &tracker,
        reuse_state_notify: &notify,
        blank_pool_diagnostics: &diagnostics,
        pre_spawn_admission: &gate,
    };
    let (ready, _) = oneshot::channel();
    let admission = claim_with_local_admission(
        ClaimAdmissionRequest {
            prepared: PreparedCandidate {
                candidate,
                resource: None,
                required_home_source_run_id: None,
                home_readiness_wait: None,
                blank_pool_selection: None,
            },
            run_id,
            profile_name: "vm0/default",
            job_vcpu: 2,
            job_memory: 4096,
            home_disk_mb: 1,
            device_rate_limits: &None,
            factory: &factory,
            rootfs_hash: "fixture-rootfs",
        },
        &resources,
        ready,
    );
    tokio::pin!(admission);
    if selected && !expired && !contended {
        tokio::select! {
            result = &mut admission => panic!("blocked Claim completed early: {}", matches!(result, Ok(Some(_)))),
            observed = overrides.wait_home_drive_mount_call_count(1, WAIT) => assert!(observed),
        }
        assert_eq!(overrides.create_configs().len(), 1);
        assert!(overrides.run_control_bind_calls().is_empty());
        assert!(overrides.start_agent_process_calls().is_empty());
        assert!(overrides.home_drive_replacements().is_empty());
        if cancelled {
            cancellation
                .handle(run_id)
                .await
                .unwrap()
                .request_hard_cancellation()
                .await;
            assert!(futures_util::poll!(admission.as_mut()).is_pending());
            assert_eq!(budget.allocated(), (2, 4096, 1));
            mounting.release_one();
        }
    } else {
        tokio::select! {
            result = &mut admission => panic!("blocked Claim completed early: {}", matches!(result, Ok(Some(_)))),
            observed = handle.wait_run_claim_in_flight(run_id, WAIT) => assert!(observed),
        }
        assert!(overrides.create_configs().is_empty());
    }
    if contended {
        // Observe the actual advertised deadline, not a test-only sleep or a
        // provider-internal flag, before releasing the weighted admission.
        tokio::select! {
            result = &mut admission => panic!("blocked Claim completed early: {}", matches!(result, Ok(Some(_)))),
            () = tokio::time::sleep_until(deadline.into()) => {},
        }
    }
    drop(blocker);
    assert!(futures_util::poll!(admission.as_mut()).is_pending());
    if contended {
        assert!(overrides.create_configs().is_empty());
    }
    handle.unblock_claim(run_id);
    assert!(
        tokio::time::timeout(WAIT, admission)
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
    tracker.close_and_wait().await;
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(cancellation.handle(run_id).await.is_none());
    assert!(pool.lock().await.is_empty());
    if selected && !expired && !contended {
        assert_eq!(overrides.destroy_call_count(), 1);
    }
}
