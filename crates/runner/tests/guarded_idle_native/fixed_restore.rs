//! Genuine fixed restore loss preserves failed cleanup and complete original custody.

use std::{panic::AssertUnwindSafe, path::Path, sync::Mutex, time::Duration};

use guest_control_client::test_support::{
    ConnectionScope,
    request_gate::{
        self, ConnectionProducer, Controls, ExchangeProducer, Frame, RequestKind,
        ResponseDisposition,
    },
};
use guest_control_proto::{
    ExecTermination, MSG_GUEST_STATE_RESTORE, MSG_GUEST_STATE_RESTORE_RESULT,
};
use runner_lifecycle::{
    guest_timezone::GuestTimezoneIntent,
    home_image_cache::{
        HomeCacheCheckoutResult, HomeImageLeaseIdentity, HomeImagePrepareLockPolicy,
    },
    idle_pool::{
        ActivationCleanupOutcome, GuardedSpeculativeIdleOwner, SpeculativeActivationState,
    },
};
use sandbox::SandboxBackingProcess;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Selection {
    terminal: bool,
    fault: native_unpark::Fault,
    pub restored: bool,
}

impl Selection {
    pub fn label(self) -> String {
        format!(
            "FixedRestore-{}-{}",
            if self.terminal { "terminal" } else { "capture" },
            match self.fault {
                native_unpark::Fault::Drop => "drop",
                native_unpark::Fault::ObserverUnwind => "observer-unwind",
                native_unpark::Fault::ProducerUnwind => "producer-unwind",
            }
        )
    }
}

type Bundle = (Controls, ExchangeProducer, ConnectionProducer);

pub(super) struct Probe {
    pub scope: ConnectionScope,
    bundle: Arc<Mutex<Option<Bundle>>>,
}

impl Probe {
    pub fn new(id: String) -> io::Result<Self> {
        let bundle = Arc::new(Mutex::new(None));
        let retained = bundle.clone();
        let scope = ConnectionScope::new(id, move |guest| {
            let (client, host) = tokio::net::UnixStream::pair()?;
            let mut owner = retained
                .lock()
                .map_err(|_| io::Error::other("fixed stream owner poisoned"))?;
            if owner.is_some() {
                return Err(io::Error::other("fixed stream already attached"));
            }
            *owner = Some(request_gate::gate_connection(host, guest));
            Ok(client)
        })?;
        Ok(Self { scope, bundle })
    }

    fn take(&self) -> io::Result<Hold> {
        let (mut controls, exchange, connection) = self
            .bundle
            .lock()
            .map_err(|_| io::Error::other("fixed stream owner poisoned"))?
            .take()
            .ok_or_else(|| {
                io::Error::other("genuine startup listener did not attach fixed controls")
            })?;
        controls.arm(RequestKind::GuestStateRestore)?;
        Ok(Hold {
            captured: controls.captured,
            dispatch: Some(controls.dispatch),
            response: controls.response,
            delivery: Some(controls.delivery),
            exchange,
            connection,
        })
    }
}

struct Hold {
    captured: oneshot::Receiver<Frame>,
    dispatch: Option<oneshot::Sender<()>>,
    response: oneshot::Receiver<Frame>,
    delivery: Option<oneshot::Sender<ResponseDisposition>>,
    exchange: ExchangeProducer,
    connection: ConnectionProducer,
}

pub(super) struct Request<'a> {
    pub context: transitions::Context,
    pub inputs: &'a fixture::Inputs,
    pub proof: &'a Arc<evidence::Case>,
    pub directory: &'a Path,
    pub backing: Arc<dyn SandboxBackingProcess>,
    pub history: RunId,
    pub selection: Selection,
    pub cache: &'a HomeImageCache,
    pub probe: &'a Probe,
}

#[derive(Debug, thiserror::Error)]
#[error("fixed restore retains original uncertainty; required saving is incomplete")]
struct FixedRestoreUncertain;

pub(super) async fn session_file(
    sandbox: &dyn sandbox::Sandbox,
    thread: &str,
) -> TestResult<Value> {
    uuid::Uuid::parse_str(thread)?;
    let command = format!(
        "python3 -I -c {}",
        shell_quote::quote_shell_arg(&format!(
            "import pathlib; files=list(pathlib.Path('/home/user/.codex/sessions/2026/06/04').glob('*{thread}.jsonl*')); assert len(files)==1; print(files[0])"
        ))
    );
    let path = fixture::exec(sandbox, &command).await?;
    let path = std::str::from_utf8(&path)?.trim();
    let data = sandbox
        .read_file(path, 4 * 1024 * 1024)
        .await?
        .ok_or_else(|| io::Error::other("original complete history file disappeared"))?;
    Ok(
        json!({"path":path,"bytes":data.len(),"sha256":continuation::digest(&data),"raw_hex":hex::encode(data)}),
    )
}

