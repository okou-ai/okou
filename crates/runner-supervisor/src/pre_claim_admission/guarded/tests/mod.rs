//! Real provider claim, Executor guest preparation and rollback composition.

use std::{path::PathBuf, sync::Mutex, time::Duration};

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::guest_timezone::GuestTimezoneIntent;
use runner_lifecycle::home_image_cache::HomeCacheCheckoutResult;
use runner_lifecycle::home_promotion::test_support::{
    HomePromotionFixture, add_healthy_cache_preparation_matcher, test_home_image,
};
use runner_lifecycle::host_memory_operations::{MemoryObservationSource, MemoryOperationPolicy};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::idle_pool::{
    ActivationCleanupOutcome, IdlePool, IdlePoolConfig, ParkResult,
    test_support::ParkedIdleCandidateBuilder,
};
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_provider::{ApiClaimTiming, ClaimResponseAttribution};
use sandbox::{SandboxBackingProcess, SandboxFactory};
use sandbox_mock::{
    ExecMatcher, MockBackingProcess, MockLifecycleGate, MockSandbox, MockSandboxFactory,
    MockSandboxOverrides,
};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::provider_test_support::MockJobProvider;
use crate::test_fixtures::execution_context::execution_context_for_test;

const MIB: u64 = 1024 * 1024;
const WAIT: Duration = Duration::from_secs(5);

mod http_claim;

struct Source {
    path: PathBuf,
    gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}
impl MemoryObservationSource for Source {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            let gate = self.gate.lock().unwrap().take();
            let sample = HostMemoryObservation::read_at(&self.path).await;
            if let Some((seen, release)) = gate {
                seen.send(()).unwrap();
                release.await.unwrap();
            }
            sample
        })
    }
}

struct Fixture {
    home: RetainedHome,
    budget: Arc<ResourceBudget>,
    overrides: Arc<MockSandboxOverrides>,
    pool: SharedIdlePool,
    tracker: IdleDestroyTracker,
    status: StatusTracker,
    source: Arc<Source>,
    operations: HostMemoryOperations,
    admission: Option<GuardedSpeculativeAdmission>,
    producer: RunId,
}

struct RetainedHome {
    _dir: Arc<tempfile::TempDir>,
    cache: runner_lifecycle::home_image_cache::HomeImageCache,
    reuse_key: String,
    sandbox_id: sandbox::SandboxId,
}

impl Fixture {
    async fn new(backing: Option<Arc<dyn SandboxBackingProcess>>, available: u64) -> Self {
        Self::with_timezone(backing, available, GuestTimezoneIntent::Unknown).await
    }

