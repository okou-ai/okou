//! Actual producer park, broker delivery, claim and independently tracked saving.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::active_runs::{ActiveRunGuard, ActiveRuns};
use runner_lifecycle::guest_timezone::GuestTimezoneIntent;
use runner_lifecycle::home_image_cache::HomeCacheCheckoutResult;
use runner_lifecycle::home_promotion::test_support::{
    HomePromotionFixture, TEST_HOME_IMAGE_SIZE_BYTES, add_healthy_cache_preparation_matcher,
    test_home_image,
};
use runner_lifecycle::host_memory_operations::{MemoryObservationSource, MemoryOperationPolicy};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::idle_pool::{
    FinalizingHandoffState, IdleParkOutcome, IdleParkRequest, IdleParkRequestParts,
};
use runner_lifecycle::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_provider::{
    ApiClaimTiming, ClaimResponseAttribution, CompletionAuth, JobCandidate, JobProvider,
};
use runner_types::storage_fingerprints::StorageFingerprints;
use runner_types::types::{CompleteRequest, HeartbeatState};
use sandbox::{SandboxBackingProcess, SandboxFactory};
use sandbox_mock::{
    MockBackingProcess, MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides,
};
use tokio::sync::{Notify, oneshot};

use super::*;
use crate::test_fixtures::execution_context::execution_context_for_test;

const MIB: u64 = 1024 * 1024;
const WAIT: Duration = Duration::from_secs(5);
const KEY: &str = "thread:guarded-finalizing";

struct MutableBacking(Mutex<sandbox::BackingProcessIdentity>);
#[async_trait::async_trait]
impl SandboxBackingProcess for MutableBacking {
    fn identity(&self) -> sandbox::BackingProcessIdentity {
        *self.0.lock().unwrap()
    }
    async fn exit_confirmed(&self) -> bool {
        false
    }
}

struct PanicOnceBacking {
    panic_next: std::sync::atomic::AtomicBool,
    identity: Mutex<sandbox::BackingProcessIdentity>,
}
#[async_trait::async_trait]
impl SandboxBackingProcess for PanicOnceBacking {
    fn identity(&self) -> sandbox::BackingProcessIdentity {
        assert!(
            !self
                .panic_next
                .swap(false, std::sync::atomic::Ordering::SeqCst),
            "initial backing producer failed"
        );
        *self.identity.lock().unwrap()
    }
    async fn exit_confirmed(&self) -> bool {
        false
    }
}

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

/// External provider verifies the exact authorization returned by its claim.
#[derive(Default)]
struct Provider {
    completed: Mutex<Vec<(RunId, String)>>,
}
#[async_trait::async_trait]
impl JobProvider for Provider {
    async fn discover(&self) -> Option<JobCandidate> {
        None
    }
    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob> {
        let mut context = execution_context_for_test(candidate.run_id());
        context.reuse_key = candidate.reuse_key().map(str::to_owned);
        context.sandbox_token = format!("original-claim-{}", candidate.run_id());
        ClaimedJob::api(
            candidate.run_id(),
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
        .ok()
    }
    async fn complete(&self, request: CompleteRequest, auth: CompletionAuth) {
        let token = auth.into_sandbox_token(request.run_id).unwrap();
        assert_eq!(token, format!("original-claim-{}", request.run_id));
        self.completed.lock().unwrap().push((request.run_id, token));
    }
    async fn heartbeat(&self, _: &HeartbeatState) -> runner_provider::ProviderResult<()> {
        Ok(())
    }
    async fn shutdown(&self) {}
}

struct Fixture {
    _dir: Arc<tempfile::TempDir>,
    cache: runner_lifecycle::home_image_cache::HomeImageCache,
    active_image: PathBuf,
    budget: Arc<ResourceBudget>,
    overrides: Arc<MockSandboxOverrides>,
    source: Arc<Source>,
    operations: HostMemoryOperations,
    tracker: IdleDestroyTracker,
    guard: ActiveRunGuard,
    predecessor: RunId,
    run: RunId,
    offer: Option<GuardedFinalizingOffer>,
    admission: Option<GuardedFinalizingAdmission>,
    provider: Provider,
}

struct Observer;
impl sandbox::SandboxFinalExecParkObserver for Observer {
    fn record_stage(&mut self, _: sandbox::SandboxFinalExecParkStage, _: Duration, _: bool) {}
}

impl Fixture {
    async fn new(
        running: bool,
        backing: Option<Arc<dyn SandboxBackingProcess>>,
        available: u64,
    ) -> Self {
        Self::with_claim_key(running, backing, available, Some(KEY)).await
    }

