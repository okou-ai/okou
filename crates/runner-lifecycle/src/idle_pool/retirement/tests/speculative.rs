//! Borrowed speculative state transitions preserve the original resource/data.

use crate::guest_timezone::GuestTimezoneIntent;
use runner_types::ids::RunId;
use sandbox::{BackingProcessIdentity, SandboxParkOutcome};
use sandbox_mock::{ExecMatcher, MockBackingProcess, MockLifecycleGate};

use crate::idle_pool::{
    ActivationCleanupOutcome, GuardedSpeculativeIdleOwner, IdleActivationOwner, IdlePool,
    IdlePoolConfig, ParkResult, SpeculativeActivationState,
};

use super::*;

fn owner(fixture: &mut JobFixture) -> GuardedSpeculativeIdleOwner {
    let mut candidate = fixture.candidate();
    candidate.metadata.native_generation_run_id = Some(RunId::new_v4());
    candidate.metadata.guest_timezone_intent = GuestTimezoneIntent::Default;
    let mut pool = IdlePool::new(IdlePoolConfig::default());
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    GuardedSpeculativeIdleOwner::new(pool.take_reserved(&fixture.reuse_key).unwrap())
        .unwrap_or_else(|_| panic!("parked speculative reservation"))
}

async fn prepare(owner: &mut GuardedSpeculativeIdleOwner, run_id: RunId) -> Result<(), String> {
    owner
        .prepare(run_id, |sandbox, _, _| {
            Box::pin(async move {
                sandbox
                    .exec(&sandbox::ExecRequest {
                        cmd: "speculative-guest-restore",
                        timeout: WAIT,
                        env: &[],
                        sudo: true,
                        expected_exit_codes: &[],
                        stdin_bytes: None,
                        output_limits: sandbox::EXEC_OUTPUT_LIMIT_64_KIB,
                    })
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
        })
        .await
}

fn reuse_report(overrides: &MockSandboxOverrides) {
    overrides.add_persistent_exec_matcher(ExecMatcher {
        pattern: "prepare-for-reuse".into(),
        exit_code: 0,
        stderr: Vec::new(),
        stdout: serde_json::to_vec(
            &crate::idle_reuse_preparation::healthy_reuse_preparation_report(),
        )
        .unwrap(),
    });
}

async fn retained(fixture: &JobFixture) {
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
async fn speculative_commit_requires_matching_run_and_transfers_original_full_lease() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:spec-commit", Some(backing)).await;
    let mut owner = owner(&mut fixture);
    let run = RunId::new_v4();
    prepare(&mut owner, run).await.unwrap();
    assert!(
        owner
            .commit(RunId::new_v4(), &GuestTimezoneIntent::Default)
            .is_err()
    );
    retained(&fixture).await;
    let (reused, lease) = owner.commit(run, &GuestTimezoneIntent::Default).unwrap();
    assert_eq!(reused.sandbox_id(), fixture.sandbox_id);
    assert!(reused.guest_state_prepared);
    assert_eq!((lease.vcpu(), lease.memory_mb()), (2, 8));
    assert_eq!(owner.state(), SpeculativeActivationState::Transferred);
}

#[tokio::test]
async fn cancelled_unpark_and_guest_preparation_never_restore_uncertain_inventory() {
    for guest in [false, true] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:spec-cancel", Some(backing)).await;
        let gate = MockLifecycleGate::new();
        if guest {
            fixture.overrides.set_exec_lifecycle_gate(gate.clone());
        } else {
            fixture.overrides.set_unpark_lifecycle_gate(gate.clone());
        }
        let mut owner = owner(&mut fixture);
        let mut pending = Box::pin(prepare(&mut owner, RunId::new_v4()));
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        gate.wait_entered(1, WAIT).await.unwrap();
        drop(pending);
        assert_eq!(owner.state(), SpeculativeActivationState::Uncertain);
        assert!(owner.take_incoming().is_err());
        assert!(prepare(&mut owner, RunId::new_v4()).await.is_err());
        retained(&fixture).await;
    }
}

#[tokio::test]
async fn unpark_and_guest_errors_or_panics_retain_required_promotion() {
    for fault in ["unpark_error", "unpark_panic", "guest_error", "guest_panic"] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:spec-fault", Some(backing)).await;
        match fault {
            "unpark_error" => {
                fixture
                    .overrides
                    .push_unpark_result(Err(sandbox::SandboxError::Start {
                        message: fault.into(),
                    }))
            }
            "unpark_panic" => fixture.overrides.push_unpark_panic(fault),
            "guest_error" => fixture.overrides.add_exec_error_matcher(
                "speculative-guest-restore",
                sandbox::SandboxError::Start {
                    message: fault.into(),
                },
            ),
            _ => fixture
                .overrides
                .add_exec_panic_matcher("speculative-guest-restore", fault),
        }
        let mut owner = owner(&mut fixture);
        assert!(prepare(&mut owner, RunId::new_v4()).await.is_err());
        assert_eq!(owner.state(), SpeculativeActivationState::Uncertain);
        retained(&fixture).await;
    }
}

