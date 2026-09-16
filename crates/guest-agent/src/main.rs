//! Guest agent — orchestrates CLI execution, heartbeat, telemetry, and
//! checkpoint creation inside a Firecracker VM.

use guest_agent::checkpoint;
use guest_agent::cli;
use guest_agent::complete;
use guest_agent::control;
use guest_agent::env;
use guest_agent::error::AgentError;
use guest_agent::failure_diagnostics;
use guest_agent::heartbeat;
use guest_agent::http::HttpClient;
use guest_agent::masker;
use guest_agent::metrics;
use guest_agent::paths;
use guest_agent::reuse_preparation;
use guest_agent::run_context::GuestRuntime;
use guest_agent::session_metadata;
use guest_agent::telemetry::{Telemetry, UploadMode};
use guest_agent::{codex_session_cleanup, session_history_identity};

use guest_contracts::diagnostics::{
    AGENT_EXECUTION_TIMEOUT_EXIT_CODE, CliTerminationReason, EventDeliveryDiagnostic, FailureClass,
    FailureDiagnostic, FailureReason, WorkloadResourceLimitDiagnostic,
};
use guest_contracts::session_history_identity::{
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS, SessionHistoryIdentityExpectation,
};
use guest_telemetry::telemetry::record_sandbox_op;
use guest_telemetry::{log_error, log_info, log_warn};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";

fn checkpoint_failure_reason(error: &AgentError) -> Option<FailureReason> {
    matches!(error, AgentError::CheckpointHistoryTooLarge { .. })
        .then_some(FailureReason::SessionHistoryLimit)
}

fn main() {
    if let Some(exit_code) = helper_exit_code_from_args() {
        std::process::exit(exit_code);
    }
    let runtime = match initialize_guest_runtime() {
        Ok(runtime) => runtime,
        Err(e) => {
            log_error!(LOG_TAG, "Fatal: {e}");
            log_info!(LOG_TAG, "✗ Sandbox failed (exit code 1)");
            std::process::exit(1);
        }
    };
    let async_runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            log_error!(
                LOG_TAG,
                "Fatal: failed to initialize async runtime: {error}"
            );
            std::process::exit(1);
        }
    };
    let exit_code = async_runtime.block_on(run(runtime));
    std::process::exit(exit_code);
}

fn initialize_guest_runtime() -> Result<GuestRuntime, String> {
    #[cfg(target_os = "linux")]
    deny_unprivileged_process_inspection()?;
    GuestRuntime::from_process_env()
}

#[cfg(target_os = "linux")]
fn deny_unprivileged_process_inspection() -> Result<(), String> {
    // SAFETY: PR_SET_DUMPABLE only changes the calling process's inspection
    // policy. It must run before the credential-bearing runtime is captured.
    let result = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) };
    if result == 0 {
        return Ok(());
    }
    Err(format!(
        "protect guest-agent from unprivileged process inspection: {}",
        std::io::Error::last_os_error()
    ))
}

fn helper_exit_code_from_args() -> Option<i32> {
    let mut args = std::env::args_os();
    let _program = args.next()?;
    let command = args.next()?;
    match command.to_str()? {
        "verify-session-history-identity" => {
            let metadata_path = args
                .next()
                .unwrap_or_else(final_session_history_identity_path_from_process_env);
            let remaining = args.collect::<Vec<_>>();
            let expected = match parse_session_history_identity_expectation(&remaining) {
                Ok(expected) => expected,
                Err(()) => return Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS),
            };
            Some(
                match session_history_identity::verify_final_session_history_identity_file(
                    metadata_path,
                    expected.as_ref(),
                ) {
                    Ok(()) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
                    Err(error) => session_history_identity_helper_exit_code(&error),
                },
            )
        }
        "export-session-history-sidecar" => {
            let Some(metadata_path) = args.next() else {
                return Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS);
            };
            let Some(export_path) = args.next() else {
                return Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS);
            };
            if args.next().is_some() {
                return Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS);
            }
            Some(
                match session_history_identity::export_final_session_history_sidecar_file(
                    metadata_path,
                    export_path,
                ) {
                    Ok(metadata) => match serde_json::to_string(&metadata) {
                        Ok(json) => {
                            println!("{json}");
                            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS
                        }
                        Err(_) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
                    },
                    Err(error) => session_history_sidecar_export_helper_exit_code(&error),
                },
            )
        }
        "prepare-for-reuse" => {
            if args.next().is_some() {
                return Some(
                    guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INVALID_REQUEST,
                );
            }
            Some(match reuse_preparation::prepare_from_stdin() {
                Ok(report) => match serde_json::to_string(&report) {
                    Ok(json) => {
                        println!("{json}");
                        guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_SUCCESS
                    }
                    Err(_) => {
                        guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INSPECTION_FAILED
                    }
                },
                Err(error) => {
                    eprintln!("{error}");
                    error.exit_code()
                }
            })
        }
        "cleanup-codex-session" => {
            let Some(session_id) = args.next().and_then(|value| value.into_string().ok()) else {
                return Some(1);
            };
            let Some(fallback_relative_path) =
                args.next().and_then(|value| value.into_string().ok())
            else {
                return Some(1);
            };
            if args.next().is_some() {
                return Some(1);
            }
            let request = guest_contracts::codex_session_cleanup::CodexSessionCleanupRequest {
                session_id,
                fallback_relative_path,
            };
            Some(match codex_session_cleanup::run(&request) {
                Ok(exit_code) => exit_code,
                Err(error) => {
                    eprintln!("{error}");
                    1
                }
            })
        }
        _ => None,
    }
}

fn session_history_identity_helper_exit_code(
    error: &session_history_identity::SessionHistoryIdentityVerifyError,
) -> i32 {
    let exit_code = error.helper_exit_code();
    if exit_code == SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS {
        SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE
    } else {
        exit_code
    }
}

fn session_history_sidecar_export_helper_exit_code(
    error: &session_history_identity::SessionHistorySidecarExportError,
) -> i32 {
    let exit_code = error.helper_exit_code();
    let Some(failure) = error.output_failure() else {
        return exit_code;
    };
    match serde_json::to_string(&failure) {
        Ok(json) => {
            println!("{json}");
            exit_code
        }
        Err(_) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
    }
}

#[allow(clippy::panic)]
fn final_session_history_identity_path_from_process_env() -> std::ffi::OsString {
    let run_id = std::env::var(guest_contracts::env::RUN_ID_ENV).unwrap_or_default();
    paths::GuestPaths::from_process_env(&run_id)
        .unwrap_or_else(|error| panic!("failed to resolve guest runtime directory: {error}"))
        .final_session_history_identity_file()
        .into()
}

fn parse_session_history_identity_expectation(
    args: &[std::ffi::OsString],
) -> Result<Option<SessionHistoryIdentityExpectation>, ()> {
    let [
        framework,
        session_id_hash,
        history_ref_kind,
        history_hash,
        history_size_bytes,
    ] = match args {
        [] => return Ok(None),
        [
            framework,
            session_id_hash,
            history_ref_kind,
            history_hash,
            history_size_bytes,
        ] => [
            framework,
            session_id_hash,
            history_ref_kind,
            history_hash,
            history_size_bytes,
        ],
        _ => return Err(()),
    };
    let framework = framework.to_str().ok_or(())?;
    let session_id_hash = session_id_hash.to_str().ok_or(())?;
    let history_ref_kind = history_ref_kind.to_str().ok_or(())?;
    let history_hash = history_hash.to_str().ok_or(())?;
    let history_size_bytes = history_size_bytes.to_str().ok_or(())?;
    SessionHistoryIdentityExpectation::from_cli_args([
        framework,
        session_id_hash,
        history_ref_kind,
        history_hash,
        history_size_bytes,
    ])
    .map(Some)
    .map_err(|_| ())
}

