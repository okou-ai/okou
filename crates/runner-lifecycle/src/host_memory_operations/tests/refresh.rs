use super::*;

#[tokio::test]
async fn unused_grant_refresh_uses_current_headroom_without_rebinding_or_starting() {
    let env = Env::new(64).await;
    let mut permit = grant(
        &env.operations,
        Plan::CleanupIo {
            growth_bytes: 8 * MIB,
        },
    )
    .await;
    let original = permit.id();
    env.source.available(4).await;
    assert!(matches!(
        permit.refresh().await,
        Err(Error::InsufficientHeadroom { .. })
    ));
    assert_eq!(permit.id(), original);
    assert_eq!(
        (
            env.operations.snapshot().unwrap().granted,
            env.operations.snapshot().unwrap().started
        ),
        (1, 0)
    );
    env.source.available(24).await;
    let observation = permit.refresh().await.unwrap();
    assert_eq!(
        observation.available_bytes_at(tokio::time::Instant::now(), policy().max_sample_age),
        Ok(24 * MIB)
    );
    assert_eq!(permit.id(), original);
    drop(permit);
    assert_eq!(
        env.operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}

#[tokio::test]
async fn held_refresh_is_fenced_and_cancellation_only_releases_unused_custody() {
    let env = Env::new(64).await;
    let mut permit = grant(&env.operations, Plan::CleanupIo { growth_bytes: MIB }).await;
    let (captured, release) = env.source.gate_next_read();
    let mut refreshing = Box::pin(permit.refresh());
    tokio::select! {
        result = &mut refreshing => panic!("held read completed: {result:?}"),
        () = async { captured.await.unwrap() } => {}
    }
    let intervening = env
        .operations
        .request(Plan::HostIo { growth_bytes: MIB })
        .unwrap();
    release.send(()).unwrap();
    assert!(matches!(refreshing.await, Err(Error::AccountingChanged)));
    drop(intervening);
    drop(permit);
    assert_eq!(
        env.operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}