    async fn with_timezone(
        backing: Option<Arc<dyn SandboxBackingProcess>>,
        available: u64,
        timezone: GuestTimezoneIntent,
    ) -> Self {
        let home = HomePromotionFixture::new("thread:spec-supervisor").await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        add_healthy_cache_preparation_matcher(&overrides);
        overrides.add_persistent_exec_matcher(ExecMatcher {
            pattern: "prepare-for-reuse".into(),
            exit_code: 0,
            stderr: Vec::new(),
            stdout: serde_json::to_vec(
                &crate::idle_reuse_preparation::healthy_reuse_preparation_report(),
            )
            .unwrap(),
        });
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(overrides.clone()),
        ));
        let budget = Arc::new(ResourceBudget::new(5, 16, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
        let mut sandbox =
            MockSandbox::with_overrides(home.sandbox_id.to_string(), overrides.clone());
        if let Some(backing) = backing {
            sandbox = sandbox.with_backing_process(backing);
        }
        let history = RunId::new_v4();
        let producer = home.promotion.run_id();
        let retained_home = RetainedHome {
            _dir: home._dir.clone(),
            cache: home.cache.clone(),
            reuse_key: home.reuse_key.clone(),
            sandbox_id: home.sandbox_id,
        };
        let HomePromotionFixture { promotion, .. } = home;
        let candidate = ParkedIdleCandidateBuilder::new("thread:spec-supervisor", lease)
            .with_source_run_id(producer)
            .with_last_completed_at("2026-10-20T00:00:00Z")
            .with_sandbox_id(home.sandbox_id)
            .with_sandbox(Box::new(sandbox))
            .with_factory(factory)
            .with_native_generation_run_id(history)
            .with_guest_timezone_intent(timezone)
            .with_home_promotion(promotion)
            .build();
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let admission =
            GuardedSpeculativeAdmission::new(pool.take_reserved("thread:spec-supervisor").unwrap())
                .unwrap_or_else(|_| panic!("parked exact"));
        let source = Arc::new(Source {
            path: home._dir.path().join("meminfo"),
            gate: Mutex::new(None),
        });
        tokio::fs::write(
            &source.path,
            format!("MemAvailable: {} kB\n", available * 1024),
        )
        .await
        .unwrap();
        let operations = HostMemoryOperations::new(
            MemoryOperationPolicy {
                bounds: HostMemoryBounds {
                    host_total_bytes: 64 * MIB,
                    operating_floor_bytes: 2 * MIB,
                    cleanup_reserve_bytes: 4 * MIB,
                    critical_available_bytes: 2 * MIB,
                    recovery_available_bytes: 8 * MIB,
                },
                max_sample_age: Duration::from_secs(10),
                max_operations: 16,
                max_cleanup_inflight: 4,
            },
            source.clone(),
        )
        .unwrap();
        let status = StatusTracker::new(home._dir.path().join("status.json"), 1, None, None);
        // Retain all independent fixture identities/bytes without retaining a
        // second promotion lock: the actual owner has the original context.
        let home = retained_home;
        Self {
            home,
            budget,
            overrides,
            pool: Arc::new(tokio::sync::Mutex::new(pool)),
            tracker: IdleDestroyTracker::new(Arc::new(Notify::new())),
            status,
            source,
            operations,
            admission: Some(admission),
            producer,
        }
    }

    fn candidate(&self, run: RunId) -> JobCandidate {
        self.candidate_for_source(run, self.producer)
    }

    fn candidate_for_source(&self, run: RunId, source: RunId) -> JobCandidate {
        JobCandidate::new(run, "vm0/default".into())
            .with_reuse_key(Some(self.home.reuse_key.clone()))
            .with_runner_preference(runner_provider::ActiveRunnerPreference::new(
                runner_host::runner_process_identity::RunnerProcessIdentity::new(
                    uuid::Uuid::from_u128(1),
                    7,
                )
                .unwrap(),
                runner_provider::RunnerPreferenceTarget::ExactSandbox(source),
                std::time::Instant::now() + Duration::from_secs(30),
            ))
    }

    async fn rollback(
        &self,
        admission: &mut GuardedSpeculativeAdmission,
    ) -> Result<GuardedSpeculativeRollback, MemoryOperationError> {
        admission
            .rollback(
                &self.pool,
                &self.tracker,
                &self.status,
                &self.operations,
                IdleRetirementEnvelope {
                    live_growth_bytes: 8 * MIB,
                    tail_growth_bytes: MIB,
                },
                MIB,
            )
            .await
    }

    async fn retained(&self) {
        assert_eq!(self.budget.allocated(), (2, 8, 1));
        assert_eq!(self.overrides.kill_call_count(), 0);
        assert_eq!(self.overrides.destroy_call_count(), 0);
        assert_eq!(
            tokio::fs::read(
                self.home
                    .cache
                    .paths()
                    .active_home_image(&self.home.sandbox_id)
            )
            .await
            .unwrap(),
            test_home_image()
        );
        assert_eq!(
            HomePromotionFixture::checkout_result(&self.home.cache, &self.home.reuse_key).await,
            HomeCacheCheckoutResult::LockBusy
        );
    }
}