/// Top-level orchestrator. Returns exit code directly (never panics/errors out).
/// Final telemetry upload is attempted on all paths where the HTTP client can
/// be initialized; when no API token is configured, that upload is a no-op.
async fn run(runtime: GuestRuntime) -> i32 {
    let start = Instant::now();

    // Record API-to-agent E2E time (as early as possible)
    guest_agent::timing::record_e2e_from_api_start(
        "api_to_agent_start",
        &runtime.config.api_start_time,
    );

    // Lifecycle: Header
    log_info!(LOG_TAG, "▶ Okou Sandbox {}", runtime.config.run_id);

    // Lifecycle: Initialization
    log_info!(LOG_TAG, "▷ Initialization");

    let http = runtime.http.clone();
    let masker = Arc::new(masker::SecretMasker::from_config(&runtime.config));
    let shutdown = CancellationToken::new();
    let cli_cancellation = CancellationToken::new();
    let framework_supports_active_input = framework_supports_active_input(runtime.config.framework);
    let has_process_control_endpoint = runtime.process_control_endpoint.is_some();
    let active_input_enabled = framework_supports_active_input && has_process_control_endpoint;
    let active_input = if active_input_enabled {
        let receipt_journal_path =
            guest_contracts::runtime_paths::active_input_receipt_journal_file(
                runtime.paths.runtime_dir(),
            );
        match guest_agent::active_input::ActiveInputRuntime::new_with_receipts(
            &runtime.config.run_id,
            &runtime.config.prompt,
            receipt_journal_path,
            http.clone(),
        ) {
            Ok(active_input) => active_input,
            Err(error) => {
                let message = format!("Active-input receipt initialization failed: {error}");
                log_error!(LOG_TAG, "{message}");
                failure_diagnostics::write_guest_error_file(
                    runtime.paths.checkpoint_error_file(),
                    &message,
                );
                return 1;
            }
        }
    } else {
        guest_agent::active_input::ActiveInputRuntime::new_disabled(
            &runtime.config.run_id,
            &runtime.config.prompt,
        )
    };
    let control_handle = control::ControlHandle::spawn(
        runtime.process_control_endpoint.as_deref(),
        shutdown.clone(),
        active_input.controller(),
        cli_cancellation.clone(),
    );
    log_info!(
        LOG_TAG,
        "Working directory: {}",
        paths::CANONICAL_WORKING_DIR
    );

    let t = Instant::now();
    let (heartbeat_status_tx, heartbeat_status_rx) = tokio::sync::oneshot::channel();
    let heartbeat_handle = spawn_heartbeat(
        runtime.config.run_id.clone(),
        shutdown.clone(),
        http.clone(),
        heartbeat_status_tx,
    );
    log_info!(LOG_TAG, "Heartbeat started");
    record_sandbox_op("heartbeat_start", t.elapsed(), true, None);

    let t = Instant::now();
    let telemetry = Telemetry::spawn_for_paths(
        runtime.config.run_id.clone(),
        &runtime.paths,
        masker.clone(),
        http.clone(),
    );
    log_info!(LOG_TAG, "Telemetry upload started");
    record_sandbox_op("telemetry_upload_start", t.elapsed(), true, None);

    let t = Instant::now();
    let mut metrics_sources = metrics::MetricsSources::new(
        std::path::PathBuf::from("/proc/stat"),
        runtime
            .workload_containment
            .as_ref()
            .map(guest_agent::workload_containment::WorkloadContainment::cpu_stat_paths),
    );
    if let Some(containment) = runtime.workload_containment.clone() {
        metrics_sources = metrics_sources.with_evidence(
            containment,
            telemetry
                .incident_reporter()
                .with_sandbox_id(runtime.config.sandbox_id.clone()),
        );
    }
    let metrics_handle = tokio::spawn({
        let shutdown = shutdown.clone();
        let metrics_log_file = runtime.paths.metrics_log_file().to_string();
        async move { metrics::metrics_loop_for_path(shutdown, metrics_log_file, metrics_sources).await }
    });
    log_info!(LOG_TAG, "Metrics collector started");
    record_sandbox_op("metrics_collector_start", t.elapsed(), true, None);

    // Execute main logic (init + CLI + checkpoint/recovery + /complete).
    // On the success path, `execute` overlaps the pre-checkpoint telemetry
    // flush with checkpoint creation. The EOF-consuming final flush runs below,
    // after background producers stop, so `/complete` logs still upload without
    // racing metrics or heartbeat writes.
    let exit_code = execute(
        &masker,
        start,
        Some(heartbeat_status_rx),
        &telemetry,
        ExecutionControls {
            active_input: active_input.into_writer(),
            cli_cancellation,
        },
        &runtime,
    )
    .await;

    stop_background_and_flush_final_telemetry(
        shutdown,
        control_handle,
        metrics_handle,
        heartbeat_handle,
        telemetry,
    )
    .await;

    if exit_code == 0 {
        log_info!(LOG_TAG, "✓ Sandbox finished successfully");
    } else {
        log_info!(LOG_TAG, "✗ Sandbox failed (exit code {exit_code})");
    }

    exit_code
}

fn framework_supports_active_input(framework: env::Framework) -> bool {
    matches!(
        framework,
        env::Framework::ClaudeCode | env::Framework::Codex | env::Framework::Pi
    )
}

struct ExecutionControls {
    active_input: guest_agent::active_input::ActiveInputWriter,
    cli_cancellation: CancellationToken,
}