    async fn with_claim_key(
        running: bool,
        backing: Option<Arc<dyn SandboxBackingProcess>>,
        available: u64,
        claim_key: Option<&str>,
    ) -> Self {
        let home = HomePromotionFixture::new(KEY).await;
        let predecessor = home.promotion.run_id();
        let run = RunId::new_v4();
        let overrides = Arc::new(MockSandboxOverrides::new());
        add_healthy_cache_preparation_matcher(&overrides);
        add_healthy_reuse_preparation_matcher(&overrides);
        let mut sandbox =
            MockSandbox::with_overrides(home.sandbox_id.to_string(), overrides.clone());
        if let Some(backing) = backing {
            sandbox = sandbox.with_backing_process(backing);
        }
        let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
            MockSandboxFactory::with_overrides(overrides.clone()),
        ));
        let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
        let active = ActiveRuns::new(Arc::new(Notify::new()));
        let guard = active.register(predecessor, Some(KEY.into()), "vm0/default".into());
        let proof = active
            .finalizing_predecessor(predecessor, KEY, "vm0/default")
            .unwrap();
        let request = proof.request_handoff(run).unwrap();
        let handoff = if running {
            overrides.push_final_exec_park_handoff_point(
                sandbox::SandboxFinalExecParkHandoffPoint::DuringDeflation,
            );
            Some(guard.reuse_publisher().handoff_signal())
        } else {
            None
        };
        let park = IdleParkRequest::new(IdleParkRequestParts {
            run_id: predecessor,
            sandbox: Box::new(sandbox),
            factory,
            reuse_key: KEY.into(),
            sandbox_id: home.sandbox_id,
            profile_name: "vm0/default".into(),
            rootfs_hash: "test-rootfs".into(),
            device_rate_limits: None,
            budget_lease: lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: StorageFingerprints::default(),
            restored_session_identity: None,
            native_generation_run_id: Some(predecessor),
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            home_image_size_bytes: TEST_HOME_IMAGE_SIZE_BYTES,
            home_promotion: Some(home.promotion),
            handoff,
        })
        .park_for_idle_with_observer(&mut Observer)
        .await
        .unwrap_or_else(|_| panic!("actual producer park"));
        let candidate = match park {
            IdleParkOutcome::Reusable(candidate) => {
                assert!(!running);
                IdleParkCandidate::Ordinary(candidate)
            }
            IdleParkOutcome::Handoff(candidate) => {
                assert!(running);
                IdleParkCandidate::Immediate(candidate)
            }
            _ => panic!("unexpected producer outcome"),
        };
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
        let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
        let provider = Provider::default();
        let claimed = provider
            .claim(
                JobCandidate::new(run, "vm0/default".into())
                    .with_reuse_key(claim_key.map(str::to_owned)),
            )
            .await
            .unwrap();
        Self {
            active_image: home.cache.paths().active_home_image(&home.sandbox_id),
            _dir: home._dir,
            cache: home.cache,
            budget,
            overrides,
            source,
            operations,
            guard,
            predecessor,
            run,
            offer: Some(GuardedFinalizingOffer::new(
                candidate,
                predecessor,
                tracker.clone(),
            )),
            admission: Some(GuardedFinalizingAdmission::new(
                claimed,
                request,
                predecessor,
                tracker.clone(),
            )),
            tracker,
            provider,
        }
    }

    fn envelope() -> IdleRetirementEnvelope {
        IdleRetirementEnvelope {
            live_growth_bytes: 8 * MIB,
            tail_growth_bytes: MIB,
        }
    }
    fn deliver(&mut self) {
        assert_eq!(
            self.offer
                .as_mut()
                .unwrap()
                .offer(&self.guard.reuse_publisher())
                .unwrap(),
            GuardedFinalizingOfferOutcome::Delivered
        );
    }
    async fn retained(&self) {
        assert_eq!(self.budget.allocated(), (2, 8, 1));
        assert_eq!(self.overrides.kill_call_count(), 0);
        assert_eq!(self.overrides.destroy_call_count(), 0);
        assert_eq!(
            tokio::fs::read(&self.active_image).await.unwrap(),
            test_home_image()
        );
        assert_eq!(
            HomePromotionFixture::checkout_result(&self.cache, KEY).await,
            HomeCacheCheckoutResult::LockBusy
        );
    }
    async fn complete(&self, claimed: ClaimedJob) {
        let before = self.provider.completed.lock().unwrap().len();
        let (context, auth, _) = claimed.into_parts();
        self.provider
            .complete(
                CompleteRequest {
                    run_id: context.run_id,
                    exit_code: 1,
                    failure_reason: None,
                    error: Some("finalizing successor cancelled".into()),
                    sandbox_id: None,
                },
                auth,
            )
            .await;
        assert_eq!(self.provider.completed.lock().unwrap().len(), before + 1);
    }
}

