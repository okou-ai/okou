//! Codex app-server execution backend.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::env::Framework;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;

use super::codex_app_server::{
    CodexAppServerClient, CodexAppServerConfig, CodexAppServerError, ServerNotification,
};
use super::codex_app_server_events::{
    CodexOutputItemKind, CodexOutputItemStart, CodexTurnUsageTracker, IGNORED_NOTIFICATION_METHODS,
    codex_output_item_start, codex_token_usage_update, notification_thread_id,
    notification_to_codex_event,
};
use super::event_delivery::{EventDeliveryRuntime, EventDeliverySender};
use super::{
    AgentExecutionDeadline, BestEffortAgentLog, CliEventIngestor, CliExecutionControls,
    CliExecutionResult, CliRuntimeConfig, HeartbeatMonitor, HeartbeatStatus, LOG_TAG,
    ParsedEventAction, codex_runtime_config,
};
use crate::active_input::{ActiveInputController, ActiveInputFrame, ActiveInputWriter};
use guest_contracts::diagnostics::{
    AGENT_EXECUTION_TIMEOUT_EXIT_CODE, CliTerminationDiagnostic, CliTerminationReason,
    HeartbeatFailureDiagnostic,
};
use guest_telemetry::{log_info, log_warn};

const TURN_NOTIFICATION_LABEL: &str = "turn notification";
const TURN_INTERRUPT_GRACE: Duration = Duration::from_secs(5);
const API_TO_CODEX_OUTPUT_ITEM_STARTED: &str = "api_to_codex_output_item_started";
const API_TO_CODEX_AGENT_MESSAGE_ITEM_STARTED: &str = "api_to_codex_agent_message_item_started";
const INVALID_PARAMS_RPC_CODE: i64 = -32602;
const INPUT_TOO_LARGE_ERROR_CODE: &str = "input_too_large";

struct NotificationIngestResult {
    emitted_thread_started: bool,
    active_input_ready: bool,
    terminal_exit_code: Option<i32>,
}

#[derive(Default)]
struct PreparedNotificationIngest {
    events: Vec<Value>,
    output_item_start: Option<CodexOutputItemStart>,
    emitted_thread_started: bool,
    active_input_ready: bool,
    terminal_exit_code: Option<i32>,
}

#[derive(Default)]
struct CodexNotificationState {
    citation_repair: super::codex_citation_repair::NativeCitationRepair,
    thread_started_emitted: bool,
    secondary_thread_notification_logged: bool,
    turn_usage: CodexTurnUsageTracker,
    allow_historical_usage: bool,
}

struct ThreadIdentity {
    wire_id: String,
    canonical_id: String,
}

struct ActiveTurnIdentity {
    wire_thread_id: String,
    canonical_thread_id: String,
    turn_id: String,
}

struct EventIngestSink<'a, 'startup> {
    ingestor: &'a mut CliEventIngestor<'startup>,
    output_timing: &'a mut CodexOutputTiming,
    agent_log: &'a mut BestEffortAgentLog,
    masker: &'a SecretMasker,
    should_send_events: bool,
    event_tx: &'a EventDeliverySender,
}

#[derive(Default)]
struct CodexOutputTiming {
    output_item_started: bool,
    agent_message_item_started: bool,
}

impl CodexOutputTiming {
    fn record(&mut self, start: &CodexOutputItemStart, ingestor: &CliEventIngestor) {
        if !self.output_item_started {
            self.output_item_started = true;
            ingestor.record_e2e_from_api_start_at(
                API_TO_CODEX_OUTPUT_ITEM_STARTED,
                start.started_at_ms,
            );
        }
        if start.kind == CodexOutputItemKind::AgentMessage && !self.agent_message_item_started {
            self.agent_message_item_started = true;
            ingestor.record_e2e_from_api_start_at(
                API_TO_CODEX_AGENT_MESSAGE_ITEM_STARTED,
                start.started_at_ms,
            );
        }
    }
}

struct CodexTurnScope<'a> {
    thread_id: &'a str,
    turn_id: &'a str,
}

enum CodexRunEvent {
    Notification(ServerNotification),
    ActiveInput(Option<ActiveInputFrame>),
}

enum AppServerRunOutcome {
    Completed(Box<Result<CliExecutionResult, CodexRunError>>),
    ExecutionTimedOut { timeout_secs: u64 },
    UserCancelled,
}

enum CodexRunError {
    Execution(AgentError),
    Heartbeat(CodexHeartbeatFailure),
}

struct CodexHeartbeatFailure {
    error: AgentError,
    diagnostic: Option<HeartbeatFailureDiagnostic>,
    termination_reason: CliTerminationReason,
}

impl From<AgentError> for CodexRunError {
    fn from(error: AgentError) -> Self {
        Self::Execution(error)
    }
}

impl std::fmt::Display for CodexRunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Execution(error) => error.fmt(formatter),
            Self::Heartbeat(failure) => failure.error.fmt(formatter),
        }
    }
}

impl AppServerRunOutcome {
    fn is_heartbeat_failure(&self) -> bool {
        matches!(
            self,
            Self::Completed(result)
                if matches!(result.as_ref(), Err(CodexRunError::Heartbeat(_)))
        )
    }
}

async fn settle_active_input_before_stop<Run>(
    mut run: Pin<&mut Run>,
    active_input: &ActiveInputController,
    stopped: AppServerRunOutcome,
) -> AppServerRunOutcome
where
    Run: Future<Output = Result<CliExecutionResult, CodexRunError>>,
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
    run: impl Future<Output = Result<CliExecutionResult, CodexRunError>>,
    deadline: Option<AgentExecutionDeadline>,
    user_cancellation: &CancellationToken,
    active_input: &ActiveInputController,
) -> AppServerRunOutcome {
    tokio::pin!(run);

    match deadline {
        Some(deadline) => {
            let deadline_sleep =
                tokio::time::sleep_until(tokio::time::Instant::from_std(deadline.at));
            tokio::pin!(deadline_sleep);
            tokio::select! {
                biased;
                result = &mut run => AppServerRunOutcome::Completed(Box::new(result)),
                () = user_cancellation.cancelled() => {
                    settle_active_input_before_stop(
                        run.as_mut(),
                        active_input,
                        AppServerRunOutcome::UserCancelled,
                    ).await
                },
                () = &mut deadline_sleep => {
                    settle_active_input_before_stop(
                        run.as_mut(),
                        active_input,
                        AppServerRunOutcome::ExecutionTimedOut {
                            timeout_secs: deadline.timeout_secs,
                        },
                    ).await
                },
            }
        }
        None => {
            tokio::select! {
                biased;
                result = &mut run => AppServerRunOutcome::Completed(Box::new(result)),
                () = user_cancellation.cancelled() => {
                    settle_active_input_before_stop(
                        run.as_mut(),
                        active_input,
                        AppServerRunOutcome::UserCancelled,
                    ).await
                },
            }
        }
    }
}