/// Main execution logic: working dir, CLI, checkpoint/recovery, and `/complete`.
/// The success path overlaps the pre-checkpoint telemetry flush with
/// checkpoint creation. Final telemetry is owned by [`run`] after producer
/// shutdown.
async fn execute(
    masker: &masker::SecretMasker,
    start: Instant,
    heartbeat_monitor: cli::HeartbeatMonitor,
    telemetry: &Telemetry,
    controls: ExecutionControls,
    runtime: &GuestRuntime,
) -> i32 {
    let ExecutionControls {
        active_input,
        cli_cancellation,
    } = controls;
    let config = &runtime.config;
    let runtime_paths = &runtime.paths;
    let http = runtime.http.clone();
    // Pre-warm kernel DNS cache for the CLI's API endpoint.
    // Fire-and-forget: runs in background so the cache is populated by the
    // time the CLI spawns and makes its first HTTPS request.
    let dns_target = match config.framework {
        env::Framework::ClaudeCode => Some("api.anthropic.com:443"),
        env::Framework::Codex => Some("api.openai.com:443"),
        env::Framework::Pi => None,
    };
    if let Some(dns_target) = dns_target {
        tokio::spawn(async move {
            let _ = tokio::net::lookup_host(dns_target).await;
        });
    }

    // Working directory setup
    let wd_start = Instant::now();
    if let Err(e) = setup_working_dir(paths::CANONICAL_WORKING_DIR) {
        let msg = format!("Working dir setup failed: {e}");
        log_error!(LOG_TAG, "{msg}");
        failure_diagnostics::write_guest_error_file(runtime_paths.checkpoint_error_file(), &msg);
        failure_diagnostics::write_guest_failure_diagnostic(
            runtime_paths.failure_diagnostic_file(),
            &failure_diagnostics::base_failure_diagnostic_for_config(
                config,
                FailureClass::WorkingDirSetupFailed,
            ),
        );
        record_sandbox_op("working_dir_setup", wd_start.elapsed(), false, Some(&msg));
        return 1;
    }
    record_sandbox_op("working_dir_setup", wd_start.elapsed(), true, None);

    let codex_startup =
        matches!(config.framework, env::Framework::Codex).then(cli::CodexStartupTiming::start);

    // Codex setup must complete before the CLI starts. On reused sandboxes,
    // continuing after a setup failure can inherit stale auth or runtime state
    // from an earlier run.
    if matches!(config.framework, env::Framework::Codex)
        && let Err(e) = cli::setup_codex_for_config(masker, config).await
    {
        if let Some(codex_startup) = codex_startup.as_ref() {
            codex_startup.record_failure();
        }
        let msg = format!("Codex setup failed: {}", masker.mask_string(&e.to_string()));
        log_error!(LOG_TAG, "{msg}");
        failure_diagnostics::write_guest_error_file(runtime_paths.checkpoint_error_file(), &msg);
        failure_diagnostics::write_guest_failure_diagnostic(
            runtime_paths.failure_diagnostic_file(),
            &failure_diagnostics::base_failure_diagnostic_for_config(
                config,
                FailureClass::CliExecutionError,
            ),
        );
        return 1;
    }

    // Memory is mounted directly through manifest.artifacts[] at the
    // framework-specific memory path — no runtime symlink needed (see #10602).

    let init_elapsed = start.elapsed();
    record_sandbox_op("init_total", init_elapsed, true, None);
    log_info!(
        LOG_TAG,
        "✓ Initialization complete ({}s)",
        init_elapsed.as_secs()
    );

    // Execution phase
    log_info!(LOG_TAG, "▷ Execution");
    let cli_start = Instant::now();
    let mut last_event_sequence = None;
    let mut active_input_delivery_ids = Vec::new();
    let mut event_delivery_failure = None;
    let session_metadata = session_metadata::SessionMetadataStore::default();
    let cli_result = cli::execute_cli_with_controls_for_config_started_at(
        masker,
        heartbeat_monitor,
        http.clone(),
        cli::CliExecutionControls::new(active_input, cli_cancellation, codex_startup.as_ref())
            .with_workload_containment(runtime.workload_containment.as_ref())
            .with_session_metadata_store(session_metadata.clone()),
        config,
        runtime_paths,
        start,
    )
    .await;
    if let Some(codex_startup) = codex_startup.as_ref() {
        codex_startup.record_failure();
    }
    let (
        cli_exit_code,
        mut exit_code,
        mut error_message,
        mut failure_diagnostic,
        cli_execution_succeeded,
    ) = match cli_result {
        Ok(cli_result) => {
            last_event_sequence = cli_result.last_event_sequence;
            active_input_delivery_ids = cli_result.active_input_delivery_ids.clone();
            if let Some(event_delivery) = cli_result.event_delivery.clone() {
                let diagnostic = failure_diagnostics::event_delivery_failure_for_config(
                    config,
                    session_metadata.captured(),
                    &cli_result,
                    event_delivery.clone(),
                );
                event_delivery_failure = Some((event_delivery, diagnostic));
            }
            let cli_exit_code = cli_result.exit_code;
            if let Some(control_error) = cli_result.control_error.as_ref() {
                let msg = control_error.to_string();
                let diagnostic = failure_diagnostics::cli_control_failure_for_config(
                    config,
                    session_metadata.captured(),
                    &cli_result,
                );
                let exit_code = if cli_result
                    .cli_termination
                    .as_ref()
                    .is_some_and(|termination| {
                        termination.reason == CliTerminationReason::ExecutionTimeout
                    }) {
                    AGENT_EXECUTION_TIMEOUT_EXIT_CODE
                } else {
                    1
                };
                (cli_exit_code, exit_code, msg, Some(diagnostic), false)
            } else if preserves_successful_post_result_cleanup(config.framework, &cli_result) {
                (cli_exit_code, 0, String::new(), None, true)
            } else if cli_exit_code != 0 {
                let failure = failure_diagnostics::cli_nonzero_failure_for_config(
                    config,
                    session_metadata.captured(),
                    &cli_result,
                );
                (
                    cli_exit_code,
                    cli_exit_code,
                    failure.message,
                    Some(failure.diagnostic),
                    false,
                )
            } else {
                (0, 0, String::new(), None, true)
            }
        }
        Err(e) => {
            let msg = e.to_string();
            log_error!(LOG_TAG, "CLI execution failed: {msg}");
            (
                1,
                1,
                msg,
                Some(failure_diagnostics::cli_execution_error_for_config(
                    config, &e,
                )),
                false,
            )
        }
    };
    if let Some(workload_containment) = runtime.workload_containment.as_ref() {
        let reason = if cli_execution_succeeded {
            guest_contracts::oom_evidence::CaptureReason::Sample
        } else {
            guest_contracts::oom_evidence::CaptureReason::CliError
        };
        let evidence = workload_containment.oom_evidence(reason).await;
        if let Some(evidence) = evidence.as_ref() {
            telemetry
                .incident_reporter()
                .with_sandbox_id(runtime.config.sandbox_id.clone())
                .record(evidence.clone());
        }
        match workload_containment.resource_diagnostics() {
            Ok(diagnostics) => {
                if let Some(pressure) = diagnostics.pressure {
                    log_info!(LOG_TAG, "{pressure}");
                }
                if let Some(hard_limit) = diagnostics.hard_limit {
                    let contained = cli_execution_succeeded
                        && evidence.as_ref().is_some_and(|evidence| {
                            evidence.proves_contained_resource_limit(&hard_limit)
                        });
                    let message =
                        apply_workload_resource_limit(&mut failure_diagnostic, hard_limit);
                    if contained {
                        log_info!(LOG_TAG, "{message} oom_classification=contained_tool_oom");
                    } else {
                        log_warn!(LOG_TAG, "{message}");
                    }
                }
            }
            Err(error) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to read workload resource diagnostics: {error}"
                );
            }
        }
    }
    let cli_elapsed = cli_start.elapsed();
    record_sandbox_op(
        "cli_execution",
        cli_elapsed,
        cli_execution_succeeded,
        if cli_execution_succeeded {
            None
        } else {
            Some(error_message.as_str())
        },
    );

    if let Some((event_delivery, event_failure_diagnostic)) = event_delivery_failure {
        match failure_diagnostic.take() {
            Some(diagnostic) => {
                failure_diagnostic = Some(diagnostic.with_event_delivery(event_delivery));
            }
            None => {
                error_message = event_delivery_failure_message(&event_delivery);
                log_error!(LOG_TAG, "{error_message}");
                exit_code = 1;
                failure_diagnostic = Some(event_failure_diagnostic);
            }
        }
    }

    complete_execution(
        cli_exit_code,
        exit_code,
        cli_elapsed,
        CompletionState {
            last_event_sequence,
            failure_message: (exit_code != 0).then_some(error_message.as_str()),
            failure_diagnostic,
            active_input_delivery_ids: &active_input_delivery_ids,
            session_metadata: session_metadata.captured(),
        },
        telemetry,
        runtime,
    )
    .await
}

fn apply_workload_resource_limit(
    failure_diagnostic: &mut Option<FailureDiagnostic>,
    hard_limit: WorkloadResourceLimitDiagnostic,
) -> String {
    let message = format!(
        "workload resource limit reached (memory_max={}, memory_oom={}, memory_oom_kill={}, memory_oom_group_kill={}, pids_max={})",
        hard_limit.memory_max_events,
        hard_limit.memory_oom_events,
        hard_limit.memory_oom_kill_events,
        hard_limit.memory_oom_group_kill_events,
        hard_limit.pids_max_events,
    );
    if let Some(diagnostic) = failure_diagnostic.take() {
        *failure_diagnostic = Some(diagnostic.with_workload_resource_limit(hard_limit));
    }
    message
}

fn event_delivery_failure_message(diagnostic: &EventDeliveryDiagnostic) -> String {
    let last_acknowledged = diagnostic
        .last_acknowledged_sequence
        .map_or_else(|| "none".to_string(), |sequence| sequence.to_string());
    let first_failed = diagnostic.first_failed_batch.as_ref();
    let drain_active = diagnostic
        .drain_timeout
        .as_ref()
        .and_then(|drain| drain.active_batch.as_ref());

    match (first_failed, drain_active) {
        (Some(failed), Some(active)) => format!(
            "Event delivery failed after acknowledged sequence {last_acknowledged}: batch {}-{} exhausted retries and the global drain deadline interrupted batch {}-{}",
            failed.first_sequence,
            failed.last_sequence,
            active.first_sequence,
            active.last_sequence
        ),
        (Some(failed), None) => format!(
            "Event delivery failed after acknowledged sequence {last_acknowledged}: batch {}-{} exhausted retries",
            failed.first_sequence, failed.last_sequence
        ),
        (None, Some(active)) => format!(
            "Event delivery failed after acknowledged sequence {last_acknowledged}: the global drain deadline interrupted batch {}-{}",
            active.first_sequence, active.last_sequence
        ),
        (None, None) => format!(
            "Event delivery did not complete before the global drain deadline after acknowledged sequence {last_acknowledged}"
        ),
    }
}

fn preserves_successful_post_result_cleanup(
    framework: env::Framework,
    cli_result: &cli::CliExecutionResult,
) -> bool {
    matches!(framework, env::Framework::ClaudeCode)
        && cli_result.control_error.is_none()
        && cli_result.exit_code != 0
        && cli_result
            .post_result_cleanup_jsonl_result
            .is_some_and(|result| result.status == cli::JsonlResultStatus::Success)
        && cli_result
            .cli_termination
            .as_ref()
            .is_some_and(|termination| {
                termination.reason == CliTerminationReason::PostResultReap
                    && termination.observed_exit_code == Some(cli_result.exit_code)
            })
}