#[tokio::test]
async fn real_claim_and_guest_restore_commit_the_original_prepared_resource() {
    for (prediction, timezone, mismatch) in [
        (GuestTimezoneIntent::Default, None, false),
        (GuestTimezoneIntent::Default, Some("Asia/Shanghai"), false),
        (GuestTimezoneIntent::Default, Some("invalid;zone"), false),
        (GuestTimezoneIntent::Unknown, None, false),
        (GuestTimezoneIntent::Default, None, true),
    ] {
        let (_, backing) = MockBackingProcess::channel();
        let expected_prepared = prediction == GuestTimezoneIntent::Default && timezone.is_none();
        let mut fixture = Fixture::with_timezone(Some(backing), 64, prediction).await;
        let run = RunId::new_v4();
        let returned_run = if mismatch { RunId::new_v4() } else { run };
        let provider: Arc<dyn JobProvider> = if mismatch {
            Arc::new(FaultProvider(ClaimFault::ReturnedRun(returned_run)))
        } else {
            let (provider, _) = MockJobProvider::new(CancellationToken::new());
            let mut context = execution_context_for_test(run);
            context.user_timezone = timezone.map(str::to_owned);
            provider.set_claim_result(run, Some(context));
            provider
        };
        let mut admission = fixture.admission.take().unwrap();
        admission
            .prepare_and_claim(provider, fixture.candidate(run), &fixture.tracker)
            .await
            .unwrap();
        assert_eq!(fixture.overrides.guest_state_restore_calls().len(), 1);
        if mismatch {
            assert!(admission.commit().is_err());
            fixture.retained().await;
            let claimed = admission.take_claim_response().unwrap().unwrap();
            let (context, auth, _) = claimed.into_parts();
            assert_eq!(context.run_id, returned_run);
            assert_eq!(auth.into_sandbox_token(returned_run).unwrap(), CLAIM_TOKEN);
        } else {
            let (claim, sandbox, lease) = admission.commit().unwrap();
            assert_eq!(claim.context().run_id, run);
            assert_eq!(sandbox.sandbox_id(), fixture.home.sandbox_id);
            assert_eq!(sandbox.into_parts().guest_state_prepared, expected_prepared);
            assert_eq!((lease.vcpu(), lease.memory_mb()), (2, 8));
        }
        fixture.tracker.close_and_wait().await;
    }
}

#[tokio::test]
async fn rejected_claim_reparks_and_returns_the_original_exact_owner() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    let (provider, _) = MockJobProvider::new(CancellationToken::new());
    let mut admission = fixture.admission.take().unwrap();
    let candidate = fixture.candidate(RunId::new_v4())
        .with_parsed_runner_preference_context(runner_provider::parse_runner_preference(Some(serde_json::json!({
            "kind": "preference", "tier": "exactSandbox",
            "runnerIdentity": { "runnerId": "11111111-1111-4111-8111-111111111111", "heartbeatGeneration": 7 },
            "expiresAt": "2099-01-01T00:00:00Z", "predecessorRunId": fixture.producer
        }))).unwrap());
    admission
        .prepare_and_claim(provider, candidate, &fixture.tracker)
        .await
        .unwrap();
    assert!(admission.commit().is_err());
    assert!(admission.take_claim_response().unwrap().is_none());
    let GuardedSpeculativeRollback::Restored(result) =
        fixture.rollback(&mut admission).await.unwrap()
    else {
        panic!("restored");
    };
    assert!(result.retirement.is_none());
    assert_eq!(result.snapshot.idle_sandboxes.len(), 1);
    assert_eq!(fixture.overrides.park_call_count(), 1);
    assert_eq!(
        fixture.pool.lock().await.held_sandbox_states()[0]
            .reusable_sandbox
            .source_run_id,
        fixture.producer
    );
    let requests: Vec<guest_contracts::reuse_preparation::ReusePreparationRequest> = fixture
        .overrides
        .exec_calls()
        .into_iter()
        .filter(|call| call.cmd.contains("guest-agent prepare-for-reuse"))
        .map(|call| serde_json::from_slice(call.stdin_bytes.as_deref().unwrap()).unwrap())
        .collect();
    assert_eq!(
        requests.last().unwrap().current_runtime_dir,
        format!("/home/user/.vm0/guest-agent/runs/{}", fixture.producer)
    );
    fixture.retained().await;
}