async fn interrupt_active_turn(
    client: &mut CodexAppServerClient,
    active_turn: &ActiveTurnIdentity,
    sink: &mut EventIngestSink<'_, '_>,
    active_input: &ActiveInputWriter,
    notification_state: &mut CodexNotificationState,
) -> Result<(), AgentError> {
    match client
        .request_value(
            "turn/interrupt",
            json!({
                "threadId": active_turn.wire_thread_id,
                "turnId": active_turn.turn_id,
            }),
        )
        .await
    {
        Ok(_) | Err(CodexAppServerError::Rpc { .. }) => {}
        Err(error) => return Err(app_server_error(sink.masker, error)),
    }

    let notification_scope = CodexTurnScope {
        thread_id: &active_turn.canonical_thread_id,
        turn_id: &active_turn.turn_id,
    };
    loop {
        let notification = client
            .next_notification(TURN_NOTIFICATION_LABEL)
            .await
            .map_err(|error| app_server_error(sink.masker, error))?;
        let is_turn_completed = notification.method == "turn/completed";
        let ingest_result = ingest_run_notification(
            notification,
            sink,
            active_input,
            &notification_scope,
            notification_state,
        )
        .await?;
        if is_turn_completed && ingest_result.terminal_exit_code.is_some() {
            return Ok(());
        }
    }
}

