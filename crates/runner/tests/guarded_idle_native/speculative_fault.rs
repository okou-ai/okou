//! Cancel/unwind a borrowed restore callback after joined actual Guest RPC.

use std::{path::Path, time::Duration};

use runner_lifecycle::{
    guest_timezone::GuestTimezoneIntent,
    idle_pool::{
        ActivationCleanupOutcome, GuardedSpeculativeIdleOwner, SpeculativeActivationState,
    },
};
use runner_supervisor::idle_lifecycle::GuardedActivationCleanupTask;
use sandbox::SandboxBackingProcess;
use serde_json::{Value, json};
use tokio::sync::{oneshot, watch};

use super::cleanup_progress::{accounting, coverage, pending, settled};
use super::*;

#[derive(Clone, Copy)]
pub(super) enum Injection {
    Callback(bool),
    Native(super::native_unpark::Fault),
    NativePause(super::native_pause::Fault),
}

impl Injection {
    fn witness(self, proof: &evidence::Case, phase: &str, value: Value) -> io::Result<()> {
        match self {
            Self::Callback(_) => proof.speculative_fault_witness(phase, value),
            Self::Native(_) => proof.unpark_witness(phase, value),
            Self::NativePause(_) => proof.pause_witness(phase, value),
        }
    }
}

pub(super) async fn live(
    context: &transitions::Context,
    proof: &evidence::Case,
    backing: &Arc<dyn SandboxBackingProcess>,
) -> TestResult<()> {
    proof.require_full_lease()?;
    if context.budget.allocated() != (2, 4096, 1)
        || futures_util::poll!(Box::pin(backing.exit_confirmed()).as_mut()).is_ready()
    {
        return Err(io::Error::other("speculative fault lost original live full owner").into());
    }
    Ok(())
}

