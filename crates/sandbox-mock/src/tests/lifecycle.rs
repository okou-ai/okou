use super::*;
use std::sync::Arc;

#[derive(Default)]
struct RecordingFinalExecParkObserver {
    records: Vec<(SandboxFinalExecParkStage, bool)>,
    substages: Vec<(
        SandboxFinalExecParkSubstage,
        bool,
        Option<SandboxFinalExecParkSubstageOutcome>,
    )>,
    substage_durations: Vec<(SandboxFinalExecParkSubstage, Duration)>,
}

impl SandboxFinalExecParkObserver for RecordingFinalExecParkObserver {
    fn record_stage(
        &mut self,
        stage: SandboxFinalExecParkStage,
        _duration: Duration,
        success: bool,
    ) {
        self.records.push((stage, success));
    }

    fn record_substage(
        &mut self,
        substage: SandboxFinalExecParkSubstage,
        duration: Duration,
        success: bool,
        outcome: Option<SandboxFinalExecParkSubstageOutcome>,
    ) {
        self.substages.push((substage, success, outcome));
        self.substage_durations.push((substage, duration));
    }
}

fn severe_memory_retention() -> SandboxParkNonReusableReason {
    SandboxParkNonReusableReason::SevereMemoryRetention(Box::new(
        SevereMemoryRetentionDiagnostics {
            requested_target_mib: 0,
            first_observed_target_mib: None,
            observed_target_mib: None,
            target_observed: false,
            first_actual_mib: None,
            previous_actual_mib: None,
            actual_mib: None,
            max_actual_mib: None,
            deficit_mib: None,
            actual_delta_mib: None,
            elapsed_ms: 0,
            sample_count: 0,
            reported_free_memory_bytes: None,
            reported_available_memory_bytes: None,
            reported_total_memory_bytes: None,
            reported_swap_in_bytes: None,
            reported_swap_out_bytes: None,
            reported_major_faults: None,
            reported_minor_faults: None,
            reported_disk_caches_bytes: None,
            progress_extension_blocker: None,
            guest_memory_snapshot_attempted: false,
            guest_memory_snapshot: None,
        },
    ))
}

#[tokio::test]
async fn sandbox_lifecycle() {
    let mut sandbox = MockSandbox::new("test-1");
    sandbox.start().await.unwrap();
    sandbox.stop().await.unwrap();
    sandbox.kill().await.unwrap();
}

#[tokio::test]
async fn operation_overrides_preserve_unrelated_sandbox_behavior() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_start_process_lifecycle_gate(MockLifecycleGate::new());
    overrides.set_copy_file_lifecycle_gate(MockLifecycleGate::new());
    overrides.set_private_write_file_lifecycle_gate(MockLifecycleGate::new());
    let mut sandbox = MockSandbox::with_overrides("test-1", Arc::clone(&overrides));

    sandbox.bind_run_control("run-1").unwrap();
    sandbox
        .write_files(&[
            WriteFileEntry {
                path: "/tmp/a.txt",
                content: b"a",
            },
            WriteFileEntry {
                path: "/tmp/b.txt",
                content: b"b",
            },
        ])
        .await
        .unwrap();

    let mut observer = RecordingFinalExecParkObserver::default();
    let outcome = sandbox
        .final_exec_and_park_with_observer(
            &ExecRequest {
                cmd: "true",
                timeout: test_timeout(),
                env: &[],
                sudo: false,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
            },
            "test",
            &mut observer,
        )
        .await
        .unwrap();

    assert_eq!(
        outcome.park_outcome,
        SandboxParkOutcome::Reusable,
        "operation overrides must not replace lifecycle behavior"
    );
    assert_eq!(overrides.run_control_bind_calls(), vec!["run-1"]);
    assert_eq!(overrides.write_files_calls().len(), 1);
    assert_eq!(overrides.write_file_calls().len(), 2);
    assert_eq!(
        observer.records,
        vec![
            (SandboxFinalExecParkStage::ReusePreparation, true),
            (SandboxFinalExecParkStage::PhysicalPark, true),
        ]
    );
    assert_eq!(
        observer.substages,
        vec![
            (
                SandboxFinalExecParkSubstage::BalloonSetup,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            ),
            (
                SandboxFinalExecParkSubstage::BalloonSettle,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            ),
            (
                SandboxFinalExecParkSubstage::BalloonDeflate,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            ),
            (SandboxFinalExecParkSubstage::VcpuPause, true, None),
        ]
    );
    assert_eq!(
        observer.substage_durations,
        vec![
            (SandboxFinalExecParkSubstage::BalloonSetup, Duration::ZERO),
            (SandboxFinalExecParkSubstage::BalloonSettle, Duration::ZERO),
            (SandboxFinalExecParkSubstage::BalloonDeflate, Duration::ZERO),
            (SandboxFinalExecParkSubstage::VcpuPause, Duration::ZERO),
        ]
    );
}

