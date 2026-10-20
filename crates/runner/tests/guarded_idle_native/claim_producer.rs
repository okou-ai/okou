//! A joined producer unwind retains the exact native owner, not cleanup proof.

use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::Mutex,
    time::Duration,
};

use async_trait::async_trait;
use runner_lifecycle::home_image_cache::{
    HomeCacheCheckoutResult, HomeImageLeaseIdentity, HomeImagePrepareLockPolicy,
};
use runner_provider::{ClaimedJob, CompletionAuth, JobCandidate, JobProvider, ProviderResult};
use runner_supervisor::pre_claim_admission::GuardedSpeculativeAdmission;
use sandbox::SandboxBackingProcess;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::*;

struct Producer {
    candidate: JobCandidate,
    entered: watch::Sender<bool>,
    release: watch::Sender<bool>,
    receipt: Mutex<serde_json::Map<String, Value>>,
    unexpected_completions: Mutex<Vec<(runner_types::types::CompleteRequest, CompletionAuth)>>,
}

impl Producer {
    fn new(candidate: JobCandidate) -> Arc<Self> {
        Arc::new(Self {
            candidate,
            entered: watch::channel(false).0,
            release: watch::channel(false).0,
            receipt: Mutex::new(serde_json::Map::new()),
            unexpected_completions: Mutex::new(Vec::new()),
        })
    }

    async fn wait_entered(&self) -> TestResult<()> {
        let mut entered = self.entered.subscribe();
        while !*entered.borrow_and_update() {
            entered.changed().await?;
        }
        Ok(())
    }

    fn release(&self) {
        self.release.send_replace(true);
    }

    fn receipt(&self) -> Value {
        Value::Object(
            self.receipt
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
        )
    }
    async fn produce(&self, candidate: JobCandidate) -> TestResult<()> {
        assert_eq!(candidate.run_id(), self.candidate.run_id());
        assert_eq!(candidate.reuse_key(), self.candidate.reuse_key());
        assert_eq!(candidate.profile_name(), self.candidate.profile_name());
        assert_eq!(
            candidate.history_generation_run_id(),
            self.candidate.history_generation_run_id()
        );
        {
            let mut receipt = self
                .receipt
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert!(receipt.is_empty(), "claim producer accepted twice");
            *receipt = serde_json::Map::from_iter([
                ("run_id".into(), json!(candidate.run_id())),
                (
                    "history_run_id".into(),
                    json!(candidate.history_generation_run_id()),
                ),
                ("reuse_key".into(), json!(candidate.reuse_key())),
                ("profile".into(), json!(candidate.profile_name())),
                ("accepted_ns".into(), json!(evidence::clocks()?.0)),
                ("boundary".into(), json!("JobProvider::claim")),
                ("accepted_calls".into(), json!(1)),
            ]);
        }
        self.entered.send_replace(true);
        let mut release = self.release.subscribe();
        while !*release.borrow_and_update() {
            release.changed().await?;
        }
        self.receipt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("unwind_ns".into(), json!(evidence::clocks()?.0));
        std::panic::resume_unwind(Box::new("owned JobProvider claim producer unwind"))
    }
}

#[async_trait]
impl JobProvider for Producer {
    async fn discover(&self) -> Option<JobCandidate> {
        None
    }

    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob> {
        if let Err(error) = self.produce(candidate).await {
            self.receipt
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert("fixture_error".into(), json!(error.to_string()));
        }
        None
    }

    async fn complete(&self, request: runner_types::types::CompleteRequest, auth: CompletionAuth) {
        self.unexpected_completions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((request, auth));
        self.receipt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("unexpected_completion".into(), json!(true));
    }
    async fn heartbeat(&self, _: &runner_types::types::HeartbeatState) -> ProviderResult<()> {
        self.receipt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("unexpected_heartbeat".into(), json!(true));
        Ok(())
    }
    async fn shutdown(&self) {}
}