struct PersistenceFailure<'a> {
    /// Human-facing name of the failed step, used for the guest error file the
    /// host surfaces as the run error.
    label: &'a str,
    error: &'a AgentError,
    elapsed: Duration,
    cli_exit_code: i32,
    wrote_failure_diagnostic: bool,
}

/// Record a failed run-settling persistence step so the runner's fallback
/// `/complete` marks the run failed.
///
/// Both the checkpoint and the Pi artifact snapshot must fail the run: settling
/// as successful would silently discard the writeback Storage mutations the
/// sandbox just made.
fn record_persistence_failure(
    failure: PersistenceFailure<'_>,
    runtime: &GuestRuntime,
    session_metadata: Option<&session_metadata::CapturedSessionMetadata>,
) {
    let config = &runtime.config;
    let runtime_paths = &runtime.paths;
    let msg = format!("{} failed: {}", failure.label, failure.error);
    log_error!(LOG_TAG, "{msg}");
    log_info!(
        LOG_TAG,
        "✗ {} failed ({}s)",
        failure.label,
        failure.elapsed.as_secs()
    );
    failure_diagnostics::write_guest_error_file(runtime_paths.checkpoint_error_file(), &msg);
    if failure.wrote_failure_diagnostic {
        return;
    }
    let mut diagnostic = failure_diagnostics::base_failure_diagnostic_for_config(
        config,
        FailureClass::CheckpointFailed,
    )
    .with_cli_exit_code(failure.cli_exit_code);
    if let Some(reason) = checkpoint_failure_reason(failure.error) {
        diagnostic = diagnostic.with_failure_reason(reason);
    }
    let diagnostic = diagnostic.with_session_history_status(
        failure_diagnostics::diagnostic_session_history_status_for_config(config, session_metadata),
    );
    failure_diagnostics::write_guest_failure_diagnostic(
        runtime_paths.failure_diagnostic_file(),
        &diagnostic,
    );
}

struct CompletionState<'a> {
    last_event_sequence: Option<u32>,
    failure_message: Option<&'a str>,
    failure_diagnostic: Option<FailureDiagnostic>,
    active_input_delivery_ids: &'a [String],
    session_metadata: Option<&'a session_metadata::CapturedSessionMetadata>,
}

async fn complete_execution(
    cli_exit_code: i32,
    mut exit_code: i32,
    cli_elapsed: Duration,
    state: CompletionState<'_>,
    telemetry: &Telemetry,
    runtime: &GuestRuntime,
) -> i32 {
    let config = &runtime.config;
    let runtime_paths = &runtime.paths;
    let http = &runtime.http;
    if let Some(message) = state.failure_message {
        failure_diagnostics::write_guest_error_file(runtime_paths.checkpoint_error_file(), message);
    }
    let mut wrote_failure_diagnostic = false;
    if let Some(diagnostic) = &state.failure_diagnostic {
        failure_diagnostics::write_guest_failure_diagnostic(
            runtime_paths.failure_diagnostic_file(),
            diagnostic,
        );
        wrote_failure_diagnostic = true;
    }

    if exit_code == 0 {
        log_info!(LOG_TAG, "✓ Execution complete ({}s)", cli_elapsed.as_secs());
    } else {
        log_info!(LOG_TAG, "✗ Execution failed ({}s)", cli_elapsed.as_secs());
    }

    let user_cancelled = state
        .failure_diagnostic
        .as_ref()
        .and_then(|diagnostic| diagnostic.cli_termination.as_ref())
        .is_some_and(|termination| termination.reason == CliTerminationReason::UserCancellation);
    let mut guest_completion_reported = false;

    // Checkpoint on success (skip when no API — local/test mode). The
    // pre-checkpoint flush runs in `tokio::join!` with the snapshot work so
    // its ~1s upload overlaps the ~4s checkpoint. The EOF-consuming final
    // pass runs from the top-level shutdown path after telemetry producers
    // stop, so it can safely catch checkpoint and `/complete` logs.
    let agent_type = config.framework.agent_type();
    if should_create_success_checkpoint(exit_code) && http.has_api() {
        log_info!(LOG_TAG, "{agent_type} completed successfully");

        log_info!(LOG_TAG, "▷ Checkpoint");
        let cp_start = Instant::now();
        let checkpoint = async {
            let session_metadata = state.session_metadata.ok_or_else(|| {
                AgentError::Checkpoint("No valid CLI session ID was captured".to_string())
            })?;
            checkpoint::prepare_checkpoint_for_runtime(runtime, session_metadata).await
        };
        let (cp_result, _) = tokio::join!(checkpoint, telemetry.flush(UploadMode::Live),);
        match cp_result {
            Ok(checkpoint) => {
                // Persist the prepared checkpoint and terminal state together
                // before returning to the top-level final telemetry pass. See
                // the `complete` module docs for the runner's idempotent fallback
                // and provider-specific finalization ordering.
                log_info!(LOG_TAG, "▷ Cleanup");
                let result = complete::report_checkpoint_for_run(
                    runtime,
                    0,
                    None,
                    None,
                    state.last_event_sequence,
                    state.active_input_delivery_ids,
                    checkpoint,
                )
                .await;
                match result {
                    Ok(()) => {
                        guest_completion_reported = true;
                        log_info!(
                            LOG_TAG,
                            "✓ Checkpoint complete ({}s)",
                            cp_start.elapsed().as_secs()
                        );
                    }
                    Err(e) => {
                        record_persistence_failure(
                            PersistenceFailure {
                                label: "Checkpoint",
                                error: &e,
                                elapsed: cp_start.elapsed(),
                                cli_exit_code,
                                wrote_failure_diagnostic,
                            },
                            runtime,
                            state.session_metadata,
                        );
                        exit_code = 1;
                    }
                }
            }
            Err(e) => {
                record_persistence_failure(
                    PersistenceFailure {
                        label: "Checkpoint",
                        error: &e,
                        elapsed: cp_start.elapsed(),
                        cli_exit_code,
                        wrote_failure_diagnostic,
                    },
                    runtime,
                    state.session_metadata,
                );
                exit_code = 1;

                // Failure path: don't call /complete from guest. The runner's
                // provider.complete() fallback posts exitCode=1, triggering
                // the route's "checkpoint not found → failed" branch.
                log_info!(LOG_TAG, "▷ Cleanup");
            }
        }
    } else {
        if exit_code == 0 {
            log_info!(LOG_TAG, "{agent_type} completed successfully");
        } else if cli_exit_code != 0 {
            log_info!(
                LOG_TAG,
                "{agent_type} failed with exit code {cli_exit_code}"
            );
        }

        if http.has_api() {
            if let Some(session_metadata) = state.session_metadata {
                log_info!(LOG_TAG, "Attempting best-effort recovery checkpoint");
                match checkpoint::prepare_recovery_checkpoint_for_runtime(runtime, session_metadata)
                    .await
                {
                    Ok(checkpoint) => {
                        match complete::report_checkpoint_for_run(
                            runtime,
                            exit_code,
                            state
                                .failure_diagnostic
                                .as_ref()
                                .and_then(|diagnostic| diagnostic.failure_reason),
                            state.failure_message,
                            state.last_event_sequence,
                            state.active_input_delivery_ids,
                            checkpoint,
                        )
                        .await
                        {
                            Ok(()) => {
                                guest_completion_reported = true;
                                log_info!(LOG_TAG, "Recovery checkpoint created");
                            }
                            Err(e) => {
                                log_warn!(LOG_TAG, "Recovery checkpoint skipped: {e}");
                            }
                        }
                    }
                    Err(e) => log_warn!(LOG_TAG, "Recovery checkpoint skipped: {e}"),
                }
            } else {
                log_warn!(
                    LOG_TAG,
                    "Recovery checkpoint skipped because no valid CLI session ID was captured"
                );
            }
        }

        log_info!(LOG_TAG, "▷ Cleanup");
    }

    if user_cancelled && !guest_completion_reported {
        complete::report_user_cancellation_for_run(
            http,
            &config.run_id,
            &config.sandbox_id,
            &config.sandbox_reuse_result,
            &config.workspace_reuse_result,
            state.last_event_sequence,
            state.active_input_delivery_ids,
        )
        .await;
    }

    exit_code
}

