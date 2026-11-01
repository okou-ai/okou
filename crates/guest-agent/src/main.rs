//! Guest agent — orchestrates CLI execution, heartbeat, telemetry, and
//! native history and file-output finalization inside a Firecracker VM.

use guest_agent::cli;
use guest_agent::complete;
use guest_agent::control;
use guest_agent::env;
use guest_agent::error::AgentError;
use guest_agent::failure_diagnostics;
use guest_agent::finalization;
use guest_agent::heartbeat;
use guest_agent::http::HttpClient;
use guest_agent::masker;
use guest_agent::metrics;
use guest_agent::paths;
use guest_agent::reuse_preparation;
use guest_agent::run_context::GuestRuntime;
use guest_agent::session_history_identity;
use guest_agent::session_metadata;
use guest_agent::telemetry::{Telemetry, UploadMode};

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

fn finalization_failure_reason(error: &AgentError) -> Option<FailureReason> {
    matches!(error, AgentError::SessionHistoryTooLarge { .. })
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
        "recover-disk-space" => {
            let filesystem = match args.next().as_deref().and_then(std::ffi::OsStr::to_str) {
                Some("home") => guest_contracts::disk_cleanup::DiskCleanupFilesystem::Home,
                Some("rootfs") => guest_contracts::disk_cleanup::DiskCleanupFilesystem::Rootfs,
                _ => return Some(2),
            };
            if args.next().is_some() {
                return Some(2);
            }
            Some(match guest_agent::disk_cleanup::recover(filesystem) {
                Ok(report) => match serde_json::to_string(&report) {
                    Ok(json) => {
                        println!("{json}");
                        0
                    }
                    Err(error) => {
                        eprintln!("serialize disk cleanup report: {error}");
                        1
                    }
                },
                Err(error) => {
                    eprintln!("disk cleanup failed: {error}");
                    1
                }
            })
        }
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
        "verify-home-cache-history" => {
            if args.next().is_some() {
                return Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS);
            }
            Some(match guest_agent::home_cache_history::verify_from_stdin() {
                Ok(report) => match serde_json::to_string(&report) {
                    Ok(json) => {
                        println!("{json}");
                        0
                    }
                    Err(_) => 1,
                },
                Err(_) => SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
            })
        }
        "prepare-for-reuse" | "prepare-for-cache" => {
            if args.next().is_some() {
                return Some(
                    guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INVALID_REQUEST,
                );
            }
            let result = if command == "prepare-for-cache" {
                reuse_preparation::prepare_for_cache_from_stdin().and_then(|report| {
                    serde_json::to_string(&report).map_err(|error| {
                        reuse_preparation::ReusePreparationError::Inspection(std::io::Error::other(
                            error,
                        ))
                    })
                })
            } else {
                reuse_preparation::prepare_from_stdin().and_then(|report| {
                    serde_json::to_string(&report).map_err(|error| {
                        reuse_preparation::ReusePreparationError::Inspection(std::io::Error::other(
                            error,
                        ))
                    })
                })
            };
            Some(match result {
                Ok(json) => {
                    println!("{json}");
                    guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_SUCCESS
                }
                Err(error) => {
                    eprintln!("{error}");
                    error.exit_code()
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
        guest_agent::active_input::ActiveInputRuntime::new_enabled(
            &runtime.config.run_id,
            &runtime.config.prompt,
            http.clone(),
        )
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

    // Execute main logic (init + CLI + finalization/recovery + /complete).
    // On the success path, `execute` overlaps the pre-finalization telemetry
    // flush with output finalization. The EOF-consuming final flush runs below,
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

/// Main execution logic: working dir, CLI, finalization/recovery, and `/complete`.
/// The success path overlaps the pre-finalization telemetry flush with
/// output finalization. Final telemetry is owned by [`run`] after producer
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
        failure_diagnostics::write_guest_error_file(runtime_paths.finalization_error_file(), &msg);
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
    let pi_startup =
        matches!(config.framework, env::Framework::Pi).then(cli::PiStartupTiming::start);

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
        failure_diagnostics::write_guest_error_file(runtime_paths.finalization_error_file(), &msg);
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
    let mut event_delivery = None;
    let session_metadata = session_metadata::SessionMetadataStore::default();
    let cli_result = cli::execute_cli_with_controls_for_config_started_at(
        masker,
        heartbeat_monitor,
        http.clone(),
        cli::CliExecutionControls::new(active_input, cli_cancellation, codex_startup.as_ref())
            .with_pi_startup(pi_startup.as_ref())
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
    if let Some(pi_startup) = pi_startup.as_ref() {
        pi_startup.record_failure();
    }
    let (
        cli_exit_code,
        exit_code,
        mut error_message,
        mut failure_diagnostic,
        cli_execution_succeeded,
    ) = match cli_result {
        Ok(cli_result) => {
            last_event_sequence = cli_result.last_event_sequence;
            event_delivery = cli_result.event_delivery.clone();
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
        attribute_codex_child_oom(
            exit_code,
            &mut error_message,
            failure_diagnostic.as_ref(),
            evidence.as_ref(),
        );
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
                    } else if let Some(classification) = evidence
                        .as_ref()
                        .and_then(guest_contracts::oom_evidence::OomEvidence::classification)
                    {
                        log_warn!(
                            LOG_TAG,
                            "{message} oom_classification={}",
                            classification.as_str()
                        );
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

    // Event visibility is best effort; native finalization still owns persistence.
    if let Some(event_delivery) = event_delivery {
        log_warn!(
            LOG_TAG,
            "{}; retaining CLI outcome; diagnostic={event_delivery:?}",
            event_delivery_failure_message(&event_delivery)
        );
        if let Some(diagnostic) = failure_diagnostic.take() {
            failure_diagnostic = Some(diagnostic.with_event_delivery(event_delivery));
        }
    }

    complete_execution(
        masker,
        cli_exit_code,
        exit_code,
        cli_elapsed,
        CompletionState {
            last_event_sequence,
            failure_message: (exit_code != 0).then_some(error_message.as_str()),
            failure_diagnostic,
            session_metadata: session_metadata.captured(),
        },
        telemetry,
        runtime,
    )
    .await
}

fn attribute_codex_child_oom(
    exit_code: i32,
    error_message: &mut String,
    diagnostic: Option<&FailureDiagnostic>,
    evidence: Option<&guest_contracts::oom_evidence::OomEvidence>,
) {
    if exit_code == 1
        && diagnostic.is_some_and(FailureDiagnostic::is_codex_app_server_sigkill)
        && evidence.is_some_and(guest_contracts::oom_evidence::OomEvidence::agent_domain_oom_kill)
    {
        *error_message = guest_contracts::diagnostics::GUEST_MEMORY_OOM_KILLED_ERROR.to_string();
    }
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
            "Event delivery failed after acknowledged sequence {last_acknowledged}: batch {}-{} failed and the global drain deadline interrupted batch {}-{}",
            failed.first_sequence,
            failed.last_sequence,
            active.first_sequence,
            active.last_sequence
        ),
        (Some(failed), None) => format!(
            "Event delivery failed after acknowledged sequence {last_acknowledged}: batch {}-{} failed",
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
/// Both the finalization and the Pi artifact snapshot must fail the run: settling
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
    failure_diagnostics::write_guest_error_file(runtime_paths.finalization_error_file(), &msg);
    if failure.wrote_failure_diagnostic {
        return;
    }
    let mut diagnostic = failure_diagnostics::base_failure_diagnostic_for_config(
        config,
        FailureClass::FinalizationFailed,
    )
    .with_cli_exit_code(failure.cli_exit_code);
    if let Some(reason) = finalization_failure_reason(failure.error) {
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
    session_metadata: Option<&'a session_metadata::CapturedSessionMetadata>,
}

async fn complete_execution(
    masker: &masker::SecretMasker,
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
    let failure_message = state
        .failure_message
        .map(|message| masker.mask_string(message));
    if let Some(message) = failure_message.as_deref() {
        failure_diagnostics::write_guest_error_file(
            runtime_paths.finalization_error_file(),
            message,
        );
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

    // Finalization on success (skip when no API — local/test mode). The
    // pre-finalization flush runs in `tokio::join!` with the snapshot work so
    // its ~1s upload overlaps the ~4s finalization. The EOF-consuming final
    // pass runs from the top-level shutdown path after telemetry producers
    // stop, so it can safely catch finalization and `/complete` logs.
    let agent_type = config.framework.agent_type();
    if should_finalize_success(exit_code) && http.has_api() {
        log_info!(LOG_TAG, "{agent_type} completed successfully");

        log_info!(LOG_TAG, "▷ Finalization");
        let finalization_start = Instant::now();
        let finalization = async {
            let session_metadata = state.session_metadata.ok_or_else(|| {
                AgentError::Finalization("No valid CLI session ID was captured".to_string())
            })?;
            finalization::prepare_finalization_for_runtime(runtime, session_metadata).await
        };
        let (finalization_result, _) =
            tokio::join!(finalization, telemetry.flush(UploadMode::Live),);
        match finalization_result {
            Ok(finalization) => {
                // Persist the prepared finalization and terminal state together
                // before returning to the top-level final telemetry pass. See
                // the `complete` module docs for the runner's idempotent fallback
                // and provider-specific finalization ordering.
                log_info!(LOG_TAG, "▷ Cleanup");
                let result = complete::report_finalization_for_run(
                    runtime,
                    0,
                    None,
                    None,
                    state.last_event_sequence,
                    finalization,
                )
                .await;
                match result {
                    Ok(()) => {
                        guest_completion_reported = true;
                        log_info!(
                            LOG_TAG,
                            "✓ Finalization complete ({}s)",
                            finalization_start.elapsed().as_secs()
                        );
                    }
                    Err(e) => {
                        record_persistence_failure(
                            PersistenceFailure {
                                label: "Finalization",
                                error: &e,
                                elapsed: finalization_start.elapsed(),
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
                        label: "Finalization",
                        error: &e,
                        elapsed: finalization_start.elapsed(),
                        cli_exit_code,
                        wrote_failure_diagnostic,
                    },
                    runtime,
                    state.session_metadata,
                );
                exit_code = 1;

                // Failure path: don't call /complete from guest. The runner's
                // provider.complete() fallback posts exitCode=1, triggering
                // the route's "missing completion outputs → failed" branch.
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
                log_info!(LOG_TAG, "Attempting best-effort recovery finalization");
                match finalization::prepare_recovery_finalization_for_runtime(
                    runtime,
                    session_metadata,
                )
                .await
                {
                    Ok(finalization) => {
                        match complete::report_finalization_for_run(
                            runtime,
                            exit_code,
                            state
                                .failure_diagnostic
                                .as_ref()
                                .and_then(|diagnostic| diagnostic.failure_reason),
                            failure_message.as_deref(),
                            state.last_event_sequence,
                            finalization,
                        )
                        .await
                        {
                            Ok(()) => {
                                guest_completion_reported = true;
                                log_info!(LOG_TAG, "Recovery finalization created");
                            }
                            Err(e) => {
                                log_warn!(LOG_TAG, "Recovery finalization skipped: {e}");
                            }
                        }
                    }
                    Err(e) => log_warn!(LOG_TAG, "Recovery finalization skipped: {e}"),
                }
            } else {
                log_warn!(
                    LOG_TAG,
                    "Recovery finalization skipped because no valid CLI session ID was captured"
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
            state.last_event_sequence,
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

fn should_finalize_success(exit_code: i32) -> bool {
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
mod tests;