#[tokio::test]
async fn finalizing_real_parked_and_running_delivery_transfers_actual_claim_and_lease() {
    for running in [false, true] {
        let (_, backing) = MockBackingProcess::channel();
        let mut f = Fixture::new(running, Some(backing), 64).await;
        let expected_id = f.offer.as_ref().unwrap().owner().unwrap().sandbox_id();
        f.deliver();
        let mut admission = f.admission.take().unwrap();
        assert_eq!(admission.predecessor, f.predecessor);
        admission.receive().await.unwrap();
        assert!(matches!(
            admission.owner().unwrap().state(),
            FinalizingHandoffState::Parked | FinalizingHandoffState::Running(_)
        ));
        let activated = admission.activate().await.unwrap();
        assert_eq!(Some(activated.resource.sandbox.sandbox_id()), expected_id);
        assert_eq!(
            (
                activated.resource.budget_lease.vcpu(),
                activated.resource.budget_lease.memory_mb()
            ),
            (2, 8)
        );
        assert_eq!(activated.claimed.context().run_id, f.run);
        f.retained().await;
        f.complete(activated.claimed).await;
    }
}

#[tokio::test]
async fn finalizing_actual_claim_reuse_key_mismatch_never_unparks_original_resource() {
    for key in [None, Some("thread:another-tenant")] {
        let (_, backing) = MockBackingProcess::channel();
        let mut f = Fixture::with_claim_key(true, Some(backing), 64, key).await;
        f.deliver();
        let mut admission = f.admission.take().unwrap();
        admission.receive().await.unwrap();
        assert!(admission.activate().await.is_err());
        assert_eq!(f.overrides.unpark_call_count(), 0);
        f.retained().await;
        f.complete(admission.take_claim_for_completion().unwrap())
            .await;
    }
}

#[tokio::test]
async fn finalizing_wrong_producer_broker_retains_the_actual_original_candidate() {
    let (_, backing) = MockBackingProcess::channel();
    let mut f = Fixture::new(true, Some(backing), 64).await;
    let another = ActiveRuns::new(Arc::new(Notify::new()));
    let guard = another.register(RunId::new_v4(), Some(KEY.into()), "vm0/default".into());
    assert_eq!(
        f.offer.as_mut().unwrap().offer(&guard.reuse_publisher()),
        Err(MemoryOperationError::OwnershipInvariant)
    );
    assert!(
        !f.offer
            .as_ref()
            .unwrap()
            .owner()
            .unwrap()
            .has_captured_backing()
    );
    f.retained().await;
    f.deliver();
    f.admission.as_mut().unwrap().receive().await.unwrap();
}

#[tokio::test]
async fn finalizing_original_generation_survives_broker_and_unpark_waits() {
    for running in [false, true] {
        for activation_wait in [false, true] {
            let backing = Arc::new(MutableBacking(Mutex::new(
                sandbox::BackingProcessIdentity::new_generation(),
            )));
            let mut f = Fixture::new(running, Some(backing.clone()), 64).await;
            f.deliver();
            let mut admission = f.admission.take().unwrap();
            if activation_wait {
                admission.receive().await.unwrap();
                let gate = MockLifecycleGate::new();
                f.overrides.set_unpark_lifecycle_gate(gate.clone());
                let mut pending = Box::pin(admission.activate());
                assert!(futures_util::poll!(pending.as_mut()).is_pending());
                gate.wait_entered(1, WAIT).await.unwrap();
                *backing.0.lock().unwrap() = sandbox::BackingProcessIdentity::new_generation();
                gate.release_one();
                assert!(pending.await.is_err());
            } else {
                *backing.0.lock().unwrap() = sandbox::BackingProcessIdentity::new_generation();
                assert_eq!(
                    admission.receive().await,
                    Err(MemoryOperationError::OwnershipInvariant)
                );
            }
            assert!(
                admission
                    .cleanup(&f.operations, Fixture::envelope())
                    .await
                    .is_err()
            );
            assert_eq!(f.operations.snapshot().unwrap().started, 0);
            f.retained().await;
            f.complete(admission.take_claim_for_completion().unwrap())
                .await;
        }
    }
}

