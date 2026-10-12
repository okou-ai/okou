use runner_host::host_memory::HostMemoryUnknown;
use sandbox_mock::MockBackingProcess;

use super::*;

#[tokio::test]
async fn invalid_inputs_are_rejected_without_registering_physical_work() {
    let env = Env::new(64).await;
    for invalid in [
        MemoryOperationPolicy {
            max_sample_age: Duration::ZERO,
            ..policy()
        },
        MemoryOperationPolicy {
            max_operations: 0,
            ..policy()
        },
        MemoryOperationPolicy {
            max_cleanup_inflight: 0,
            ..policy()
        },
        MemoryOperationPolicy {
            max_cleanup_inflight: 17,
            ..policy()
        },
    ] {
        assert_eq!(
            HostMemoryOperations::new(invalid, env.source.clone())
                .err()
                .unwrap(),
            Error::InvalidLimits
        );
    }
    assert!(matches!(
        env.operations.request(Plan::Fresh {
            memory_mib: 8,
            preparation_bytes: u64::MAX
        }),
        Err(Error::Bounds(
            crate::host_memory_policy::HostMemoryBoundsError::Overflow
        ))
    ));
    assert!(matches!(
        env.operations.request(Plan::HostIo { growth_bytes: 0 }),
        Err(Error::UnsupportedGrowth)
    ));
    assert!(matches!(
        env.operations.request(Plan::CleanupIo {
            growth_bytes: u64::MAX
        }),
        Err(Error::AccountingOverflow)
    ));
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}

#[tokio::test]
async fn full_profile_and_preparation_margin_protect_floor_and_reserve() {
    let env = Env::new(15).await;
    let first = grant(
        &env.operations,
        Plan::Fresh {
            memory_mib: 8,
            preparation_bytes: MIB,
        },
    )
    .await;
    let mut second = env.operations.request(fresh(1)).unwrap();
    assert_eq!(
        second.try_grant().await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 15 * MIB,
            required: 16 * MIB
        }
    );
    drop(first);
    let next = second.try_grant().await.unwrap();
    drop(next);
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
async fn concurrent_same_headroom_is_fenced_but_fitting_parallelism_is_allowed() {
    let env = Env::new(14).await;
    let mut first = env.operations.request(fresh(8)).unwrap();
    let mut second = env.operations.request(fresh(8)).unwrap();
    let (observed, release) = env.source.gate_next_read();
    let deciding = tokio::spawn(async move {
        let result = first.try_grant().await;
        (first, result)
    });
    observed.await.unwrap();
    let second_permit = second.try_grant().await.unwrap();
    release.send(()).unwrap();
    let (mut first, stale) = deciding.await.unwrap();
    assert_eq!(stale.err().unwrap(), Error::AccountingChanged);
    assert_eq!(
        first.try_grant().await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 14 * MIB,
            required: 22 * MIB
        }
    );
    env.source.available(22).await;
    let first_permit = first.try_grant().await.unwrap();
    assert_ne!(first_permit.id(), second_permit.id());
    assert_eq!(env.operations.snapshot().unwrap().granted, 2);
    drop((first_permit, second_permit));
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}

#[tokio::test]
async fn cleanup_uses_reserve_once_and_above_reserve_bytes_remain_covered() {
    let env = Env::new(7).await;
    let first = grant(
        &env.operations,
        Plan::CleanupIo {
            growth_bytes: 3 * MIB,
        },
    )
    .await;
    let second = grant(
        &env.operations,
        Plan::CleanupIo {
            growth_bytes: 2 * MIB,
        },
    )
    .await;
    let mut ordinary = env.operations.request(fresh(1)).unwrap();
    assert_eq!(
        ordinary.try_grant().await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 7 * MIB,
            required: 8 * MIB
        }
    );
    env.source.available(8).await;
    let ordinary = ordinary.try_grant().await.unwrap();
    assert_eq!(
        env.operations.snapshot().unwrap().cleanup_growth_bytes,
        5 * MIB
    );
    drop((first, second, ordinary));
}