async fn stop_background_and_flush_final_telemetry(
    shutdown: CancellationToken,
    control_handle: Option<control::ControlHandle>,
    metrics_handle: tokio::task::JoinHandle<()>,
    heartbeat_handle: tokio::task::JoinHandle<()>,
    telemetry: Telemetry,
) {
    // Stop telemetry producers before the EOF-consuming final pass.
    shutdown.cancel();
    stop_heartbeat(heartbeat_handle).await;
    if let Some(control_handle) = control_handle {
        control_handle.join();
    }
    let _ = metrics_handle.await;
    final_telemetry(telemetry).await;
    log_info!(LOG_TAG, "Background processes stopped");
}

fn spawn_heartbeat(
    run_id: String,
    shutdown: CancellationToken,
    http: HttpClient,
    status_tx: tokio::sync::oneshot::Sender<cli::HeartbeatStatus>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let heartbeat_task =
            tokio::spawn(heartbeat::heartbeat_loop_for_run(run_id, http, shutdown));
        let _abort_on_drop = AbortTaskOnDrop(heartbeat_task.abort_handle());
        let status = match heartbeat_task.await {
            Ok(Ok(())) => cli::HeartbeatStatus::Stopped,
            Ok(Err(error)) => cli::HeartbeatStatus::Failed(error),
            Err(error) => cli::HeartbeatStatus::TaskFailed(error.to_string()),
        };
        let _ = status_tx.send(status);
    })
}

struct AbortTaskOnDrop(tokio::task::AbortHandle);

impl Drop for AbortTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn stop_heartbeat(handle: tokio::task::JoinHandle<()>) {
    if !handle.is_finished() {
        handle.abort();
    }
    match handle.await {
        Ok(()) => {}
        Err(error) if error.is_cancelled() => {}
        Err(error) => log_warn!(LOG_TAG, "Heartbeat task stopped: {error}"),
    }
}

fn should_create_success_checkpoint(exit_code: i32) -> bool {
    exit_code == 0
}

fn setup_working_dir(path: impl AsRef<Path>) -> std::io::Result<()> {
    let path = path.as_ref();
    std::fs::create_dir_all(path)?;
    std::env::set_current_dir(path)
}

