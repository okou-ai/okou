//! Actual provider404, real speculative Guest rollback and joined required saving.

use std::{path::Path, time::Duration};

use runner_provider::JobProvider;
use runner_supervisor::pre_claim_admission::{
    GuardedSpeculativeAdmission, GuardedSpeculativeRollback,
};
use sandbox::SandboxBackingProcess;
use serde_json::{Value, json};

use super::cleanup_progress::{accounting, coverage, pending, settled};
use super::*;

async fn read_status(path: &Path) -> TestResult<Value> {
    if !tokio::fs::symlink_metadata(path).await?.is_file() {
        return Err(io::Error::other("claim rollback status is not a regular file").into());
    }
    Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
}

async fn live(
    context: &transitions::Context,
    proof: &evidence::Case,
    backing: &Arc<dyn SandboxBackingProcess>,
) -> TestResult<()> {
    proof.require_full_lease()?;
    if context.budget.allocated() != (2, 4096, 1)
        || futures_util::poll!(Box::pin(backing.exit_confirmed()).as_mut()).is_ready()
    {
        return Err(io::Error::other("rejected claim lost its original live full owner").into());
    }
    Ok(())
}

struct Claim<'a> {
    context: &'a transitions::Context,
    inputs: &'a fixture::Inputs,
    proof: &'a Arc<evidence::Case>,
    backing: &'a Arc<dyn SandboxBackingProcess>,
    path: &'a Path,
    initial: &'a Value,
    held_states: &'a Value,
    revision: u64,
    history: RunId,
    run: RunId,
}

async fn observe_claim(
    request: Claim<'_>,
    admission: &mut GuardedSpeculativeAdmission,
    probe: &mut foreground_probe::Probe,
    provider: Arc<dyn JobProvider>,
    gate: &claim_peer::Gate,
) -> TestResult<()> {
    let Claim {
        context,
        inputs,
        proof,
        backing,
        path,
        initial,
        held_states,
        revision,
        history,
        run,
    } = request;
    let candidate = source_candidate(run, &context.reuse_key, history)?;
    let mut preparation =
        Box::pin(admission.prepare_and_claim(provider, candidate, &context.tracker));
    let mut completed = None;
    let mut pool_hold = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        tokio::select! {
            entered = gate.wait_entered() => entered?,
            result = preparation.as_mut() => {
                completed = Some(result);
                return Err(io::Error::other("native preparation did not retain its held actual claim").into());
            }
        }
        pending(preparation.as_mut(), &mut completed).await?;
        live(context,proof,backing).await?;
        if !gate.is_held() || !context.pool.lock().await.is_empty() {
            return Err(io::Error::other("native claim was released or original published too early").into());
        }
        proof.claim_loss_witness("claim_waiting",json!({
            "policy":serde_json::to_value(inputs)?,"status_path":path,"published_status":initial,
            "selected_revision":revision,"history_run_id":history,"claim_run_id":run,
            "original_held_states":held_states,
            "request":gate.receipt()?,"claim_response_held":true,"preparation_polled_pending":true,
            "original_full_lease_active":true,"original_exit_polled_pending":true,"pool_empty":true,
            "allocated":context.budget.allocated(),
        }))?;
        pool_hold = Some(context.pool.lock().await);
        let pool_held_ns = evidence::clocks()?.0;
        probe.request()?;
        {
            let heartbeat = probe.complete(); tokio::pin!(heartbeat);
            if futures_util::poll!(&mut heartbeat).is_ready() {
                return Err(io::Error::other("claim heartbeat ignored held pool").into());
            }
        }
        let heartbeat_pending_ns = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        live(context,proof,backing).await?;
        if !gate.is_held() { return Err(io::Error::other("claim response escaped held pool").into()); }
        proof.claim_loss_witness("pool_wait_progress",json!({
            "pool_held_ns":pool_held_ns,"heartbeat_pending_ns":heartbeat_pending_ns,
            "heartbeat_polled_pending":true,"observer":observer,"claim_response_held":true,
            "original_full_lease_active":true,"allocated":context.budget.allocated(),
        }))?;
        let pool_released_ns = evidence::clocks()?.0;
        drop(pool_hold.take());
        let heartbeat = probe.complete().await?;
        pending(preparation.as_mut(),&mut completed).await?;
        live(context,proof,backing).await?;
        if !gate.is_held() { return Err(io::Error::other("claim response escaped progress wait").into()); }
        proof.claim_loss_witness("claim_wait_progress",json!({
            "pool_released_ns":pool_released_ns,"heartbeat":heartbeat,"claim_response_held":true,
            "preparation_polled_pending":true,"original_full_lease_active":true,"allocated":context.budget.allocated(),
        }))?;
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    drop(pool_hold.take());
    let released = evidence::clocks();
    gate.release();
    // Accepted HTTP and actual Guest preparation join even if observation times out.
    let prepared = match completed {
        Some(result) => result,
        None => preparation.as_mut().await,
    };
    drop(preparation);
    outcome.map_err(io::Error::other)??;
    prepared.map_err(io::Error::other)?;
    let joined_ns = evidence::clocks()?.0;
    if admission.preparation_error().is_some() {
        return Err(io::Error::other("native claim Guest preparation failed").into());
    }
    if let Ok(transferred) = admission.commit() {
        proof.retain(transferred);
        return Err(
            io::Error::other("provider404 unexpectedly committed its actual owners").into(),
        );
    }
    if let Some(claimed) = admission.take_claim_response()? {
        proof.retain(claimed);
        return Err(
            io::Error::other("provider404 unexpectedly returned a successful claim").into(),
        );
    }
    if !context.pool.lock().await.is_empty() {
        return Err(io::Error::other("provider404 transferred a claim or original Guest").into());
    }
    live(context, proof, backing).await?;
    proof.claim_loss_witness(
        "claim_rejected",
        json!({
            "response_release_requested_ns":released?.0,"preparation_joined_ns":joined_ns,
            "receipt":gate.receipt()?,"claim_unavailable":true,"commit_refused":true,
            "guest_preparation_completed":true,"pool_empty":true,"original_full_lease_active":true,
            "original_exit_polled_pending":true,"allocated":context.budget.allocated(),
        }),
    )?;
    Ok(())
}