pub struct Request<'a> {
    pub context: transitions::Context,
    pub inputs: &'a fixture::Inputs,
    pub proof: &'a Arc<evidence::Case>,
    pub directory: &'a Path,
    pub backing: Arc<dyn SandboxBackingProcess>,
    pub history: RunId,
    pub restore: &'a Arc<claim_restore::Probe>,
    pub cancelled: bool,
    pub cache: &'a HomeImageCache,
}

async fn live(request: &Request<'_>) -> TestResult<()> {
    request.proof.require_full_lease()?;
    if request.context.budget.allocated() != (2, 4096, 1)
        || futures_util::poll!(Box::pin(request.backing.exit_confirmed()).as_mut()).is_ready()
    {
        return Err(
            io::Error::other("native producer loss released its original full owner").into(),
        );
    }
    Ok(())
}

fn home(directory: &Path, id: &str) -> TestResult<Value> {
    let path = sandbox_firecracker::FactoryPaths::new(directory.into())
        .workspace(id)
        .join("home.ext4");
    if !std::fs::symlink_metadata(&path)?.is_file() {
        return Err(io::Error::other("retained original home is not a regular file").into());
    }
    let mut file = std::fs::File::open(&path)?;
    let bytes = file.metadata()?.len();
    let mut block = [0; 1024];
    file.seek(SeekFrom::Start(1024))?;
    file.read_exact(&mut block)?;
    if bytes != fixture::IMAGE_BYTES || block[56..58] != [0x53, 0xef] {
        return Err(io::Error::other("retained original home lost its ext4 identity").into());
    }
    Ok(
        json!({"path":path,"bytes":bytes,"filesystem_uuid":hex::encode(&block[104..120]),
        "superblock_sha256":continuation::digest(&block)}),
    )
}

async fn observe(
    request: &Request<'_>,
    admission: &mut GuardedSpeculativeAdmission,
    provider: Arc<Producer>,
    probe: &mut foreground_probe::Probe,
    run: RunId,
) -> TestResult<()> {
    let context = &request.context;
    let candidate = JobCandidate::new(run, fixture::PROFILE.into())
        .with_reuse_key(Some(context.reuse_key.clone()))
        .with_history_generation_run_id(Some(request.history));
    let mut preparation =
        Box::pin(admission.prepare_and_claim(provider.clone(), candidate, &context.tracker));
    let mut completed = None;
    let mut held_pool = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        tokio::select! {
            entered = provider.wait_entered() => entered?,
            result = preparation.as_mut() => { completed = Some(result);return Err(io::Error::other("accepted producer did not remain pending").into()); }
        }
        let restored = tokio::select! {
            restored = request.restore.wait() => restored?,
            result = preparation.as_mut() => { completed = Some(result);return Err(io::Error::other("claim observation completed before held response").into()); }
        };
        // This poll also completes the synchronous Executor/owner continuation
        // after the actual restore checkpoint, leaving only the response wait.
        cleanup_progress::pending(preparation.as_mut(), &mut completed).await?;
        live(request).await?;
        request.proof.claim_producer_witness("claim_waiting",json!({
            "policy":request.inputs,"history_run_id":request.history,"claim_run_id":run,
            "reuse_key":context.reuse_key,"producer":provider.receipt(),"restore":restored,
            "preparation_polled_pending":true,"original_full_lease_active":true,
            "original_exit_polled_pending":true,"allocated":context.budget.allocated(),
        }))?;
        held_pool = Some(context.pool.lock().await);
        let pool_held_ns = evidence::clocks()?.0;
        probe.request()?;
        {
            let heartbeat = probe.complete();tokio::pin!(heartbeat);
            if futures_util::poll!(&mut heartbeat).is_ready() {
                return Err(io::Error::other("claim heartbeat ignored held pool").into());
            }
        }
        let pending_ns = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        let released_ns = evidence::clocks()?.0;
        drop(held_pool.take());
        let heartbeat = probe.complete().await?;
        cleanup_progress::pending(preparation.as_mut(),&mut completed).await?;
        live(request).await?;
        let sample_after_ns = evidence::clocks()?.0;
        let p1_sample_ns = claim_sample::wait(&std::env::current_dir()?.join("samples.jsonl"), sample_after_ns).await?;
        live(request).await?;
        request.proof.claim_producer_witness("claim_wait_progress",json!({
            "pool_held_ns":pool_held_ns,"heartbeat_pending_ns":pending_ns,"observer":observer,
            "pool_released_ns":released_ns,"heartbeat":heartbeat,
            "producer_still_held":!*provider.release.borrow(),"original_full_lease_active":true,
            "allocated":context.budget.allocated(),
            "sample_after_ns":sample_after_ns,"p1_sample_ns":p1_sample_ns,
        }))?;
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    drop(held_pool.take());
    let (cancellation_ns, release_ns) = if request.cancelled && matches!(&outcome, Ok(Ok(()))) {
        drop(preparation);
        let wait = admission.wait_for_claim();
        tokio::pin!(wait);
        if futures_util::poll!(&mut wait).is_ready() {
            provider.release();
            return Err(io::Error::other("claim-only observer was not pending").into());
        }
        (Some(evidence::clocks()?.0), evidence::clocks()?.0)
    } else {
        let released = evidence::clocks()?.0;
        provider.release();
        let result = match completed {
            Some(value) => value,
            None => preparation.as_mut().await,
        };
        drop(preparation);
        if result != Err(MemoryOperationError::ProducerLost.to_string()) {
            return Err(io::Error::other("actual native claim did not return ProducerLost").into());
        }
        (None, released)
    };
    provider.release();
    context.tracker.close_and_wait().await;
    outcome.map_err(io::Error::other)??;
    live(request).await?;
    request.proof.claim_producer_witness("producer_joined",json!({
        "cancelled":request.cancelled,"response_observer_cancelled_ns":cancellation_ns,
        "release_requested_ns":release_ns,"joined_ns":evidence::clocks()?.0,
        "producer":provider.receipt(),"tracker_joined":true,"actual_native_restore_completed":true,
        "original_full_lease_active":true,"allocated":context.budget.allocated(),
    }))?;
    Ok(())
}