async fn inject(
    context: &transitions::Context,
    proof: &evidence::Case,
    backing: &Arc<dyn SandboxBackingProcess>,
    owner: &mut GuardedSpeculativeIdleOwner,
    history: RunId,
    panic: bool,
) -> TestResult<()> {
    let witness = |phase, value| proof.speculative_fault_witness(phase, value);
    let operation = RunId::new_v4();
    let (entered, mut receipt) = oneshot::channel();
    let (release, mut released) = watch::channel(false);
    let started_ns = evidence::clocks()?.0;
    let mut preparation = Box::pin(owner.prepare(operation, move |sandbox, _, _| {
        Box::pin(async move {
            runner_executor::executor::restore_guest_state_with_timezone(sandbox, "UTC")
                .await
                .map_err(|error| error.to_string())?;
            let digest = fixture::verify_speculative_guest(sandbox, history)
                .await
                .map_err(|error| error.to_string())?;
            let rpc_completed_ns = evidence::clocks().map_err(|error| error.to_string())?.0;
            entered
                .send((rpc_completed_ns, digest))
                .map_err(|_| "speculative callback observer disappeared")?;
            while !*released.borrow_and_update() {
                released
                    .changed()
                    .await
                    .map_err(|error| error.to_string())?;
            }
            std::panic::resume_unwind(Box::new("owned native restore callback panic"));
        })
    }));
    let mut completed = None;
    let outcome: TestResult<()> = async {
        let (rpc_completed_ns, digest) = tokio::time::timeout(Duration::from_secs(90), async {
            tokio::select! {
                entered = &mut receipt => Ok::<_,Box<dyn Error+Send+Sync>>(entered.map_err(io::Error::other)?),
                result = preparation.as_mut() => {
                    completed = Some(result);
                    Err(io::Error::other("speculative restore completed before callback release").into())
                }
            }
        })
        .await??;
        pending(preparation.as_mut(), &mut completed).await?;
        live(context, proof, backing).await?;
        if !context.pool.lock().await.is_empty() {
            return Err(io::Error::other("pending speculative resource was published").into());
        }
        witness("callback_waiting", json!({
            "mode":if panic {"panic"} else {"drop"}, "history_run_id":history,
            "operation_run_id":operation,"reuse_key":context.reuse_key,
            "prepare_started_ns":started_ns,"rpc_completed_ns":rpc_completed_ns,
            "payload_sha256":digest,"payload_bytes":fixture::PAYLOAD_BYTES,
            "production_restore_completed":true,"private_marker_verified":true,
            "ordinary_home_verified":true,"callback_polled_pending":true,
            "callback_release_withheld":true,"pool_empty":true,
            "original_full_lease_active":true,"original_exit_polled_pending":true,
            "allocated":context.budget.allocated(),
        }))?;
        Ok(())
    }.await;
    let failure_requested_ns = evidence::clocks();
    if panic && outcome.is_ok() {
        release.send_replace(true);
        let result = match completed.take() {
            Some(result) => result,
            None => preparation.as_mut().await,
        };
        completed = Some(result);
    }
    // This is the deliberate callback cancellation, not a timeout-as-success.
    drop(preparation);
    release.send_replace(true);
    outcome?;
    if panic
        && completed
            .as_ref()
            .and_then(|value| value.as_ref().err())
            .map(String::as_str)
            != Some("speculative preparation panicked")
    {
        return Err(io::Error::other("native callback panic was not caught by its owner").into());
    }
    if owner.state() != SpeculativeActivationState::Uncertain
        || !owner.matches_claim(Some(&context.reuse_key), Some(history), fixture::PROFILE)
    {
        return Err(
            io::Error::other("callback loss did not preserve original uncertain owner").into(),
        );
    }
    live(context, proof, backing).await?;
    if let Ok(transferred) = owner.commit(operation, &GuestTimezoneIntent::Default) {
        proof.retain(transferred);
        return Err(io::Error::other("uncertain native preparation committed").into());
    }
    if owner.repark(fixture::IMAGE_BYTES).await.is_ok() {
        return Err(io::Error::other("uncertain native preparation reparks as verified").into());
    }
    if let Ok(incoming) = owner.take_incoming() {
        proof.retain(incoming);
        return Err(io::Error::other("uncertain native preparation became inventory").into());
    }
    witness(
        "preparation_lost",
        json!({
            "failure_requested_ns":failure_requested_ns?.0,"failure_joined_ns":evidence::clocks()?.0,
            "mode":if panic {"panic"} else {"drop"},"panic_caught":panic,
            "state":"Uncertain","commit_refused":true,"repark_refused":true,"incoming_refused":true,
            "original_metadata_preserved":true,"original_full_lease_active":true,
            "original_exit_polled_pending":true,"pool_empty":context.pool.lock().await.is_empty(),
            "allocated":context.budget.allocated(),
        }),
    )?;
    Ok(())
}

async fn read_status(path: &Path) -> TestResult<Value> {
    if !tokio::fs::symlink_metadata(path).await?.is_file() {
        return Err(io::Error::other("speculative status is not a regular file").into());
    }
    Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
}

