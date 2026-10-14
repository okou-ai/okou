use super::*;

fn shared_cache(capacity: usize) -> (Arc<tempfile::TempDir>, HomeImageCache) {
    let dir = Arc::new(tempfile::tempdir().unwrap());
    let cache = HomeImageCache::new(runner_host::paths::RunnerPaths::new(
        dir.path().join("runner"),
    ))
    .with_promotion_host_cpus(capacity * 2);
    (dir, cache)
}

async fn park_shared_home(
    fixture: &BatchFixture,
    dir: &Arc<tempfile::TempDir>,
    cache: &HomeImageCache,
    key: &str,
) -> ParkedHome {
    let home = HomePromotionFixture::new_with_cache(dir.clone(), cache.clone(), key, None).await;
    let (candidate, home) = fixture.candidate_with_home(home, true);
    assert!(matches!(
        fixture.pool.lock().await.park(candidate),
        ParkResult::Parked
    ));
    home
}

#[tokio::test]
async fn shared_reclamation_failure_retains_both_batch_owners_without_blocking_shutdown() {
    for capacity in [1, 2] {
        let fixture = BatchFixture::new().await;
        let (dir, cache) = shared_cache(capacity);
        let mut homes = Vec::new();
        for key in ["thread:shared-saving-first", "thread:shared-saving-second"] {
            let home = park_shared_home(&fixture, &dir, &cache, key).await;
            home.overrides.add_exec_matcher(ExecMatcher {
                pattern: "--freeze".into(),
                exit_code: 64,
                stdout: Vec::new(),
                stderr: b"required shared saving failed".to_vec(),
            });
            homes.push(home);
            // P2 registration is serialized so its concurrent-accounting
            // sample fence cannot mask accepted reclamation waiting.
            let report = join(&mut fixture.start(IdleRetirementBatchScope::All).await).await;
            assert!(report.not_started.is_empty(), "{report:?}");
            assert_eq!((report.completed, report.uncertain), (0, 1));
            assert!(!report.is_complete());
        }
        tokio::time::timeout(WAIT, fixture.tracker.close_and_wait())
            .await
            .unwrap();
        assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
        for home in &homes {
            home.assert_active_bytes().await;
            assert_eq!(home.overrides.destroy_call_count(), 0);
        }
        assert_eq!(
            fixture.operations.close_and_wait().await.unwrap().uncertain,
            4
        );
        let owners = fixture.tracker.take_retained_activation_owners().unwrap();
        assert_eq!(owners.len(), 2);
        for home in &homes {
            assert!(owners.iter().any(|owner| owner.sandbox_id() == home.id));
        }
        assert_eq!(
            owners
                .iter()
                .filter(|owner| owner.state() == IdleActivationState::Parked)
                .count(),
            2 - capacity
        );
        assert!(owners.iter().all(|owner| !owner.cleanup_completed()));
        drop(owners);
        assert_eq!(fixture.budget.allocated(), (0, 0, 0));
        let probe =
            HomePromotionFixture::new_with_cache(dir, cache, "thread:reconciled", None).await;
        let permit = tokio::time::timeout(
            WAIT,
            probe
                .promotion
                .acquire_required_idle_home_reclamation_permit(),
        )
        .await
        .unwrap()
        .unwrap();
        drop(permit);
    }
}

#[tokio::test]
async fn queued_required_reclamation_observes_saturation_without_releasing_failed_cpu_custody() {
    let fixture = BatchFixture::new().await;
    let (dir, cache) = shared_cache(1);
    let home = park_shared_home(&fixture, &dir, &cache, "thread:pending-saving-failure").await;
    let unpark = MockLifecycleGate::new();
    home.overrides.set_unpark_lifecycle_gate(unpark.clone());
    home.overrides
        .push_unpark_result(Err(sandbox::SandboxError::Start {
            message: "required terminal readiness failed".into(),
        }));
    let mut batch = fixture.start(IdleRetirementBatchScope::All).await;
    unpark.wait_entered(1, WAIT).await.unwrap();
    let probe =
        HomePromotionFixture::new_with_cache(dir, cache, "thread:pending-probe", None).await;
    let waiting = probe
        .promotion
        .acquire_required_idle_home_reclamation_permit();
    tokio::pin!(waiting);
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    unpark.release_one();
    assert_eq!(join(&mut batch).await.uncertain, 1);
    assert!(tokio::time::timeout(WAIT, waiting).await.unwrap().is_err());
    // Existing best-effort admission still waits for the retained real permit.
    let ordinary = probe.promotion.acquire_idle_home_reclamation_permit();
    tokio::pin!(ordinary);
    assert!(futures_util::poll!(ordinary.as_mut()).is_pending());
    fixture.tracker.close_and_wait().await;
    home.assert_active_bytes().await;
    assert_eq!(home.overrides.destroy_call_count(), 0);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    let owners = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(owners.len(), 1);
    assert!(!owners[0].cleanup_completed());
    drop(owners);
    drop(tokio::time::timeout(WAIT, ordinary).await.unwrap().unwrap());
    assert_eq!(
        fixture.operations.close_and_wait().await.unwrap().uncertain,
        2
    );
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn shared_healthy_reclamation_waits_for_exact_exit_and_completes_both_original_homes() {
    let fixture = BatchFixture::new().await;
    let (dir, cache) = shared_cache(1);
    let mut first = park_shared_home(&fixture, &dir, &cache, "thread:healthy-first").await;
    let first_kill = MockLifecycleGate::new();
    first.overrides.set_kill_lifecycle_gate(first_kill.clone());
    let mut batch = fixture.start(IdleRetirementBatchScope::All).await;
    first_kill.wait_entered(1, WAIT).await.unwrap();
    let mut second = park_shared_home(&fixture, &dir, &cache, "thread:healthy-second").await;
    let second_kill = MockLifecycleGate::new();
    second
        .overrides
        .set_kill_lifecycle_gate(second_kill.clone());
    let candidate = fixture
        .pool
        .lock()
        .await
        .retirement_candidate(&runner_lifecycle::idle_pool::IdleSandboxIdentity::Exact(
            second.key.clone(),
        ))
        .unwrap();
    let mut task = fixture
        .tracker
        .retire_pool_entry(
            &fixture.pool,
            &fixture.operations,
            IdlePoolRetirementRequest {
                candidate,
                envelope: IdleRetirementEnvelope {
                    live_growth_bytes: 8 * MIB,
                    tail_growth_bytes: MIB,
                },
                context: "shared_healthy_reclamation",
            },
        )
        .await
        .unwrap()
        .task;
    {
        let completion = task.join();
        tokio::pin!(completion);
        assert!(futures_util::poll!(completion.as_mut()).is_pending());
    }
    assert_eq!(second.overrides.terminal_unpark_call_count(), 0);
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    first.confirm_exit();
    first_kill.release_one();
    let report = join(&mut batch).await;
    assert!(report.is_complete(), "{report:?}");
    second_kill.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    second.confirm_exit();
    second_kill.release_one();
    assert!(matches!(
        tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    drop(task.take_completed_lease().unwrap());
    first.assert_cached_bytes().await;
    second.assert_cached_bytes().await;
    fixture.tracker.close_and_wait().await;
    assert!(
        fixture
            .tracker
            .take_retained_activation_owners()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}
