//! Required export after actual parked/running finalizing delivery cancellation.

use runner_lifecycle::active_runs::ActiveRuns;
use runner_lifecycle::guest_timezone::GuestTimezoneIntent;
use runner_lifecycle::home_image_cache::HomeImageLease;
use runner_lifecycle::host_memory_operations::HostMemoryOperations;
use runner_lifecycle::idle_pool::{
    ActivationCleanupOutcome, IdleParkCandidate, IdleParkOutcome, IdleParkRequest,
    IdleParkRequestParts,
};
use runner_provider::ClaimedJob;
use runner_supervisor::finalizing_admission::{
    GuardedFinalizingAdmission, GuardedFinalizingOffer, GuardedFinalizingOfferOutcome,
};
use sandbox::{Sandbox, SandboxFinalExecParkHandoffPoint};

use super::*;

pub struct Context {
    pub factory: Arc<Box<dyn SandboxFactory>>,
    pub cache: HomeImageCache,
    pub sandbox: Box<dyn Sandbox>,
    pub home: HomeImageLease,
    pub budget: Arc<ResourceBudget>,
    pub operations: HostMemoryOperations,
    pub rootfs_hash: String,
    pub run_id: RunId,
    pub sandbox_id: SandboxId,
    pub reuse_key: String,
}

struct Observer;
impl sandbox::SandboxFinalExecParkObserver for Observer {
    fn record_stage(
        &mut self,
        _: sandbox::SandboxFinalExecParkStage,
        _: std::time::Duration,
        _: bool,
    ) {
    }
}

pub async fn exercise(
    context: Context,
    inputs: &fixture::Inputs,
    running: bool,
    receipts: Option<&Arc<evidence::Case>>,
) -> TestResult<()> {
    let Context {
        factory,
        cache,
        sandbox,
        home,
        budget,
        operations,
        rootfs_hash,
        run_id,
        sandbox_id,
        reuse_key,
    } = context;
    let promotion = home
        .into_promotion_context(HomeImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: HomeCacheTerminalStatus::Success,
            completed_at: chrono::Utc::now().to_rfc3339(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .ok_or_else(|| io::Error::other("native finalizing fixture lost required home owner"))?;
    let active = ActiveRuns::new(Arc::new(Notify::new()));
    let guard = active.register(run_id, Some(reuse_key.clone()), fixture::PROFILE.into());
    let proof = active
        .finalizing_predecessor(run_id, &reuse_key, fixture::PROFILE)
        .ok_or_else(|| io::Error::other("native finalizing predecessor unavailable"))?;
    let successor = RunId::new_v4();
    let request = proof
        .request_handoff(successor)
        .ok_or_else(|| io::Error::other("native finalizing request unavailable"))?;
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096)
        .ok_or_else(|| io::Error::other("native finalizing lease unavailable"))?;
    let parked = IdleParkRequest::new(IdleParkRequestParts {
        run_id,
        sandbox,
        factory: factory.clone(),
        reuse_key: reuse_key.clone(),
        sandbox_id,
        profile_name: fixture::PROFILE.into(),
        rootfs_hash: rootfs_hash.clone(),
        device_rate_limits: None,
        budget_lease: lease,
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: StorageFingerprints::default(),
        restored_session_identity: None,
        native_generation_run_id: Some(run_id),
        guest_timezone_intent: GuestTimezoneIntent::Unknown,
        home_image_size_bytes: fixture::IMAGE_BYTES,
        home_promotion: Some(promotion),
        handoff: running.then(|| guard.reuse_publisher().handoff_signal()),
    })
    .park_for_idle_with_observer(&mut Observer)
    .await;
    let parked = match parked {
        Ok(parked) => parked,
        Err(error) => {
            if let Some(receipts) = receipts {
                receipts.retain(error);
                receipts.retain(guard);
            }
            return Err(io::Error::other("native finalizing park/preparation failed").into());
        }
    };
    let candidate = match (running, parked) {
        (false, IdleParkOutcome::Reusable(candidate)) => IdleParkCandidate::Ordinary(candidate),
        (true, IdleParkOutcome::Handoff(candidate)) => {
            if candidate.handoff_point() != SandboxFinalExecParkHandoffPoint::BeforeBalloon {
                if let Some(receipts) = receipts {
                    receipts.retain(candidate);
                    receipts.retain(guard);
                }
                return Err(io::Error::other(
                    "native finalizing handoff reached an unexpected physical boundary",
                )
                .into());
            }
            IdleParkCandidate::Immediate(candidate)
        }
        (_, outcome) => {
            if let Some(receipts) = receipts {
                receipts.retain(outcome);
                receipts.retain(guard);
            }
            return Err(io::Error::other(
                "native provider did not reach requested finalizing state",
            )
            .into());
        }
    };
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    if let Some(receipts) = receipts {
        receipts.retain(tracker.clone());
        receipts.retain(operations.clone());
    }
    let mut producer = GuardedFinalizingOffer::new(candidate, run_id, tracker.clone());
    let mut actual_context =
        runner_executor::test_fixtures::execution_context::execution_context_for_test(successor);
    actual_context.reuse_key = Some(reuse_key.clone());
    let claimed = ClaimedJob::local_with_active_input_source(successor, actual_context, None)
        .map_err(|_| io::Error::other("native finalizing claim mismatch"))?;
    let mut admission = GuardedFinalizingAdmission::new(claimed, request, run_id, tracker.clone());
    let cleanup: TestResult<()> = async {
        if producer.offer(&guard.reuse_publisher())? != GuardedFinalizingOfferOutcome::Delivered {
            return Err(io::Error::other("native finalizing delivery was refused").into());
        }
        admission.cancel_delivery();
        let mut task = admission.cleanup(&operations, inputs.envelope()).await?;
        if !matches!(
            task.join().await??,
            ActivationCleanupOutcome::Completed {
                home_cache_promoted: true
            }
        ) {
            return Err(io::Error::other("native finalizing required export incomplete").into());
        }
        tracker.close_and_wait().await;
        drop(task.take_completed_lease()?);
        Ok(())
    }
    .await;
    if let Err(error) = cleanup {
        if let Some(receipts) = receipts {
            receipts.retain(admission);
            receipts.retain(producer);
            receipts.retain(guard);
        }
        return Err(error);
    }
    drop(
        admission
            .take_claim_for_completion()
            .ok_or_else(|| io::Error::other("native finalizing original claim disappeared"))?,
    );
    drop(admission);
    drop(producer);
    if !tracker.take_retained_activation_owners()?.is_empty()
        || !tracker.take_retained_finalizing_owners()?.is_empty()
    {
        return Err(io::Error::other("native finalizing retained unresolved ownership").into());
    }
    let report = operations.close_and_wait().await?;
    assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
    assert_eq!(budget.allocated(), (0, 0, 0));
    let restore_run = RunId::new_v4();
    let restore_id = SandboxId::new_v4();
    let mut restored_home =
        fixture::checkout(&cache, restore_run, restore_id, &reuse_key, &rootfs_hash).await;
    assert!(restored_home.is_cache_hit());
    let mut restored = factory
        .create(fixture::sandbox_config(restore_id, &mut restored_home).await?)
        .await?;
    let result = async {
        restored.bind_run_control(&restore_run.to_string())?;
        restored.start().await?;
        ensure_home_drive_mounted(&*restored, restore_run)
            .await
            .map_err(|failure| failure.error)?;
        fixture::verify_saved_guest(&*restored, run_id).await
    }
    .await;
    factory.destroy(restored).await;
    result
}
