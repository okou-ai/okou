//! Accepted real resume, with the public unpark still awaiting HTTP delivery.

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use runner_lifecycle::idle_pool::{GuardedSpeculativeIdleOwner, SpeculativeActivationState};
use sandbox::SandboxBackingProcess;
use sandbox_firecracker::api_request_gate::{
    BackendResponse, CapturedRequest, RequestOutcome, RequestProducer, RequestRoute,
    ResponseDisposition, Transition, gate_request_with_response_control,
};
use sandbox_firecracker::{RuntimePaths, SockPaths};
use serde_json::json;
use tokio::sync::oneshot;

use super::*;

#[test]
fn native_unpark_reader_checks_original_files_and_cli() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/native_unpark_report_test.py"
        ))
        .output()
        .expect("native unpark reader requires Python3");
    assert!(
        output.status.success(),
        "native unpark report: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact-source Host/current Guests, owned KVM/NBD and accepted-resume P1 proof"]
async fn native_accepted_unpark_loss_preserves_required_saving() -> TestResult<()> {
    measured_selected_corpora(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        &[
            Corpus::NativeUnpark(Fault::Drop),
            Corpus::NativeUnpark(Fault::ObserverUnwind),
            Corpus::NativeUnpark(Fault::ProducerUnwind),
        ],
    )
    .await
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Fault {
    Drop,
    ObserverUnwind,
    ProducerUnwind,
}

impl Fault {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Drop => "UnparkDrop",
            Self::ObserverUnwind => "UnparkObserverUnwind",
            Self::ProducerUnwind => "UnparkProducerUnwind",
        }
    }
}

pub(super) struct Hold {
    sandbox_id: String,
    backend: std::path::PathBuf,
    front: std::path::PathBuf,
    request_sha256: Option<String>,
    route: Option<RequestRoute>,
    captured: oneshot::Receiver<CapturedRequest>,
    dispatch: Option<oneshot::Sender<()>>,
    response: oneshot::Receiver<BackendResponse>,
    delivery: Option<oneshot::Sender<ResponseDisposition>>,
    producer: RequestProducer,
    joined: bool,
}

impl Hold {
    pub(super) fn new(sandbox_id: String) -> TestResult<Self> {
        let directory = RuntimePaths::new().sock_dir(&sandbox_id);
        let backend = SockPaths::new(directory.clone()).api_sock();
        let front = directory.join("unpark-proof.sock");
        let (request, response, producer) = gate_request_with_response_control(
            tokio::net::UnixListener::bind(&front)?,
            backend.clone(),
            Transition::Resume,
        );
        Ok(Self {
            sandbox_id,
            route: Some(RequestRoute::new(backend.clone(), front.clone())?),
            backend,
            front,
            request_sha256: None,
            captured: request.arrived,
            dispatch: Some(request.release),
            response: response.arrived,
            delivery: Some(response.release),
            producer,
            joined: false,
        })
    }

    /// Always outside the borrowed prepare/cleanup observations.
    pub(super) async fn close(&mut self) -> TestResult<()> {
        drop(self.dispatch.take());
        if let Some(release) = self.delivery.take() {
            let _ = release.send(ResponseDisposition::Deliver);
        }
        if !self.joined {
            let result = self.producer.join().await;
            self.joined = true;
            result?;
        }
        Ok(())
    }