fn frame(frame: &Frame) -> Value {
    json!({"message_type":frame.message_type(),"sequence":frame.sequence(),
        "raw_hex":hex::encode(frame.raw()),"sha256":continuation::digest(frame.raw())})
}

async fn live(request: &Request<'_>) -> TestResult<()> {
    speculative_fault::live(&request.context, request.proof, &request.backing).await?;
    if let Some(lease) = ResourceBudget::try_reserve_lease(&request.context.budget, 2, 4096) {
        request.proof.retain(lease);
        return Err(io::Error::other("fixed restore lost original no-headroom lease").into());
    }
    Ok(())
}

async fn lose(
    request: &Request<'_>,
    owner: &mut GuardedSpeculativeIdleOwner,
    hold: &mut Hold,
    probe: &mut foreground_probe::Probe,
) -> TestResult<()> {
    let witness = |phase, value| request.proof.fixed_restore_witness(phase, value);
    let operation = RunId::new_v4();
    let started = evidence::clocks()?.0;
    let mut preparation = Box::pin(owner.prepare(operation, |sandbox, _, _| {
        Box::pin(async move {
            runner_executor::executor::restore_guest_state_with_timezone(sandbox, "UTC")
                .await
                .map_err(|error| error.to_string())
        })
    }));
    let captured = tokio::time::timeout(Duration::from_secs(90),async {
        tokio::select! {
            captured = &mut hold.captured => Ok::<_,io::Error>(captured.map_err(io::Error::other)?),
            result = preparation.as_mut() => Err(io::Error::other(format!("fixed prepare preceded capture: {result:?}"))),
        }
    }).await??;
    if captured.message_type() != MSG_GUEST_STATE_RESTORE || captured.sequence() == 0 {
        return Err(io::Error::other("captured another Guest operation").into());
    }
    let payload = captured
        .raw()
        .get(guest_control_proto::HEADER_SIZE + guest_control_proto::MIN_BODY_SIZE..)
        .ok_or_else(|| io::Error::other("fixed request header truncated"))?;
    let decoded = guest_control_proto::decode_guest_state_restore_request(payload)?;
    if decoded.entropy.len() != 256
        || decoded.timezone != guest_control_proto::GuestStateRestoreTimezone::Required("UTC")
    {
        return Err(io::Error::other("fixed helper input substituted").into());
    }
    live(request).await?;
    witness(
        "request_captured",
        json!({"history_run_id":request.history,"operation_run_id":operation,
        "prepare_started_ns":started,"request":frame(&captured),"backend_dispatched":false,
        "canonical_fixed_helper":true,"original_full_lease_active":true,"allocated":request.context.budget.allocated()}),
    )?;
    let mut terminal = None;
    if request.selection.terminal {
        hold.dispatch
            .take()
            .ok_or_else(|| io::Error::other("dispatch missing"))?
            .send(())
            .map_err(|_| io::Error::other("fixed dispatch producer lost"))?;
        let response = tokio::time::timeout(Duration::from_secs(90),async {
            tokio::select! {
                response = &mut hold.response => Ok::<_,io::Error>(response.map_err(io::Error::other)?),
                result = preparation.as_mut() => Err(io::Error::other(format!("fixed prepare passed held terminal: {result:?}"))),
            }
        }).await??;
        terminal = Some(response);
    }
    let mut completed = None;
    cleanup_progress::pending(preparation.as_mut(), &mut completed).await?;
    witness(
        "observation_waiting",
        json!({"boundary":if request.selection.terminal {"terminal"} else {"capture"},
        "request":frame(&captured),"response":terminal.as_ref().map(frame),"public_restore_polled_pending":true,
        "running_helper_observed":false,"original_full_lease_active":true,"allocated":request.context.budget.allocated()}),
    )?;
    let lost = evidence::clocks()?.0;
    if request.selection.fault == native_unpark::Fault::ObserverUnwind {
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(move || {
                let _observation = preparation;
                std::panic::resume_unwind(Box::new("borrowed fixed restore observation unwound"));
            }))
            .is_err()
        );
    } else {
        drop(preparation);
    }
    if owner.state() != SpeculativeActivationState::Uncertain
        || !owner.matches_claim(
            Some(&request.context.reuse_key),
            Some(request.history),
            fixture::PROFILE,
        )
    {
        return Err(io::Error::other("fixed loss changed original capsule metadata").into());
    }
    if let Ok(resource) = owner.commit(operation, &GuestTimezoneIntent::Default) {
        request.proof.retain(resource);
        return Err(io::Error::other("fixed loss committed").into());
    }
    if owner.repark(fixture::IMAGE_BYTES).await.is_ok() {
        return Err(io::Error::other("fixed loss reparks").into());
    }
    if let Ok(incoming) = owner.take_incoming() {
        request.proof.retain(incoming);
        return Err(io::Error::other("fixed loss became inventory").into());
    }
    live(request).await?;
    witness(
        "observation_lost",
        json!({"lost_ns":lost,"observer_unwound":request.selection.fault==native_unpark::Fault::ObserverUnwind,
        "state":"Uncertain","commit_refused":true,"repark_refused":true,"incoming_refused":true,
        "original_metadata_preserved":true,"pool_empty":request.context.pool.lock().await.is_empty(),
        "original_full_lease_active":true,"original_exit_polled_pending":true,"allocated":request.context.budget.allocated()}),
    )?;
    let pool = request.context.pool.lock().await;
    let held = evidence::clocks()?.0;
    let status = request.context.status.hold_state_for_test().await;
    let status_held = evidence::clocks()?.0;
    let mut waits = request.context.status.idle_snapshot_waits_for_test();
    let waits_before = *waits.borrow_and_update();
    let mut publication = Box::pin(
        request
            .context
            .status
            .set_idle_snapshot(pool.status_snapshot()),
    );
    let mut published = None;
    cleanup_progress::pending(publication.as_mut(), &mut published).await?;
    let waits_after = *waits.borrow_and_update();
    let status_wait_polled_ns = evidence::clocks()?.0;
    if waits_after != waits_before + 1 {
        return Err(
            io::Error::other("fixed status publication did not contend on held state").into(),
        );
    }
    probe.request()?;
    {
        let completion = probe.complete();
        tokio::pin!(completion);
        if futures_util::poll!(completion.as_mut()).is_ready() {
            return Err(io::Error::other("fixed heartbeat ignored held pool").into());
        }
    }
    let pending = evidence::clocks()?.0;
    let observer = foreground_probe::observe().await?;
    drop(pool);
    let released = evidence::clocks()?.0;
    let heartbeat = probe.complete().await?;
    drop(status);
    let status_released = evidence::clocks()?.0;
    publication.await?;
    let status_published_ns = evidence::clocks()?.0;
    let sample_after_ns = evidence::clocks()?.0;
    let p1_sample_ns = claim_sample::wait(
        &std::env::current_dir()?.join("samples.jsonl"),
        sample_after_ns,
    )
    .await?;
    live(request).await?;
    witness(
        "late_wait_progress",
        json!({"pool_held_ns":held,"status_held_ns":status_held,
        "heartbeat_pending_ns":pending,"observer":observer,"pool_released_ns":released,
        "heartbeat":heartbeat,"status_released_ns":status_released,
        "status_wait_polled_ns":status_wait_polled_ns,"status_waits_before":waits_before,
        "status_waits_after":waits_after,"status_published_ns":status_published_ns,
        "sample_after_ns":sample_after_ns,"p1_sample_ns":p1_sample_ns,
        "selected_delivery_withheld":true,"additional_full_profile_refused":true,
        "original_full_lease_active":true,"allocated":request.context.budget.allocated()}),
    )?;
    if let Some(dispatch) = hold.dispatch.take() {
        dispatch
            .send(())
            .map_err(|_| io::Error::other("fixed dispatch lost"))?;
    }
    let response = match terminal {
        Some(response) => response,
        None => tokio::time::timeout(Duration::from_secs(90), &mut hold.response).await??,
    };
    if response.message_type() != MSG_GUEST_STATE_RESTORE_RESULT
        || response.sequence() != captured.sequence()
    {
        return Err(io::Error::other("real fixed helper terminal missing").into());
    }
    let payload = response
        .raw()
        .get(guest_control_proto::HEADER_SIZE + guest_control_proto::MIN_BODY_SIZE..)
        .ok_or_else(|| io::Error::other("fixed result header truncated"))?;
    let decoded = guest_control_proto::decode_guest_state_restore_result(payload)?;
    if decoded.termination != (ExecTermination::Exited { exit_code: 0 })
        || !decoded.diagnostic.is_empty()
        || !matches!(
            decoded.stderr,
            guest_control_proto::ExecCapturedOutput::Captured {
                truncated: false,
                ..
            }
        )
    {
        return Err(io::Error::other("real canonical helper did not complete successfully").into());
    }
    let producer_unwind = request.selection.fault == native_unpark::Fault::ProducerUnwind;
    let delivered = evidence::clocks()?.0;
    hold.delivery
        .take()
        .ok_or_else(|| io::Error::other("delivery absent"))?
        .send(if producer_unwind {
            ResponseDisposition::UnwindAfterDelivery
        } else {
            ResponseDisposition::Deliver
        })
        .map_err(|_| io::Error::other("fixed response producer lost"))?;
    let exchange = hold.exchange.join().await;
    if producer_unwind {
        if exchange.is_ok() {
            return Err(io::Error::other("unwound exchange claimed success").into());
        }
        let failure = hold
            .connection
            .join()
            .await
            .err()
            .ok_or_else(|| io::Error::other("fixed relay failed to unwind"))?;
        if !failure
            .get_ref()
            .and_then(|error| error.downcast_ref::<tokio::task::JoinError>())
            .is_some_and(tokio::task::JoinError::is_panic)
        {
            return Err(
                io::Error::other("fixed producer failure was not the requested unwind").into(),
            );
        }
    } else {
        let exchange = exchange?;
        if exchange.request != captured || exchange.response != response {
            return Err(io::Error::other("joined fixed exchange substituted frames").into());
        }
        if futures_util::poll!(Box::pin(hold.connection.join()).as_mut()).is_ready() {
            return Err(io::Error::other("live native connection already ended").into());
        }
    }
    live(request).await?;
    witness(
        "actual_terminal_drained",
        json!({"request":frame(&captured),"response":frame(&response),
        "delivery_requested_ns":delivered,"joined_ns":evidence::clocks()?.0,
        "canonical_helper_exited_zero":true,"helper_stdin_stderr_joined":true,
        "exchange_joined":!producer_unwind,"transport_producer_unwound":producer_unwind,
        "connection_retained_pending":!producer_unwind,"running_helper_observed":false,
        "ordinary_reuse_reopened":false,"original_full_lease_active":true,"allocated":request.context.budget.allocated()}),
    )?;
    Ok(())
}

