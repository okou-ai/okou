use super::*;

#[tokio::test]
async fn ordinary_blank_needs_current_pressure_and_publishes_exact_prepared_inventory() {
    let mut owner = Owner::new().await;
    owner.observe(4096).await;
    assert!(!owner.start());
    assert!(owner.overrides.create_configs().is_empty());
    owner.observe(32768).await;
    owner.observe(32768).await;
    assert!(owner.start());
    let result = owner.ready().await;
    let prepared = result.snapshot();
    assert!(prepared.prepared && prepared.retained_resource);
    assert!(!prepared.retired_exact && !prepared.published);
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    owner.publish(&result).await.unwrap();
    assert!(result.snapshot().published);
    assert!(!result.snapshot().retained_resource);
    assert_eq!(owner.fixture.pool.lock().await.blank_len(), 1);
    owner.dispose().await;
    assert_eq!(
        owner
            .fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .uncertain,
        0
    );
}

#[tokio::test]
async fn aged_conversion_saves_original_home_before_fresh_creation_and_reuses_full_lease() {
    let mut owner = Owner::new().await;
    let (candidate, mut home) = owner.fixture.candidate("thread:optional-aged", true).await;
    assert!(matches!(
        owner
            .fixture
            .pool
            .lock()
            .await
            .park_at_for_test(candidate, Instant::now() - Duration::from_secs(40 * 60)),
        ParkResult::Parked
    ));
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    assert!(owner.start());
    kill.wait_entered(1, WAIT).await.unwrap();
    assert!(owner.overrides.create_configs().is_empty());
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    home.assert_active_bytes().await;
    home.confirm_exit();
    kill.release_one();
    let result = owner.ready().await;
    assert!(result.snapshot().retired_exact && result.snapshot().prepared);
    home.assert_cached_bytes().await;
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    owner.publish(&result).await.unwrap();
    owner.dispose().await;
}

#[tokio::test]
async fn cancellation_during_aged_saving_releases_cpu_but_keeps_required_home_work() {
    let mut owner = Owner::new().await;
    let (candidate, mut home) = owner
        .fixture
        .candidate("thread:optional-aged-cancel", true)
        .await;
    assert!(matches!(
        owner
            .fixture
            .pool
            .lock()
            .await
            .park_at_for_test(candidate, Instant::now() - Duration::from_secs(40 * 60)),
        ParkResult::Parked
    ));
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    assert!(owner.start());
    kill.wait_entered(1, WAIT).await.unwrap();
    let foreground =
        tokio::time::timeout(WAIT, owner.admission.acquire(2, &CancellationToken::new()))
            .await
            .unwrap()
            .unwrap();
    assert!(owner.overrides.create_configs().is_empty());
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    let result = {
        let waiting = owner.replenisher.wait_for_optional_preparation();
        tokio::pin!(waiting);
        assert!(futures_util::poll!(waiting.as_mut()).is_pending());
        home.confirm_exit();
        kill.release_one();
        tokio::time::timeout(WAIT, waiting).await.unwrap().unwrap()
    };
    assert!(!result.snapshot().prepared);
    home.assert_cached_bytes().await;
    assert!(owner.overrides.create_configs().is_empty());
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
    drop(foreground);
    owner.dispose().await;
}

#[tokio::test]
async fn fresh_refusal_never_detaches_aged_home_or_calls_provider() {
    let mut owner = Owner::new().await;
    let (candidate, mut home) = owner
        .fixture
        .candidate("thread:optional-no-fresh", true)
        .await;
    assert!(matches!(
        owner
            .fixture
            .pool
            .lock()
            .await
            .park_at_for_test(candidate, Instant::now() - Duration::from_secs(40 * 60)),
        ParkResult::Parked
    ));
    // The controller can remain Ready while a fresh, separate admission read
    // proves there is no physical headroom; scheduling is not permission.
    tokio::fs::write(&owner.fixture.meminfo, "MemAvailable: 1024 kB\n")
        .await
        .unwrap();
    assert!(owner.start());
    let result = owner.ready().await;
    assert!(result.snapshot().error.is_some());
    assert!(!result.snapshot().retired_exact);
    assert!(owner.overrides.create_configs().is_empty());
    assert_eq!(owner.fixture.pool.lock().await.len(), 1);
    home.assert_active_bytes().await;
    owner.observe(32768).await;
    owner.observe(32768).await;
    home.confirm_exit();
    owner.dispose().await;
}