async fn save(
    context: &transitions::Context,
    inputs: &fixture::Inputs,
    receipt: (&evidence::Case, Injection),
    gate: &foreground_io::Gate,
    probe: &mut foreground_probe::Probe,
    task: &mut GuardedActivationCleanupTask,
    path: &Path,
) -> TestResult<()> {
    let (proof, injection) = receipt;
    let witness = |phase, value| injection.witness(proof, phase, value);
    let mut completion = Box::pin(task.join());
    let mut completed = None;
    let mut pool_hold = None;
    let mut status_hold = None;
    let mut io_released_ns = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        gate.wait_entered().await?;
        pending(completion.as_mut(), &mut completed).await?;
        proof.join_exit().await?;
        witness("tail_blocked", json!({
            "original_exit_confirmed":true,"receiver_polled_pending":true,"coverage":coverage(context,inputs,proof,false)?,
        }))?;
        pool_hold = Some(context.pool.lock().await);
        let pool_held_ns = evidence::clocks()?.0;
        status_hold = Some(context.status.hold_state_for_test().await);
        let status_held_ns = evidence::clocks()?.0;
        probe.request()?;
        {
            let heartbeat = probe.complete(); tokio::pin!(heartbeat);
            if futures_util::poll!(&mut heartbeat).is_ready() {
                return Err(io::Error::other("speculative heartbeat ignored held pool").into());
            }
        }
        let heartbeat_pending_ns = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        witness("pool_wait_progress", json!({
            "pool_held_ns":pool_held_ns,"status_held_ns":status_held_ns,
            "heartbeat_pending_ns":heartbeat_pending_ns,"heartbeat_polled_pending":true,
            "observer":observer,"coverage":coverage(context,inputs,proof,false)?,
        }))?;
        let pool_released_ns = evidence::clocks()?.0;
        drop(pool_hold.take());
        let heartbeat = probe.complete().await?;
        pending(completion.as_mut(), &mut completed).await?;
        witness("tail_wait_progress", json!({
            "pool_released_ns":pool_released_ns,"status_held_ns":status_held_ns,
            "heartbeat":heartbeat,"receiver_polled_pending":true,
            "coverage":coverage(context,inputs,proof,false)?,
        }))?;
        io_released_ns = Some(evidence::clocks()?.0);
        gate.release()?;
        completed = Some(completion.as_mut().await);
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    drop(pool_hold.take());
    let released = gate.release();
    let joined = match completed {
        Some(result) => result,
        None => completion.as_mut().await,
    };
    drop(completion);
    let checked: TestResult<()> = async {
        released?;
        if !matches!(
            joined??,
            ActivationCleanupOutcome::Completed {
                home_cache_promoted: true
            }
        ) {
            return Err(io::Error::other("speculative original required saving incomplete").into());
        }
        drop(task.take_completed_lease()?);
        proof.require_original_lease_released()?;
        outcome.map_err(io::Error::other)??;
        context.tracker.close_and_wait().await;
        let operations = context.operations.close_and_wait().await?;
        settled(&operations)?;
        if context.budget.allocated() != (0, 0, 0) || !context.pool.lock().await.is_empty() {
            return Err(io::Error::other("speculative saving left resources").into());
        }
        witness("saving_joined", json!({
            "io_released_ns":io_released_ns.ok_or_else(||io::Error::other("IO release absent"))?,
            "saving_joined_ns":evidence::clocks()?.0,"home_cache_promoted":true,
            "original_lease_released":true,"allocated":context.budget.allocated(),
            "accounting":accounting(&operations),
        }))?;
        Ok(())
    }
    .await;
    if let Err(error) = checked {
        drop(status_hold.take());
        return Err(error);
    }
    let snapshot = context.pool.lock().await.status_snapshot();
    let mut waits = context.status.idle_snapshot_waits_for_test();
    let before = *waits.borrow_and_update();
    let mut publication = Box::pin(context.status.set_idle_snapshot(snapshot));
    let mut published = None;
    let outcome = tokio::time::timeout(Duration::from_secs(30), async {
        pending(publication.as_mut(), &mut published).await?;
        let after = *waits.borrow_and_update();
        let polled_ns = evidence::clocks()?.0;
        if after != before+1 {
            return Err(io::Error::other("speculative status wait was not observed").into());
        }
        probe.request()?;
        let heartbeat = probe.complete().await?;
        witness("status_wait_progress", json!({
            "status_wait_polled_ns":polled_ns,"status_waits_before":before,"status_waits_after":after,
            "heartbeat":heartbeat,"publication_polled_pending":true,"allocated":context.budget.allocated(),
        }))?;
        Ok::<(),Box<dyn Error+Send+Sync>>(())
    }).await;
    let status_released_ns = evidence::clocks();
    drop(status_hold.take());
    let publication = match published {
        Some(result) => result,
        None => publication.await,
    };
    publication?;
    outcome.map_err(io::Error::other)??;
    witness(
        "status_published",
        json!({
            "status_released_ns":status_released_ns?.0,"publication_joined_ns":evidence::clocks()?.0,
            "published_status":read_status(path).await?,"regular_file":true,"allocated":context.budget.allocated(),
        }),
    )?;
    Ok(())
}