pub(super) async fn exercise(request: Request<'_>) -> TestResult<()> {
    let context = &request.context;
    request.proof.retain(context.pool.clone());
    request.proof.retain(request.probe.bundle.clone());
    let snapshot = context.pool.lock().await.status_snapshot();
    let [entry] = snapshot.idle_sandboxes.as_slice() else {
        return Err(io::Error::other("fixed restore original absent").into());
    };
    let id = entry.sandbox_id.to_string();
    if !request.proof.owns(&id) {
        return Err(io::Error::other("fixed original changed").into());
    }
    let home = claim_producer::home(request.directory, &id)?;
    let mut owner = None;
    let mut cleanup = None;
    let mut task = None;
    let mut progress = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        request.directory,
        &context.rootfs_hash,
    )
    .await?;
    let mut hold = request.probe.take()?;
    let outcome: TestResult<()> = async {
        let reservation=context.pool.lock().await.take_reserved(&context.reuse_key).ok_or_else(||io::Error::other("fixed reservation missing"))?;
        owner=Some(match GuardedSpeculativeIdleOwner::new(reservation) {Ok(owner)=>owner,Err(owner)=>{request.proof.retain(owner);return Err(io::Error::other("fixed original was not parked").into());}});
        let snapshot = context.pool.lock().await.status_snapshot();
        context.status.set_idle_snapshot(snapshot).await?;
        lose(&request,owner.as_mut().ok_or_else(||io::Error::other("fixed capsule absent"))?,&mut hold,&mut progress).await?;
        cleanup=Some(owner.as_mut().ok_or_else(||io::Error::other("fixed capsule absent"))?.take_cleanup_owner()?);
        task=Some(context.tracker.retire_activation_owner(&mut cleanup,&context.operations,request.inputs.envelope(),"native_fixed_restore_loss").await?);
        let current=task.as_mut().ok_or_else(||io::Error::other("fixed cleanup absent"))?;
        let result=current.join().await??;
        let ActivationCleanupOutcome::NoProgress(error)=result else{return Err(io::Error::other("abandoned fixed RPC fabricated completed saving").into());};
        if !error.contains("normal operations are not available on this connection") || current.take_completed_lease().is_ok() {
            return Err(io::Error::other(format!("fixed cleanup did not retain NotParkable refusal: {error}")).into());
        }
        live(&request).await?;
        request.proof.fixed_restore_witness("required_cleanup_refused",json!({"error":error,"normal_operations_not_parkable":true,
            "completed_lease_refused":true,"required_saving_complete":false,"cleanup_complete":false,
            "original_home":home,"original_full_lease_active":true,"allocated":context.budget.allocated()}))?;
        Ok(())
    }.await;
    request.proof.retain(owner.take());
    request.proof.retain(cleanup.take());
    request.proof.retain(task.take());
    request.proof.retain(hold);
    context.tracker.close_and_wait().await;
    let accounting = context.operations.close_and_wait().await;
    let reporting = progress.finish().await;
    outcome?;
    reporting?;
    let accounting = accounting?;
    let retained = context.tracker.take_retained_activation_owners()?;
    let retained_ok = matches!(retained.as_slice(), [original]
        if original.sandbox_id().to_string() == id
            && !original.cleanup_completed() && original.cleanup_error().is_some());
    request.proof.retain(retained);
    if !retained_ok || accounting.uncertain != 2 || accounting.tracked_tasks != 0 {
        return Err(io::Error::other("fixed original cleanup or growth custody lost").into());
    }
    let attempt_run = RunId::new_v4();
    let attempt_sandbox = SandboxId::new_v4();
    let attempted = request
        .cache
        .prepare_with_lock_policy(
            runner_lifecycle::home_image_cache::HomeImagePrepareRequest {
                identity: HomeImageLeaseIdentity {
                    run_id: attempt_run,
                    sandbox_id: attempt_sandbox,
                    profile_name: fixture::PROFILE,
                    rootfs_hash: &context.rootfs_hash,
                    reuse_key: Some(&context.reuse_key),
                    working_dir:
                        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                    image_size_bytes: fixture::IMAGE_BYTES,
                },
                home_drive_required: true,
            },
            HomeImagePrepareLockPolicy::ImmediateFallback,
        )
        .await;
    if attempted.result() != HomeCacheCheckoutResult::LockBusy {
        request.proof.retain(attempted);
        return Err(io::Error::other("fixed loss released promotion identity").into());
    }
    live(&request).await?;
    if home != claim_producer::home(request.directory, &id)? {
        return Err(io::Error::other("fixed retained original home changed").into());
    }
    request.proof.fixed_restore_witness("original_owners_retained",json!({"original_home":home,
        "promotion_lock_busy":true,"promotion_probe_run_id":attempt_run,"promotion_probe_sandbox_id":attempt_sandbox,
        "original_capsule_retained":true,"original_session_history_retained":true,"original_backing_retained":true,
        "original_full_lease_active":true,"original_exit_polled_pending":true,"allocated":context.budget.allocated(),
        "tracker_joined":true,"heartbeat_provider_peer_joined":true,"accounting":cleanup_progress::accounting(&accounting),
        "required_saving_complete":false,"cleanup_complete":false,"physical_relief_proven":false,"memory_credit":false,
        "running_helper_boundary":"blocked","preterminal_acceptance_boundary":"blocked","original_cleanup_io_progress":"blocked_not_parkable"}))?;
    Err(FixedRestoreUncertain.into())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact committed Host/current Guests, owned KVM/NBD, new matching snapshot and unchanged P1"]