    pub(super) async fn finish(
        &mut self,
        context: &transitions::Context,
        proof: &evidence::Case,
        backing: &Arc<dyn SandboxBackingProcess>,
        owner: &mut GuardedSpeculativeIdleOwner,
        probe: &mut foreground_probe::Probe,
        fault: Fault,
    ) -> TestResult<()> {
        let mut completion = Box::pin(owner.observe_terminal_unpark_for_test());
        let mut completed = None;
        cleanup_progress::pending(completion.as_mut(), &mut completed).await?;
        speculative_fault::live(context, proof, backing).await?;
        if let Some(lease) = ResourceBudget::try_reserve_lease(&context.budget, 2, 4096) {
            proof.retain(lease);
            return Err(io::Error::other("native unpark lost full-profile no-headroom").into());
        }
        let pool = context.pool.lock().await;
        let pool_held_ns = evidence::clocks()?.0;
        probe.request()?;
        {
            let heartbeat = probe.complete();
            tokio::pin!(heartbeat);
            if futures_util::poll!(heartbeat.as_mut()).is_ready() {
                return Err(
                    io::Error::other("native unpark heartbeat ignored pool contention").into(),
                );
            }
        }
        let heartbeat_pending_ns = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        drop(pool);
        let pool_released_ns = evidence::clocks()?.0;
        let heartbeat = probe.complete().await?;
        cleanup_progress::pending(completion.as_mut(), &mut completed).await?;
        proof.unpark_witness(
            "native_wait_progress",
            json!({
                "pool_held_ns":pool_held_ns,"heartbeat_pending_ns":heartbeat_pending_ns,
                "pool_released_ns":pool_released_ns,"observer":observer,"heartbeat":heartbeat,
                "terminal_unpark_polled_pending":true,"response_delivery_withheld":true,
                "additional_full_profile_refused":true,"original_full_lease_active":true,
                "allocated":context.budget.allocated(),
            }),
        )?;
        drop(completion);
        let released_ns = evidence::clocks()?.0;
        self.delivery
            .take()
            .ok_or_else(|| io::Error::other("native delivery control absent"))?
            .send(if fault == Fault::ProducerUnwind {
                ResponseDisposition::UnwindAfterDelivery
            } else {
                ResponseDisposition::Deliver
            })
            .map_err(|_| io::Error::other("native response producer disappeared"))?;
        let result = self.producer.join().await;
        self.joined = true;
        let (producer_unwound, joined_request_sha256) = match result {
            Ok(RequestOutcome::ResponseDrained {
                request,
                status: 204,
                delivery: Ok(()),
                ..
            }) if fault != Fault::ProducerUnwind => {
                let digest = continuation::digest(&request.raw);
                if self.request_sha256.as_ref() != Some(&digest) {
                    return Err(io::Error::other(
                        "native joined producer changed original request",
                    )
                    .into());
                }
                (false, Some(digest))
            }
            Err(error) if fault == Fault::ProducerUnwind && error.producer_panicked() => {
                (true, None)
            }
            result => {
                return Err(
                    io::Error::other(format!("native response join invalid: {result:?}")).into(),
                );
            }
        };
        proof.unpark_witness(
            "request_producer_joined",
            json!({
                "response_released_ns":released_ns,"producer_joined_ns":evidence::clocks()?.0,
                "producer_joined":true,"producer_unwound":producer_unwound,
                "joined_request_sha256":joined_request_sha256,
                "backend_status":204,"accepted_response_before_cancellation":true,
                "internal_vmm_inflight_claimed":false,
            }),
        )?;
        Ok(())
    }
}