pub(super) struct Saving<'a> {
    pub context: &'a transitions::Context,
    pub inputs: &'a fixture::Inputs,
    pub proof: &'a Arc<evidence::Case>,
    pub gate: &'a foreground_io::Gate,
    pub probe: &'a mut foreground_probe::Probe,
    pub path: &'a Path,
    pub backing: &'a Arc<dyn SandboxBackingProcess>,
    pub witness: fn(&evidence::Case, &str, Value) -> io::Result<()>,
}

pub(super) async fn save(request: Saving<'_>) -> TestResult<()> {
    let Saving {
        context,
        inputs,
        proof,
        gate,
        probe,
        path,
        backing,
        witness,
    } = request;
    let mut batch = context
        .tracker
        .start_pool_retirement_batch(
            context.pool.clone(),
            context.status.clone(),
            context.operations.clone(),
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_claim_required_saving",
            },
        )
        .await?;
    let mut completion = Box::pin(batch.join());
    let mut completed = None;
    let mut status_hold = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90),async {
        gate.wait_entered().await?;
        pending(completion.as_mut(),&mut completed).await?;
        if !backing.exit_confirmed().await { return Err(io::Error::other("claim original exit unconfirmed").into()); }
        witness(proof,"tail_blocked",json!({"original_exit_confirmed":true,
            "receiver_polled_pending":true,"coverage":coverage(context,inputs,proof,false)?}))?;
        let observer = foreground_probe::observe().await?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        pending(completion.as_mut(),&mut completed).await?;
        witness(proof,"tail_wait_progress",json!({"observer":observer,"heartbeat":heartbeat,
            "receiver_polled_pending":true,"coverage":coverage(context,inputs,proof,false)?}))?;
        status_hold = Some(context.status.hold_state_for_test().await);
        let status_held_ns = evidence::clocks()?.0;
        let mut waits = context.status.idle_snapshot_waits_for_test();
        let before = *waits.borrow_and_update();
        let io_released_ns = evidence::clocks()?.0;
        gate.release()?;
        while *waits.borrow_and_update() == before { waits.changed().await?; }
        let after = *waits.borrow();
        let status_wait_polled_ns = evidence::clocks()?.0;
        while context.operations.snapshot()?.tracked_tasks != 0 { tokio::task::yield_now().await; }
        if after != before+1 || context.budget.allocated() != (0,0,0) {
            return Err(io::Error::other("claim saving lost positive final status wait/lease release").into());
        }
        proof.require_original_lease_released()?;
        pending(completion.as_mut(),&mut completed).await?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        witness(proof,"status_wait_progress",json!({
            "status_held_ns":status_held_ns,"io_released_ns":io_released_ns,"status_wait_polled_ns":status_wait_polled_ns,
            "status_waits_before":before,"status_waits_after":after,"heartbeat":heartbeat,
            "original_lease_released":true,"receiver_polled_pending":true,
            "accounting":accounting(&context.operations.snapshot()?),"allocated":context.budget.allocated(),
        }))?;
        let status_released_ns = evidence::clocks()?.0;
        drop(status_hold.take());
        let report = completed.insert(completion.as_mut().await);
        let report = report.as_ref().map_err(|e| io::Error::other(e.to_string()))?;
        if !report.is_complete() || report.selected != 1 || report.completed != 1
            || !context.pool.lock().await.is_empty() || context.budget.allocated() != (0,0,0) {
            return Err(io::Error::other("claim original required saving did not complete").into());
        }
        witness(proof,"original_completed",json!({
            "status_released_ns":status_released_ns,"batch_joined_ns":evidence::clocks()?.0,
            "selected":report.selected,"completed":report.completed,"uncertain":report.uncertain,
            "not_started":report.not_started.len(),"status_error":report.status_error.is_some(),"is_complete":report.is_complete(),
            "published_status":read_status(path).await?,"regular_file":true,"allocated":context.budget.allocated(),
        }))?;
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    drop(status_hold.take());
    let released = gate.release();
    let joined = match completed {
        Some(result) => result,
        None => completion.await,
    };
    released?;
    joined?;
    outcome.map_err(io::Error::other)??;
    Ok(())
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    proof: &Arc<evidence::Case>,
    directory: &Path,
    backing: Arc<dyn SandboxBackingProcess>,
    history: RunId,
) -> TestResult<()> {
    exercise_failure(
        context,
        inputs,
        proof,
        directory,
        backing,
        history,
        claim_peer::Outcome::Unavailable,
    )
    .await
}