async fn native_fixed_restore_loss_retains_original_uncertainty() -> TestResult<()> {
    let terminal = match std::env::var("OKOU_TEST_FIXED_RESTORE_BOUNDARY")?.as_str() {
        "capture" => false,
        "terminal" => true,
        _ => return Err(io::Error::other("fixed boundary invalid").into()),
    };
    let restored = match std::env::var("OKOU_TEST_FIXED_RESTORE_MODE")?.as_str() {
        "fresh" => false,
        "snapshot" => true,
        _ => return Err(io::Error::other("fixed mode invalid").into()),
    };
    let fault = match std::env::var("OKOU_TEST_FIXED_RESTORE_FAULT")?.as_str() {
        "drop" => native_unpark::Fault::Drop,
        "observer-unwind" => native_unpark::Fault::ObserverUnwind,
        "producer-unwind" => native_unpark::Fault::ProducerUnwind,
        _ => return Err(io::Error::other("fixed fault invalid").into()),
    };
    measured_selected_corpora(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        &[Corpus::FixedRestore(Selection {
            terminal,
            fault,
            restored,
        })],
    )
    .await
}

#[test]
fn fixed_restore_reader_checks_original_files_and_cli() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/fixed_restore_report_test.py"
        ))
        .output()
        .expect("fixed restore reader requires Python3");
    assert!(
        output.status.success(),
        "fixed restore reader: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
