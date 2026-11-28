//! Antigravity ACP execution backend with mid-turn steer support.

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use guest_contracts::diagnostics::{
    AGENT_EXECUTION_TIMEOUT_EXIT_CODE, CliObservedExitDiagnostic, CliTerminationDiagnostic,
    CliTerminationReason, FailureDetailSource, HeartbeatFailureDiagnostic,
};
use guest_telemetry::{log_info, log_warn};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::active_input::{ActiveInputController, ActiveInputFrame, ActiveInputWriter};
use crate::cli::event_delivery::{EventDeliveryRuntime, EventDeliverySender};
use crate::cli::jsonl_result::JsonlResultSummary;
use crate::cli::{
    AgentExecutionDeadline, BestEffortAgentLog, CliEventIngestor, CliExecutionControls,
    CliExecutionResult, CliFailureDiagnostic, CliRuntimeConfig, CliStartupTiming, HeartbeatMonitor,
    HeartbeatStatus, LOG_TAG, ParsedEventAction, child_env, cli_exit_summary_from_status,
    session_output, user_env_value,
};
use crate::env::Framework;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;

use super::acp::{
    AcpIncoming, AntigravityAcpClient, AntigravityAcpConfig, AntigravityAcpError, JsonRpcError,
};
use super::events::EventProjector;
use super::{Launch, configure_env};

const ACP_EVENT_LABEL: &str = "antigravity acp session";
const CANCEL_GRACE: Duration = Duration::from_secs(5);

enum AcpRunEvent {
    Incoming(Result<AcpIncoming, AntigravityAcpError>),
    ActiveInput(Option<ActiveInputFrame>),
}

enum AcpRunOutcome {
    Completed(Box<Result<CliExecutionResult, AcpRunError>>),
    ExecutionTimedOut { timeout_secs: u64 },
    UserCancelled,
}

enum AcpRunError {
    Execution(AgentError),
    Heartbeat(AcpHeartbeatFailure),
}

struct AcpHeartbeatFailure {
    error: AgentError,
    diagnostic: Option<HeartbeatFailureDiagnostic>,
    termination_reason: CliTerminationReason,
}

impl From<AgentError> for AcpRunError {
    fn from(error: AgentError) -> Self {
        Self::Execution(error)
    }
}

impl AcpRunOutcome {
    fn is_heartbeat_failure(&self) -> bool {
        matches!(
            self,
            Self::Completed(result) if matches!(result.as_ref(), Err(AcpRunError::Heartbeat(_)))
        )
    }
}

struct EventSink<'a, 'startup> {
    ingestor: &'a mut CliEventIngestor<'startup>,
    agent_log: &'a mut BestEffortAgentLog,
    masker: &'a SecretMasker,
    should_send_events: bool,
    event_tx: &'a EventDeliverySender,
}

impl EventSink<'_, '_> {
    async fn ingest(&mut self, event: Value) -> Result<(), AgentError> {
        let mut transcript = event.clone();
        self.masker.mask_value(&mut transcript);
        let raw_line = transcript.to_string();
        let action = self
            .ingestor
            .begin_event(
                self.agent_log,
                &raw_line,
                &event,
                self.masker,
                Framework::Antigravity,
            )
            .await;
        if matches!(action, ParsedEventAction::Forward) {
            self.ingestor.enqueue_event(
                event,
                self.masker,
                self.should_send_events,
                self.event_tx,
            )?;
        }
        Ok(())
    }

    async fn ingest_all(&mut self, events: Vec<Value>) -> Result<(), AgentError> {
        for event in events {
            self.ingest(event).await?;
        }
        Ok(())
    }

    async fn emit_terminal_events(
        &mut self,
        events: Vec<Value>,
    ) -> Result<Option<JsonlResultSummary>, AgentError> {
        let mut summary = None;
        for event in events {
            if event.get("type").and_then(Value::as_str) == Some("result") {
                summary = Some(JsonlResultSummary::from_event(&event));
                if let Some(result) = event.get("result").and_then(Value::as_str) {
                    println!("{}", self.masker.mask_string(result));
                }
            }
            self.ingest(event).await?;
        }
        Ok(summary)
    }
}