#[tokio::test]
async fn cancelling_preparation_observation_does_not_cancel_accepted_claim_or_shutdown_owner() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    let (provider, handle) = MockJobProvider::new(CancellationToken::new());
    let run = RunId::new_v4();
    provider.set_claim_result(run, Some(execution_context_for_test(run)));
    handle.block_claims();
    let gate = MockLifecycleGate::new();
    fixture
        .overrides
        .set_guest_state_restore_lifecycle_gate(gate.clone());
    let mut admission = fixture.admission.take().unwrap();
    let mut pending = Box::pin(admission.prepare_and_claim(
        provider.clone(),
        fixture.candidate(run),
        &fixture.tracker,
    ));
    assert!(futures_util::poll!(pending.as_mut()).is_pending());
    gate.wait_entered(1, WAIT).await.unwrap();
    assert!(handle.wait_claim_in_flight(1, WAIT).await);
    drop(pending);
    let mut pending = Box::pin(admission.wait_for_claim());
    assert!(futures_util::poll!(pending.as_mut()).is_pending());
    drop(pending);
    assert!(matches!(
        admission.take_claim_response(),
        Err(MemoryOperationError::Consumed)
    ));
    fixture.retained().await;
    let mut shutdown = Box::pin(fixture.tracker.close_and_wait());
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    handle.unblock_claims();
    tokio::time::timeout(WAIT, admission.wait_for_claim())
        .await
        .unwrap()
        .unwrap();
    // Guest preparation was cancelled: failed commit must return the same
    // successful claim to retained custody for explicit completion.
    assert!(admission.commit().is_err());
    let claim = admission.take_claim_response().unwrap().unwrap();
    assert_eq!(claim.context().run_id, run);
    admission.wait_for_claim().await.unwrap();
    assert!(matches!(
        admission.take_claim_response(),
        Err(MemoryOperationError::Consumed)
    ));
    assert_eq!(
        admission
            .prepare_and_claim(provider, fixture.candidate(run), &fixture.tracker)
            .await
            .unwrap_err(),
        "speculative claim already began; observe its retained response"
    );
    assert!(admission.commit().is_err());
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    assert_eq!(handle.claim_candidates().len(), 1);
    fixture.retained().await;
}

#[tokio::test]
async fn successful_claim_survives_guest_error_panic_and_cancel_for_explicit_completion() {
    for fault in ["error", "panic", "cancel"] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = Fixture::new(Some(backing), 64).await;
        let run = RunId::new_v4();
        let provider = Arc::new(FaultProvider(ClaimFault::ReturnedRun(run)));
        let mut admission = fixture.admission.take().unwrap();
        if fault == "cancel" {
            let gate = MockLifecycleGate::new();
            fixture
                .overrides
                .set_guest_state_restore_lifecycle_gate(gate.clone());
            let mut pending = Box::pin(admission.prepare_and_claim(
                provider,
                fixture.candidate(run),
                &fixture.tracker,
            ));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            gate.wait_entered(1, WAIT).await.unwrap();
            drop(pending);
        } else {
            if fault == "error" {
                fixture.overrides.push_guest_state_restore_result(Err(
                    sandbox::SandboxError::Start {
                        message: fault.into(),
                    },
                ));
            } else {
                fixture.overrides.push_guest_state_restore_panic(fault);
            }
            assert!(
                admission
                    .prepare_and_claim(provider, fixture.candidate(run), &fixture.tracker)
                    .await
                    .is_err()
            );
        }
        admission.wait_for_claim().await.unwrap();
        assert!(admission.commit().is_err());
        let claim = admission.take_claim_response().unwrap().unwrap();
        let (context, auth, _) = claim.into_parts();
        assert_eq!(context.run_id, run);
        assert_eq!(auth.into_sandbox_token(run).unwrap(), CLAIM_TOKEN);
        assert!(admission.commit().is_err());
        fixture.retained().await;
        fixture.tracker.close_and_wait().await;
    }
}

#[tokio::test]
async fn no_unknown_or_cancelled_cleanup_observation_retains_original_required_data() {
    for fault in ["none", "unknown", "cancel"] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = Fixture::new(Some(backing), if fault == "none" { 0 } else { 64 }).await;
        fixture.overrides.push_unpark_panic("speculative failure");
        let (provider, _) = MockJobProvider::new(CancellationToken::new());
        let mut admission = fixture.admission.take().unwrap();
        assert!(
            admission
                .prepare_and_claim(
                    provider,
                    fixture.candidate(RunId::new_v4()),
                    &fixture.tracker
                )
                .await
                .is_err()
        );
        if fault == "unknown" {
            tokio::fs::write(&fixture.source.path, "invalid meminfo\n")
                .await
                .unwrap();
        }
        if fault == "cancel" {
            let (seen, observed) = oneshot::channel();
            let (release, wait) = oneshot::channel();
            *fixture.source.gate.lock().unwrap() = Some((seen, wait));
            let mut pending = Box::pin(fixture.rollback(&mut admission));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            tokio::select! { _ = observed => {}, _ = pending.as_mut() => panic!("unexpected acceptance") }
            drop(pending);
            drop(release);
        } else {
            assert!(fixture.rollback(&mut admission).await.is_err());
        }
        fixture.retained().await;
        assert_eq!(fixture.overrides.terminal_unpark_call_count(), 0);
        assert!(fixture.pool.lock().await.is_empty());
        fixture.tracker.close_and_wait().await;
    }
}