pub async fn exercise(request: Request<'_>) -> TestResult<()> {
    let context = &request.context;
    let original = context.pool.lock().await.status_snapshot();
    let [entry] = original.idle_sandboxes.as_slice() else {
        return Err(io::Error::other("claim uncertainty needs one exact original").into());
    };
    let id = entry.sandbox_id.to_string();
    if !request.proof.owns(&id) || entry.reuse_key != context.reuse_key {
        return Err(io::Error::other("claim uncertainty changed original inventory").into());
    }
    let original_home = home(request.directory, &id)?;
    request.restore.arm(id.clone(), &request.backing)?;
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        request.directory,
        &context.rootfs_hash,
    )
    .await?;
    let run = RunId::new_v4();
    let candidate = JobCandidate::new(run, fixture::PROFILE.into())
        .with_reuse_key(Some(context.reuse_key.clone()))
        .with_history_generation_run_id(Some(request.history));
    let producer = Producer::new(candidate);
    request.proof.retain(producer.clone());
    let mut admission = None;
    let outcome: TestResult<MemoryOperationError> = async {
        let reserved = context.pool.lock().await.take_reserved(&context.reuse_key)
            .ok_or_else(||io::Error::other("original uncertainty reservation absent"))?;
        admission = Some(match GuardedSpeculativeAdmission::new(reserved) {
            Ok(owner)=>owner,Err(owner)=>{request.proof.retain(owner);return Err(io::Error::other("uncertainty received a running owner").into())}
        });
        let current = context.pool.lock().await.status_snapshot();
        context.status.set_idle_snapshot(current).await?;
        let owner = admission.as_mut().ok_or_else(||io::Error::other("claim uncertainty owner absent"))?;
        observe(&request,owner,producer.clone(),&mut probe,run).await?;
        let first = match owner.take_claim_response() {
            Err(error @ MemoryOperationError::ProducerLost)=>error,
            result=>{request.proof.retain(result);return Err(io::Error::other("lost claim became a response").into())}
        };
        if !matches!(owner.take_claim_response(),Err(MemoryOperationError::Consumed))
            || !matches!(owner.wait_for_claim().await,Err(MemoryOperationError::ProducerLost)) {
            return Err(io::Error::other("receipt consumption cleared claim uncertainty").into());
        }
        if let Ok(transferred) = owner.commit() {
            request.proof.retain(transferred);
            return Err(io::Error::other("uncertain claim committed").into());
        }
        for converted in [false,true] {
            if converted { owner.require_cleanup()?; }
            if !matches!(owner.rollback(&context.pool,&context.tracker,&context.status,&context.operations,
                request.inputs.envelope(),fixture::IMAGE_BYTES).await,Err(MemoryOperationError::ProducerLost)) {
                return Err(io::Error::other("uncertain claim admitted repark or cleanup").into());
            }
        }
        let attempt_run = RunId::new_v4();
        let attempt_sandbox = SandboxId::new_v4();
        let attempted = request.cache.prepare_with_lock_policy(runner_lifecycle::home_image_cache::HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity { run_id:attempt_run,sandbox_id:attempt_sandbox,profile_name:fixture::PROFILE,
                rootfs_hash:&context.rootfs_hash,reuse_key:Some(&context.reuse_key),
                working_dir:api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,image_size_bytes:fixture::IMAGE_BYTES },
            home_drive_required:true,
        },HomeImagePrepareLockPolicy::ImmediateFallback).await;
        if attempted.result()!=HomeCacheCheckoutResult::LockBusy {
            request.proof.retain(attempted);
            return Err(io::Error::other("uncertain claim released original promotion lock").into());
        }
        drop(attempted);
        live(&request).await?;
        if !context.pool.lock().await.is_empty() || home(request.directory,&id)? != original_home {
            return Err(io::Error::other("uncertain original was reused or lost its home").into());
        }
        let status:Value=serde_json::from_slice(&tokio::fs::read(request.directory.join("status.json")).await?)?;
        request.proof.claim_producer_witness("sticky_uncertainty",json!({
            "first_receipt":"ProducerLost","second_receipt":"Consumed","later_wait":"ProducerLost",
            "commit_refused":true,"rollback_refused":true,"required_cleanup_conversion_still_refused":true,
            "pool_empty":true,"promotion_lock_busy":true,"promotion_probe_run_id":attempt_run,
            "promotion_probe_sandbox_id":attempt_sandbox,"original_home":original_home,
            "published_status":status,"original_full_lease_active":true,"original_exit_polled_pending":true,
            "allocated":context.budget.allocated(),"returned_completion_authorizations":0,
            "completion_reports":0,"required_saving_complete":false,"cleanup_complete":false,
        }))?;
        Ok(first)
    }.await;
    producer.release();
    request.proof.retain(admission.take());
    context.tracker.close_and_wait().await;
    let operations = context.operations.close_and_wait().await;
    let reporting = probe.finish().await;
    let original_error = outcome?;
    reporting?;
    let operations = operations?;
    cleanup_progress::settled(&operations)?;
    live(&request).await?;
    request.proof.claim_producer_witness("uncertain_owners_retained",json!({
        "claim_producer_joined":true,"tracker_joined":true,"accounting_joined":true,
        "heartbeat_joined":true,"heartbeat_provider_joined":true,"peer_joined":true,
        "admission_retained":true,"backing_wait_retained_pending":true,
        "original_full_lease_active":true,"allocated":context.budget.allocated(),
        "accounting":cleanup_progress::accounting(&operations),"original_home":original_home,
        "original_outcome":"ProducerLost","required_saving_complete":false,"cleanup_complete":false,
        "physical_relief_proven":false,"memory_credit":false,
    }))?;
    // Preserve the actual failed receipt. The measured owner and required home
    // survive this failure; ordinary successful-case teardown is never entered.
    Err(original_error.into())
}