pub(super) async fn execute_codex_app_server_for_runtime(
    masker: &SecretMasker,
    mut heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    controls: CliExecutionControls<'_>,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    log_info!(LOG_TAG, "Starting codex app-server execution...");

    let should_send_events = http.has_api();
    let event_delivery = EventDeliveryRuntime::start(http.clone(), &runtime.run_id, 0, false)?;

    let run_result = run_codex_app_server(
        masker,
        &mut heartbeat_monitor,
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

async fn run_codex_app_server(
    masker: &SecretMasker,
    heartbeat_monitor: &mut HeartbeatMonitor,
    should_send_events: bool,
    event_tx: &EventDeliverySender,
    controls: CliExecutionControls<'_>,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    let CliExecutionControls {
        mut active_input,
        user_cancellation,
        codex_startup,
        workload_containment,
        session_metadata,
    } = controls;
    let mut agent_log = BestEffortAgentLog::open(runtime.agent_log_file.as_ref());
    let mut ingestor =
        CliEventIngestor::new_with_session_metadata(runtime, codex_startup, session_metadata, 0);
    let mut output_timing = CodexOutputTiming::default();
    let resume_thread_id = resume_thread_id_from_runtime(runtime)?;
    let can_replay_historical_usage = resume_thread_id.is_some();
    let mut notification_state = CodexNotificationState {
        allow_historical_usage: can_replay_historical_usage,
        ..CodexNotificationState::default()
    };
    let mut active_turn = None;
    let mut client = CodexAppServerClient::spawn(codex_app_server_config(
        runtime,
        workload_containment.cloned(),
    ))
    .map_err(|error| app_server_error(masker, error))?;
    let mut heartbeat_done = false;
    let active_input_controller = active_input.controller();

    let run = async {
        race_with_heartbeat(
            client.initialize(),
            heartbeat_monitor,
            &mut heartbeat_done,
            masker,
        )
        .await?;
        let thread_response = race_with_heartbeat(
            start_or_resume_thread(&mut client, resume_thread_id.as_deref(), runtime),
            heartbeat_monitor,
            &mut heartbeat_done,
            masker,
        )
        .await?;
        let thread_identity = thread_identity_from_response(&thread_response)?;
        validate_resumed_thread_id(&thread_identity.canonical_id, resume_thread_id.as_deref())?;
        notification_state.citation_repair =
            super::codex_citation_repair::NativeCitationRepair::new(
                runtime.codex_home(),
                &thread_identity.canonical_id,
                resume_thread_id.is_some(),
            );

        while let Some(notification) = client.pop_notification() {
            let mut sink = EventIngestSink {
                ingestor: &mut ingestor,
                output_timing: &mut output_timing,
                agent_log: &mut agent_log,
                masker,
                should_send_events,
                event_tx,
            };
            let ingest_result = ingest_notification(
                notification,
                &mut sink,
                &thread_identity.canonical_id,
                "",
                None,
                &mut notification_state,
            )
            .await?;
            notification_state.thread_started_emitted =
                notification_state.thread_started_emitted || ingest_result.emitted_thread_started;
        }

        if !notification_state.thread_started_emitted {
            let mut sink = EventIngestSink {
                ingestor: &mut ingestor,
                output_timing: &mut output_timing,
                agent_log: &mut agent_log,
                masker,
                should_send_events,
                event_tx,
            };
            ingest_event(
                synthesize_thread_started_event(&thread_identity.canonical_id),
                &mut sink,
            )
            .await?;
            notification_state.thread_started_emitted = true;
        }

        let turn_response = race_with_heartbeat(
            client.request_value(
                "turn/start",
                turn_start_params(&thread_identity.wire_id, runtime),
            ),
            heartbeat_monitor,
            &mut heartbeat_done,
            masker,
        )
        .await?;
        let turn_id = turn_id_from_response(&turn_response)?;
        active_turn = Some(ActiveTurnIdentity {
            wire_thread_id: thread_identity.wire_id.clone(),
            canonical_thread_id: thread_identity.canonical_id.clone(),
            turn_id: turn_id.clone(),
        });
        let mut active_input_open = active_input.is_enabled();
        let mut turn_started_observed = false;
        notification_state.allow_historical_usage = can_replay_historical_usage;

        let exit_code = loop {
            let event = next_codex_run_event(
                &mut client,
                &mut active_input,
                active_input_open,
                turn_started_observed,
                heartbeat_monitor,
                &mut heartbeat_done,
                masker,
            )
            .await?;
            match event {
                CodexRunEvent::Notification(notification) => {
                    let mut sink = EventIngestSink {
                        ingestor: &mut ingestor,
                        output_timing: &mut output_timing,
                        agent_log: &mut agent_log,
                        masker,
                        should_send_events,
                        event_tx,
                    };
                    let notification_scope = CodexTurnScope {
                        thread_id: &thread_identity.canonical_id,
                        turn_id: &turn_id,
                    };
                    let ingest_result = ingest_run_notification(
                        notification,
                        &mut sink,
                        &active_input,
                        &notification_scope,
                        &mut notification_state,
                    )
                    .await?;
                    turn_started_observed =
                        turn_started_observed || ingest_result.active_input_ready;
                    if let Some(exit_code) = ingest_result.terminal_exit_code {
                        active_input.close_terminal();
                        break exit_code;
                    }
                }
                CodexRunEvent::ActiveInput(Some(frame)) => {
                    let steer_scope = CodexTurnScope {
                        thread_id: &thread_identity.wire_id,
                        turn_id: &turn_id,
                    };
                    steer_active_input(
                        &mut client,
                        &active_input,
                        frame,
                        &steer_scope,
                        heartbeat_monitor,
                        &mut heartbeat_done,
                        masker,
                    )
                    .await?;
                    let mut sink = EventIngestSink {
                        ingestor: &mut ingestor,
                        output_timing: &mut output_timing,
                        agent_log: &mut agent_log,
                        masker,
                        should_send_events,
                        event_tx,
                    };
                    let notification_scope = CodexTurnScope {
                        thread_id: &thread_identity.canonical_id,
                        turn_id: &turn_id,
                    };
                    if let Some(exit_code) = drain_queued_notifications(
                        &mut client,
                        &mut sink,
                        &active_input,
                        &notification_scope,
                        &mut notification_state,
                    )
                    .await?
                    {
                        active_input.close_terminal();
                        break exit_code;
                    }
                }
                CodexRunEvent::ActiveInput(None) => {
                    active_input_open = false;
                }
            }
        };

        Ok::<CliExecutionResult, CodexRunError>(CliExecutionResult {
            exit_code,
            // App-server terminal events report a protocol-level turn status,
            // not the child process wait status.
            cli_observed_exit: None,
            stderr_lines: Vec::new(),
            last_event_sequence: None,
            event_delivery: None,
            heartbeat: None,
            jsonl_result: None,
            post_result_cleanup_jsonl_result: None,
            failure_diagnostic: ingestor.failure_diagnostic(),
            control_error: None,
            cli_termination: None,
            active_input_delivery_ids: Vec::new(),
        })
    };
    let run_outcome = run_with_execution_deadline(
        run,
        runtime.agent_execution_deadline,
        &user_cancellation,
        &active_input_controller,
    )
    .await;
    active_input.close_terminal();

    let interrupted_terminal = if matches!(
        &run_outcome,
        AppServerRunOutcome::ExecutionTimedOut { .. } | AppServerRunOutcome::UserCancelled
    ) && let Some(active_turn) = active_turn.as_ref()
    {
        let mut sink = EventIngestSink {
            ingestor: &mut ingestor,
            output_timing: &mut output_timing,
            agent_log: &mut agent_log,
            masker,
            should_send_events,
            event_tx,
        };
        match tokio::time::timeout(
            TURN_INTERRUPT_GRACE,
            interrupt_active_turn(
                &mut client,
                active_turn,
                &mut sink,
                &active_input,
                &mut notification_state,
            ),
        )
        .await
        {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                log_warn!(
                    LOG_TAG,
                    "Codex active turn interruption failed; terminating app-server: {}",
                    masker.mask_string(&error.to_string())
                );
                false
            }
            Err(_) => {
                log_warn!(
                    LOG_TAG,
                    "Codex active turn interruption timed out; terminating app-server"
                );
                false
            }
        }
    } else {
        false
    };

    let shutdown_result = match &run_outcome {
        AppServerRunOutcome::Completed(result) if result.is_ok() => client.shutdown().await,
        AppServerRunOutcome::ExecutionTimedOut { .. } | AppServerRunOutcome::UserCancelled
            if interrupted_terminal =>
        {
            match client.shutdown().await {
                Ok(()) => Ok(()),
                Err(error) => {
                    log_warn!(
                        LOG_TAG,
                        "Codex app-server shutdown failed after turn interruption; terminating: {}",
                        masker.mask_string(&error.to_string())
                    );
                    client.terminate().await
                }
            }
        }
        AppServerRunOutcome::Completed(_)
        | AppServerRunOutcome::ExecutionTimedOut { .. }
        | AppServerRunOutcome::UserCancelled => client.terminate().await,
    };
    if shutdown_result.is_ok()
        && matches!(
            &run_outcome,
            AppServerRunOutcome::ExecutionTimedOut { .. } | AppServerRunOutcome::UserCancelled
        )
        && active_input_controller.sink_in_flight()
    {
        active_input_controller.mark_sink_stopped_after_consumer_exit();
    }
    let active_input_delivery_ids = active_input_controller.finalize_receipts().await;
    let stderr_lines = masker.mask_diagnostic_lines(client.stderr_tail().to_vec());
    for event in notification_state.citation_repair.abandon() {
        let mut sink = EventIngestSink {
            ingestor: &mut ingestor,
            output_timing: &mut output_timing,
            agent_log: &mut agent_log,
            masker,
            should_send_events,
            event_tx,
        };
        ingest_event(event, &mut sink).await?;
    }
    // Publish buffered event-log bytes after the child is stopped and before
    // callers observe the finished app-server execution.
    agent_log.flush().await;
    let active_input_delivery_ids = match active_input_delivery_ids {
        Ok(delivery_ids) => delivery_ids,
        Err(active_input_error) if run_outcome.is_heartbeat_failure() => {
            log_warn!(
                LOG_TAG,
                "Codex active-input cleanup failed after heartbeat failure: {}",
                masker.mask_string(&active_input_error.to_string())
            );
            Vec::new()
        }
        Err(active_input_error) => {
            if let Err(shutdown_error) = &shutdown_result {
                return Err(AgentError::Execution(format!(
                    "codex app-server cleanup failed before active-input quiescence: {}",
                    masker.mask_string(&shutdown_error.to_string())
                )));
            }
            return Err(active_input_error);
        }
    };

    match run_outcome {
        AppServerRunOutcome::Completed(run_result) => match (*run_result, shutdown_result) {
            (Ok(mut result), Ok(())) => {
                result.stderr_lines = stderr_lines;
                result.active_input_delivery_ids = active_input_delivery_ids;
                Ok(result)
            }
            (Ok(_result), Err(error)) => Err(AgentError::Execution(format!(
                "codex app-server shutdown failed: {}",
                masker.mask_string(&error.to_string())
            ))),
            (Err(CodexRunError::Execution(error)), Ok(())) => {
                Err(with_stderr_tail(error, &stderr_lines))
            }
            (Err(CodexRunError::Execution(error)), Err(shutdown_error)) => {
                let shutdown_error = masker.mask_string(&shutdown_error.to_string());
                log_warn!(
                    LOG_TAG,
                    "codex app-server shutdown failed after run error: {shutdown_error}"
                );
                Err(with_stderr_tail(error, &stderr_lines))
            }
            (Err(CodexRunError::Heartbeat(failure)), shutdown_result) => {
                if let Err(shutdown_error) = shutdown_result {
                    let shutdown_error = masker.mask_string(&shutdown_error.to_string());
                    log_warn!(
                        LOG_TAG,
                        "codex app-server termination failed after heartbeat failure: {shutdown_error}"
                    );
                }
                Ok(CliExecutionResult {
                    exit_code: 1,
                    cli_observed_exit: None,
                    stderr_lines,
                    last_event_sequence: None,
                    event_delivery: None,
                    heartbeat: failure.diagnostic,
                    jsonl_result: None,
                    post_result_cleanup_jsonl_result: None,
                    failure_diagnostic: ingestor.failure_diagnostic(),
                    control_error: Some(failure.error),
                    cli_termination: Some(CliTerminationDiagnostic::new(
                        failure.termination_reason,
                    )),
                    active_input_delivery_ids,
                })
            }
        },
        AppServerRunOutcome::ExecutionTimedOut { timeout_secs } => {
            if let Err(shutdown_error) = shutdown_result {
                let shutdown_error = masker.mask_string(&shutdown_error.to_string());
                log_warn!(
                    LOG_TAG,
                    "codex app-server termination failed after execution timeout: {shutdown_error}"
                );
            }
            Ok(CliExecutionResult {
                exit_code: AGENT_EXECUTION_TIMEOUT_EXIT_CODE,
                cli_observed_exit: None,
                stderr_lines,
                last_event_sequence: None,
                event_delivery: None,
                heartbeat: None,
                jsonl_result: None,
                post_result_cleanup_jsonl_result: None,
                failure_diagnostic: ingestor.failure_diagnostic(),
                control_error: Some(AgentError::Execution(format!(
                    "Agent execution timed out after {timeout_secs} seconds"
                ))),
                cli_termination: Some(CliTerminationDiagnostic::new(
                    CliTerminationReason::ExecutionTimeout,
                )),
                active_input_delivery_ids,
            })
        }
        AppServerRunOutcome::UserCancelled => {
            if let Err(shutdown_error) = shutdown_result {
                let shutdown_error = masker.mask_string(&shutdown_error.to_string());
                log_warn!(
                    LOG_TAG,
                    "codex app-server termination failed after user cancellation: {shutdown_error}"
                );
            }
            Ok(CliExecutionResult {
                exit_code: 1,
                cli_observed_exit: None,
                stderr_lines,
                last_event_sequence: None,
                event_delivery: None,
                heartbeat: None,
                jsonl_result: None,
                post_result_cleanup_jsonl_result: None,
                failure_diagnostic: ingestor.failure_diagnostic(),
                control_error: Some(AgentError::Execution("Run cancelled by user".to_string())),
                cli_termination: Some(CliTerminationDiagnostic::new(
                    CliTerminationReason::UserCancellation,
                )),
                active_input_delivery_ids,
            })
        }
    }
}