#[tokio::test]
async fn finalizing_failed_initial_backing_capture_cannot_retry_with_a_replacement() {
    let backing = Arc::new(PanicOnceBacking {
        panic_next: std::sync::atomic::AtomicBool::new(false),
        identity: Mutex::new(sandbox::BackingProcessIdentity::new_generation()),
    });
    let mut f = Fixture::new(true, Some(backing.clone()), 64).await;
    backing
        .panic_next
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let mut offer = f.offer.take().unwrap();
    assert_eq!(
        offer.offer(&f.guard.reuse_publisher()),
        Err(MemoryOperationError::ProducerLost)
    );
    *backing.identity.lock().unwrap() = sandbox::BackingProcessIdentity::new_generation();
    assert!(offer.offer(&f.guard.reuse_publisher()).is_err());
    assert!(
        offer
            .cleanup(&f.operations, Fixture::envelope())
            .await
            .is_err()
    );
    assert_eq!(
        offer.owner().unwrap().state(),
        FinalizingHandoffState::Uncertain
    );
    assert!(!offer.owner().unwrap().has_captured_backing());
    assert_eq!(f.operations.snapshot().unwrap().started, 0);
    f.retained().await;
}

#[tokio::test]
async fn finalizing_cancelled_receive_and_dropped_admission_recover_queued_real_delivery() {
    for running in [false, true] {
        let (_, backing) = MockBackingProcess::channel();
        let mut f = Fixture::new(running, Some(backing), 64).await;
        let mut admission = f.admission.take().unwrap();
        let mut wait = Box::pin(admission.receive());
        assert!(futures_util::poll!(wait.as_mut()).is_pending());
        drop(wait);
        f.deliver();
        drop(admission);
        assert!(f.tracker.take_retained_finalizing_owners().is_err());
        f.tracker.close_and_wait().await;
        let mut owners = f.tracker.take_retained_finalizing_owners().unwrap();
        assert_eq!(owners.len(), 1);
        let recovered = owners.pop().unwrap();
        assert!(matches!(
            recovered.resource,
            Some(RetainedFinalizingResource::Handoff(_))
        ));
        f.retained().await;
        f.complete(recovered.claimed.unwrap()).await;
    }
}

#[tokio::test]
async fn finalizing_mismatched_claim_and_predecessor_retain_resource_and_original_auth() {
    for prior in [false, true] {
        let (_, backing) = MockBackingProcess::channel();
        let mut f = Fixture::new(true, Some(backing), 64).await;
        f.deliver();
        let mut admission = f.admission.take().unwrap();
        admission.receive().await.unwrap();
        let original = if prior {
            admission.predecessor = RunId::new_v4();
            None
        } else {
            let other = f
                .provider
                .claim(JobCandidate::new(RunId::new_v4(), "vm0/default".into()))
                .await
                .unwrap();
            admission.claimed.replace(other)
        };
        assert!(admission.activate().await.is_err());
        assert!(admission.owner().is_some());
        f.retained().await;
        f.complete(admission.take_claim_for_completion().unwrap())
            .await;
        if let Some(original) = original {
            f.complete(original).await;
        }
    }
}

#[tokio::test]
async fn finalizing_unpark_cancellation_failure_and_panic_preserve_claim() {
    for fault in ["cancel", "error", "panic"] {
        let (_, backing) = MockBackingProcess::channel();
        let mut f = Fixture::new(true, Some(backing), 64).await;
        let gate = MockLifecycleGate::new();
        match fault {
            "cancel" => f.overrides.set_unpark_lifecycle_gate(gate.clone()),
            "error" => f
                .overrides
                .push_unpark_result(Err(sandbox::SandboxError::Start {
                    message: fault.into(),
                })),
            _ => f.overrides.push_unpark_panic(fault),
        }
        f.deliver();
        let mut admission = f.admission.take().unwrap();
        admission.receive().await.unwrap();
        if fault == "cancel" {
            let mut pending = Box::pin(admission.activate());
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            gate.wait_entered(1, WAIT).await.unwrap();
            drop(pending);
        } else {
            assert!(admission.activate().await.is_err());
        }
        assert_eq!(
            admission.owner().unwrap().state(),
            FinalizingHandoffState::Uncertain
        );
        assert_eq!(admission.claimed().unwrap().context().run_id, f.run);
        f.retained().await;
        f.complete(admission.take_claim_for_completion().unwrap())
            .await;
    }
}

