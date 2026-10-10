use sandbox_mock::MockBackingProcess;

use super::*;

#[tokio::test]
async fn missing_backing_invalid_envelopes_and_registration_limits_return_original_data() {
    for case in 0..4 {
        let env = Env::with_policy(
            64,
            MemoryOperationPolicy {
                max_operations: if case == 3 { 1 } else { 16 },
                max_cleanup_inflight: if case == 3 { 1 } else { 4 },
                ..policy()
            },
        )
        .await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new(
            "thread:rejected-phase-registration",
            (case != 0).then_some(backing as Arc<dyn SandboxBackingProcess>),
        )
        .await;
        let mut envelope = envelope();
        if case == 1 {
            envelope.live_growth_bytes = 0;
        } else if case == 2 {
            envelope.tail_growth_bytes = 0;
        }
        let failure =
            GuardedIdleRetirement::new(fixture.job.take().unwrap(), &env.operations, envelope)
                .err()
                .unwrap();
        assert_eq!(
            failure.error(),
            &match case {
                0 => MemoryOperationError::MissingBacking,
                1 | 2 => MemoryOperationError::UnsupportedGrowth,
                _ => MemoryOperationError::OperationLimit,
            }
        );
        fixture.untouched().await;
        let job = failure.into_job();
        assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
        exit.confirm_exit();
        job.run_with_context("fixture_rejected_registration_cleanup")
            .await;
        assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    }
}

#[tokio::test]
async fn insufficient_live_or_tail_headroom_keeps_parked_job_and_both_phase_claims() {
    for available in [9, 10] {
        let env = Env::new(available).await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:no-export-headroom", Some(backing)).await;
        let mut pending = fixture.pending(&env);
        assert!(matches!(
            pending.try_grant().await,
            Err(MemoryOperationError::InsufficientHeadroom { .. })
        ));
        fixture.untouched().await;
        let snapshot = env.operations.snapshot().unwrap();
        assert_eq!(snapshot.started, 0);
        assert_eq!(snapshot.tracked_tasks, 0);
        assert_eq!(snapshot.granted, usize::from(available == 10));
        assert_eq!(snapshot.queued + snapshot.granted, 2);
        let job = pending.into_job();
        assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
        // Explicitly recovered fixture work; admission did not destroy anything.
        exit.confirm_exit();
        job.run_with_context("fixture_no_headroom_cleanup").await;
    }
}

#[tokio::test]
async fn cancellation_of_a_fresh_grant_wait_keeps_the_original_owner_for_retry() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:cancel-grant", Some(backing)).await;
    let mut pending = fixture.pending(&env);
    let (seen, release) = env.source.gate_read();
    {
        let grant = pending.try_grant();
        tokio::pin!(grant);
        tokio::select! {
            () = async { seen.await.unwrap() } => {},
            result = &mut grant => panic!("grant must remain externally held: {result:?}"),
        }
    }
    drop(release);
    fixture.untouched().await;
    assert_eq!(env.operations.snapshot().unwrap().queued, 2);
    pending.try_grant().await.unwrap();
    exit.confirm_exit();
    let result = pending
        .start("fixture_retried_grant")
        .unwrap()
        .join()
        .await
        .unwrap();
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    drop(result.budget_lease);
    fixture.saved().await;
}

#[tokio::test]
async fn incomplete_grants_and_late_close_reject_start_without_losing_resources() {
    for close in [false, true] {
        let env = Env::new(64).await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:reject-paired-start", Some(backing)).await;
        let mut pending = fixture.pending(&env);
        if close {
            pending.try_grant().await.unwrap();
            let report = env.operations.close_and_wait().await.unwrap();
            assert_eq!(report.granted, 2);
            assert_eq!(report.started, 0);
        }
        let failure = pending.start("must_not_start").err().unwrap();
        assert_eq!(
            failure.error(),
            &if close {
                MemoryOperationError::Closed
            } else {
                MemoryOperationError::Consumed
            }
        );
        fixture.untouched().await;
        let job = failure.into_retirement().into_job();
        let report = env.operations.snapshot().unwrap();
        assert_eq!(report.registered_operations, 0);
        assert_eq!(report.tracked_tasks, 0);
        exit.confirm_exit();
        job.run_with_context("fixture_start_rejection_cleanup")
            .await;
    }
}

#[tokio::test]
async fn unknown_observation_and_cleanup_wave_limit_do_not_start_or_abandon_saving() {
    for unknown in [false, true] {
        let env = Env::with_policy(
            64,
            MemoryOperationPolicy {
                max_cleanup_inflight: 1,
                ..policy()
            },
        )
        .await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:unavailable-coverage", Some(backing)).await;
        let mut pending = fixture.pending(&env);
        if unknown {
            tokio::fs::remove_file(&env.source.path).await.unwrap();
        }
        let result = pending.try_grant().await;
        assert!(if unknown {
            matches!(result, Err(MemoryOperationError::UnknownObservation(_)))
        } else {
            matches!(result, Err(MemoryOperationError::CleanupWaveFull))
        });
        fixture.untouched().await;
        let job = pending.into_job();
        exit.confirm_exit();
        job.run_with_context("fixture_unavailable_coverage_cleanup")
            .await;
    }
}