#[tokio::test]
async fn cleanup_priority_wave_and_total_registration_are_bounded() {
    let env = Env::new(64).await;
    let a = grant(&env.operations, Plan::CleanupIo { growth_bytes: MIB }).await;
    let b = grant(&env.operations, Plan::CleanupIo { growth_bytes: MIB }).await;
    let mut cleanup = env
        .operations
        .request(Plan::CleanupIo { growth_bytes: MIB })
        .unwrap();
    let mut ordinary = env.operations.request(fresh(1)).unwrap();
    assert_eq!(
        cleanup.try_grant().await.err().unwrap(),
        Error::CleanupWaveFull
    );
    assert_eq!(
        ordinary.try_grant().await.err().unwrap(),
        Error::CleanupWaiting
    );
    drop(cleanup);
    let ordinary = ordinary.try_grant().await.unwrap();
    drop((a, b, ordinary));

    let env = Env::with_policy(
        64,
        MemoryOperationPolicy {
            max_operations: 2,
            ..policy()
        },
    )
    .await;
    let a = env.operations.request(fresh(1)).unwrap();
    let b = env.operations.request(fresh(1)).unwrap();
    assert!(matches!(
        env.operations.request(fresh(1)),
        Err(Error::OperationLimit)
    ));
    let old_id = a.id();
    drop(a);
    let c = env.operations.request(fresh(1)).unwrap();
    assert_ne!(old_id, c.id());
    drop((b, c));
}

#[tokio::test]
async fn failed_prestart_rebind_is_atomic_and_success_tracks_actual_backing() {
    let env = Env::new(7).await;
    let mut permit = grant(&env.operations, fresh(1)).await;
    let (producer, backing) = MockBackingProcess::channel();
    let selection = Plan::Resume {
        memory_mib: 8,
        preparation_bytes: 0,
        backing: backing.clone(),
    };
    assert_eq!(
        permit.rebind(selection.clone()).await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 7 * MIB,
            required: 14 * MIB
        }
    );
    let mut other = env.operations.request(fresh(1)).unwrap();
    assert_eq!(
        other.try_grant().await.err().unwrap(),
        Error::InsufficientHeadroom {
            available: 7 * MIB,
            required: 8 * MIB
        }
    );
    drop(other);
    env.source.available(16).await;
    permit.rebind(selection).await.unwrap();
    let other = grant(&env.operations, fresh(2)).await;
    assert_eq!(
        permit
            .rebind(Plan::Retire {
                growth_bytes: MIB,
                backing
            })
            .await
            .err()
            .unwrap(),
        Error::PurposeChanged
    );
    drop((permit, other, producer));
}

#[tokio::test]
async fn unknown_zero_and_excess_total_never_reuse_healthy_headroom() {
    let env = Env::new(14).await;
    let mut request = env.operations.request(fresh(8)).unwrap();
    env.source.available(65).await;
    assert_eq!(
        request.try_grant().await.err().unwrap(),
        Error::ObservationExceedsTotal
    );
    env.source.available(0).await;
    assert!(matches!(
        request.try_grant().await,
        Err(Error::InsufficientHeadroom { available: 0, .. })
    ));
    tokio::fs::write(&env.source.path, "MemAvailable: broken kB\n")
        .await
        .unwrap();
    assert_eq!(
        request.try_grant().await.err().unwrap(),
        Error::UnknownObservation(HostMemoryUnknown::Malformed)
    );
    tokio::fs::remove_file(&env.source.path).await.unwrap();
    assert!(matches!(
        request.try_grant().await,
        Err(Error::UnknownObservation(HostMemoryUnknown::ReadFailed(_)))
    ));
}

#[tokio::test(start_paused = true)]
async fn delayed_observation_must_still_be_fresh_at_admission() {
    let env = Env::with_policy(
        14,
        MemoryOperationPolicy {
            max_sample_age: Duration::from_secs(1),
            ..policy()
        },
    )
    .await;
    let mut request = env.operations.request(fresh(8)).unwrap();
    let (observed, release) = env.source.gate_next_read();
    let deciding = tokio::spawn(async move { request.try_grant().await });
    observed.await.unwrap();
    tokio::time::advance(Duration::from_secs(1)).await;
    release.send(()).unwrap();
    assert_eq!(
        deciding.await.unwrap().err().unwrap(),
        Error::UnknownObservation(HostMemoryUnknown::Stale)
    );
}