/// Final telemetry upload — best-effort and logs on failure.
/// Success `/complete` reporting has already run before this point; the runner
/// still keeps its idempotent VM-exit fallback.
async fn final_telemetry(telemetry: Telemetry) {
    log_info!(LOG_TAG, "Performing final telemetry upload...");
    if telemetry.final_flush_and_shutdown().await.is_err() {
        log_error!(LOG_TAG, "Final telemetry upload failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use guest_contracts::diagnostics::{
        AgentFramework, CliObservedExitDiagnostic, CliTerminationDiagnostic, CliTerminationSignal,
        FailureDetailSource, PromptMetadata, SessionHistoryStatus,
    };
    use httpmock::prelude::*;
    use serde_json::json;
    use std::sync::LazyLock;

    static TEST_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn checkpoint_history_limit_errors_have_a_stable_failure_reason() {
        assert_eq!(
            checkpoint_failure_reason(&AgentError::CheckpointHistoryTooLarge { max_bytes: 1 }),
            Some(FailureReason::SessionHistoryLimit)
        );
        assert_eq!(
            checkpoint_failure_reason(&AgentError::Checkpoint(
                "Session history exceeds maximum size of 134217728 bytes".to_string(),
            )),
            None
        );
        assert_eq!(
            checkpoint_failure_reason(&AgentError::Checkpoint(
                "artifact upload failed".to_string()
            )),
            None
        );
    }

    static COMPLETE_EXECUTION_MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(MockServer::start);
    static MAIN_TEST_RUNTIME_ROOT: LazyLock<std::path::PathBuf> = LazyLock::new(|| {
        let timestamp_nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "vm0-guest-agent-main-tests-{}-{timestamp_nanos}",
            std::process::id()
        ))
    });
    fn lock_test_state() -> std::sync::MutexGuard<'static, ()> {
        TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn test_http_client(server: &MockServer) -> HttpClient {
        HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap()
    }

    fn test_guest_config(server: &MockServer, prompt: Option<&str>) -> env::GuestConfig {
        env::GuestConfig::from_raw(env::GuestConfigRaw {
            run_id: "main-recovery-checkpoint".to_string(),
            api_url: server.base_url(),
            api_token: "test-token".to_string(),
            home: Some("/home/vm0".to_string()),
            run_payload_file: write_test_run_payload(prompt)
                .to_string_lossy()
                .into_owned(),
            guest_runtime_dir: Some(test_runtime_dir()),
            ..env::GuestConfigRaw::default()
        })
        .unwrap()
    }

    fn test_guest_runtime(config: env::GuestConfig, http: HttpClient) -> GuestRuntime {
        GuestRuntime {
            config,
            paths: paths::GuestPaths::from_runtime_dir(test_runtime_dir()),
            http,
            workload_containment: None,
            process_control_endpoint: None,
        }
    }

    fn test_runtime_dir() -> std::path::PathBuf {
        MAIN_TEST_RUNTIME_ROOT.join("main-recovery-checkpoint")
    }

    fn write_test_run_payload(prompt: Option<&str>) -> std::path::PathBuf {
        let dir = test_runtime_dir().join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
        let create_result = std::fs::create_dir_all(&dir);
        assert!(
            create_result.is_ok(),
            "create test run payload dir: {create_result:?}"
        );
        let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
        let payload = guest_contracts::env::RunPayload {
            prompt: prompt.unwrap_or_default().to_string(),
            ..guest_contracts::env::RunPayload::default()
        };
        let bytes_result = serde_json::to_vec(&payload);
        assert!(
            bytes_result.is_ok(),
            "serialize test run payload: {bytes_result:?}"
        );
        let write_result = std::fs::write(&path, bytes_result.unwrap_or_default());
        assert!(
            write_result.is_ok(),
            "write test run payload: {write_result:?}"
        );
        path
    }

    fn test_guest_paths() -> paths::GuestPaths {
        paths::GuestPaths::from_runtime_dir(test_runtime_dir())
    }

    fn run_scoped_cleanup_paths(paths: &paths::GuestPaths, include_session: bool) -> Vec<String> {
        let mut cleanup_paths = Vec::new();
        if include_session {
            cleanup_paths.push(paths.session_id_file().to_string());
        }
        cleanup_paths.extend([
            paths.checkpoint_error_file().to_string(),
            paths.failure_diagnostic_file().to_string(),
            paths.sandbox_ops_file().to_string(),
            paths.telemetry_system_log_pos_file().to_string(),
            paths.telemetry_metrics_pos_file().to_string(),
            paths.telemetry_sandbox_ops_pos_file().to_string(),
        ]);
        cleanup_paths
    }

    #[test]
    fn framework_supports_active_input_for_all_cli_frameworks() {
        assert!(framework_supports_active_input(env::Framework::ClaudeCode));
        assert!(framework_supports_active_input(env::Framework::Codex));
        assert!(framework_supports_active_input(env::Framework::Pi));
    }

    struct TestRuntimeRootGuard;

    impl TestRuntimeRootGuard {
        fn new() -> Self {
            let _ = std::fs::remove_dir_all(&*MAIN_TEST_RUNTIME_ROOT);
            Self
        }
    }

    impl Drop for TestRuntimeRootGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&*MAIN_TEST_RUNTIME_ROOT);
        }
    }

    struct SystemLogOverrideGuard;

    impl SystemLogOverrideGuard {
        fn set(path: &std::path::Path) -> Self {
            guest_telemetry::log::set_system_log_file(path.to_string_lossy().as_ref());
            Self
        }
    }

    impl Drop for SystemLogOverrideGuard {
        fn drop(&mut self) {
            guest_telemetry::log::clear_system_log_file();
        }
    }

    struct SandboxOpsOverrideGuard;

    impl SandboxOpsOverrideGuard {
        fn set(path: &std::path::Path) -> Self {
            guest_telemetry::telemetry::set_sandbox_ops_log_file(path);
            Self
        }
    }

    impl Drop for SandboxOpsOverrideGuard {
        fn drop(&mut self) {
            guest_telemetry::telemetry::clear_sandbox_ops_log_file();
        }
    }

    #[test]
    fn successful_post_result_cleanup_preserves_semantic_success_only_for_narrow_case() {
        let success_result = cli::JsonlResultSummary {
            num_turns: Some(1),
            status: cli::JsonlResultStatus::Success,
            model_request: None,
        };
        let make_result = |jsonl_result: cli::JsonlResultSummary,
                           cleanup_result: cli::JsonlResultSummary,
                           termination_reason: CliTerminationReason| {
            let termination = CliTerminationDiagnostic::new(termination_reason)
                .record_signal(CliTerminationSignal::Sigterm, Some(42), Some(1_000))
                .with_observed_exit_code(143);
            cli::CliExecutionResult {
                exit_code: 143,
                cli_observed_exit: Some(CliObservedExitDiagnostic::from_signal(libc::SIGTERM)),
                stderr_lines: Vec::new(),
                last_event_sequence: None,
                event_delivery: None,
                heartbeat: None,
                jsonl_result: Some(jsonl_result),
                post_result_cleanup_jsonl_result: Some(cleanup_result),
                failure_diagnostic: None,
                control_error: None,
                cli_termination: Some(termination),
                active_input_delivery_ids: Vec::new(),
            }
        };
        let successful_cleanup = make_result(
            success_result,
            success_result,
            CliTerminationReason::PostResultReap,
        );

        assert!(preserves_successful_post_result_cleanup(
            env::Framework::ClaudeCode,
            &successful_cleanup,
        ));
        assert!(!preserves_successful_post_result_cleanup(
            env::Framework::Codex,
            &successful_cleanup,
        ));

        let late_error_result_after_successful_cleanup = make_result(
            cli::JsonlResultSummary {
                num_turns: Some(1),
                status: cli::JsonlResultStatus::Error,
                model_request: None,
            },
            success_result,
            CliTerminationReason::PostResultReap,
        );
        assert!(preserves_successful_post_result_cleanup(
            env::Framework::ClaudeCode,
            &late_error_result_after_successful_cleanup,
        ));

        let error_cleanup = make_result(
            success_result,
            cli::JsonlResultSummary {
                num_turns: Some(1),
                status: cli::JsonlResultStatus::Error,
                model_request: None,
            },
            CliTerminationReason::PostResultReap,
        );
        assert!(!preserves_successful_post_result_cleanup(
            env::Framework::ClaudeCode,
            &error_cleanup,
        ));

        let stronger_termination = make_result(
            success_result,
            success_result,
            CliTerminationReason::StuckToolWatchdog,
        );
        assert!(!preserves_successful_post_result_cleanup(
            env::Framework::ClaudeCode,
            &stronger_termination,
        ));
    }

    #[test]
    fn success_checkpoint_follows_semantic_run_success() {
        assert!(should_create_success_checkpoint(0));
        assert!(!should_create_success_checkpoint(1));
    }

    #[test]
    fn final_telemetry_success_does_not_record_recursive_upload_op() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(assert_final_telemetry_does_not_record_recursive_upload_op(
                200,
            ));
    }

    #[test]
    fn final_telemetry_failure_does_not_record_recursive_upload_op() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(assert_final_telemetry_does_not_record_recursive_upload_op(
                500,
            ));
    }

    async fn assert_final_telemetry_does_not_record_recursive_upload_op(status: u16) {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _runtime_root_guard = TestRuntimeRootGuard::new();
        let guest_paths = test_guest_paths();

        let tmp = tempfile::tempdir().unwrap();
        let system_log_path = tmp.path().join("system.log");
        let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);
        let _sandbox_ops_guard =
            SandboxOpsOverrideGuard::set(std::path::Path::new(guest_paths.sandbox_ops_file()));
        let cleanup_paths = vec![
            system_log_path.to_string_lossy().into_owned(),
            guest_paths.sandbox_ops_file().to_string(),
            guest_paths.telemetry_system_log_pos_file().to_string(),
            guest_paths.telemetry_metrics_pos_file().to_string(),
            guest_paths.telemetry_sandbox_ops_pos_file().to_string(),
        ];
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let telemetry_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("before_final_telemetry");
            then.status(status)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        record_sandbox_op(
            "before_final_telemetry",
            Duration::from_millis(1),
            true,
            None,
        );
        let config = test_guest_config(server, None);
        let masker = Arc::new(masker::SecretMasker::from_config(&config));
        let http = test_http_client(server);
        let telemetry =
            Telemetry::spawn_for_paths(config.run_id.clone(), &guest_paths, masker, http);

        final_telemetry(telemetry).await;

        telemetry_mock.assert_calls_async(1).await;
        telemetry_mock.delete_async().await;
        let sandbox_ops =
            std::fs::read_to_string(guest_paths.sandbox_ops_file()).unwrap_or_default();
        assert!(
            !sandbox_ops.contains("final_telemetry_upload"),
            "final telemetry must not record telemetry-upload telemetry through the same stream"
        );

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn final_telemetry_waits_for_background_producers_before_upload() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
                server.reset_async().await;
                let tmp = tempfile::tempdir().unwrap();
                let guest_paths = paths::GuestPaths::from_runtime_dir(tmp.path());
                let system_log_path = Path::new(guest_paths.system_log_file());
                paths::write_private(system_log_path, "").unwrap();
                let _system_log_guard = SystemLogOverrideGuard::set(system_log_path);
                let _sandbox_ops_guard = SandboxOpsOverrideGuard::set(std::path::Path::new(
                    guest_paths.sandbox_ops_file(),
                ));

                let marker = "producer_after_shutdown_before_final_upload";
                let request_bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
                let request_bodies_for_mock = Arc::clone(&request_bodies);
                let telemetry_mock = server.mock(|when, then| {
                    when.method(POST)
                        .path("/api/webhooks/agent/telemetry");
                    then.respond_with(move |request| {
                        request_bodies_for_mock.lock().unwrap().push(request.body_vec());
                        HttpMockResponse::builder()
                            .status(200)
                            .header("Content-Type", "application/json")
                            .body("{}")
                            .build()
                    });
                });

                let shutdown = CancellationToken::new();
                let producer_shutdown = shutdown.clone();
                let (producer_cancelled_tx, producer_cancelled_rx) = tokio::sync::oneshot::channel();
                let (release_producer_tx, release_producer_rx) = tokio::sync::oneshot::channel();
                let metrics_handle = tokio::spawn(async move {
                    producer_shutdown.cancelled().await;
                    producer_cancelled_tx.send(()).unwrap();
                    release_producer_rx.await.unwrap();
                    record_sandbox_op(marker, Duration::from_millis(1), true, None);
                });
                let (heartbeat_done_tx, heartbeat_done_rx) = tokio::sync::oneshot::channel();
                let heartbeat_handle = tokio::spawn(async move {
                    heartbeat_done_tx.send(()).unwrap();
                });
                let masker = Arc::new(masker::SecretMasker::from_raw(""));
                let http = test_http_client(server);
                let telemetry = Telemetry::spawn_for_paths(
                    "test-run-001".to_string(),
                    &guest_paths,
                    masker,
                    http,
                );

                tokio::time::timeout(Duration::from_secs(5), async {
                    // On this current-thread runtime the sender's task finishes
                    // before we resume. Heartbeat cleanup must not mask the join
                    // under test by providing another pending await first.
                    heartbeat_done_rx.await.unwrap();
                    assert!(heartbeat_handle.is_finished());
                    let finalization = stop_background_and_flush_final_telemetry(
                        shutdown,
                        None,
                        metrics_handle,
                        heartbeat_handle,
                        telemetry,
                    );
                    // Exclude cooperative-budget yields from both explicit polls.
                    let finalization = tokio::task::unconstrained(finalization);
                    tokio::pin!(finalization);
                    assert!(futures_util::poll!(&mut finalization).is_pending());
                    producer_cancelled_rx.await.unwrap();

                    // Poll past already-settled heartbeat cleanup while the
                    // producer is acknowledged but still blocked on release.
                    let finalization_poll = futures_util::poll!(&mut finalization);
                    // This log is synchronously persisted before final_telemetry's
                    // first await, unlike an eventually dispatched HTTP request.
                    let final_upload_log = "Performing final telemetry upload...";
                    assert!(
                        !std::fs::read_to_string(system_log_path)
                            .unwrap()
                            .contains(final_upload_log),
                        "final telemetry started before the producer was released"
                    );
                    assert!(finalization_poll.is_pending());

                    release_producer_tx.send(()).unwrap();
                    finalization.await;
                    assert!(
                        std::fs::read_to_string(system_log_path)
                            .unwrap()
                            .contains(final_upload_log),
                        "completed shutdown must exercise the final-upload log boundary"
                    );
                })
                .await
                .expect(
                    "final telemetry producer shutdown and final upload completion should finish within 5 seconds",
                );

                telemetry_mock.assert_calls_async(1).await;
                telemetry_mock.delete_async().await;
                let request_bodies = request_bodies.lock().unwrap();
                assert_eq!(request_bodies.len(), 1);
                let payload: serde_json::Value = serde_json::from_slice(&request_bodies[0]).unwrap();
                let operations = payload["sandboxOperations"].as_array().unwrap();
                assert_eq!(operations.len(), 1);
                assert_eq!(operations[0]["action_type"], marker);
            });
    }

    #[test]
    fn stop_heartbeat_aborts_pending_task_promptly() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let heartbeat_handle = tokio::spawn(async {
                    std::future::pending::<()>().await;
                });
                tokio::time::timeout(Duration::from_secs(1), stop_heartbeat(heartbeat_handle))
                    .await
                    .expect("stop_heartbeat should not wait for the heartbeat loop");
            });
    }

    #[test]
    fn complete_execution_creates_recovery_checkpoint_after_cli_failure() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_after_cli_failure_inner(
                200,
                1,
                1,
                "You've hit your usage limit.",
                FailureReason::UsageLimit,
            ));
    }

    #[test]
    fn complete_execution_keeps_cli_failure_when_recovery_report_fails() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_after_cli_failure_inner(
                500,
                3,
                1,
                "You've hit your usage limit.",
                FailureReason::UsageLimit,
            ));
    }

    #[test]
    fn complete_execution_reports_timeout_reason_with_recovery_checkpoint() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_after_cli_failure_inner(
                200,
                1,
                AGENT_EXECUTION_TIMEOUT_EXIT_CODE,
                "execution: Agent execution timed out after 7200 seconds",
                FailureReason::ExecutionTimeout,
            ));
    }

    #[test]
    fn complete_execution_keeps_success_when_history_is_unavailable() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_keeps_success_when_history_is_unavailable_inner());
    }

    #[test]
    fn complete_execution_writes_checkpoint_failure_diagnostic() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_writes_checkpoint_failure_diagnostic_inner());
    }

    #[test]
    fn complete_execution_treats_combined_report_failure_as_checkpoint_failure() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(
                complete_execution_treats_combined_report_failure_as_checkpoint_failure_inner(),
            );
    }

    #[test]
    fn complete_execution_keeps_workload_resource_counters_out_of_messages() {
        let _test_state_guard = lock_test_state();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(complete_execution_keeps_workload_resource_counters_out_of_messages_inner());
    }

    async fn complete_execution_keeps_workload_resource_counters_out_of_messages_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        let _runtime_root_guard = TestRuntimeRootGuard::new();
        let hard_limit = WorkloadResourceLimitDiagnostic {
            memory_max_events: 1_882_956,
            memory_oom_events: 3,
            memory_oom_kill_events: 3,
            memory_oom_group_kill_events: 0,
            pids_max_events: 0,
        };
        let provider_message = "Selected model is at capacity. Please try a different model.";
        let provider_diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(1)
        .with_failure_detail_source(FailureDetailSource::CodexJsonl)
        .with_failure_reason(FailureReason::ProviderOverloaded);

        let (exit_code, error, diagnostic) = complete_after_workload_resource_limit(
            server,
            1,
            provider_message,
            Some(provider_diagnostic),
            hard_limit,
        )
        .await;

        assert_eq!(exit_code, 1);
        assert_eq!(error.as_deref(), Some(provider_message));
        let diagnostic = diagnostic.expect("expected classified failure diagnostic");
        assert_eq!(
            diagnostic.failure_reason,
            Some(FailureReason::ProviderOverloaded)
        );
        assert_eq!(diagnostic.workload_resource_limit, Some(hard_limit));

        let generic_message = "Agent exited with code 137";
        let generic_diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(137)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL))
        .with_failure_detail_source(FailureDetailSource::FallbackExitCode);

        let (exit_code, error, diagnostic) = complete_after_workload_resource_limit(
            server,
            137,
            generic_message,
            Some(generic_diagnostic),
            hard_limit,
        )
        .await;

        assert_eq!(exit_code, 137);
        assert_eq!(error.as_deref(), Some(generic_message));
        let diagnostic = diagnostic.expect("expected generic failure diagnostic");
        assert_eq!(diagnostic.failure_reason, None);
        assert_eq!(diagnostic.workload_resource_limit, Some(hard_limit));

        let timeout_message = "Agent execution timed out after 7200 seconds";
        let timeout_termination =
            CliTerminationDiagnostic::new(CliTerminationReason::ExecutionTimeout);
        let timeout_diagnostic = FailureDiagnostic::new(
            FailureClass::CliExecutionError,
            AgentFramework::Codex,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(AGENT_EXECUTION_TIMEOUT_EXIT_CODE)
        .with_cli_termination(timeout_termination);

        let (exit_code, error, diagnostic) = complete_after_workload_resource_limit(
            server,
            AGENT_EXECUTION_TIMEOUT_EXIT_CODE,
            timeout_message,
            Some(timeout_diagnostic),
            hard_limit,
        )
        .await;

        assert_eq!(exit_code, AGENT_EXECUTION_TIMEOUT_EXIT_CODE);
        assert_eq!(error.as_deref(), Some(timeout_message));
        let diagnostic = diagnostic.expect("expected timeout failure diagnostic");
        assert_eq!(diagnostic.cli_termination, Some(timeout_termination));
        assert_eq!(diagnostic.workload_resource_limit, Some(hard_limit));

        let (exit_code, error, diagnostic) =
            complete_after_workload_resource_limit(server, 0, "", None, hard_limit).await;

        assert_eq!(exit_code, 0);
        assert_eq!(error, None);
        assert_eq!(diagnostic, None);
    }

    async fn complete_after_workload_resource_limit(
        server: &MockServer,
        cli_exit_code: i32,
        initial_error_message: &str,
        mut failure_diagnostic: Option<FailureDiagnostic>,
        hard_limit: WorkloadResourceLimitDiagnostic,
    ) -> (i32, Option<String>, Option<FailureDiagnostic>) {
        let guest_paths = test_guest_paths();
        let cleanup_paths = run_scoped_cleanup_paths(&guest_paths, false);
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let mut config = test_guest_config(server, Some("plain prompt"));
        config.framework = env::Framework::Codex;
        config.cli_agent_type = "codex".to_string();
        let masker = Arc::new(masker::SecretMasker::from_config(&config));
        let http = HttpClient::new().unwrap();
        let telemetry =
            Telemetry::spawn_for_paths(config.run_id.clone(), &guest_paths, masker, http.clone());
        let runtime = test_guest_runtime(config, http);
        let error_message = initial_error_message.to_string();
        apply_workload_resource_limit(&mut failure_diagnostic, hard_limit);
        let exit_code = complete_execution(
            cli_exit_code,
            cli_exit_code,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: (cli_exit_code != 0).then_some(error_message.as_str()),
                failure_diagnostic,
                active_input_delivery_ids: &[],
                session_metadata: None,
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        let error_path = std::path::Path::new(guest_paths.checkpoint_error_file());
        let written_error = error_path
            .exists()
            .then(|| std::fs::read_to_string(error_path).unwrap());
        let diagnostic_path = std::path::Path::new(guest_paths.failure_diagnostic_file());
        let written_diagnostic = diagnostic_path
            .exists()
            .then(|| serde_json::from_slice(&std::fs::read(diagnostic_path).unwrap()).unwrap());

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
        (exit_code, written_error, written_diagnostic)
    }

    async fn complete_execution_writes_checkpoint_failure_diagnostic_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _runtime_root_guard = TestRuntimeRootGuard::new();
        let guest_paths = test_guest_paths();

        let cleanup_paths = run_scoped_cleanup_paths(&guest_paths, true);
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let config = test_guest_config(server, Some("/checkpoint-failure"));
        let masker = Arc::new(masker::SecretMasker::from_config(&config));
        let http = test_http_client(server);
        let telemetry =
            Telemetry::spawn_for_paths(config.run_id.clone(), &guest_paths, masker, http.clone());
        let runtime = test_guest_runtime(config, http.clone());
        let exit_code = complete_execution(
            0,
            0,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: None,
                failure_diagnostic: None,
                active_input_delivery_ids: &[],
                session_metadata: None,
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        let error = std::fs::read_to_string(guest_paths.checkpoint_error_file()).unwrap();
        assert!(error.contains("Checkpoint failed"), "got: {error}");
        let diagnostic: FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(guest_paths.failure_diagnostic_file()).unwrap())
                .unwrap();
        assert_eq!(diagnostic.failure_class, FailureClass::CheckpointFailed);
        assert_eq!(diagnostic.cli_exit_code, Some(0));
        assert_eq!(
            diagnostic.session_history_status,
            SessionHistoryStatus::Missing
        );
        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_treats_combined_report_failure_as_checkpoint_failure_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _runtime_root_guard = TestRuntimeRootGuard::new();
        let guest_paths = test_guest_paths();

        let cleanup_paths = run_scoped_cleanup_paths(&guest_paths, true);
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let complete_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/complete")
                .json_body_includes(
                    r#"{"exitCode":0,"checkpoint":{"cliAgentSessionId":"combined-failure-session"}}"#,
                );
            then.status(500);
        });
        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let config = test_guest_config(server, Some("/combined-checkpoint-failure"));
        let masker = Arc::new(masker::SecretMasker::from_config(&config));
        let http = test_http_client(server);
        let telemetry =
            Telemetry::spawn_for_paths(config.run_id.clone(), &guest_paths, masker, http.clone());
        let runtime = test_guest_runtime(config, http);
        let session_metadata =
            session_metadata::CapturedSessionMetadata::for_test("combined-failure-session", None);
        let exit_code = complete_execution(
            0,
            0,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: None,
                failure_diagnostic: None,
                active_input_delivery_ids: &[],
                session_metadata: Some(&session_metadata),
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 1);
        complete_mock.assert_calls_async(3).await;
        let error = std::fs::read_to_string(guest_paths.checkpoint_error_file()).unwrap();
        assert!(
            error.contains("POST failed after 3 attempts"),
            "got: {error}"
        );
        let diagnostic: FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(guest_paths.failure_diagnostic_file()).unwrap())
                .unwrap();
        assert_eq!(diagnostic.failure_class, FailureClass::CheckpointFailed);
        assert_eq!(diagnostic.cli_exit_code, Some(0));

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_keeps_success_when_history_is_unavailable_inner() {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _runtime_root_guard = TestRuntimeRootGuard::new();
        let guest_paths = test_guest_paths();

        let cleanup_paths = run_scoped_cleanup_paths(&guest_paths, false);
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let prepare_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history");
            then.status(500);
        });
        let complete_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/complete")
                .json_body_includes(
                    r#"{"exitCode":0,"checkpoint":{"cliAgentSessionHistoryDisposition":"unavailable"}}"#,
                );
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({"success": true, "status": "completed"}));
        });
        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let config = test_guest_config(server, Some("/help"));
        let masker = Arc::new(masker::SecretMasker::from_config(&config));
        let http = test_http_client(server);
        let telemetry =
            Telemetry::spawn_for_paths(config.run_id.clone(), &guest_paths, masker, http.clone());
        let runtime = test_guest_runtime(config, http.clone());
        let session_metadata =
            session_metadata::CapturedSessionMetadata::for_test("zero-turn-session", None);
        let exit_code = complete_execution(
            0,
            0,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: None,
                failure_diagnostic: None,
                active_input_delivery_ids: &[],
                session_metadata: Some(&session_metadata),
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, 0);
        assert_eq!(prepare_mock.calls_async().await, 0);
        assert_eq!(complete_mock.calls_async().await, 1);

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn complete_execution_after_cli_failure_inner(
        completion_status: u16,
        expected_completion_calls: usize,
        failure_exit_code: i32,
        failure_message: &str,
        failure_reason: FailureReason,
    ) {
        let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
        server.reset_async().await;
        let _runtime_root_guard = TestRuntimeRootGuard::new();
        let guest_paths = test_guest_paths();

        let cleanup_paths = run_scoped_cleanup_paths(&guest_paths, true);
        for path in &cleanup_paths {
            let _ = std::fs::remove_file(path);
        }

        let dir = tempfile::tempdir().unwrap();
        let session_id = "recovery-session-from-main";
        let config_dir = dir.path().join("claude-config");
        let history_path = config_dir
            .join("projects")
            .join("-home-user-workspace")
            .join(format!("{session_id}.jsonl"));
        let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
        std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        std::fs::write(&history_path, &history).unwrap();
        let session_metadata = session_metadata::CapturedSessionMetadata::for_test(
            session_id,
            Some(
                guest_contracts::session_history_identity::SessionHistorySourceRef::ClaudeCode {
                    config_dir: config_dir.to_string_lossy().into_owned(),
                    working_dir: paths::CANONICAL_WORKING_DIR.to_string(),
                    session_id: session_id.to_string(),
                },
            ),
        );

        let prepare_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history")
                .json_body_includes(r#"{"runId":"main-recovery-checkpoint"}"#);
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({
                    "presignedUrl": server.url("/test/main-recovery-history-upload"),
                    "existing": false
                }));
        });
        let upload_mock = server.mock(|when, then| {
            when.method(PUT)
                .path("/test/main-recovery-history-upload")
                .body(history.as_str());
            then.status(200);
        });
        let complete_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/complete")
                .json_body_includes(
                    serde_json::json!({
                        "exitCode": failure_exit_code,
                        "failureReason": failure_reason.as_str(),
                        "error": failure_message,
                        "checkpoint": {
                            "cliAgentSessionId": "recovery-session-from-main"
                        }
                    })
                    .to_string(),
                );
            then.status(completion_status)
                .header("Content-Type", "application/json")
                .json_body(json!({"success": true, "status": "failed"}));
        });
        let _telemetry_mock = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .header("Content-Type", "application/json")
                .json_body(json!({}));
        });

        let config = test_guest_config(server, Some("plain prompt"));
        let masker = Arc::new(masker::SecretMasker::from_config(&config));
        let http = test_http_client(server);
        let telemetry =
            Telemetry::spawn_for_paths(config.run_id.clone(), &guest_paths, masker, http.clone());
        let runtime = test_guest_runtime(config, http.clone());
        let failure_diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_cli_exit_code(failure_exit_code)
        .with_failure_reason(failure_reason)
        .with_session_history_status(SessionHistoryStatus::Present);
        let exit_code = complete_execution(
            failure_exit_code,
            failure_exit_code,
            Duration::ZERO,
            CompletionState {
                last_event_sequence: None,
                failure_message: Some(failure_message),
                failure_diagnostic: Some(failure_diagnostic.clone()),
                active_input_delivery_ids: &[],
                session_metadata: Some(&session_metadata),
            },
            &telemetry,
            &runtime,
        )
        .await;
        telemetry.shutdown().await;

        assert_eq!(exit_code, failure_exit_code);
        assert_eq!(
            std::fs::read_to_string(guest_paths.checkpoint_error_file()).unwrap(),
            failure_message
        );
        let diagnostic: FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(guest_paths.failure_diagnostic_file()).unwrap())
                .unwrap();
        assert_eq!(diagnostic, failure_diagnostic);
        prepare_mock.assert_calls_async(1).await;
        upload_mock.assert_calls_async(1).await;
        complete_mock
            .assert_calls_async(expected_completion_calls)
            .await;

        for path in cleanup_paths {
            let _ = std::fs::remove_file(path);
        }
    }
}