#[tokio::test]
async fn overrides_count_park_and_unpark_calls_across_factory_sandboxes() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let mut first = factory.create(test_sandbox_config()).await.unwrap();
    let mut second = factory.create(test_sandbox_config()).await.unwrap();

    first.park().await.unwrap();
    first.park().await.unwrap();
    second.park().await.unwrap();

    first.unpark().await.unwrap();
    second.unpark().await.unwrap();
    first.unpark_for_terminal_operations().await.unwrap();

    assert_eq!(overrides.park_call_count(), 3);
    assert_eq!(overrides.unpark_call_count(), 3);
    assert_eq!(overrides.terminal_unpark_call_count(), 1);
}

#[tokio::test]
async fn park_outcomes_are_consumed_fifo_and_default_to_reusable() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_park_result(Ok(SandboxParkOutcome::NonReusable(
        severe_memory_retention(),
    )));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut first = factory.create(test_sandbox_config()).await.unwrap();
    let mut second = factory.create(test_sandbox_config()).await.unwrap();

    assert_eq!(
        first.park().await.unwrap(),
        SandboxParkOutcome::NonReusable(severe_memory_retention())
    );
    assert_eq!(second.park().await.unwrap(), SandboxParkOutcome::Reusable);
    assert_eq!(overrides.park_call_count(), 2);
}

#[tokio::test]
async fn overrides_count_destroy_calls_across_factory_sandboxes() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let first = factory.create(test_sandbox_config()).await.unwrap();
    let second = factory.create(test_sandbox_config()).await.unwrap();

    factory.destroy(first).await;
    factory.destroy(second).await;

    assert_eq!(overrides.destroy_call_count(), 2);
}

#[tokio::test]
async fn lifecycle_behaviors_are_consumed_fifo_and_default_to_success() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_stop_result(Err(SandboxError::Start {
        message: "queued stop failure".into(),
    }));
    overrides.push_stop_result(Ok(()));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let err = sandbox
        .stop()
        .await
        .expect_err("first queued stop behavior should fail");
    assert!(err.to_string().contains("queued stop failure"));
    sandbox
        .stop()
        .await
        .expect("second queued stop behavior should succeed");
    sandbox
        .stop()
        .await
        .expect("empty stop behavior queue should default to success");
    assert_eq!(overrides.stop_call_count(), 3);

    overrides.push_kill_result(Err(SandboxError::Start {
        message: "queued kill failure".into(),
    }));
    let err = sandbox
        .kill()
        .await
        .expect_err("queued kill behavior should fail");
    assert!(err.to_string().contains("queued kill failure"));
    sandbox
        .kill()
        .await
        .expect("empty kill behavior queue should default to success");
    assert_eq!(overrides.kill_call_count(), 2);
}

#[tokio::test]
async fn lifecycle_gate_observes_park_entry_after_it_already_happened() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let park_task = tokio::spawn(async move { sandbox.park().await });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    assert_eq!(overrides.park_call_count(), 1);

    gate.release_one();
    park_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn lifecycle_gate_wait_entered_zero_returns_immediately() {
    let gate = MockLifecycleGate::new();

    assert_eq!(gate.wait_entered(0, test_timeout()).await.unwrap(), 0);
    assert_eq!(gate.entered_count(), 0);
}

#[tokio::test]
async fn lifecycle_gate_wait_entered_timeout_reports_observed_count() {
    let gate = MockLifecycleGate::new();
    gate.release_one();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

    sandbox.park().await.unwrap();
    let err = gate
        .wait_entered(2, Duration::ZERO)
        .await
        .expect_err("second entry should time out");

    assert_eq!(err.target_count(), 2);
    assert_eq!(err.actual_count(), 1);
    assert_eq!(err.timeout(), Duration::ZERO);
    assert_eq!(gate.entered_count(), 1);
}