#[tokio::test]
async fn failed_repark_accepts_required_export_and_dropped_observer_retains_completed_full_lease() {
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    let (provider, _) = MockJobProvider::new(CancellationToken::new());
    let mut admission = fixture.admission.take().unwrap();
    admission
        .prepare_and_claim(
            provider,
            fixture.candidate(RunId::new_v4()),
            &fixture.tracker,
        )
        .await
        .unwrap();
    fixture
        .overrides
        .push_park_panic("speculative rollback park panic");
    let kill = MockLifecycleGate::new();
    fixture.overrides.set_kill_lifecycle_gate(kill.clone());
    let GuardedSpeculativeRollback::Cleanup(task) = fixture.rollback(&mut admission).await.unwrap()
    else {
        panic!("required cleanup");
    };
    drop(task);
    kill.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    let mut shutdown = Box::pin(fixture.tracker.close_and_wait());
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    exit.confirm_exit();
    kill.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    let mut retained = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert!(retained[0].cleanup_completed());
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert!(matches!(
        HomePromotionFixture::checkout_result(&fixture.home.cache, &fixture.home.reuse_key).await,
        HomeCacheCheckoutResult::Hit
    ));
    drop(retained[0].take_completed_lease().unwrap());
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn required_preparation_failure_remains_recoverable_after_observer_loss_and_shutdown() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    fixture.overrides.push_unpark_panic("speculative failure");
    fixture.overrides.add_exec_error_matcher(
        "prepare-for-cache",
        sandbox::SandboxError::Start {
            message: "required saving unavailable".into(),
        },
    );
    let (provider, _) = MockJobProvider::new(CancellationToken::new());
    let mut admission = fixture.admission.take().unwrap();
    assert!(
        admission
            .prepare_and_claim(
                provider,
                fixture.candidate(RunId::new_v4()),
                &fixture.tracker
            )
            .await
            .is_err()
    );
    let GuardedSpeculativeRollback::Cleanup(mut task) =
        fixture.rollback(&mut admission).await.unwrap()
    else {
        panic!("cleanup");
    };
    assert!(matches!(
        task.join().await.unwrap().unwrap(),
        ActivationCleanupOutcome::NoProgress(_)
    ));
    drop(task);
    fixture.tracker.close_and_wait().await;
    let retained = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].sandbox_id(), fixture.home.sandbox_id);
    assert!(!retained[0].cleanup_completed());
    fixture.retained().await;
}

#[tokio::test]
async fn missing_backing_or_mismatched_candidate_prevents_claim_and_keeps_full_owner() {
    for missing in [false, true] {
        let backing = if missing {
            None
        } else {
            Some(MockBackingProcess::channel().1 as Arc<dyn SandboxBackingProcess>)
        };
        let mut fixture = Fixture::new(backing, 64).await;
        let (provider, handle) = MockJobProvider::new(CancellationToken::new());
        let mut admission = fixture.admission.take().unwrap();
        let candidate = if missing {
            fixture.candidate(RunId::new_v4())
        } else {
            fixture.candidate_for_source(RunId::new_v4(), RunId::new_v4())
        };
        assert!(
            admission
                .prepare_and_claim(provider, candidate, &fixture.tracker)
                .await
                .is_err()
        );
        assert!(handle.claim_candidates().is_empty());
        assert_eq!(fixture.overrides.unpark_call_count(), 0);
        fixture.retained().await;
    }
}

async fn add_blank(
    fixture: &Fixture,
) -> (
    sandbox_mock::MockBackingProcessCompletion,
    Arc<MockSandboxOverrides>,
) {
    let (exit, backing) = MockBackingProcess::channel();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let id = sandbox::SandboxId::new_v4();
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(overrides.clone()),
    ));
    let lease = ResourceBudget::try_reserve_lease(&fixture.budget, 2, 8).unwrap();
    let mut candidate = runner_lifecycle::idle_pool::ParkedIdleCandidate::blank(
        Box::new(
            MockSandbox::with_overrides(id.to_string(), overrides.clone())
                .with_backing_process(backing),
        ),
        factory,
        lease,
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    );
    candidate.capture_retirement_backing().unwrap();
    assert!(matches!(
        fixture.pool.lock().await.park(candidate),
        ParkResult::Parked
    ));
    (exit, overrides)
}