#[tokio::test]
async fn repark_preserves_original_timestamp_metadata_and_complete_lease() {
    for native_generation in [Some(RunId::new_v4()), None] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:spec-repark", Some(backing)).await;
        reuse_report(&fixture.overrides);
        let mut candidate = fixture.candidate();
        let producer = candidate.metadata.source_run_id.unwrap();
        candidate.metadata.native_generation_run_id = native_generation;
        let mut pool = IdlePool::new(IdlePoolConfig::default());
        let timestamp = std::time::Instant::now() - Duration::from_secs(60);
        assert!(matches!(
            pool.park_at_for_test(candidate, timestamp),
            ParkResult::Parked
        ));
        let mut owner =
            GuardedSpeculativeIdleOwner::new(pool.take_reserved(&fixture.reuse_key).unwrap())
                .unwrap_or_else(|_| panic!("parked reservation"));
        let run = RunId::new_v4();
        prepare(&mut owner, run).await.unwrap();
        owner.repark(MIB).await.unwrap();
        let incoming = owner.take_incoming().unwrap();
        let crate::idle_pool::IdlePoolIncomingOwner::Reserved(reserved) =
            incoming.into_owner().unwrap()
        else {
            panic!("restore owner");
        };
        let entry = reserved
            .into_parked_entry_preserving_owner()
            .unwrap_or_else(|_| panic!("parked owner"));
        assert_eq!(entry.parked_at, timestamp);
        assert_eq!(entry.metadata.native_generation_run_id, native_generation);
        assert_eq!(entry.metadata.source_run_id, Some(producer));
        assert_eq!(entry.resources.sandbox.id(), fixture.sandbox_id.to_string());
        assert_eq!(
            (entry.budget_lease.vcpu(), entry.budget_lease.memory_mb()),
            (2, 8)
        );
        assert_eq!(fixture.overrides.park_call_count(), 1);
        let calls = fixture.overrides.exec_calls();
        let call = calls
            .iter()
            .find(|call| call.cmd.contains("prepare-for-reuse"))
            .unwrap();
        let request: guest_contracts::reuse_preparation::ReusePreparationRequest =
            serde_json::from_slice(call.stdin_bytes.as_ref().unwrap()).unwrap();
        assert_eq!(
            request.current_runtime_dir,
            format!("/home/user/.vm0/guest-agent/runs/{producer}")
        );
        assert!(!request.current_runtime_dir.contains(&run.to_string()));
        retained(&fixture).await;
    }
}

#[tokio::test]
async fn cancelled_error_panicked_and_rejected_repark_retain_uncertain_owner() {
    for fault in ["cancel", "error", "panic", "reject", "report"] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:spec-park-fault", Some(backing)).await;
        reuse_report(&fixture.overrides);
        let mut owner = owner(&mut fixture);
        prepare(&mut owner, RunId::new_v4()).await.unwrap();
        match fault {
            "cancel" => {
                let gate = MockLifecycleGate::new();
                fixture.overrides.set_park_lifecycle_gate(gate.clone());
                let mut pending = Box::pin(owner.repark(MIB));
                assert!(futures_util::poll!(pending.as_mut()).is_pending());
                gate.wait_entered(1, WAIT).await.unwrap();
                drop(pending);
            }
            "error" => {
                fixture
                    .overrides
                    .push_park_result(Err(sandbox::SandboxError::Start {
                        message: fault.into(),
                    }));
                assert!(owner.repark(MIB).await.is_err());
            }
            "panic" => {
                fixture.overrides.push_park_panic(fault);
                assert!(owner.repark(MIB).await.is_err());
            }
            "reject" => {
                fixture.overrides.push_park_result(Ok(non_reusable()));
                assert!(owner.repark(MIB).await.is_err());
            }
            _ => {
                fixture.overrides.add_exec_matcher(ExecMatcher {
                    pattern: "prepare-for-reuse".into(),
                    exit_code: 0,
                    stderr: Vec::new(),
                    stdout: b"invalid report".to_vec(),
                });
                assert!(owner.repark(MIB).await.is_err());
            }
        }
        assert_eq!(owner.state(), SpeculativeActivationState::Uncertain);
        assert!(owner.take_incoming().is_err());
        retained(&fixture).await;
    }
}

