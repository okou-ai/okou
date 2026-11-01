use super::*;

fn run_id(value: u128) -> RunId {
    RunId::from(uuid::Uuid::from_u128(value))
}

#[tokio::test(start_paused = true)]
async fn records_refreshes_and_saturates_without_eviction() {
    let cooldowns = ClaimCooldowns::new(2);
    let first_run_id = run_id(1);
    let second_run_id = run_id(2);
    let overflow_run_id = run_id(3);

    assert!(matches!(
        cooldowns
            .record(second_run_id, Duration::from_secs(30))
            .await,
        ClaimCooldownRecord::Recorded { active_count: 1 }
    ));
    assert!(matches!(
        cooldowns
            .record(first_run_id, Duration::from_secs(20))
            .await,
        ClaimCooldownRecord::Recorded { active_count: 2 }
    ));
    let snapshot = cooldowns.snapshot().await;
    assert_eq!(snapshot.run_ids, vec![first_run_id, second_run_id]);
    assert_eq!(snapshot.retry_after, Some(Duration::from_secs(20)));

    tokio::time::advance(Duration::from_secs(5)).await;
    assert!(matches!(
        cooldowns
            .record(second_run_id, Duration::from_secs(30))
            .await,
        ClaimCooldownRecord::Recorded { active_count: 2 }
    ));
    assert!(matches!(
        cooldowns
            .record(overflow_run_id, Duration::from_secs(30))
            .await,
        ClaimCooldownRecord::Saturated { active_count: 2 }
    ));
    let snapshot = cooldowns.snapshot().await;
    assert_eq!(snapshot.run_ids, vec![first_run_id, second_run_id]);
    assert_eq!(snapshot.retry_after, Some(Duration::from_secs(15)));

    tokio::time::advance(Duration::from_secs(15)).await;
    let snapshot = cooldowns.snapshot().await;
    assert_eq!(snapshot.run_ids, vec![second_run_id]);
    assert_eq!(snapshot.retry_after, Some(Duration::from_secs(15)));
}

#[tokio::test(start_paused = true)]
async fn global_deadline_precedes_per_run_deadline_until_expiry() {
    let cooldowns = ClaimCooldowns::new(1);
    let first_run_id = run_id(1);
    let next_run_id = run_id(2);

    assert!(matches!(
        cooldowns
            .record(first_run_id, Duration::from_secs(30))
            .await,
        ClaimCooldownRecord::Recorded { active_count: 1 }
    ));
    cooldowns.block_all(Duration::from_secs(5)).await;

    let snapshot = cooldowns.snapshot().await;
    assert_eq!(snapshot.run_ids, vec![first_run_id]);
    assert_eq!(snapshot.retry_after, Some(Duration::from_secs(5)));
    assert_eq!(
        cooldowns.remaining(first_run_id).await,
        Some(Duration::from_secs(5))
    );
    assert_eq!(
        cooldowns.remaining(next_run_id).await,
        Some(Duration::from_secs(5))
    );

    tokio::time::advance(Duration::from_secs(5)).await;
    let snapshot = cooldowns.snapshot().await;
    assert_eq!(snapshot.run_ids, vec![first_run_id]);
    assert_eq!(snapshot.retry_after, Some(Duration::from_secs(25)));
    assert_eq!(
        cooldowns.remaining(first_run_id).await,
        Some(Duration::from_secs(25))
    );
    assert_eq!(cooldowns.remaining(next_run_id).await, None);

    tokio::time::advance(Duration::from_secs(25)).await;
    assert!(matches!(
        cooldowns.record(next_run_id, Duration::from_secs(10)).await,
        ClaimCooldownRecord::Recorded { active_count: 1 }
    ));
    let snapshot = cooldowns.snapshot().await;
    assert_eq!(snapshot.run_ids, vec![next_run_id]);
    assert_eq!(snapshot.retry_after, Some(Duration::from_secs(10)));
}

#[tokio::test(start_paused = true)]
async fn remove_clears_only_requested_run_and_updates_retry_deadline() {
    let cooldowns = ClaimCooldowns::new(2);
    let first_run_id = run_id(1);
    let second_run_id = run_id(2);

    assert!(matches!(
        cooldowns
            .record(first_run_id, Duration::from_secs(10))
            .await,
        ClaimCooldownRecord::Recorded { active_count: 1 }
    ));
    assert!(matches!(
        cooldowns
            .record(second_run_id, Duration::from_secs(20))
            .await,
        ClaimCooldownRecord::Recorded { active_count: 2 }
    ));

    cooldowns.remove(first_run_id).await;

    let snapshot = cooldowns.snapshot().await;
    assert_eq!(snapshot.run_ids, vec![second_run_id]);
    assert_eq!(snapshot.retry_after, Some(Duration::from_secs(20)));
    assert_eq!(cooldowns.remaining(first_run_id).await, None);
    assert_eq!(
        cooldowns.remaining(second_run_id).await,
        Some(Duration::from_secs(20))
    );
}