#[tokio::test]
async fn blank_replacement_progresses_before_old_exit_under_separate_coverage() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    let (provider, _) = MockJobProvider::new(CancellationToken::new());
    let mut admission = fixture.admission.take().unwrap();
    admission
        .prepare_and_claim(
            provider,
            fixture.candidate(RunId::new_v4()),
            &fixture.tracker,
        )
        .await
        .unwrap();
    let (exit, blank) = add_blank(&fixture).await;
    let gate = MockLifecycleGate::new();
    blank.set_kill_lifecycle_gate(gate.clone());
    let GuardedSpeculativeRollback::Restored(mut result) =
        tokio::time::timeout(WAIT, fixture.rollback(&mut admission))
            .await
            .unwrap()
            .unwrap()
    else {
        panic!("restored");
    };
    gate.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(result.snapshot.idle_sandboxes.len(), 1);
    assert!(result.snapshot.blank_sandboxes.is_empty());
    assert_eq!(fixture.budget.allocated(), (4, 16, 2));
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    let retirement = result.retirement.as_mut().unwrap();
    exit.confirm_exit();
    gate.release_one();
    let outcome = tokio::time::timeout(WAIT, retirement.join())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(
        outcome,
        ActivationCleanupOutcome::Completed { .. }
    ));
    let old = retirement.take_completed_lease().unwrap();
    assert_eq!((old.vcpu(), old.memory_mb()), (2, 8));
    drop(old);
    fixture.retained().await;
    fixture.tracker.close_and_wait().await;
}

#[tokio::test]
async fn pool_mutation_during_replacement_admission_retains_incoming_and_original_blank() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    let (provider, _) = MockJobProvider::new(CancellationToken::new());
    let mut admission = fixture.admission.take().unwrap();
    admission
        .prepare_and_claim(
            provider,
            fixture.candidate(RunId::new_v4()),
            &fixture.tracker,
        )
        .await
        .unwrap();
    let (_exit, blank) = add_blank(&fixture).await;
    let (seen, observed) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    *fixture.source.gate.lock().unwrap() = Some((seen, wait));
    let mut pending = Box::pin(fixture.rollback(&mut admission));
    assert!(futures_util::poll!(pending.as_mut()).is_pending());
    tokio::select! { _ = observed => {}, _ = pending.as_mut() => panic!("unexpected acceptance") }
    let mut pool = fixture.pool.lock().await;
    let original_blank = pool
        .reserve_blank("vm0/default", &None)
        .unwrap_or_else(|_| panic!("blank"));
    assert!(matches!(
        pool.restore_reserved(original_blank),
        RestoreReservedIdleResult::Restored
    ));
    drop(pool);
    release.send(()).unwrap();
    assert!(pending.await.is_err());
    assert!(matches!(admission.resource, Resource::Incoming(_)));
    assert_eq!(fixture.budget.allocated(), (4, 16, 2));
    assert_eq!(blank.kill_call_count(), 0);
    assert_eq!(blank.destroy_call_count(), 0);
    assert_eq!(fixture.pool.lock().await.blank_len(), 1);
    assert_eq!(fixture.operations.snapshot().unwrap().started, 0);
}

#[tokio::test]
async fn status_wait_cancellation_leaves_replaced_blank_in_joined_tracker() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    let (provider, _) = MockJobProvider::new(CancellationToken::new());
    let mut admission = fixture.admission.take().unwrap();
    admission
        .prepare_and_claim(
            provider,
            fixture.candidate(RunId::new_v4()),
            &fixture.tracker,
        )
        .await
        .unwrap();
    let (exit, blank) = add_blank(&fixture).await;
    let kill = MockLifecycleGate::new();
    blank.set_kill_lifecycle_gate(kill.clone());
    let started = Arc::new(Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    fixture.status = StatusTracker::new_with_write_gate(
        fixture.home._dir.path().join("held-status.json"),
        1,
        started.clone(),
        release,
    );
    let observed = started.notified();
    let mut pending = Box::pin(fixture.rollback(&mut admission));
    tokio::select! { _ = observed => {}, _ = pending.as_mut() => panic!("status was not held") }
    drop(pending);
    kill.wait_entered(1, WAIT).await.unwrap();
    assert!(matches!(admission.resource, Resource::Transferred));
    assert_eq!(
        fixture
            .pool
            .lock()
            .await
            .status_snapshot()
            .idle_sandboxes
            .len(),
        1
    );
    let mut shutdown = Box::pin(fixture.tracker.close_and_wait());
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    exit.confirm_exit();
    kill.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (4, 16, 2));
    let mut retained = fixture.tracker.take_retained_activation_owners().unwrap();
    assert_eq!(retained.len(), 1);
    assert!(retained[0].cleanup_completed());
    let lease = retained[0].take_completed_lease().unwrap();
    assert_eq!((lease.vcpu(), lease.memory_mb()), (2, 8));
    drop(lease);
    fixture.retained().await;
}