fn non_reusable() -> SandboxParkOutcome {
    SandboxParkOutcome::NonReusable(
        sandbox::SandboxParkNonReusableReason::SevereMemoryRetention(Box::new(
            sandbox::SevereMemoryRetentionDiagnostics {
                requested_target_mib: 8,
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
        )),
    )
}

#[tokio::test]
async fn promotion_image_size_mismatch_does_not_abandon_required_home() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:spec-identity", Some(backing)).await;
    let mut owner = owner(&mut fixture);
    prepare(&mut owner, RunId::new_v4()).await.unwrap();
    assert_eq!(
        owner.repark(2 * MIB).await.unwrap_err(),
        "image size mismatch"
    );
    assert_eq!(fixture.overrides.park_call_count(), 0);
    retained(&fixture).await;
}

struct MutableBacking(Mutex<BackingProcessIdentity>);
#[async_trait::async_trait]
impl SandboxBackingProcess for MutableBacking {
    fn identity(&self) -> BackingProcessIdentity {
        *self.0.lock().unwrap()
    }
    async fn exit_confirmed(&self) -> bool {
        false
    }
}

struct ChangingBacking {
    original: BackingProcessIdentity,
    replacement: BackingProcessIdentity,
    original_reads: Mutex<Option<usize>>,
}

#[async_trait::async_trait]
impl SandboxBackingProcess for ChangingBacking {
    fn identity(&self) -> BackingProcessIdentity {
        let mut reads = self.original_reads.lock().unwrap();
        match *reads {
            None => self.original,
            Some(0) => self.replacement,
            Some(remaining) => {
                *reads = Some(remaining - 1);
                self.original
            }
        }
    }

    async fn exit_confirmed(&self) -> bool {
        false
    }
}

#[tokio::test]
async fn cleanup_registration_never_recaptures_a_replacement_generation() {
    let backing = Arc::new(ChangingBacking {
        original: BackingProcessIdentity::new_generation(),
        replacement: BackingProcessIdentity::new_generation(),
        original_reads: Mutex::new(None),
    });
    let mut fixture =
        JobFixture::new("thread:spec-cleanup-generation", Some(backing.clone())).await;
    let mut speculative = owner(&mut fixture);
    prepare(&mut speculative, RunId::new_v4()).await.unwrap();
    let mut cleanup = Some(speculative.take_cleanup_owner().unwrap());
    // The provider acknowledges both original-fence reads, then reports the
    // replacement throughout registration/admission. Coverage must retain the
    // original captured identity rather than capturing that replacement.
    *backing.original_reads.lock().unwrap() = Some(2);
    let env = Env::new(64).await;
    assert_eq!(
        cleanup
            .as_mut()
            .unwrap()
            .grant_cleanup(&env.operations, envelope())
            .await,
        Err(MemoryOperationError::OwnershipInvariant)
    );
    assert!(
        IdleActivationOwner::start_cleanup(&mut cleanup, "speculative_generation_changed").is_err()
    );
    assert!(cleanup.is_some());
    assert_eq!(env.operations.snapshot().unwrap().started, 0);
    retained(&fixture).await;
}

#[tokio::test]
async fn original_generation_fence_survives_conversion_to_required_cleanup() {
    let backing = Arc::new(MutableBacking(Mutex::new(
        BackingProcessIdentity::new_generation(),
    )));
    let mut fixture = JobFixture::new("thread:spec-generation", Some(backing.clone())).await;
    let mut owner = owner(&mut fixture);
    let run = RunId::new_v4();
    prepare(&mut owner, run).await.unwrap();
    *backing.0.lock().unwrap() = BackingProcessIdentity::new_generation();
    assert!(owner.commit(run, &GuestTimezoneIntent::Default).is_err());
    assert!(owner.take_incoming().is_err());
    let env = Env::new(64).await;
    let mut cleanup = owner.take_cleanup_owner().unwrap();
    assert_eq!(
        cleanup
            .grant_cleanup(&env.operations, envelope())
            .await
            .unwrap_err(),
        MemoryOperationError::OwnershipInvariant
    );
    retained(&fixture).await;
    assert_eq!(env.operations.snapshot().unwrap().started, 0);
}