fn codex_app_server_config(
    runtime: &CliRuntimeConfig<'_>,
    workload_containment: Option<crate::workload_containment::WorkloadContainment>,
) -> CodexAppServerConfig {
    let binary = if runtime.use_mock_codex {
        log_info!(LOG_TAG, "Using mock-codex app-server for testing");
        PathBuf::from(runtime.mock_codex_path.as_ref())
    } else {
        PathBuf::from("codex")
    };
    let codex_home = PathBuf::from(runtime.codex_home());
    let child_user_env = runtime.child_user_env();
    let config_overrides = runtime.codex_startup_config_overrides();
    let mut config = CodexAppServerConfig::new(binary, codex_home)
        .with_child_env(
            runtime.home_dir.as_ref(),
            child_user_env.as_ref(),
            runtime.api_url.as_ref(),
        )
        .with_config_overrides(config_overrides)
        .with_current_dir(paths::CANONICAL_WORKING_DIR)
        .with_workload_containment(workload_containment)
        .with_opt_out_notification_methods(IGNORED_NOTIFICATION_METHODS.iter().copied());
    if runtime.use_mock_codex {
        let scenario = std::env::var("MOCK_CODEX_APP_SERVER_SCENARIO")
            .unwrap_or_else(|_| "runtime-turn-complete".to_string());
        config = config.with_env("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
    }
    if runtime.codex_oauth_mode {
        config = config.with_env(
            "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
            crate::codex_auth::REFRESH_TOKEN_NOOP_URL,
        );
    }
    config
}

async fn start_or_resume_thread(
    client: &mut CodexAppServerClient,
    resume_thread_id: Option<&str>,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<Value, CodexAppServerError> {
    match resume_thread_id {
        Some(resume_thread_id) => {
            let mut params = thread_param_fields(runtime);
            params.insert(
                "threadId".to_string(),
                Value::String(resume_thread_id.to_string()),
            );
            params.insert("excludeTurns".to_string(), Value::Bool(true));
            client
                .request_value("thread/resume", Value::Object(params))
                .await
        }
        None => {
            client
                .request_value("thread/start", thread_params(runtime))
                .await
        }
    }
}

fn thread_params(runtime: &CliRuntimeConfig<'_>) -> Value {
    Value::Object(thread_param_fields(runtime))
}

fn thread_param_fields(runtime: &CliRuntimeConfig<'_>) -> Map<String, Value> {
    let mut params = Map::new();
    params.insert(
        "cwd".to_string(),
        Value::String(paths::CANONICAL_WORKING_DIR.to_string()),
    );
    params.insert(
        "approvalPolicy".to_string(),
        Value::String("never".to_string()),
    );
    params.insert(
        "approvalsReviewer".to_string(),
        Value::String("user".to_string()),
    );
    params.insert(
        "sandbox".to_string(),
        Value::String("danger-full-access".to_string()),
    );
    params.insert(
        "config".to_string(),
        json!({
            "features.memories": true,
        }),
    );
    if !runtime.openai_model.is_empty() {
        params.insert(
            "model".to_string(),
            Value::String(runtime.openai_model.to_string()),
        );
    }
    if let Some(provider_id) = runtime.codex_model_provider_id() {
        params.insert(
            "modelProvider".to_string(),
            Value::String(provider_id.to_string()),
        );
    }
    if !runtime.append_system_prompt.is_empty() {
        params.insert(
            "developerInstructions".to_string(),
            Value::String(runtime.append_system_prompt.to_string()),
        );
    }
    params
}

fn turn_start_params(thread_id: &str, runtime: &CliRuntimeConfig<'_>) -> Value {
    let mut params = Map::new();
    params.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    params.insert(
        "input".to_string(),
        Value::Array(vec![json!({
            "type": "text",
            "text": runtime.prompt.as_ref(),
            "text_elements": [],
        })]),
    );
    params.insert(
        "cwd".to_string(),
        Value::String(paths::CANONICAL_WORKING_DIR.to_string()),
    );
    params.insert(
        "approvalPolicy".to_string(),
        Value::String("never".to_string()),
    );
    params.insert(
        "approvalsReviewer".to_string(),
        Value::String("user".to_string()),
    );
    params.insert(
        "sandboxPolicy".to_string(),
        json!({ "type": "dangerFullAccess" }),
    );
    if !runtime.openai_model.is_empty() {
        params.insert(
            "model".to_string(),
            Value::String(runtime.openai_model.to_string()),
        );
    }
    if let Some(effort) = runtime.reasoning_effort.or_else(|| {
        codex_runtime_config::default_reasoning_effort_for_model(runtime.openai_model.as_ref())
    }) {
        params.insert("effort".to_string(), Value::String(effort.to_string()));
    }
    Value::Object(params)
}

async fn next_codex_run_event(
    client: &mut CodexAppServerClient,
    active_input: &mut ActiveInputWriter,
    active_input_open: bool,
    active_input_ready: bool,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
    masker: &SecretMasker,
) -> Result<CodexRunEvent, CodexRunError> {
    let active_input_can_be_read = can_read_active_input(active_input_open, active_input_ready);
    // Do not let buffered terminal notifications overtake input the control
    // path already accepted.
    if active_input_can_be_read && let Some(frame) = active_input.try_next_frame() {
        return Ok(CodexRunEvent::ActiveInput(Some(frame)));
    }
    if let Some(notification) = client.pop_notification() {
        return Ok(CodexRunEvent::Notification(notification));
    }

    tokio::select! {
        biased;
        frame = active_input.next_frame(), if active_input_can_be_read => {
            Ok(CodexRunEvent::ActiveInput(frame))
        }
        notification = client.next_notification(TURN_NOTIFICATION_LABEL) => {
            notification
                .map(CodexRunEvent::Notification)
                .map_err(|error| CodexRunError::Execution(app_server_error(masker, error)))
        }
        heartbeat_result = wait_for_heartbeat(heartbeat_monitor), if !*heartbeat_done => {
            *heartbeat_done = true;
            Err(heartbeat_error(heartbeat_result))
        }
    }
}

fn can_read_active_input(active_input_open: bool, active_input_ready: bool) -> bool {
    active_input_open && active_input_ready
}

async fn steer_active_input(
    client: &mut CodexAppServerClient,
    active_input: &ActiveInputWriter,
    frame: ActiveInputFrame,
    target: &CodexTurnScope<'_>,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
    masker: &SecretMasker,
) -> Result<(), CodexRunError> {
    let thread_id = target.thread_id;
    let turn_id = target.turn_id;
    let params = turn_steer_params(thread_id, turn_id, &frame);
    log_info!(
        LOG_TAG,
        "Codex active input steer: target_thread_id={thread_id} captured_active_turn_id={turn_id} expected_turn_id={turn_id} input_uuid={} outcome=attempt",
        frame.uuid
    );
    active_input.mark_writing(&frame.uuid);
    let result = race_with_heartbeat(
        client.request_value("turn/steer", params),
        heartbeat_monitor,
        heartbeat_done,
        masker,
    )
    .await;
    match result {
        Ok(_) => {
            active_input.mark_backend_accepted_without_replay(&frame)?;
            log_info!(
                LOG_TAG,
                "Codex active input steer: target_thread_id={thread_id} captured_active_turn_id={turn_id} expected_turn_id={turn_id} input_uuid={} outcome=active_turn_advanced",
                frame.uuid
            );
            Ok(())
        }
        Err(error) => {
            active_input.mark_backend_failed(&frame);
            active_input.close_terminal();
            log_warn!(
                LOG_TAG,
                "Codex active input steer: target_thread_id={thread_id} captured_active_turn_id={turn_id} expected_turn_id={turn_id} input_uuid={} outcome=failed error={error}",
                frame.uuid
            );
            match error {
                CodexRunError::Execution(error) => {
                    Err(CodexRunError::Execution(AgentError::Execution(format!(
                        "codex app-server active input steer failed for input {}: {error}",
                        frame.uuid
                    ))))
                }
                CodexRunError::Heartbeat(failure) => Err(CodexRunError::Heartbeat(failure)),
            }
        }
    }
}

fn turn_steer_params(thread_id: &str, turn_id: &str, frame: &ActiveInputFrame) -> Value {
    json!({
        "threadId": thread_id,
        "expectedTurnId": turn_id,
        "clientUserMessageId": frame.uuid.as_str(),
        "input": [{
            "type": "text",
            "text": frame.text.as_str(),
            "text_elements": [],
        }],
    })
}

async fn race_with_heartbeat<T>(
    app_server_wait: impl Future<Output = Result<T, CodexAppServerError>>,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
    masker: &SecretMasker,
) -> Result<T, CodexRunError> {
    // If heartbeat wins, the caller exits the run and shuts the app-server
    // down. We intentionally do not try to reuse a possibly half-read JSON-RPC
    // stream after cancelling `app_server_wait`.
    tokio::select! {
        biased;
        result = app_server_wait => result
            .map_err(|error| CodexRunError::Execution(app_server_error(masker, error))),
        heartbeat_result = wait_for_heartbeat(heartbeat_monitor), if !*heartbeat_done => {
            *heartbeat_done = true;
            Err(heartbeat_error(heartbeat_result))
        }
    }
}

async fn drain_queued_notifications(
    client: &mut CodexAppServerClient,
    sink: &mut EventIngestSink<'_, '_>,
    active_input: &ActiveInputWriter,
    scope: &CodexTurnScope<'_>,
    notification_state: &mut CodexNotificationState,
) -> Result<Option<i32>, AgentError> {
    let mut prepared_notifications = Vec::new();
    let mut prepared_thread_started_emitted = notification_state.thread_started_emitted;
    while let Some(notification) = client.pop_notification() {
        let prepared = prepare_notification_ingest(
            notification,
            prepared_thread_started_emitted,
            scope.thread_id,
            scope.turn_id,
            notification_state,
        )?;
        prepared_thread_started_emitted =
            prepared_thread_started_emitted || prepared.emitted_thread_started;
        let is_terminal = prepared.terminal_exit_code.is_some();
        prepared_notifications.push(prepared);
        if is_terminal {
            active_input.close_terminal();
            break;
        }
    }
    for prepared in prepared_notifications {
        record_output_item_start(prepared.output_item_start.as_ref(), sink);
        for event in prepared.events {
            ingest_event(event, sink).await?;
        }
        notification_state.thread_started_emitted =
            notification_state.thread_started_emitted || prepared.emitted_thread_started;
        if let Some(exit_code) = prepared.terminal_exit_code {
            return Ok(Some(exit_code));
        }
    }
    Ok(None)
}

async fn ingest_run_notification(
    notification: ServerNotification,
    sink: &mut EventIngestSink<'_, '_>,
    active_input: &ActiveInputWriter,
    scope: &CodexTurnScope<'_>,
    notification_state: &mut CodexNotificationState,
) -> Result<NotificationIngestResult, AgentError> {
    let prepared = prepare_notification_ingest(
        notification,
        notification_state.thread_started_emitted,
        scope.thread_id,
        scope.turn_id,
        notification_state,
    )?;
    record_output_item_start(prepared.output_item_start.as_ref(), sink);
    // Close before any ingest await so the control path cannot accept input
    // after this run has already observed a terminal turn event.
    if prepared.terminal_exit_code.is_some() {
        active_input.close_terminal();
    }
    let result = NotificationIngestResult {
        emitted_thread_started: prepared.emitted_thread_started,
        active_input_ready: prepared.active_input_ready,
        terminal_exit_code: prepared.terminal_exit_code,
    };
    for event in prepared.events {
        ingest_event(event, sink).await?;
    }
    notification_state.thread_started_emitted =
        notification_state.thread_started_emitted || prepared.emitted_thread_started;
    Ok(result)
}

fn app_server_error(masker: &SecretMasker, error: CodexAppServerError) -> AgentError {
    if let Some((actual_chars, max_chars)) = codex_input_too_large_counts(&error) {
        return AgentError::CodexInputTooLarge {
            actual_chars,
            max_chars,
        };
    }
    AgentError::Execution(masker.mask_string(&error.to_string()))
}

fn codex_input_too_large_counts(error: &CodexAppServerError) -> Option<(u64, u64)> {
    let CodexAppServerError::Rpc {
        method,
        error: rpc_error,
        ..
    } = error
    else {
        return None;
    };
    if method != "turn/start" || rpc_error.code != INVALID_PARAMS_RPC_CODE {
        return None;
    }
    let data = rpc_error.data.as_ref()?.as_object()?;
    if data.get("input_error_code")?.as_str()? != INPUT_TOO_LARGE_ERROR_CODE {
        return None;
    }
    let actual_chars = data.get("actual_chars")?.as_u64()?;
    let max_chars = data.get("max_chars")?.as_u64()?;
    (max_chars > 0 && actual_chars > max_chars).then_some((actual_chars, max_chars))
}

async fn wait_for_heartbeat(
    heartbeat_monitor: &mut HeartbeatMonitor,
) -> Result<HeartbeatStatus, oneshot::error::RecvError> {
    match heartbeat_monitor.as_mut() {
        Some(receiver) => receiver.await,
        None => std::future::pending().await,
    }
}

fn heartbeat_error(result: Result<HeartbeatStatus, oneshot::error::RecvError>) -> CodexRunError {
    match result {
        Ok(HeartbeatStatus::Failed(failure)) => CodexRunError::Heartbeat(CodexHeartbeatFailure {
            error: failure.error,
            diagnostic: Some(failure.diagnostic),
            termination_reason: CliTerminationReason::HeartbeatError,
        }),
        Ok(HeartbeatStatus::Stopped) => CodexRunError::Execution(AgentError::Execution(
            "heartbeat stopped before codex app-server completed".to_string(),
        )),
        Ok(HeartbeatStatus::TaskFailed(message)) => {
            CodexRunError::Heartbeat(CodexHeartbeatFailure {
                error: AgentError::Execution(format!("heartbeat task panicked: {message}")),
                diagnostic: None,
                termination_reason: CliTerminationReason::HeartbeatPanic,
            })
        }
        Err(error) => CodexRunError::Heartbeat(CodexHeartbeatFailure {
            error: AgentError::Execution(format!(
                "heartbeat task stopped before reporting status: {error}"
            )),
            diagnostic: None,
            termination_reason: CliTerminationReason::HeartbeatPanic,
        }),
    }
}

async fn ingest_notification(
    notification: ServerNotification,
    sink: &mut EventIngestSink<'_, '_>,
    expected_thread_id: &str,
    active_turn_id: &str,
    terminal_active_input: Option<&ActiveInputWriter>,
    notification_state: &mut CodexNotificationState,
) -> Result<NotificationIngestResult, AgentError> {
    let prepared = prepare_notification_ingest(
        notification,
        notification_state.thread_started_emitted,
        expected_thread_id,
        active_turn_id,
        notification_state,
    )?;
    record_output_item_start(prepared.output_item_start.as_ref(), sink);
    if prepared.terminal_exit_code.is_some()
        && let Some(active_input) = terminal_active_input
    {
        active_input.close_terminal();
    }
    let result = NotificationIngestResult {
        emitted_thread_started: prepared.emitted_thread_started,
        active_input_ready: prepared.active_input_ready,
        terminal_exit_code: prepared.terminal_exit_code,
    };
    for event in prepared.events {
        ingest_event(event, sink).await?;
    }
    Ok(result)
}

fn prepare_notification_ingest(
    notification: ServerNotification,
    thread_started_emitted: bool,
    expected_thread_id: &str,
    active_turn_id: &str,
    notification_state: &mut CodexNotificationState,
) -> Result<PreparedNotificationIngest, AgentError> {
    if let Some(secondary_thread_id) =
        secondary_notification_thread_id(&notification, expected_thread_id)
    {
        if !notification_state.secondary_thread_notification_logged {
            log_info!(
                LOG_TAG,
                "Ignoring codex app-server notification for secondary thread: method={} thread_id={secondary_thread_id}",
                notification.method
            );
            notification_state.secondary_thread_notification_logged = true;
        }
        return Ok(PreparedNotificationIngest::default());
    }

    if let Some(update) = codex_token_usage_update(&notification)
        .map_err(|error| AgentError::Execution(error.to_string()))?
    {
        if notification_state.allow_historical_usage
            && (active_turn_id.is_empty() || update.turn_id != active_turn_id)
        {
            validate_scope(
                Some(&update.thread_id),
                None,
                expected_thread_id,
                active_turn_id,
            )?;
            notification_state.turn_usage.observe_replay(update);
        } else {
            validate_scope(
                Some(&update.thread_id),
                Some(&update.turn_id),
                expected_thread_id,
                active_turn_id,
            )?;
            notification_state
                .turn_usage
                .observe_current(update)
                .map_err(|error| AgentError::Execution(error.to_string()))?;
            notification_state.allow_historical_usage = false;
        }
        return Ok(PreparedNotificationIngest::default());
    }

    let output_item_start = codex_output_item_start(&notification)
        .map_err(|error| AgentError::Execution(error.to_string()))?;
    if let Some(start) = &output_item_start {
        validate_scope(
            Some(&start.thread_id),
            Some(&start.turn_id),
            expected_thread_id,
            active_turn_id,
        )?;
    }
    let Some(mut event) = notification_to_codex_event(&notification)
        .map_err(|error| AgentError::Execution(error.to_string()))?
    else {
        return Ok(PreparedNotificationIngest {
            events: notification_state.citation_repair.drain(false),
            output_item_start,
            ..PreparedNotificationIngest::default()
        });
    };
    validate_event_scope(&event, expected_thread_id, active_turn_id)?;
    if !active_turn_id.is_empty() && event_turn_id(&event).is_some() {
        notification_state.allow_historical_usage = false;
    }
    if event.get("type").and_then(Value::as_str) == Some("turn.completed")
        && let Some(usage) = notification_state
            .turn_usage
            .usage()
            .map_err(|error| AgentError::Execution(error.to_string()))?
    {
        let event = event.as_object_mut().ok_or_else(|| {
            AgentError::Execution("normalized codex event is not an object".to_string())
        })?;
        event.insert("usage".to_string(), usage);
    }
    if is_duplicate_thread_started(&event, thread_started_emitted, expected_thread_id) {
        return Ok(PreparedNotificationIngest {
            output_item_start,
            ..PreparedNotificationIngest::default()
        });
    }
    let emitted_thread_started = is_thread_started_event(&event, expected_thread_id);
    let active_input_ready = is_turn_started_event(&event);
    let terminal_exit_code = terminal_exit_code(&event, expected_thread_id, active_turn_id);
    Ok(PreparedNotificationIngest {
        events: notification_state.citation_repair.submit(
            event,
            notification
                .params
                .as_ref()
                .and_then(|params| params.pointer("/item/phase"))
                .and_then(Value::as_str),
            terminal_exit_code.is_some(),
        ),
        output_item_start,
        emitted_thread_started,
        active_input_ready,
        terminal_exit_code,
    })
}

fn secondary_notification_thread_id(
    notification: &ServerNotification,
    expected_canonical_thread_id: &str,
) -> Option<String> {
    let canonical_thread_id = guest_contracts::codex_thread_id::canonical_codex_thread_id(
        notification_thread_id(notification)?,
    )?;
    (canonical_thread_id != expected_canonical_thread_id).then_some(canonical_thread_id)
}

fn validate_event_scope(
    event: &Value,
    expected_canonical_thread_id: &str,
    active_turn_id: &str,
) -> Result<(), AgentError> {
    validate_scope(
        event_thread_id(event),
        event_turn_id(event),
        expected_canonical_thread_id,
        active_turn_id,
    )
}

fn validate_scope(
    thread_id: Option<&str>,
    turn_id: Option<&str>,
    expected_canonical_thread_id: &str,
    active_turn_id: &str,
) -> Result<(), AgentError> {
    if let Some(thread_id) = thread_id
        && !thread_id_matches_canonical(thread_id, expected_canonical_thread_id)
    {
        return Err(AgentError::Execution(
            "codex app-server reported unexpected thread id in event".to_string(),
        ));
    }
    if let Some(turn_id) = turn_id {
        if active_turn_id.is_empty() {
            return Err(AgentError::Execution(
                "codex app-server reported turn-scoped event before turn/start".to_string(),
            ));
        }
        if turn_id != active_turn_id {
            return Err(AgentError::Execution(
                "codex app-server reported unexpected turn id in event".to_string(),
            ));
        }
    }
    Ok(())
}

fn record_output_item_start(
    start: Option<&CodexOutputItemStart>,
    sink: &mut EventIngestSink<'_, '_>,
) {
    if let Some(start) = start {
        sink.output_timing.record(start, sink.ingestor);
    }
}

fn event_thread_id(event: &Value) -> Option<&str> {
    event.get("thread_id").and_then(Value::as_str)
}

fn event_turn_id(event: &Value) -> Option<&str> {
    event
        .get("turn_id")
        .and_then(Value::as_str)
        .or_else(|| event.pointer("/turn/id").and_then(Value::as_str))
}

async fn ingest_event(event: Value, sink: &mut EventIngestSink<'_, '_>) -> Result<(), AgentError> {
    let raw_line = serde_json::to_vec(&event)?;
    match sink
        .ingestor
        .begin_event(
            sink.agent_log,
            raw_line,
            &event,
            sink.masker,
            Framework::Codex,
        )
        .await
    {
        ParsedEventAction::Forward => {
            if let Some(text) = codex_agent_message_text(&event) {
                println!("{}", sink.masker.mask_string(text));
            }
            sink.ingestor.enqueue_event(
                event,
                sink.masker,
                sink.should_send_events,
                sink.event_tx,
            )?;
        }
        ParsedEventAction::Skip => {}
    }
    Ok(())
}

fn codex_agent_message_text(event: &Value) -> Option<&str> {
    if event.get("type").and_then(Value::as_str) != Some("item.completed") {
        return None;
    }
    let item = event.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("agent_message") {
        return None;
    }
    item.get("text").and_then(Value::as_str)
}

fn is_duplicate_thread_started(
    event: &Value,
    thread_started_emitted: bool,
    expected_canonical_thread_id: &str,
) -> bool {
    thread_started_emitted && is_thread_started_event(event, expected_canonical_thread_id)
}

fn is_thread_started_event(event: &Value, expected_canonical_thread_id: &str) -> bool {
    event.get("type").and_then(Value::as_str) == Some("thread.started")
        && event
            .get("thread_id")
            .and_then(Value::as_str)
            .is_some_and(|thread_id| {
                thread_id_matches_canonical(thread_id, expected_canonical_thread_id)
            })
}

fn is_turn_started_event(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("turn.started")
}

fn terminal_exit_code(
    event: &Value,
    expected_canonical_thread_id: &str,
    active_turn_id: &str,
) -> Option<i32> {
    match event.get("type").and_then(Value::as_str)? {
        "turn.completed" => {
            if !event
                .get("thread_id")
                .and_then(Value::as_str)
                .is_some_and(|thread_id| {
                    thread_id_matches_canonical(thread_id, expected_canonical_thread_id)
                })
            {
                return None;
            }
            let turn_id = event.pointer("/turn/id").and_then(Value::as_str)?;
            if turn_id != active_turn_id {
                return None;
            }
            match event.pointer("/turn/status").and_then(Value::as_str) {
                Some("completed") => Some(0),
                Some("failed" | "interrupted") => Some(1),
                _ => None,
            }
        }
        "error" => {
            if event
                .get("thread_id")
                .and_then(Value::as_str)
                .is_some_and(|thread_id| {
                    thread_id_matches_canonical(thread_id, expected_canonical_thread_id)
                })
                && event.get("turn_id").and_then(Value::as_str) == Some(active_turn_id)
                && event.get("will_retry").and_then(Value::as_bool) == Some(false)
            {
                Some(1)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn synthesize_thread_started_event(thread_id: &str) -> Value {
    json!({
        "type": "thread.started",
        "thread_id": thread_id,
    })
}

fn thread_identity_from_response(response: &Value) -> Result<ThreadIdentity, AgentError> {
    let wire_id = non_empty_string_at(response, "/thread/id", "thread response missing thread.id")?;
    let canonical_id = canonical_codex_thread_id(
        &wire_id,
        "thread response returned an invalid Codex thread id",
    )?;
    Ok(ThreadIdentity {
        wire_id,
        canonical_id,
    })
}

fn resume_thread_id_from_runtime(
    runtime: &CliRuntimeConfig<'_>,
) -> Result<Option<String>, AgentError> {
    let resume_id = runtime.resume_session_id.as_ref();
    if resume_id.is_empty() {
        return Ok(None);
    }
    canonical_codex_thread_id(
        resume_id,
        "resume session id is not a valid Codex thread id",
    )
    .map(Some)
}

fn validate_resumed_thread_id(
    canonical_thread_id: &str,
    resume_thread_id: Option<&str>,
) -> Result<(), AgentError> {
    if let Some(resume_thread_id) = resume_thread_id
        && canonical_thread_id != resume_thread_id
    {
        return Err(AgentError::Execution(
            "thread/resume returned a different thread id".to_string(),
        ));
    }
    Ok(())
}

fn turn_id_from_response(response: &Value) -> Result<String, AgentError> {
    non_empty_string_at(response, "/turn/id", "turn/start response missing turn.id")
}

fn thread_id_matches_canonical(thread_id: &str, expected_canonical_thread_id: &str) -> bool {
    guest_contracts::codex_thread_id::canonical_codex_thread_id(thread_id).as_deref()
        == Some(expected_canonical_thread_id)
}

fn canonical_codex_thread_id(thread_id: &str, message: &'static str) -> Result<String, AgentError> {
    guest_contracts::codex_thread_id::canonical_codex_thread_id(thread_id)
        .ok_or_else(|| AgentError::Execution(message.to_string()))
}

fn non_empty_string_at(
    value: &Value,
    pointer: &'static str,
    message: &'static str,
) -> Result<String, AgentError> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| AgentError::Execution(message.to_string()))
}

/// Retain stderr on the existing execution-error path without replacing typed
/// failures or changing heartbeat/cancellation precedence. Call only after
/// masking the collected lines together, before this additional output bound.
fn with_stderr_tail(error: AgentError, masked_stderr: &[String]) -> AgentError {
    const MAX_TAIL_BYTES: usize = 4096;
    const TRUNCATED: &str = "[truncated] ";

    let AgentError::Execution(mut message) = error else {
        return error;
    };
    let stderr = masked_stderr.join("\n");
    if stderr.is_empty() {
        return AgentError::Execution(message);
    }

    // Keep whole escaped characters from the end, bounding the rendered bytes
    // (not just the raw input) and preventing stderr from injecting log lines.
    let mut tail = std::collections::VecDeque::new();
    let mut bytes = 0;
    for character in stderr.chars().rev() {
        let escaped = character.escape_debug().to_string();
        if bytes + escaped.len() > MAX_TAIL_BYTES - TRUNCATED.len() {
            tail.push_front(TRUNCATED.to_string());
            break;
        }
        bytes += escaped.len();
        tail.push_front(escaped);
    }
    message.push_str("; stderr tail: ");
    for fragment in tail {
        message.push_str(&fragment);
    }
    AgentError::Execution(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn execution_stderr_preserves_primary_error_and_escapes_controls() {
        let error = with_stderr_tail(
            AgentError::Execution("initialize failed".to_string()),
            &["第一行\r\u{1b}".to_string(), "second\tline".to_string()],
        );
        assert_eq!(
            error.to_string(),
            "execution: initialize failed; stderr tail: 第一行\\r\\u{1b}\\nsecond\\tline"
        );
    }

    #[test]
    fn execution_stderr_bounds_rendered_controls_and_unicode() {
        for character in ['界', '\u{1b}', '\n'] {
            let error = with_stderr_tail(
                AgentError::Execution("initialize failed".to_string()),
                &[format!(
                    "{}last diagnostic",
                    character.to_string().repeat(5000)
                )],
            );
            let message = error.to_string();
            let (_, tail) = message.split_once("; stderr tail: ").unwrap();
            assert!(tail.len() <= 4096);
            assert!(tail.starts_with("[truncated] "));
            assert!(tail.ends_with("last diagnostic"));
            assert!(!tail.chars().any(char::is_control));
        }
    }

    #[test]
    fn execution_stderr_masks_multiline_secrets_before_tail_truncation() {
        let secret = "secret-first-line\nsecret-second-line";
        let encoded_secret = base64::engine::general_purpose::STANDARD.encode(secret);
        let masker = SecretMasker::from_raw(&encoded_secret);
        // Raw tail truncation here would cut through the secret, leaving only a
        // suffix that the ordinary complete-secret matcher could not recognize.
        let lines = format!(
            "{}\n{secret}\n{}",
            "older context".repeat(400),
            "x".repeat(4060)
        )
        .lines()
        .map(str::to_string)
        .collect();
        let masked = masker.mask_diagnostic_lines(lines);
        let error = with_stderr_tail(
            AgentError::Execution("initialize failed".to_string()),
            &masked,
        );
        let message = error.to_string();
        assert!(!message.contains("first-line"));
        assert!(!message.contains("second-line"));
        assert!(message.contains("***"));
        assert!(message.ends_with(&"x".repeat(4060)));
    }

    #[test]
    fn execution_stderr_leaves_empty_tail_and_typed_failure_unchanged() {
        let error = with_stderr_tail(AgentError::Execution("initialize failed".to_string()), &[]);
        assert_eq!(error.to_string(), "execution: initialize failed");
        let error = with_stderr_tail(
            AgentError::CodexInputTooLarge {
                actual_chars: 100,
                max_chars: 50,
            },
            &["secondary diagnostic".to_string()],
        );
        assert!(matches!(
            error,
            AgentError::CodexInputTooLarge {
                actual_chars: 100,
                max_chars: 50
            }
        ));
    }

    #[test]
    fn active_input_is_read_only_after_source_and_turn_are_ready() {
        assert!(!can_read_active_input(false, false));
        assert!(!can_read_active_input(false, true));
        assert!(!can_read_active_input(true, false));
        assert!(can_read_active_input(true, true));
    }

    #[test]
    fn codex_agent_message_text_reads_completed_agent_message_only() {
        let agent_message = json!({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": "RESULT=ok"
            }
        });
        let plan_message = json!({
            "type": "item.completed",
            "item": {
                "type": "plan",
                "text": "not final output"
            }
        });
        let started_agent_message = json!({
            "type": "item.started",
            "item": {
                "type": "agent_message",
                "text": "not completed"
            }
        });

        assert_eq!(codex_agent_message_text(&agent_message), Some("RESULT=ok"));
        assert_eq!(codex_agent_message_text(&plan_message), None);
        assert_eq!(codex_agent_message_text(&started_agent_message), None);
    }
}