pub(super) async fn inject(
    context: &transitions::Context,
    proof: &evidence::Case,
    backing: &Arc<dyn SandboxBackingProcess>,
    owner: &mut GuardedSpeculativeIdleOwner,
    history: RunId,
    fault: Fault,
    hold: &mut Hold,
) -> TestResult<()> {
    if !proof.owns(&hold.sandbox_id) {
        return Err(io::Error::other("native unpark gate targets another original owner").into());
    }
    let operation = RunId::new_v4();
    let started_ns = evidence::clocks()?.0;
    let route = hold
        .route
        .take()
        .ok_or_else(|| io::Error::other("native route consumed"))?;
    let mut preparation = Box::pin(route.scope(owner.prepare(operation, |_, _, _| {
        Box::pin(async { Err("native unpark unexpectedly reached restore callback".into()) })
    })));
    let captured = tokio::time::timeout(Duration::from_secs(90), async {
        tokio::select! {
            captured = &mut hold.captured => Ok::<_,io::Error>(captured.map_err(io::Error::other)?),
            result = preparation.as_mut() => Err(io::Error::other(format!("native unpark completed before capture: {result:?}"))),
        }
    }).await??;
    let capture_ns = evidence::clocks()?.0;
    let request_sha256 = continuation::digest(&captured.raw);
    hold.request_sha256 = Some(request_sha256.clone());
    speculative_fault::live(context, proof, backing).await?;
    proof.unpark_witness(
        "resume_captured",
        json!({
            "mode":fault.name(),"history_run_id":history,"operation_run_id":operation,
            "reuse_key":context.reuse_key,"prepare_started_ns":started_ns,
            "capture_observed_ns":capture_ns,"request_raw":String::from_utf8(captured.raw.clone())?,
            "request_sha256":request_sha256,"backend_socket":hold.backend,"front_socket":hold.front,
            "backend_dispatched":false,"restore_callback_reached":false,
            "original_full_lease_active":true,"allocated":context.budget.allocated(),
        }),
    )?;
    hold.dispatch
        .take()
        .ok_or_else(|| io::Error::other("native dispatch control absent"))?
        .send(())
        .map_err(|_| io::Error::other("native request producer disappeared"))?;
    let accepted = tokio::time::timeout(Duration::from_secs(90), async {
        tokio::select! {
            response = &mut hold.response => Ok::<_,io::Error>(response.map_err(io::Error::other)?),
            result = preparation.as_mut() => Err(io::Error::other(format!("native unpark passed held real response: {result:?}"))),
        }
    }).await??;
    if accepted.request != captured
        || accepted.status != 204
        || !futures_util::poll!(preparation.as_mut()).is_pending()
    {
        return Err(
            io::Error::other("native accepted resume identity/status/wait mismatch").into(),
        );
    }
    speculative_fault::live(context, proof, backing).await?;
    proof.unpark_witness(
        "resume_accepted_waiting",
        json!({
            "backend_response_observed_ns":evidence::clocks()?.0,"backend_status":accepted.status,
            "response_raw":String::from_utf8(accepted.raw.clone())?,
            "response_sha256":continuation::digest(&accepted.raw),
            "public_unpark_polled_pending":true,"response_delivery_withheld":true,
            "restore_callback_reached":false,"internal_vmm_inflight_claimed":false,
            "original_full_lease_active":true,"original_exit_polled_pending":true,
            "allocated":context.budget.allocated(),
        }),
    )?;
    let cancelled_ns = evidence::clocks()?.0;
    if fault == Fault::ObserverUnwind {
        if std::panic::catch_unwind(AssertUnwindSafe(move || {
            let _observation = preparation;
            std::panic::resume_unwind(Box::new("native borrowed unpark observer unwound"));
        }))
        .is_ok()
        {
            return Err(io::Error::other("native observer did not unwind").into());
        }
    } else {
        drop(preparation);
    }
    if owner.state() != SpeculativeActivationState::Uncertain
        || !owner.matches_claim(Some(&context.reuse_key), Some(history), fixture::PROFILE)
    {
        return Err(io::Error::other("native unpark lost original uncertain capsule").into());
    }
    if let Ok(resource) = owner.commit(
        operation,
        &runner_lifecycle::guest_timezone::GuestTimezoneIntent::Default,
    ) {
        proof.retain(resource);
        return Err(io::Error::other("native uncertain unpark committed").into());
    }
    if owner.repark(fixture::IMAGE_BYTES).await.is_ok() {
        return Err(io::Error::other("native uncertain unpark reparks").into());
    }
    if let Ok(resource) = owner.take_incoming() {
        proof.retain(resource);
        return Err(io::Error::other("native uncertain unpark became inventory").into());
    }
    speculative_fault::live(context, proof, backing).await?;
    proof.unpark_witness(
        "preparation_lost",
        json!({
            "cancel_requested_ns":cancelled_ns,"observation_dropped_ns":evidence::clocks()?.0,
            "observer_unwound":fault==Fault::ObserverUnwind,"state":"Uncertain",
            "commit_refused":true,"repark_refused":true,"incoming_refused":true,
            "original_metadata_preserved":true,"original_full_lease_active":true,
            "original_exit_polled_pending":true,"pool_empty":context.pool.lock().await.is_empty(),
            "allocated":context.budget.allocated(),
        }),
    )?;
    Ok(())
}