enum ClaimFault {
    Panic,
    ReturnedRun(RunId),
}

const CLAIM_TOKEN: &str = "original-speculative-claim-token";

/// Fault injection belongs to the external provider boundary. The shared
/// healthy provider correctly rejects mismatched contexts before returning.
struct FaultProvider(ClaimFault);
#[async_trait::async_trait]
impl JobProvider for FaultProvider {
    async fn discover(&self) -> Option<JobCandidate> {
        None
    }
    async fn claim(&self, _: JobCandidate) -> Option<ClaimedJob> {
        match self.0 {
            ClaimFault::Panic => panic!("claim transport producer lost"),
            ClaimFault::ReturnedRun(run) => {
                let mut context = execution_context_for_test(run);
                context.sandbox_token = CLAIM_TOKEN.into();
                Some(
                    ClaimedJob::api(
                        run,
                        context,
                        ApiClaimTiming::new(
                            Duration::ZERO,
                            Duration::ZERO,
                            Duration::ZERO,
                            Duration::ZERO,
                            Duration::ZERO,
                            ClaimResponseAttribution::from_body_and_encoding(1, None),
                        ),
                    )
                    .unwrap(),
                )
            }
        }
    }
    async fn complete(
        &self,
        _: runner_types::types::CompleteRequest,
        _: runner_provider::CompletionAuth,
    ) {
    }
    async fn heartbeat(
        &self,
        _: &runner_types::types::HeartbeatState,
    ) -> runner_provider::ProviderResult<()> {
        Ok(())
    }
    async fn shutdown(&self) {}
}

#[tokio::test]
async fn lost_claim_producer_cannot_be_reinterpreted_as_rejection_after_receipt_take() {
    for cancelled_preparation in [false, true] {
        let (_, backing) = MockBackingProcess::channel();
        let mut fixture = Fixture::new(Some(backing), 64).await;
        let mut admission = fixture.admission.take().unwrap();
        if cancelled_preparation {
            let gate = MockLifecycleGate::new();
            fixture
                .overrides
                .set_guest_state_restore_lifecycle_gate(gate.clone());
            let mut pending = Box::pin(admission.prepare_and_claim(
                Arc::new(FaultProvider(ClaimFault::Panic)),
                fixture.candidate(RunId::new_v4()),
                &fixture.tracker,
            ));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            gate.wait_entered(1, WAIT).await.unwrap();
            drop(pending);
            // The accepted claim finishes before its caller has ever observed
            // the receipt. Taking it must still preserve sticky uncertainty.
            fixture.tracker.close_and_wait().await;
        } else {
            assert!(
                admission
                    .prepare_and_claim(
                        Arc::new(FaultProvider(ClaimFault::Panic)),
                        fixture.candidate(RunId::new_v4()),
                        &fixture.tracker,
                    )
                    .await
                    .is_err()
            );
        }
        assert!(matches!(
            admission.take_claim_response(),
            Err(MemoryOperationError::ProducerLost)
        ));
        assert!(matches!(
            fixture.rollback(&mut admission).await,
            Err(MemoryOperationError::ProducerLost)
        ));
        assert_eq!(fixture.overrides.park_call_count(), 0);
        assert!(fixture.pool.lock().await.is_empty());
        fixture.retained().await;
        fixture.tracker.close_and_wait().await;
    }
}

struct MutableBacking {
    identity: Mutex<sandbox::BackingProcessIdentity>,
    lost: std::sync::atomic::AtomicBool,
}
#[async_trait::async_trait]
impl SandboxBackingProcess for MutableBacking {
    fn identity(&self) -> sandbox::BackingProcessIdentity {
        assert!(
            !self.lost.load(std::sync::atomic::Ordering::SeqCst),
            "backing producer lost"
        );
        *self.identity.lock().unwrap()
    }
    async fn exit_confirmed(&self) -> bool {
        false
    }
}