pub async fn exercise_failure(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    proof: &Arc<evidence::Case>,
    directory: &Path,
    backing: Arc<dyn SandboxBackingProcess>,
    history: RunId,
    outcome: claim_peer::Outcome,
) -> TestResult<()> {
    let initial = context.pool.lock().await.status_snapshot();
    let held_states = serde_json::to_value(context.pool.lock().await.held_sandbox_states())?;
    let [entry] = initial.idle_sandboxes.as_slice() else {
        return Err(io::Error::other("claim needs exactly original inventory").into());
    };
    if !initial.blank_sandboxes.is_empty()
        || entry.reuse_key != context.reuse_key
        || !proof.owns(&entry.sandbox_id.to_string())
    {
        return Err(io::Error::other("claim original inventory changed").into());
    }
    let old_id = entry.sandbox_id;
    let revision = initial.revision;
    context.status.set_idle_snapshot(initial).await?;
    let path = directory.join("status.json");
    let published = read_status(&path).await?;
    let io_gate = Arc::new(foreground_io::Gate::new()?);
    proof.install_foreground_io(io_gate.clone())?;
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    let run = RunId::new_v4();
    let held_claim = if outcome == claim_peer::Outcome::Unavailable {
        probe.hold_claim(run)
    } else {
        probe.hold_claim_failure(run, outcome)
    };
    let (provider, claim_gate) = match held_claim {
        Ok(value) => value,
        Err(error) => {
            probe.finish().await?;
            return Err(error);
        }
    };
    let mut admission = None;
    let outcome: TestResult<()> = async {
        let reservation = context.pool.lock().await.take_reserved(&context.reuse_key)
            .ok_or_else(||io::Error::other("claim original reservation missing"))?;
        admission = Some(match GuardedSpeculativeAdmission::new(reservation) {
            Ok(owner)=>owner,Err(owner)=>{proof.retain(owner);return Err(io::Error::other("claim received a running owner").into())}
        });
        let owner = admission.as_mut().ok_or_else(||io::Error::other("claim owner missing"))?;
        observe_claim(Claim {context:&context,inputs,proof,backing:&backing,path:&path,initial:&published,held_states:&held_states,revision,history,run},
            owner,&mut probe,provider,&claim_gate).await?;
        let started_ns = evidence::clocks()?.0;
        let result = owner.rollback(&context.pool,&context.tracker,&context.status,&context.operations,inputs.envelope(),fixture::IMAGE_BYTES).await?;
        let GuardedSpeculativeRollback::Restored(result) = result else {
            return Err(io::Error::other("native rejected claim did not repark/restore original").into());
        };
        if let Some(task) = result.retirement { proof.retain(task);return Err(io::Error::other("claim rollback replaced unrelated inventory").into()); }
        let rollback_joined_ns = evidence::clocks()?.0;
        let current = context.pool.lock().await.status_snapshot();
        if result.snapshot.revision != current.revision || current.revision <= revision
            || current.idle_sandboxes.len() != 1
            || current.idle_sandboxes.first().is_none_or(|entry| entry.sandbox_id != old_id || entry.reuse_key != context.reuse_key)
            || !current.blank_sandboxes.is_empty() {
            return Err(io::Error::other("claim rollback did not preserve exact original insertion/history").into());
        }
        live(&context,proof,&backing).await?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        if heartbeat.pointer("/receipt/state/heldSandboxStates") != Some(&held_states) {
            return Err(io::Error::other("claim rollback lost original advertised history/profile").into());
        }
        proof.claim_loss_witness("original_restored",json!({
            "rollback_started_ns":started_ns,"rollback_joined_ns":rollback_joined_ns,"revision":current.revision,
            "sandbox_id":old_id,"reuse_key":context.reuse_key,"history_run_id":history,
            "guest_preparation_completed":true,"physical_repark_completed":true,"guarded_restore_completed":true,
            "heartbeat":heartbeat,
            "published_status":read_status(&path).await?,"regular_file":true,
            "original_full_lease_active":true,"original_exit_polled_pending":true,"allocated":context.budget.allocated(),
        }))?;
        drop(admission.take());
        save(Saving {context:&context,inputs,proof,gate:&io_gate,probe:&mut probe,path:&path,backing:&backing,witness:evidence::Case::claim_loss_witness}).await
    }.await;
    claim_gate.release();
    let released = io_gate.release();
    if outcome.is_err() {
        proof.retain(admission.take());
    }
    context.tracker.close_and_wait().await;
    let operations = context.operations.close_and_wait().await;
    let reporting = probe.finish().await;
    released?;
    reporting?;
    outcome?;
    let operations = operations?;
    settled(&operations)?;
    let activation = context.tracker.take_retained_activation_owners()?;
    let finalizing = context.tracker.take_retained_finalizing_owners()?;
    if !activation.is_empty() || !finalizing.is_empty() {
        proof.retain(activation);
        proof.retain(finalizing);
        return Err(io::Error::other("claim rejection retained unresolved owners").into());
    }
    proof.claim_loss_witness(
        "producers_joined",
        json!({
            "claim_joined":true,"batch_joined":true,"tracker_joined":true,"accounting_joined":true,
            "heartbeat_joined":true,"provider_joined":true,"peer_joined":true,
            "remaining_activation_owners":0,"remaining_finalizing_owners":0,
            "allocated":context.budget.allocated(),"accounting":accounting(&operations),
        }),
    )?;
    Ok(())
}