pub(in crate::cli) async fn execute_antigravity_acp_for_runtime(
    masker: &SecretMasker,
    mut heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    controls: CliExecutionControls<'_>,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    log_info!(LOG_TAG, "Starting antigravity acp execution...");

    let should_send_events = http.has_api();
    let event_delivery = EventDeliveryRuntime::start(http.clone(), &runtime.run_id)?;

    let run_result = run_antigravity_acp(
        masker,
        &mut heartbeat_monitor,
        &http,
        should_send_events,
        event_delivery.sender(),
        controls,
        runtime,
    )
    .await;

    match run_result {
        Ok(mut result) if result.control_error.is_some() => {
            let delivery_report = event_delivery.abort().await;
            result.last_event_sequence = delivery_report.last_acknowledged_sequence;
            result.event_delivery = delivery_report.diagnostic;
            Ok(result)
        }
        Ok(mut result) => {
            let delivery_report = event_delivery.finish().await?;
            result.last_event_sequence = delivery_report.last_acknowledged_sequence;
            result.event_delivery = delivery_report.diagnostic;
            Ok(result)
        }
        Err(error) => {
            event_delivery.abort().await;
            Err(error)
        }
    }
}

async fn run_antigravity_acp(
    masker: &SecretMasker,
    heartbeat_monitor: &mut HeartbeatMonitor,
    http: &HttpClient,
    should_send_events: bool,
    event_tx: &EventDeliverySender,
    controls: CliExecutionControls<'_>,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    let CliExecutionControls {
        mut active_input,
        user_cancellation,
        codex_startup: _,
        pi_startup: _,
        workload_containment,
        session_metadata,
        #[cfg(feature = "test-support")]
            codex_turn_start_gate: _,
    } = controls;

    let launch = Launch::prepare(runtime)?;
    let acp_config = build_acp_config(&launch, runtime, workload_containment.cloned())?;

    let mut agent_log = BestEffortAgentLog::open(runtime.agent_log_file.as_ref());
    let mut ingestor = CliEventIngestor::new_with_session_metadata(
        runtime,
        CliStartupTiming::default(),
        session_metadata,
        0,
    );
    let session_output = session_output::start(
        http.clone(),
        runtime.run_id.as_ref(),
        user_env_value(runtime.user_env, "OKOU_CHAT_THREAD_ID"),
        session_output::FirstSessionOutputTiming {
            api_start_time: runtime.api_start_time.to_string(),
            ..Default::default()
        },
    );
    let mut projector = EventProjector::new(&launch.model.slug, session_output, masker);
    let mut client =
        AntigravityAcpClient::spawn(acp_config).map_err(|error| acp_error(masker, error))?;
    let mut heartbeat_done = false;
    let active_input_controller = active_input.controller();
    let mut sink = EventSink {
        ingestor: &mut ingestor,
        agent_log: &mut agent_log,
        masker,
        should_send_events,
        event_tx,
    };

    let mut active_session_id: Option<String> = None;
    let mut in_flight_prompts: HashSet<i64> = HashSet::new();

    let run = async {
        // 1. Handshake: initialize -> session/new -> session/set_mode -> session/set_config_option
        let init_res = race_with_heartbeat(
            client.request_value(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                    "clientInfo": {
                        "name": "okou-guest-agent",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }),
            ),
            heartbeat_monitor,
            &mut heartbeat_done,
        )
        .await?;
        if let Err(error) = init_res {
            return handle_acp_transport_or_rpc_error(error, &mut projector, &mut sink).await;
        }

        let (session_response, resumed) = match start_or_resume_session(
            &mut client,
            runtime,
            heartbeat_monitor,
            &mut heartbeat_done,
        )
        .await?
        {
            Ok(outcome) => outcome,
            Err(error) => {
                return handle_acp_transport_or_rpc_error(error, &mut projector, &mut sink).await;
            }
        };

        let session_id = session_id_from_response(
            &session_response,
            resumed.then_some(runtime.resume_session_id.as_ref()),
        )?;
        active_session_id = Some(session_id.clone());
        sink.ingest(projector.begin_session(session_id.clone()))
            .await?;

        for (method, params) in [
            (
                "session/set_mode",
                json!({ "sessionId": &session_id, "modeId": "accept-edits" }),
            ),
            (
                "session/set_config_option",
                json!({
                    "sessionId": &session_id,
                    "configId": "model",
                    "value": &launch.model.family,
                }),
            ),
            (
                "session/set_config_option",
                json!({
                    "sessionId": &session_id,
                    "configId": "thought_level",
                    "value": &launch.model.effort,
                }),
            ),
        ] {
            let res = race_with_heartbeat(
                client.request_value(method, params),
                heartbeat_monitor,
                &mut heartbeat_done,
            )
            .await?;
            if let Err(error) = res {
                return handle_acp_transport_or_rpc_error(error, &mut projector, &mut sink).await;
            }
        }

        while let Some(notification) = client.pop_notification() {
            let events = projector.project_notification(&notification)?;
            sink.ingest_all(events).await?;
        }

        // 2. Send initial prompt.
        let initial_send = race_with_heartbeat(
            client.send_request(
                "session/prompt",
                prompt_params(&session_id, runtime.prompt.as_ref()),
            ),
            heartbeat_monitor,
            &mut heartbeat_done,
        )
        .await?;
        let initial_id = match initial_send {
            Ok(id) => id,
            Err(error) => {
                return handle_acp_transport_or_rpc_error(error, &mut projector, &mut sink).await;
            }
        };
        in_flight_prompts.insert(initial_id);

        let mut active_input_open = true;

        // 3. Event and steer loop.
        loop {
            let event = next_acp_run_event(
                &mut client,
                &mut active_input,
                active_input_open,
                heartbeat_monitor,
                &mut heartbeat_done,
            )
            .await?;
            match event {
                AcpRunEvent::ActiveInput(Some(frame)) => {
                    if let Some(early_result) = send_steered_prompt(
                        &mut client,
                        &active_input,
                        frame,
                        &session_id,
                        &mut in_flight_prompts,
                        &mut projector,
                        &mut sink,
                        heartbeat_monitor,
                        &mut heartbeat_done,
                    )
                    .await?
                    {
                        return Ok(early_result);
                    }
                }
                AcpRunEvent::ActiveInput(None) => {
                    active_input_open = false;
                }
                AcpRunEvent::Incoming(Err(error)) => {
                    active_input.close_terminal();
                    return handle_acp_transport_or_rpc_error(error, &mut projector, &mut sink)
                        .await;
                }
                AcpRunEvent::Incoming(Ok(AcpIncoming::Notification(notification))) => {
                    let events = projector.project_notification(&notification)?;
                    sink.ingest_all(events).await?;
                }
                AcpRunEvent::Incoming(Ok(AcpIncoming::Response { id, outcome, .. })) => {
                    in_flight_prompts.remove(&id);
                    match outcome {
                        Ok(result) => {
                            let flushed = projector.record_prompt_response(&result);
                            sink.ingest_all(flushed).await?;
                            if in_flight_prompts.is_empty() {
                                if active_input_open
                                    && let Some(frame) = active_input.try_next_frame()
                                {
                                    if let Some(early_result) = send_steered_prompt(
                                        &mut client,
                                        &active_input,
                                        frame,
                                        &session_id,
                                        &mut in_flight_prompts,
                                        &mut projector,
                                        &mut sink,
                                        heartbeat_monitor,
                                        &mut heartbeat_done,
                                    )
                                    .await?
                                    {
                                        return Ok(early_result);
                                    }
                                    continue;
                                }
                                active_input.close_terminal();
                                let terminal = projector.finish_success();
                                let jsonl_result = sink.emit_terminal_events(terminal).await?;
                                return Ok(acp_execution_result(
                                    0,
                                    None,
                                    jsonl_result,
                                    sink.ingestor.failure_diagnostic(),
                                ));
                            }
                        }
                        Err(rpc_error) => {
                            active_input.close_terminal();
                            return finish_rpc_error_result(rpc_error, &mut projector, &mut sink)
                                .await;
                        }
                    }
                }
            }
        }
    };

    let run_outcome = run_with_execution_deadline(
        run,
        runtime.agent_execution_deadline,
        &user_cancellation,
        &active_input_controller,
    )
    .await;
    active_input.close_terminal();

    let cancelled_cleanly = if matches!(
        &run_outcome,
        AcpRunOutcome::ExecutionTimedOut { .. } | AcpRunOutcome::UserCancelled
    ) && let Some(session_id) = active_session_id.as_deref()
        && !in_flight_prompts.is_empty()
    {
        match tokio::time::timeout(
            CANCEL_GRACE,
            cancel_active_session(
                &mut client,
                session_id,
                &mut in_flight_prompts,
                &mut projector,
                &mut sink,
            ),
        )
        .await
        {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                log_warn!(
                    LOG_TAG,
                    "Antigravity ACP cancellation failed; terminating child: {}",
                    masker.mask_string(&error.to_string())
                );
                false
            }
            Err(_) => {
                log_warn!(
                    LOG_TAG,
                    "Antigravity ACP cancellation timed out; terminating child"
                );
                false
            }
        }
    } else {
        false
    };

    let shutdown_result = match &run_outcome {
        AcpRunOutcome::Completed(result) if result.is_ok() => client.shutdown().await,
        AcpRunOutcome::ExecutionTimedOut { .. } | AcpRunOutcome::UserCancelled
            if cancelled_cleanly =>
        {
            match client.shutdown().await {
                Ok(()) => Ok(()),
                Err(error) => {
                    log_warn!(
                        LOG_TAG,
                        "Antigravity ACP shutdown failed after cancel; terminating: {}",
                        masker.mask_string(&error.to_string())
                    );
                    client.terminate().await
                }
            }
        }
        AcpRunOutcome::Completed(_)
        | AcpRunOutcome::ExecutionTimedOut { .. }
        | AcpRunOutcome::UserCancelled => client.terminate().await,
    };

    // Keep the temporary hooks directory alive until the child has exited.
    drop(launch);

    if shutdown_result.is_ok()
        && matches!(
            &run_outcome,
            AcpRunOutcome::ExecutionTimedOut { .. } | AcpRunOutcome::UserCancelled
        )
        && active_input_controller.sink_in_flight()
    {
        active_input_controller.mark_sink_stopped_after_consumer_exit();
    }
    let active_input_finalized = active_input_controller
        .finalize_steered_declarations()
        .await;
    agent_log.flush().await;

    match active_input_finalized {
        Ok(()) => {}
        Err(active_input_error) if run_outcome.is_heartbeat_failure() => {
            log_warn!(
                LOG_TAG,
                "Antigravity active-input cleanup failed after heartbeat failure: {}",
                masker.mask_string(&active_input_error.to_string())
            );
        }
        Err(active_input_error) => {
            if let Err(shutdown_error) = &shutdown_result {
                return Err(AgentError::Execution(format!(
                    "antigravity acp cleanup failed before active-input quiescence: {}",
                    masker.mask_string(&shutdown_error.to_string())
                )));
            }
            return Err(active_input_error);
        }
    }

    match run_outcome {
        AcpRunOutcome::Completed(run_result) => match (*run_result, shutdown_result) {
            (Ok(result), Ok(())) => Ok(result),
            (Ok(_), Err(error)) => Err(AgentError::Execution(format!(
                "antigravity acp shutdown failed: {}",
                masker.mask_string(&error.to_string())
            ))),
            (Err(AcpRunError::Execution(error)), Ok(())) => Err(error),
            (Err(AcpRunError::Execution(error)), Err(shutdown_error)) => {
                log_warn!(
                    LOG_TAG,
                    "antigravity acp shutdown failed after run error: {}",
                    masker.mask_string(&shutdown_error.to_string())
                );
                Err(error)
            }
            (Err(AcpRunError::Heartbeat(failure)), shutdown_result) => {
                if let Err(shutdown_error) = shutdown_result {
                    log_warn!(
                        LOG_TAG,
                        "antigravity acp termination failed after heartbeat failure: {}",
                        masker.mask_string(&shutdown_error.to_string())
                    );
                }
                Ok(CliExecutionResult {
                    heartbeat: failure.diagnostic,
                    control_error: Some(failure.error),
                    cli_termination: Some(CliTerminationDiagnostic::new(
                        failure.termination_reason,
                    )),
                    ..acp_execution_result(1, None, None, ingestor.failure_diagnostic())
                })
            }
        },
        AcpRunOutcome::ExecutionTimedOut { timeout_secs } => {
            if let Err(shutdown_error) = shutdown_result {
                log_warn!(
                    LOG_TAG,
                    "antigravity acp termination failed after execution timeout: {}",
                    masker.mask_string(&shutdown_error.to_string())
                );
            }
            Ok(CliExecutionResult {
                control_error: Some(AgentError::Execution(format!(
                    "Agent execution timed out after {timeout_secs} seconds"
                ))),
                cli_termination: Some(CliTerminationDiagnostic::new(
                    CliTerminationReason::ExecutionTimeout,
                )),
                ..acp_execution_result(
                    AGENT_EXECUTION_TIMEOUT_EXIT_CODE,
                    None,
                    None,
                    ingestor.failure_diagnostic(),
                )
            })
        }
        AcpRunOutcome::UserCancelled => {
            if let Err(shutdown_error) = shutdown_result {
                log_warn!(
                    LOG_TAG,
                    "antigravity acp termination failed after user cancellation: {}",
                    masker.mask_string(&shutdown_error.to_string())
                );
            }
            Ok(CliExecutionResult {
                control_error: Some(AgentError::Execution("Run cancelled by user".to_string())),
                cli_termination: Some(CliTerminationDiagnostic::new(
                    CliTerminationReason::UserCancellation,
                )),
                ..acp_execution_result(1, None, None, ingestor.failure_diagnostic())
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn send_steered_prompt(
    client: &mut AntigravityAcpClient,
    active_input: &ActiveInputWriter,
    frame: ActiveInputFrame,
    session_id: &str,
    in_flight_prompts: &mut HashSet<i64>,
    projector: &mut EventProjector<'_>,
    sink: &mut EventSink<'_, '_>,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
) -> Result<Option<CliExecutionResult>, AcpRunError> {
    log_info!(
        LOG_TAG,
        "Antigravity ACP active input steer: session_id={session_id} input_uuid={} in_flight={}",
        frame.uuid,
        in_flight_prompts.len(),
    );
    active_input.mark_writing(&frame.uuid);
    let send_res = race_with_heartbeat(
        client.send_request("session/prompt", prompt_params(session_id, &frame.text)),
        heartbeat_monitor,
        heartbeat_done,
    )
    .await;
    match send_res {
        Ok(Ok(req_id)) => {
            active_input.mark_backend_accepted_without_replay(&frame)?;
            in_flight_prompts.insert(req_id);
            Ok(None)
        }
        Ok(Err(error)) => {
            active_input.mark_backend_failed(&frame);
            active_input.close_terminal();
            handle_acp_transport_or_rpc_error(error, projector, sink)
                .await
                .map(Some)
        }
        Err(heartbeat_err) => {
            active_input.mark_backend_failed(&frame);
            active_input.close_terminal();
            Err(heartbeat_err)
        }
    }
}

async fn cancel_active_session(
    client: &mut AntigravityAcpClient,
    session_id: &str,
    in_flight_prompts: &mut HashSet<i64>,
    projector: &mut EventProjector<'_>,
    sink: &mut EventSink<'_, '_>,
) -> Result<(), AgentError> {
    client
        .notify("session/cancel", json!({ "sessionId": session_id }))
        .await
        .map_err(|error| acp_error(sink.masker, error))?;
    while !in_flight_prompts.is_empty() {
        let incoming = client
            .next_incoming("session/cancel drain")
            .await
            .map_err(|error| acp_error(sink.masker, error))?;
        match incoming {
            AcpIncoming::Notification(notification) => {
                let events = projector.project_notification(&notification)?;
                sink.ingest_all(events).await?;
            }
            AcpIncoming::Response { id, outcome, .. } => {
                in_flight_prompts.remove(&id);
                if let Ok(result) = outcome {
                    let flushed = projector.record_prompt_response(&result);
                    sink.ingest_all(flushed).await?;
                }
            }
        }
    }
    Ok(())
}

async fn handle_acp_transport_or_rpc_error(
    error: AntigravityAcpError,
    projector: &mut EventProjector<'_>,
    sink: &mut EventSink<'_, '_>,
) -> Result<CliExecutionResult, AcpRunError> {
    match error {
        AntigravityAcpError::Rpc { error, .. } => {
            finish_rpc_error_result(*error, projector, sink).await
        }
        AntigravityAcpError::ChildExited { status, .. } => {
            let (raw_exit_code, cli_observed_exit) = cli_exit_summary_from_status(&status);
            let exit_code = if raw_exit_code == 0 { 1 } else { raw_exit_code };
            let diagnostic = CliFailureDiagnostic {
                message: "Antigravity exited without a terminal result".into(),
                source: FailureDetailSource::FallbackExitCode,
                failure_reason: None,
                codex_failure: None,
            };
            Ok(acp_execution_result(
                exit_code,
                cli_observed_exit,
                None,
                Some(diagnostic),
            ))
        }
        AntigravityAcpError::Disconnected { .. } => {
            let diagnostic = CliFailureDiagnostic {
                message: "Antigravity exited without a terminal result".into(),
                source: FailureDetailSource::FallbackExitCode,
                failure_reason: None,
                codex_failure: None,
            };
            Ok(acp_execution_result(1, None, None, Some(diagnostic)))
        }
        other => Err(AcpRunError::Execution(acp_error(sink.masker, other))),
    }
}

async fn finish_rpc_error_result(
    rpc_error: JsonRpcError,
    projector: &mut EventProjector<'_>,
    sink: &mut EventSink<'_, '_>,
) -> Result<CliExecutionResult, AcpRunError> {
    let (events, diagnostic) = projector.finish_rpc_error(&rpc_error);
    sink.ingestor.replace_failure_diagnostic(diagnostic.clone());
    let jsonl_result = sink.emit_terminal_events(events).await?;
    Ok(acp_execution_result(
        1,
        None,
        jsonl_result,
        Some(diagnostic),
    ))
}

async fn next_acp_run_event(
    client: &mut AntigravityAcpClient,
    active_input: &mut ActiveInputWriter,
    active_input_open: bool,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
) -> Result<AcpRunEvent, AcpRunError> {
    if active_input_open && let Some(frame) = active_input.try_next_frame() {
        return Ok(AcpRunEvent::ActiveInput(Some(frame)));
    }
    if let Some(notification) = client.pop_notification() {
        return Ok(AcpRunEvent::Incoming(Ok(AcpIncoming::Notification(
            notification,
        ))));
    }

    tokio::select! {
        biased;
        frame = active_input.next_frame(), if active_input_open => {
            Ok(AcpRunEvent::ActiveInput(frame))
        }
        incoming = client.next_incoming(ACP_EVENT_LABEL) => {
            Ok(AcpRunEvent::Incoming(incoming))
        }
        heartbeat_result = wait_for_heartbeat(heartbeat_monitor), if !*heartbeat_done => {
            *heartbeat_done = true;
            Err(heartbeat_error(heartbeat_result))
        }
    }
}

async fn settle_active_input_before_stop<Run>(
    mut run: Pin<&mut Run>,
    active_input: &ActiveInputController,
    stopped: AcpRunOutcome,
) -> AcpRunOutcome
where
    Run: Future<Output = Result<CliExecutionResult, AcpRunError>>,
{
    active_input.close_terminal();
    if !active_input.sink_in_flight() {
        return stopped;
    }

    let settle = async {
        tokio::select! {
            biased;
            _ = run.as_mut() => {}
            _ = active_input.wait_for_sink_idle() => {}
        }
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(crate::constants::ACTIVE_INPUT_SINK_QUIESCENCE_TIMEOUT_SECS),
        settle,
    )
    .await;
    stopped
}

async fn run_with_execution_deadline(
    run: impl Future<Output = Result<CliExecutionResult, AcpRunError>>,
    deadline: Option<AgentExecutionDeadline>,
    user_cancellation: &CancellationToken,
    active_input: &ActiveInputController,
) -> AcpRunOutcome {
    tokio::pin!(run);

    let deadline = deadline.map(|deadline| {
        let at = tokio::time::Instant::from_std(deadline.at);
        (tokio::time::sleep_until(at), deadline.timeout_secs)
    });
    let deadline_elapsed = async move {
        match deadline {
            Some((sleep, timeout_secs)) => {
                sleep.await;
                timeout_secs
            }
            None => std::future::pending().await,
        }
    };
    tokio::pin!(deadline_elapsed);

    let stopped = tokio::select! {
        biased;
        result = &mut run => return AcpRunOutcome::Completed(Box::new(result)),
        () = user_cancellation.cancelled() => AcpRunOutcome::UserCancelled,
        timeout_secs = &mut deadline_elapsed => AcpRunOutcome::ExecutionTimedOut {
            timeout_secs,
        },
    };
    settle_active_input_before_stop(run.as_mut(), active_input, stopped).await
}

fn build_acp_config(
    launch: &Launch,
    runtime: &CliRuntimeConfig<'_>,
    workload_containment: Option<crate::workload_containment::WorkloadContainment>,
) -> Result<AntigravityAcpConfig, AgentError> {
    let (binary, args) = launch
        .argv
        .split_first()
        .ok_or_else(|| AgentError::Execution("empty antigravity command".into()))?;
    let mut child_env_values = child_env::values_for_runtime(runtime);
    configure_env(&mut child_env_values);
    if let Some(containment) = workload_containment.as_ref() {
        let (key, value) = containment.tool_placement_env();
        child_env_values.push((key.to_string(), value));
    }
    let child_env_values = child_env::normalize_values(child_env_values);
    Ok(AntigravityAcpConfig {
        binary: PathBuf::from(binary),
        args: args.to_vec(),
        child_env_values,
        current_dir: PathBuf::from(paths::CANONICAL_WORKING_DIR),
        workload_containment,
    })
}

async fn start_or_resume_session(
    client: &mut AntigravityAcpClient,
    runtime: &CliRuntimeConfig<'_>,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
) -> Result<Result<(Value, bool), AntigravityAcpError>, AcpRunError> {
    let resume_session_id = runtime.resume_session_id.as_ref();
    if resume_session_id.is_empty() {
        return Ok(race_with_heartbeat(
            client.request_value("session/new", build_session_new_params(runtime)),
            heartbeat_monitor,
            heartbeat_done,
        )
        .await?
        .map(|value| (value, false)));
    }
    let resumed = race_with_heartbeat(
        client.request_value(
            "session/resume",
            build_session_resume_params(runtime, resume_session_id),
        ),
        heartbeat_monitor,
        heartbeat_done,
    )
    .await?;
    match resumed {
        Ok(value) => Ok(Ok((value, true))),
        Err(AntigravityAcpError::Rpc { method, error })
            if has_non_empty_recovery_prompt(runtime.native_continuation)
                && method == "session/resume"
                && is_missing_or_unreadable_session_error(&error) =>
        {
            log_warn!(
                LOG_TAG,
                "Antigravity ACP session/resume could not read retained session; starting fresh session with recovery context"
            );
            let mut fresh = runtime.clone();
            fresh.enable_native_recovery();
            Ok(race_with_heartbeat(
                client.request_value("session/new", build_session_new_params(&fresh)),
                heartbeat_monitor,
                heartbeat_done,
            )
            .await?
            .map(|value| (value, false)))
        }
        Err(error) => Ok(Err(error)),
    }
}

pub(super) fn session_id_from_response(
    response: &Value,
    resumed_session_id: Option<&str>,
) -> Result<String, AgentError> {
    let raw_id = match response.get("sessionId") {
        Some(value) => value
            .as_str()
            .ok_or_else(|| AgentError::Execution("Invalid Antigravity session ID".into()))?,
        None => resumed_session_id
            .ok_or_else(|| AgentError::Execution("Invalid Antigravity session ID".into()))?,
    };
    if uuid::Uuid::try_parse(raw_id).is_err() {
        return Err(AgentError::Execution(
            "Invalid Antigravity session ID".into(),
        ));
    }
    if let Some(expected) = resumed_session_id
        && raw_id != expected
    {
        return Err(AgentError::Execution(
            "Antigravity session/resume returned a different session ID".into(),
        ));
    }
    Ok(raw_id.to_owned())
}

pub(super) fn has_non_empty_recovery_prompt(
    native_continuation: Option<&guest_contracts::env::NativeContinuation>,
) -> bool {
    native_continuation
        .and_then(|native| native.recovery_prompt.as_deref())
        .is_some_and(|prompt| !prompt.trim().is_empty())
}

fn is_missing_or_unreadable_session_error(error: &JsonRpcError) -> bool {
    (error.code == -32603 && error.message.starts_with("Failed to read session "))
        || (error.code == -32002 && error.message.starts_with("Session not found"))
}

fn build_session_new_params(runtime: &CliRuntimeConfig<'_>) -> Value {
    if runtime.append_system_prompt.is_empty() {
        json!({
            "cwd": paths::CANONICAL_WORKING_DIR,
            "mcpServers": [],
        })
    } else {
        json!({
            "cwd": paths::CANONICAL_WORKING_DIR,
            "mcpServers": [],
            "_meta": {
                "antigravity": {
                    "systemPrompt": {
                        "append": runtime.append_system_prompt.as_ref(),
                    }
                }
            }
        })
    }
}

fn build_session_resume_params(runtime: &CliRuntimeConfig<'_>, session_id: &str) -> Value {
    if runtime.append_system_prompt.is_empty() {
        json!({
            "sessionId": session_id,
            "cwd": paths::CANONICAL_WORKING_DIR,
            "mcpServers": [],
        })
    } else {
        json!({
            "sessionId": session_id,
            "cwd": paths::CANONICAL_WORKING_DIR,
            "mcpServers": [],
            "_meta": {
                "antigravity": {
                    "systemPrompt": {
                        "append": runtime.append_system_prompt.as_ref(),
                    }
                }
            }
        })
    }
}

fn prompt_params(session_id: &str, text: &str) -> Value {
    json!({
        "sessionId": session_id,
        "prompt": [{
            "type": "text",
            "text": text,
        }],
    })
}

fn acp_execution_result(
    exit_code: i32,
    cli_observed_exit: Option<CliObservedExitDiagnostic>,
    jsonl_result: Option<JsonlResultSummary>,
    failure_diagnostic: Option<CliFailureDiagnostic>,
) -> CliExecutionResult {
    CliExecutionResult {
        exit_code,
        cli_observed_exit,
        stderr_lines: Vec::new(),
        last_event_sequence: None,
        event_delivery: None,
        heartbeat: None,
        jsonl_result,
        post_result_cleanup_jsonl_result: None,
        failure_diagnostic,
        control_error: None,
        cli_termination: None,
    }
}

async fn race_with_heartbeat<T>(
    fut: impl Future<Output = Result<T, AntigravityAcpError>>,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
) -> Result<Result<T, AntigravityAcpError>, AcpRunError> {
    tokio::select! {
        biased;
        result = fut => Ok(result),
        heartbeat_result = wait_for_heartbeat(heartbeat_monitor), if !*heartbeat_done => {
            *heartbeat_done = true;
            Err(heartbeat_error(heartbeat_result))
        }
    }
}

async fn wait_for_heartbeat(
    heartbeat_monitor: &mut HeartbeatMonitor,
) -> Result<HeartbeatStatus, oneshot::error::RecvError> {
    match heartbeat_monitor.as_mut() {
        Some(receiver) => receiver.await,
        None => std::future::pending().await,
    }
}

fn heartbeat_error(result: Result<HeartbeatStatus, oneshot::error::RecvError>) -> AcpRunError {
    match result {
        Ok(HeartbeatStatus::Failed(failure)) => AcpRunError::Heartbeat(AcpHeartbeatFailure {
            error: failure.error,
            diagnostic: Some(failure.diagnostic),
            termination_reason: CliTerminationReason::HeartbeatError,
        }),
        Ok(HeartbeatStatus::Stopped) => AcpRunError::Execution(AgentError::Execution(
            "heartbeat stopped before antigravity acp completed".to_string(),
        )),
        Ok(HeartbeatStatus::TaskFailed(message)) => AcpRunError::Heartbeat(AcpHeartbeatFailure {
            error: AgentError::Execution(format!("heartbeat task panicked: {message}")),
            diagnostic: None,
            termination_reason: CliTerminationReason::HeartbeatPanic,
        }),
        Err(error) => AcpRunError::Heartbeat(AcpHeartbeatFailure {
            error: AgentError::Execution(format!(
                "heartbeat task stopped before reporting status: {error}"
            )),
            diagnostic: None,
            termination_reason: CliTerminationReason::HeartbeatPanic,
        }),
    }
}

fn acp_error(masker: &SecretMasker, error: AntigravityAcpError) -> AgentError {
    let message = masker.mask_string(&error.to_string());
    match error {
        AntigravityAcpError::ChildExited { status, .. } => {
            AgentError::CliProcessExited { message, status }
        }
        _ => AgentError::Execution(message),
    }
}