#[tokio::test]
async fn incoming_backing_change_or_loss_during_admission_never_rebinds_the_original_generation() {
    for lost in [false, true] {
        let backing = Arc::new(MutableBacking {
            identity: Mutex::new(sandbox::BackingProcessIdentity::new_generation()),
            lost: std::sync::atomic::AtomicBool::new(false),
        });
        let mut fixture = Fixture::new(Some(backing.clone()), 64).await;
        let (provider, _) = MockJobProvider::new(CancellationToken::new());
        let mut admission = fixture.admission.take().unwrap();
        admission
            .prepare_and_claim(
                provider,
                fixture.candidate(RunId::new_v4()),
                &fixture.tracker,
            )
            .await
            .unwrap();
        let (_exit, blank) = add_blank(&fixture).await;
        let (seen, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        *fixture.source.gate.lock().unwrap() = Some((seen, wait));
        let mut pending = Box::pin(fixture.rollback(&mut admission));
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        tokio::select! { _ = observed => {}, _ = pending.as_mut() => panic!("unexpected acceptance") }
        if lost {
            backing
                .lost
                .store(true, std::sync::atomic::Ordering::SeqCst);
        } else {
            *backing.identity.lock().unwrap() = sandbox::BackingProcessIdentity::new_generation();
        }
        release.send(()).unwrap();
        assert!(pending.await.is_err());
        assert!(matches!(admission.resource, Resource::Incoming(_)));
        assert_eq!(fixture.operations.snapshot().unwrap().started, 0);
        assert_eq!(fixture.budget.allocated(), (4, 16, 2));
        assert_eq!(blank.kill_call_count(), 0);
        assert_eq!(fixture.pool.lock().await.blank_len(), 1);
        admission.require_cleanup().unwrap();
        assert!(fixture.rollback(&mut admission).await.is_err());
        assert_eq!(fixture.overrides.kill_call_count(), 0);
        assert_eq!(fixture.overrides.destroy_call_count(), 0);
        assert_eq!(
            tokio::fs::read(
                fixture
                    .home
                    .cache
                    .paths()
                    .active_home_image(&fixture.home.sandbox_id)
            )
            .await
            .unwrap(),
            test_home_image()
        );
        fixture.tracker.close_and_wait().await;
    }
}

#[tokio::test]
async fn same_key_pool_collision_refuses_restore_without_abandoning_incoming_required_home() {
    let (_, backing) = MockBackingProcess::channel();
    let mut fixture = Fixture::new(Some(backing), 64).await;
    let (provider, _) = MockJobProvider::new(CancellationToken::new());
    let mut admission = fixture.admission.take().unwrap();
    admission
        .prepare_and_claim(
            provider,
            fixture.candidate(RunId::new_v4()),
            &fixture.tracker,
        )
        .await
        .unwrap();
    let id = sandbox::SandboxId::new_v4();
    let (_, backing) = MockBackingProcess::channel();
    let other = Arc::new(MockSandboxOverrides::new());
    let lease = ResourceBudget::try_reserve_lease(&fixture.budget, 2, 8).unwrap();
    let candidate = ParkedIdleCandidateBuilder::new(&fixture.home.reuse_key, lease)
        .with_sandbox_id(id)
        .with_sandbox(Box::new(
            MockSandbox::with_overrides(id.to_string(), other.clone())
                .with_backing_process(backing),
        ))
        .build();
    assert!(matches!(
        fixture.pool.lock().await.park(candidate),
        ParkResult::Parked
    ));
    assert!(fixture.rollback(&mut admission).await.is_err());
    assert!(matches!(admission.resource, Resource::Incoming(_)));
    assert_eq!(
        fixture.pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id,
        id
    );
    assert_eq!(fixture.budget.allocated(), (4, 16, 2));
    assert_eq!(other.kill_call_count(), 0);
    assert_eq!(fixture.overrides.destroy_call_count(), 0);
    assert_eq!(
        tokio::fs::read(
            fixture
                .home
                .cache
                .paths()
                .active_home_image(&fixture.home.sandbox_id)
        )
        .await
        .unwrap(),
        test_home_image()
    );
    assert_eq!(
        HomePromotionFixture::checkout_result(&fixture.home.cache, &fixture.home.reuse_key).await,
        HomeCacheCheckoutResult::LockBusy
    );
    admission.require_cleanup().unwrap();
    assert!(matches!(admission.resource, Resource::Cleanup(_)));
}