#[tokio::test]
async fn finalizing_receiver_loss_retains_producer_and_failed_grants_do_no_cleanup() {
    for running in [false, true] {
        let (_, backing) = MockBackingProcess::channel();
        let mut f = Fixture::new(running, Some(backing), 0).await;
        let mut admission = f.admission.take().unwrap();
        admission.cancel_delivery();
        let mut offer = f.offer.take().unwrap();
        assert_eq!(
            offer.offer(&f.guard.reuse_publisher()).unwrap(),
            if running {
                GuardedFinalizingOfferOutcome::Undelivered
            } else {
                GuardedFinalizingOfferOutcome::NotRequested
            }
        );
        assert!(matches!(
            offer.cleanup(&f.operations, Fixture::envelope()).await,
            Err(MemoryOperationError::InsufficientHeadroom { .. })
        ));
        f.retained().await;
        drop(offer);
        f.tracker.close_and_wait().await;
        let owners = f.tracker.take_retained_finalizing_owners().unwrap();
        assert_eq!(owners.len(), 1);
        assert!(matches!(
            owners[0].resource,
            Some(RetainedFinalizingResource::RequiredCleanup(_))
        ));
        f.complete(admission.take_claim_for_completion().unwrap())
            .await;
    }
}

#[tokio::test]
async fn finalizing_lost_producer_is_sticky_uncertainty_and_missing_backing_is_retained() {
    let (_, backing) = MockBackingProcess::channel();
    let mut f = Fixture::new(false, Some(backing), 64).await;
    assert!(f.guard.reuse_publisher().publish_no_exact_sandbox());
    let mut admission = f.admission.take().unwrap();
    for _ in 0..2 {
        assert_eq!(
            admission.receive().await,
            Err(MemoryOperationError::ProducerLost)
        );
    }
    assert_eq!(admission.claimed().unwrap().context().run_id, f.run);
    f.retained().await;
    f.complete(admission.take_claim_for_completion().unwrap())
        .await;
    drop(admission);
    // Producer-loss uncertainty survives the observation owner, even when its
    // claim has already moved to the explicit completion owner.
    f.tracker.close_and_wait().await;
    let recovered = f.tracker.take_retained_finalizing_owners().unwrap();
    assert_eq!(recovered.len(), 1);
    assert!(recovered[0].delivery_uncertain);
    assert!(recovered[0].claimed.is_none());

    let mut missing = Fixture::new(true, None, 64).await;
    assert_eq!(
        missing
            .offer
            .as_mut()
            .unwrap()
            .offer(&missing.guard.reuse_publisher()),
        Err(MemoryOperationError::MissingBacking)
    );
    missing.retained().await;
}

#[tokio::test]
async fn finalizing_cancelled_admission_and_unknown_observation_retain_cleanup_and_auth() {
    for unknown in [false, true] {
        let (_, backing) = MockBackingProcess::channel();
        let mut f = Fixture::new(true, Some(backing), 64).await;
        f.deliver();
        let mut admission = f.admission.take().unwrap();
        admission.cancel_delivery();
        if unknown {
            tokio::fs::write(&f.source.path, "MemAvailable: broken kB\n")
                .await
                .unwrap();
            assert!(matches!(
                admission.cleanup(&f.operations, Fixture::envelope()).await,
                Err(MemoryOperationError::UnknownObservation(_))
            ));
        } else {
            let (seen, observed) = oneshot::channel();
            let (release, wait) = oneshot::channel();
            *f.source.gate.lock().unwrap() = Some((seen, wait));
            let mut pending = Box::pin(admission.cleanup(&f.operations, Fixture::envelope()));
            tokio::select! { result = &mut pending => { assert!(result.is_err(), "unexpected acceptance"); panic!("coverage ended before gate"); }, result = observed => result.unwrap() }
            drop(pending);
            drop(release);
        }
        f.retained().await;
        assert_eq!(admission.claimed().unwrap().context().run_id, f.run);
        drop(admission);
        f.tracker.close_and_wait().await;
        let mut owners = f.tracker.take_retained_finalizing_owners().unwrap();
        assert_eq!(owners.len(), 1);
        f.complete(owners.pop().unwrap().claimed.unwrap()).await;
    }
}