#[tokio::test]
async fn lifecycle_gate_wakes_multiple_waiters_for_same_entry() {
    let gate = MockLifecycleGate::new();
    let first_waiter = tokio::spawn({
        let gate = gate.clone();
        async move { gate.wait_entered(1, test_timeout()).await.unwrap() }
    });
    let second_waiter = tokio::spawn({
        let gate = gate.clone();
        async move { gate.wait_entered(1, test_timeout()).await.unwrap() }
    });
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let park_task = tokio::spawn(async move { sandbox.park().await });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    assert_eq!(first_waiter.await.unwrap(), 1);
    assert_eq!(second_waiter.await.unwrap(), 1);

    gate.release_one();
    park_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn lifecycle_gate_release_before_park_entry_is_not_lost() {
    let gate = MockLifecycleGate::new();
    gate.release_one();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

    tokio::time::timeout(test_timeout(), sandbox.park())
        .await
        .expect("early release permit should let park finish")
        .unwrap();

    assert_eq!(gate.entered_count(), 1);
    assert_eq!(overrides.park_call_count(), 1);

    let mut next_sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let next_park_task = tokio::spawn(async move { next_sandbox.park().await });
    assert_eq!(gate.wait_entered(2, test_timeout()).await.unwrap(), 2);
    assert!(
        !next_park_task.is_finished(),
        "early release permit should be consumed by only one lifecycle entry"
    );
    gate.release_one();
    next_park_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn lifecycle_gate_release_zero_does_not_release_entry() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let park_task = tokio::spawn(async move { sandbox.park().await });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

    gate.release_many(0);
    assert_eq!(lifecycle_gate_released_count(&gate), 0);
    assert!(
        !park_task.is_finished(),
        "zero release count must not let the entry through"
    );

    gate.release_one();
    park_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn lifecycle_gate_early_release_many_releases_only_that_many_entries() {
    let gate = MockLifecycleGate::new();
    gate.release_many(2);
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut park_tasks = Vec::new();

    for idx in 0..3 {
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let done_tx = done_tx.clone();
        park_tasks.push(tokio::spawn(async move {
            sandbox.park().await.unwrap();
            done_tx.send(idx).unwrap();
        }));
    }
    drop(done_tx);

    assert_eq!(gate.wait_entered(3, test_timeout()).await.unwrap(), 3);
    assert_eq!(lifecycle_gate_released_count(&gate), 2);
    for _ in 0..2 {
        tokio::time::timeout(test_timeout(), done_rx.recv())
            .await
            .expect("early releases should complete two entries")
            .expect("completion channel should remain open");
    }
    assert!(
        matches!(
            done_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ),
        "third entry must remain blocked until another release"
    );

    gate.release_one();
    tokio::time::timeout(test_timeout(), done_rx.recv())
        .await
        .expect("final release should complete third entry")
        .expect("completion channel should remain open");
    for task in park_tasks {
        task.await.unwrap();
    }
}

#[tokio::test]
async fn lifecycle_gate_release_after_cancelled_entry_does_not_release_future_entry() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut first_sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let first_park_task = tokio::spawn(async move { first_sandbox.park().await });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    first_park_task.abort();
    assert!(first_park_task.await.unwrap_err().is_cancelled());

    gate.release_one();
    let mut second_sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let second_park_task = tokio::spawn(async move { second_sandbox.park().await });
    assert_eq!(gate.wait_entered(2, test_timeout()).await.unwrap(), 2);
    assert!(
        !second_park_task.is_finished(),
        "release for a cancelled entry must not pass a future entry"
    );

    gate.release_one();
    second_park_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn lifecycle_gate_waits_for_nth_park_entry() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let mut park_tasks = Vec::new();
    for _ in 0..3 {
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();
        park_tasks.push(tokio::spawn(async move { sandbox.park().await }));
    }

    assert_eq!(gate.wait_entered(3, test_timeout()).await.unwrap(), 3);
    assert_eq!(overrides.park_call_count(), 3);

    gate.release_many(park_tasks.len());
    for task in park_tasks {
        task.await.unwrap().unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lifecycle_gate_counts_concurrent_park_entries_on_multithread_runtime() {
    const ENTRY_COUNT: usize = 32;

    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let mut park_tasks = Vec::with_capacity(ENTRY_COUNT);
    for _ in 0..ENTRY_COUNT {
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();
        park_tasks.push(tokio::spawn(async move { sandbox.park().await }));
    }

    assert_eq!(
        gate.wait_entered(ENTRY_COUNT as u64, test_timeout())
            .await
            .unwrap(),
        ENTRY_COUNT as u64
    );
    assert_eq!(gate.entered_count(), ENTRY_COUNT as u64);
    assert_eq!(overrides.park_call_count(), ENTRY_COUNT as u32);

    gate.release_many(ENTRY_COUNT);
    for task in park_tasks {
        task.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn destroy_lifecycle_gate_release_before_entry_is_not_lost() {
    let gate = MockLifecycleGate::new();
    gate.release_one();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();

    tokio::time::timeout(test_timeout(), factory.destroy(sandbox))
        .await
        .expect("early release permit should let destroy finish");

    assert_eq!(gate.entered_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);

    let next_sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let next_destroy_task = tokio::spawn(async move {
        factory.destroy(next_sandbox).await;
    });
    assert_eq!(gate.wait_entered(2, test_timeout()).await.unwrap(), 2);
    assert!(
        !next_destroy_task.is_finished(),
        "early release permit should be consumed by only one lifecycle entry"
    );
    gate.release_one();
    next_destroy_task.await.unwrap();
}

#[tokio::test]
async fn destroy_lifecycle_gate_release_after_cancelled_entry_does_not_release_future_entry() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
    let first_sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let first_destroy_task = tokio::spawn({
        let factory = Arc::clone(&factory);
        async move {
            factory.destroy(first_sandbox).await;
        }
    });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    first_destroy_task.abort();
    assert!(first_destroy_task.await.unwrap_err().is_cancelled());

    gate.release_one();
    let second_sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let second_destroy_task = tokio::spawn({
        let factory = Arc::clone(&factory);
        async move {
            factory.destroy(second_sandbox).await;
        }
    });
    assert_eq!(gate.wait_entered(2, test_timeout()).await.unwrap(), 2);
    assert!(
        !second_destroy_task.is_finished(),
        "release for a cancelled destroy entry must not pass a future entry"
    );

    gate.release_one();
    second_destroy_task.await.unwrap();
}

#[tokio::test]
async fn destroy_lifecycle_gate_waits_for_nth_destroy_entry() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_destroy_lifecycle_gate(gate.clone());
    let factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));

    let mut destroy_tasks = Vec::new();
    for _ in 0..3 {
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let factory = Arc::clone(&factory);
        destroy_tasks.push(tokio::spawn(async move {
            factory.destroy(sandbox).await;
        }));
    }

    assert_eq!(gate.wait_entered(3, test_timeout()).await.unwrap(), 3);
    assert_eq!(overrides.destroy_call_count(), 3);

    gate.release_many(destroy_tasks.len());
    for task in destroy_tasks {
        task.await.unwrap();
    }
}

#[tokio::test]
async fn destroy_lifecycle_gate_blocks_before_destroy_panic() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_destroy_lifecycle_gate(gate.clone());
    overrides.push_destroy_panic("simulated destroy panic");
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let destroy_task = tokio::spawn(async move {
        factory.destroy(sandbox).await;
    });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        !destroy_task.is_finished(),
        "destroy behavior should not run until the gate is released"
    );

    gate.release_one();
    let err = destroy_task.await.expect_err("destroy should panic");
    assert!(err.is_panic());
}