pub(super) async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    proof: &Arc<evidence::Case>,
    directory: &Path,
    backing: Arc<dyn SandboxBackingProcess>,
    history: RunId,
    injection: Injection,
) -> TestResult<()> {
    let witness = |phase, value| injection.witness(proof, phase, value);
    let initial = context.pool.lock().await.status_snapshot();
    context.status.set_idle_snapshot(initial).await?;
    let path = directory.join("status.json");
    witness(
        "inputs_verified",
        json!({
            "policy":serde_json::to_value(inputs)?,"status_path":path,
            "published_status":read_status(&path).await?,"regular_file":true,
        }),
    )?;
    let gate = Arc::new(foreground_io::Gate::new()?);
    proof.install_foreground_io(gate.clone())?;
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    let mut speculative = None;
    let mut cleanup = None;
    let mut task = None;
    let mut native_hold = None;
    let outcome: TestResult<()> = async {
        let reservation = context
            .pool
            .lock()
            .await
            .take_reserved(&context.reuse_key)
            .ok_or_else(|| io::Error::other("speculative original absent"))?;
        let sandbox_id = reservation.sandbox_id().to_string();
        speculative = Some(match GuardedSpeculativeIdleOwner::new(reservation) {
            Ok(owner) => owner,
            Err(owner) => {
                proof.retain(owner);
                return Err(io::Error::other("speculative original running").into());
            }
        });
        let owner = speculative
            .as_mut()
            .ok_or_else(|| io::Error::other("speculative capsule absent"))?;
        match injection {
            Injection::Callback(panic) => {
                inject(&context, proof, &backing, owner, history, panic).await?
            }
            Injection::Native(fault) | Injection::NativePause(fault) => {
                let transition = if matches!(injection, Injection::NativePause(_)) {
                    sandbox_firecracker::api_request_gate::Transition::Pause
                } else {
                    sandbox_firecracker::api_request_gate::Transition::Resume
                };
                native_hold = Some(native_transition::Hold::new(sandbox_id, transition)?);
                native_transition::inject(
                    &context,
                    proof,
                    &backing,
                    owner,
                    history,
                    fault,
                    native_hold
                        .as_mut()
                        .ok_or_else(|| io::Error::other("native gate custody absent"))?,
                )
                .await?;
            }
        }
        if let (Injection::Native(fault) | Injection::NativePause(fault), Some(hold)) =
            (injection, native_hold.as_mut())
        {
            hold.finish(&context, proof, &backing, owner, &mut probe, fault)
                .await?;
        }
        cleanup = Some(owner.take_cleanup_owner()?);
        task = Some(
            context
                .tracker
                .retire_activation_owner(
                    &mut cleanup,
                    &context.operations,
                    inputs.envelope(),
                    "native_speculative_cancellation",
                )
                .await?,
        );
        let task = task
            .as_mut()
            .ok_or_else(|| io::Error::other("speculative cleanup observer absent"))?;
        save(
            &context,
            inputs,
            (proof.as_ref(), injection),
            &gate,
            &mut probe,
            task,
            &path,
        )
        .await
    }
    .await;
    let released = gate.release();
    if outcome.is_err() {
        proof.retain(speculative.take());
        proof.retain(cleanup.take());
        proof.retain(task.take());
    }
    let native_join = match native_hold.as_mut() {
        Some(hold) => hold.close().await,
        None => Ok(()),
    };
    if native_join.is_err() {
        proof.retain(native_hold.take());
    }
    context.tracker.close_and_wait().await;
    let operations = context.operations.close_and_wait().await;
    let reporting = probe.finish().await;
    released?;
    reporting?;
    outcome?;
    native_join?;
    let operations = operations?;
    settled(&operations)?;
    let activation = context.tracker.take_retained_activation_owners()?;
    let finalizing = context.tracker.take_retained_finalizing_owners()?;
    if !activation.is_empty() || !finalizing.is_empty() {
        proof.retain(activation);
        proof.retain(finalizing);
        return Err(io::Error::other("speculative callback retained unresolved owners").into());
    }
    witness(
        "producers_joined",
        json!({
            "tracker_joined":true,"accounting_joined":true,"heartbeat_joined":true,
            "provider_joined":true,"peer_joined":true,"remaining_activation_owners":0,
            "remaining_finalizing_owners":0,"allocated":context.budget.allocated(),
            "accounting":accounting(&operations),
        }),
    )?;
    Ok(())
}
