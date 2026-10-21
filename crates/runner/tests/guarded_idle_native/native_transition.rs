//! Retained real transition gates outside borrowed unpark and physical repark observers.

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use runner_lifecycle::idle_pool::{GuardedSpeculativeIdleOwner, SpeculativeActivationState};
use sandbox::SandboxBackingProcess;
use sandbox_firecracker::api_request_gate::{
    BackendResponse, CapturedRequest, RequestOutcome, RequestProducer, RequestRoute,
    ResponseDisposition, Transition, gate_request_with_response_control,
};
use sandbox_firecracker::{RuntimePaths, SockPaths};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Fault {
    Drop,
    ObserverUnwind,
    ProducerUnwind,
}

impl Fault {
    pub(super) fn pause_name(self) -> &'static str {
        match self {
            Self::Drop => "PauseDrop",
            Self::ObserverUnwind => "PauseObserverUnwind",
            Self::ProducerUnwind => "PauseProducerUnwind",
        }
    }

    fn transition_name(self, transition: Transition) -> &'static str {
        match transition {
            Transition::Resume => self.name(),
            Transition::Pause => self.pause_name(),
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Drop => "UnparkDrop",
            Self::ObserverUnwind => "UnparkObserverUnwind",
            Self::ProducerUnwind => "UnparkProducerUnwind",
        }
    }
}

pub(super) struct Hold {
    transition: Transition,
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
    fn witness(&self, proof: &evidence::Case, phase: &str, value: Value) -> io::Result<()> {
        match self.transition {
            Transition::Resume => proof.unpark_witness(phase, value),
            Transition::Pause => {
                let phase = match phase {
                    "resume_captured" => "pause_captured",
                    "resume_accepted_waiting" => "pause_accepted_waiting",
                    phase => phase,
                };
                proof.pause_witness(phase, value)
            }
        }
    }

    pub(super) fn new(sandbox_id: String, transition: Transition) -> TestResult<Self> {
        let directory = RuntimePaths::new().sock_dir(&sandbox_id);
        let backend = SockPaths::new(directory.clone()).api_sock();
        let front = directory.join(match transition {
            Transition::Resume => "unpark-proof.sock",
            Transition::Pause => "pause-proof.sock",
        });
        let (request, response, producer) = gate_request_with_response_control(
            tokio::net::UnixListener::bind(&front)?,
            backend.clone(),
            transition,
        );
        Ok(Self {
            transition,
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
        self.witness(
            proof,
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
        self.witness(
            proof,
            "request_producer_joined",
            json!({
                "response_released_ns":released_ns,"producer_joined_ns":evidence::clocks()?.0,
                "producer_joined":true,"producer_unwound":producer_unwound,
                "joined_request_sha256":joined_request_sha256,
                "backend_status":204,"accepted_response_before_cancellation":true,
                "internal_vmm_inflight_claimed":false,
            }),
        )?;
        if self.transition == Transition::Pause {
            owner
                .observe_terminal_unpark_for_test()
                .await
                .map_err(io::Error::other)?;
            if owner.state() != SpeculativeActivationState::Uncertain {
                return Err(io::Error::other(
                    "terminal readiness changed original uncertain capsule",
                )
                .into());
            }
            speculative_fault::live(context, proof, backing).await?;
            self.witness(proof, "terminal_readiness_joined", json!({
                "pause_and_resume_readiness_joined":true,"ordinary_reuse_reopened":false,
                "state":"Uncertain","original_full_lease_active":true,"original_exit_polled_pending":true,
                "allocated":context.budget.allocated(),
            }))?;
        }
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
    let prepare_started_ns = evidence::clocks()?.0;
    let prepared = if hold.transition == Transition::Pause {
        let (verified, receipt) = oneshot::channel();
        owner
            .prepare(operation, move |sandbox, _, _| {
                Box::pin(async move {
                    runner_executor::executor::restore_guest_state_with_timezone(sandbox, "UTC")
                        .await
                        .map_err(|error| error.to_string())?;
                    let digest = fixture::verify_speculative_guest(sandbox, history)
                        .await
                        .map_err(|error| error.to_string())?;
                    let completed = evidence::clocks().map_err(|error| error.to_string())?.0;
                    verified
                        .send((completed, digest))
                        .map_err(|_| "physical data observation lost")?;
                    Ok(())
                })
            })
            .await
            .map_err(io::Error::other)?;
        Some(receipt.await?)
    } else {
        None
    };
    let started_ns = evidence::clocks()?.0;
    let route = hold
        .route
        .take()
        .ok_or_else(|| io::Error::other("native route consumed"))?;
    let transition = hold.transition;
    let mut preparation = Box::pin(route.scope(async {
        match transition {
            Transition::Resume => {
                owner
                    .prepare(operation, |_, _, _| {
                        Box::pin(async {
                            Err("native unpark unexpectedly reached restore callback".into())
                        })
                    })
                    .await
            }
            Transition::Pause => owner.repark(fixture::IMAGE_BYTES).await,
        }
    }));
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
    let mut captured_evidence = json!({
        "mode":fault.transition_name(hold.transition),"history_run_id":history,"operation_run_id":operation,
        "reuse_key":context.reuse_key,"prepare_started_ns":prepare_started_ns,
        "capture_observed_ns":capture_ns,"request_raw":String::from_utf8(captured.raw.clone())?,
        "request_sha256":request_sha256,"backend_socket":hold.backend,"front_socket":hold.front,
        "backend_dispatched":false,"restore_callback_reached":prepared.is_some(),
        "original_full_lease_active":true,"allocated":context.budget.allocated(),
    });
    if let Some((verified_ns, digest)) = prepared {
        let fields = captured_evidence
            .as_object_mut()
            .ok_or_else(|| io::Error::other("pause capture not an object"))?;
        fields.insert("data_verified_ns".into(), json!(verified_ns));
        fields.insert("repark_started_ns".into(), json!(started_ns));
        fields.insert("payload_sha256".into(), json!(digest));
        fields.insert("payload_bytes".into(), json!(fixture::PAYLOAD_BYTES));
        fields.insert("production_restore_completed".into(), json!(true));
        fields.insert("private_history_verified".into(), json!(true));
        fields.insert("ordinary_home_verified".into(), json!(true));
    }
    hold.witness(proof, "resume_captured", captured_evidence)?;
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
    let mut accepted_evidence = json!({
        "backend_response_observed_ns":evidence::clocks()?.0,"backend_status":accepted.status,
        "response_raw":String::from_utf8(accepted.raw.clone())?,
        "response_sha256":continuation::digest(&accepted.raw),
        "public_unpark_polled_pending":true,"response_delivery_withheld":true,
        "restore_callback_reached":hold.transition==Transition::Pause,"internal_vmm_inflight_claimed":false,
        "original_full_lease_active":true,"original_exit_polled_pending":true,
        "allocated":context.budget.allocated(),
    });
    if hold.transition == Transition::Pause {
        let fields = accepted_evidence
            .as_object_mut()
            .ok_or_else(|| io::Error::other("pause acceptance not an object"))?;
        fields.remove("public_unpark_polled_pending");
        fields.insert("public_park_polled_pending".into(), json!(true));
    }
    hold.witness(proof, "resume_accepted_waiting", accepted_evidence)?;
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
        || !owner.matches_source_claim(Some(&context.reuse_key), history, fixture::PROFILE)
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
    hold.witness(
        proof,
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