#[tokio::test]
async fn destroy_panic_override_is_consumed_once_across_factories() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_destroy_panic("simulated destroy panic");
    let first_factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let first_sandbox = first_factory.create(test_sandbox_config()).await.unwrap();

    let err = tokio::spawn(async move {
        first_factory.destroy(first_sandbox).await;
    })
    .await
    .expect_err("first destroy should panic");
    assert!(err.is_panic());

    let second_factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let second_sandbox = second_factory.create(test_sandbox_config()).await.unwrap();
    second_factory.destroy(second_sandbox).await;

    assert_eq!(overrides.destroy_call_count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_destroy_panic_is_consumed_once_across_concurrent_factories() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_destroy_panic("simulated destroy panic");
    let first_factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
    let second_factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
    let first_sandbox = first_factory.create(test_sandbox_config()).await.unwrap();
    let second_sandbox = second_factory.create(test_sandbox_config()).await.unwrap();
    let barrier = Arc::new(tokio::sync::Barrier::new(2));

    let first = tokio::spawn({
        let barrier = Arc::clone(&barrier);
        async move {
            barrier.wait().await;
            first_factory.destroy(first_sandbox).await;
        }
    });
    let second = tokio::spawn({
        let barrier = Arc::clone(&barrier);
        async move {
            barrier.wait().await;
            second_factory.destroy(second_sandbox).await;
        }
    });

    let classify = |result: std::result::Result<(), tokio::task::JoinError>| match result {
        Ok(()) => (1, 0),
        Err(err) if err.is_panic() => (0, 1),
        Err(err) => panic!("destroy task should not be cancelled: {err}"),
    };
    let (first_success_count, first_panic_count) = classify(first.await);
    let (second_success_count, second_panic_count) = classify(second.await);
    let panic_count = first_panic_count + second_panic_count;
    let success_count = first_success_count + second_success_count;
    assert_eq!(
        panic_count, 1,
        "shared destroy panic should be consumed by exactly one concurrent factory"
    );
    assert_eq!(
        success_count, 1,
        "the factory that did not consume the shared destroy panic should complete"
    );
    assert_eq!(overrides.destroy_call_count(), 2);
}