#[tokio::test]
async fn generation_change_during_guest_or_repark_wait_never_publishes_readiness() {
    for park in [false, true] {
        let backing = Arc::new(MutableBacking(Mutex::new(
            BackingProcessIdentity::new_generation(),
        )));
        let mut fixture =
            JobFixture::new("thread:spec-wait-generation", Some(backing.clone())).await;
        reuse_report(&fixture.overrides);
        let mut owner = owner(&mut fixture);
        let run = RunId::new_v4();
        let gate = MockLifecycleGate::new();
        if park {
            prepare(&mut owner, run).await.unwrap();
            fixture.overrides.set_park_lifecycle_gate(gate.clone());
            let mut pending = Box::pin(owner.repark(MIB));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            gate.wait_entered(1, WAIT).await.unwrap();
            *backing.0.lock().unwrap() = BackingProcessIdentity::new_generation();
            gate.release_one();
            assert!(pending.await.is_err());
        } else {
            fixture.overrides.set_exec_lifecycle_gate(gate.clone());
            let mut pending = Box::pin(prepare(&mut owner, run));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            gate.wait_entered(1, WAIT).await.unwrap();
            *backing.0.lock().unwrap() = BackingProcessIdentity::new_generation();
            gate.release_one();
            assert!(pending.await.is_err());
        }
        assert_eq!(owner.state(), SpeculativeActivationState::Uncertain);
        assert!(owner.take_incoming().is_err());
        retained(&fixture).await;
    }
}

#[tokio::test]
async fn no_unknown_or_cancelled_headroom_retains_full_speculative_cleanup_capsule() {
    for fault in ["none", "unknown", "cancel"] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:spec-memory", Some(backing)).await;
        fixture
            .overrides
            .push_unpark_panic("failed speculative preparation");
        let mut owner = owner(&mut fixture);
        assert!(prepare(&mut owner, RunId::new_v4()).await.is_err());
        let mut cleanup = owner.take_cleanup_owner().unwrap();
        let env = Env::new(if fault == "none" { 0 } else { 64 }).await;
        if fault == "unknown" {
            tokio::fs::write(&env.source.path, "invalid\n")
                .await
                .unwrap();
        }
        if fault == "cancel" {
            let (observed, release) = env.source.gate_read();
            let mut pending = Box::pin(cleanup.grant_cleanup(&env.operations, envelope()));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            tokio::select! { _ = observed => {}, result = pending.as_mut() => panic!("unexpected grant: {result:?}") }
            drop(pending);
            drop(release);
        } else {
            assert!(
                cleanup
                    .grant_cleanup(&env.operations, envelope())
                    .await
                    .is_err()
            );
        }
        assert_eq!(fixture.overrides.terminal_unpark_call_count(), 0);
        retained(&fixture).await;
    }
}

#[tokio::test]
async fn failed_speculation_runs_shared_required_export_and_retains_full_completed_lease() {
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:spec-required-export", Some(backing)).await;
    fixture
        .overrides
        .push_unpark_panic("partial speculative unpark");
    let mut owner = owner(&mut fixture);
    assert!(prepare(&mut owner, RunId::new_v4()).await.is_err());
    let mut cleanup = owner.take_cleanup_owner().unwrap();
    let env = Env::new(64).await;
    cleanup
        .grant_cleanup(&env.operations, envelope())
        .await
        .unwrap();
    let (task, retained_owner) =
        IdleActivationOwner::start_cleanup(&mut Some(cleanup), "speculative_export")
            .unwrap()
            .into_parts();
    exit.confirm_exit();
    assert!(matches!(
        task.join().await.unwrap(),
        ActivationCleanupOutcome::Completed {
            home_cache_promoted: true
        }
    ));
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    fixture.saved().await;
    let lease = retained_owner.take_completed_lease().unwrap();
    assert_eq!((lease.vcpu(), lease.memory_mb()), (2, 8));
    drop(lease);
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}