#[tokio::test]
async fn finalizing_dropped_cleanup_observer_shutdown_waits_for_required_tail_and_retains_lease() {
    for running in [false, true] {
        let (exit, backing) = MockBackingProcess::channel();
        let mut f = Fixture::new(running, Some(backing), 64).await;
        f.deliver();
        let mut admission = f.admission.take().unwrap();
        admission.cancel_delivery();
        let gate = MockLifecycleGate::new();
        f.overrides.set_destroy_lifecycle_gate(gate.clone());
        let task = admission
            .cleanup(&f.operations, Fixture::envelope())
            .await
            .unwrap();
        drop(task);
        exit.confirm_exit();
        gate.wait_entered(1, WAIT).await.unwrap();
        assert_eq!(f.budget.allocated(), (2, 8, 1));
        assert!(f.operations.snapshot().unwrap().registered_operations > 0);
        let status = runner_lifecycle::status::StatusTracker::new(
            f._dir.path().join("held-status.json"),
            1,
            None,
            None,
        );
        let status_hold = status.hold_state_for_test().await;
        let mut shutdown = Box::pin(f.tracker.close_and_wait());
        assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
        gate.release_one();
        tokio::time::timeout(WAIT, shutdown).await.unwrap();
        drop(status_hold);
        let owners = f.tracker.take_retained_activation_owners().unwrap();
        assert_eq!(owners.len(), 1);
        assert_eq!(f.operations.snapshot().unwrap().registered_operations, 0);
        assert_eq!(f.overrides.kill_call_count(), 1);
        assert_eq!(f.overrides.destroy_call_count(), 1);
        assert_ne!(
            HomePromotionFixture::checkout_result(&f.cache, KEY).await,
            HomeCacheCheckoutResult::LockBusy
        );
        f.complete(admission.take_claim_for_completion().unwrap())
            .await;
    }
}

#[tokio::test]
async fn finalizing_required_freeze_failures_and_lost_exit_retain_original_home_and_claim() {
    for fault in ["freeze_error", "freeze_panic", "exit_lost"] {
        let (exit, backing) = MockBackingProcess::channel();
        let mut f = Fixture::new(true, Some(backing), 64).await;
        match fault {
            "freeze_error" => f.overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
                pattern: "--freeze".into(),
                exit_code: 64,
                stdout: Vec::new(),
                stderr: b"required freeze rejected".to_vec(),
            }),
            "freeze_panic" => f
                .overrides
                .add_exec_panic_matcher("--freeze", "required freeze panic"),
            _ => {}
        }
        f.deliver();
        let mut admission = f.admission.take().unwrap();
        admission.cancel_delivery();
        let mut task = admission
            .cleanup(&f.operations, Fixture::envelope())
            .await
            .unwrap();
        if fault == "exit_lost" {
            drop(exit);
        } else {
            exit.confirm_exit();
        }
        assert!(matches!(
            task.join().await.unwrap().unwrap(),
            runner_lifecycle::idle_pool::ActivationCleanupOutcome::NoProgress(_)
        ));
        f.tracker.close_and_wait().await;
        let owners = f.tracker.take_retained_activation_owners().unwrap();
        assert_eq!(owners.len(), 1);
        assert_eq!(f.budget.allocated(), (2, 8, 1));
        assert_eq!(f.overrides.destroy_call_count(), 0);
        if fault != "exit_lost" {
            assert_eq!(f.overrides.kill_call_count(), 0);
        }
        assert_eq!(
            tokio::fs::read(&f.active_image).await.unwrap(),
            test_home_image()
        );
        assert_eq!(
            HomePromotionFixture::checkout_result(&f.cache, KEY).await,
            HomeCacheCheckoutResult::LockBusy
        );
        assert_eq!(f.operations.close_and_wait().await.unwrap().uncertain, 2);
        f.complete(admission.take_claim_for_completion().unwrap())
            .await;
    }
}
