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
fn finalization_history_limit_errors_have_a_stable_failure_reason() {
    assert_eq!(
        finalization_failure_reason(&AgentError::SessionHistoryTooLarge { max_bytes: 1 }),
        Some(FailureReason::SessionHistoryLimit)
    );
    assert_eq!(
        finalization_failure_reason(&AgentError::Finalization(
            "Session history exceeds maximum size of 134217728 bytes".to_string(),
        )),
        None
    );
    assert_eq!(
        finalization_failure_reason(&AgentError::Finalization(
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
        run_id: "main-recovery-finalization".to_string(),
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
    MAIN_TEST_RUNTIME_ROOT.join("main-recovery-finalization")
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
        paths.finalization_error_file().to_string(),
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
fn success_finalization_follows_semantic_run_success() {
    assert!(should_finalize_success(0));
    assert!(!should_finalize_success(1));
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
    let telemetry = Telemetry::spawn_for_paths(config.run_id.clone(), &guest_paths, masker, http);

    final_telemetry(telemetry).await;

    telemetry_mock.assert_calls_async(1).await;
    telemetry_mock.delete_async().await;
    let sandbox_ops = std::fs::read_to_string(guest_paths.sandbox_ops_file()).unwrap_or_default();
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
fn complete_execution_creates_recovery_finalization_after_cli_failure() {
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
fn complete_execution_reports_timeout_reason_with_recovery_finalization() {
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
fn complete_execution_writes_finalization_failure_diagnostic() {
    let _test_state_guard = lock_test_state();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(complete_execution_writes_finalization_failure_diagnostic_inner());
}

#[test]
fn complete_execution_treats_combined_report_failure_as_finalization_failure() {
    let _test_state_guard = lock_test_state();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(
            complete_execution_treats_combined_report_failure_as_finalization_failure_inner(),
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
        None,
        None,
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
        None,
        None,
    )
    .await;

    assert_eq!(exit_code, 137);
    assert_eq!(error.as_deref(), Some(generic_message));
    let diagnostic = diagnostic.expect("expected generic failure diagnostic");
    assert_eq!(diagnostic.failure_reason, None);
    assert_eq!(diagnostic.workload_resource_limit, Some(hard_limit));

    let timeout_message = "Agent execution timed out after 7200 seconds";
    let timeout_termination = CliTerminationDiagnostic::new(CliTerminationReason::ExecutionTimeout);
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
        None,
        None,
    )
    .await;

    assert_eq!(exit_code, AGENT_EXECUTION_TIMEOUT_EXIT_CODE);
    assert_eq!(error.as_deref(), Some(timeout_message));
    let diagnostic = diagnostic.expect("expected timeout failure diagnostic");
    assert_eq!(diagnostic.cli_termination, Some(timeout_termination));
    assert_eq!(diagnostic.workload_resource_limit, Some(hard_limit));

    let (exit_code, error, diagnostic) =
        complete_after_workload_resource_limit(server, 0, "", None, hard_limit, None, None).await;

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
    evidence: Option<&guest_contracts::oom_evidence::OomEvidence>,
    session_metadata: Option<&session_metadata::CapturedSessionMetadata>,
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
    let http = if session_metadata.is_some() {
        test_http_client(server)
    } else {
        HttpClient::new().unwrap()
    };
    let telemetry = Telemetry::spawn_for_paths(
        config.run_id.clone(),
        &guest_paths,
        masker.clone(),
        http.clone(),
    );
    let runtime = test_guest_runtime(config, http);
    let mut error_message = initial_error_message.to_string();
    apply_workload_resource_limit(&mut failure_diagnostic, hard_limit);
    attribute_codex_child_oom(
        cli_exit_code,
        &mut error_message,
        failure_diagnostic.as_ref(),
        evidence,
    );
    let exit_code = complete_execution(
        &masker,
        cli_exit_code,
        cli_exit_code,
        Duration::ZERO,
        CompletionState {
            last_event_sequence: None,
            failure_message: (cli_exit_code != 0).then_some(error_message.as_str()),
            failure_diagnostic,
            session_metadata,
        },
        &telemetry,
        &runtime,
    )
    .await;
    telemetry.shutdown().await;

    let error_path = std::path::Path::new(guest_paths.finalization_error_file());
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

#[test]
fn complete_execution_attributes_proven_codex_child_oom_without_changing_wrapper_exit() {
    let _test_state_guard = lock_test_state();
    tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                use guest_contracts::diagnostics::GUEST_MEMORY_OOM_KILLED_ERROR;
                use guest_contracts::oom_evidence::OomEvidence;
                let server = &*COMPLETE_EXECUTION_MOCK_SERVER;
                let _runtime_root_guard = TestRuntimeRootGuard::new();
                let runtime_oom: OomEvidence = serde_json::from_str(include_str!(
                    "../../../guest-contracts/tests/fixtures/runtime-counter-oom.json"
                ))
                .unwrap();
                let tool_oom: OomEvidence = serde_json::from_str(include_str!(
                    "../../../guest-contracts/tests/fixtures/contained-tool-oom.json"
                ))
                .unwrap();
                let mut unproven = runtime_oom.clone();
                unproven.groups[1].local_baseline.oom_kill = None;
                for incident in &mut unproven.incidents {
                    incident.groups[1].local_baseline.oom_kill = None;
                }
                let diagnostic = FailureDiagnostic::new(
                    FailureClass::CliExecutionError,
                    AgentFramework::Codex,
                    PromptMetadata::from_prompt("plain prompt"),
                )
                .with_cli_exit_code(137)
                .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));
                let hard_limit = WorkloadResourceLimitDiagnostic {
                    memory_max_events: 0,
                    memory_oom_events: 0,
                    memory_oom_kill_events: 1,
                    memory_oom_group_kill_events: 0,
                    pids_max_events: 0,
                };
                let original = "execution: codex app-server child exited while waiting for initialize: signal: 9 (SIGKILL)";
                let session_metadata = session_metadata::CapturedSessionMetadata::for_test(
                    "11111111-1111-4111-8111-111111111111",
                    None,
                );
                for (evidence, expected) in [
                    (Some(&runtime_oom), GUEST_MEMORY_OOM_KILLED_ERROR),
                    (Some(&tool_oom), original),
                    (Some(&unproven), original),
                    (None, original),
                ] {
                    server.reset_async().await;
                    let complete = server.mock(|when, then| {
                        when.method(POST)
                            .path("/api/webhooks/agent/complete")
                            .json_body_includes(json!({"exitCode": 1, "error": expected}).to_string());
                        then.status(200)
                            .json_body(json!({"success": true, "status": "failed"}));
                    });
                    let _telemetry = server.mock(|when, then| {
                        when.method(POST).path("/api/webhooks/agent/telemetry");
                        then.status(200).json_body(json!({}));
                    });
                    let (exit, error, retained) = complete_after_workload_resource_limit(
                        server,
                        1,
                        original,
                        Some(diagnostic.clone()),
                        hard_limit,
                        evidence,
                        Some(&session_metadata),
                    )
                    .await;
                    assert_eq!(exit, 1);
                    assert_eq!(error.as_deref(), Some(expected));
                    assert_eq!(
                        retained,
                        Some(diagnostic.clone().with_workload_resource_limit(hard_limit))
                    );
                    complete.assert_calls(1);
                }
            });
}

async fn complete_execution_writes_finalization_failure_diagnostic_inner() {
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

    let config = test_guest_config(server, Some("/finalization-failure"));
    let masker = Arc::new(masker::SecretMasker::from_config(&config));
    let http = test_http_client(server);
    let telemetry = Telemetry::spawn_for_paths(
        config.run_id.clone(),
        &guest_paths,
        masker.clone(),
        http.clone(),
    );
    let runtime = test_guest_runtime(config, http.clone());
    let exit_code = complete_execution(
        &masker,
        0,
        0,
        Duration::ZERO,
        CompletionState {
            last_event_sequence: None,
            failure_message: None,
            failure_diagnostic: None,
            session_metadata: None,
        },
        &telemetry,
        &runtime,
    )
    .await;
    telemetry.shutdown().await;

    assert_eq!(exit_code, 1);
    let error = std::fs::read_to_string(guest_paths.finalization_error_file()).unwrap();
    assert!(error.contains("Finalization failed"), "got: {error}");
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(guest_paths.failure_diagnostic_file()).unwrap())
            .unwrap();
    assert_eq!(diagnostic.failure_class, FailureClass::FinalizationFailed);
    assert_eq!(diagnostic.cli_exit_code, Some(0));
    assert_eq!(
        diagnostic.session_history_status,
        SessionHistoryStatus::Missing
    );
    for path in cleanup_paths {
        let _ = std::fs::remove_file(path);
    }
}

async fn complete_execution_treats_combined_report_failure_as_finalization_failure_inner() {
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
                r#"{"exitCode":0,"completion":{"cliAgentSessionId":"combined-failure-session"}}"#,
            );
        then.status(500);
    });
    let _telemetry_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });

    let config = test_guest_config(server, Some("/combined-finalization-failure"));
    let masker = Arc::new(masker::SecretMasker::from_config(&config));
    let http = test_http_client(server);
    let telemetry = Telemetry::spawn_for_paths(
        config.run_id.clone(),
        &guest_paths,
        masker.clone(),
        http.clone(),
    );
    let runtime = test_guest_runtime(config, http);
    let session_metadata =
        session_metadata::CapturedSessionMetadata::for_test("combined-failure-session", None);
    let exit_code = complete_execution(
        &masker,
        0,
        0,
        Duration::ZERO,
        CompletionState {
            last_event_sequence: None,
            failure_message: None,
            failure_diagnostic: None,
            session_metadata: Some(&session_metadata),
        },
        &telemetry,
        &runtime,
    )
    .await;
    telemetry.shutdown().await;

    assert_eq!(exit_code, 1);
    complete_mock.assert_calls_async(3).await;
    let error = std::fs::read_to_string(guest_paths.finalization_error_file()).unwrap();
    assert!(
        error.contains("POST failed after 3 attempts"),
        "got: {error}"
    );
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(guest_paths.failure_diagnostic_file()).unwrap())
            .unwrap();
    assert_eq!(diagnostic.failure_class, FailureClass::FinalizationFailed);
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

    let complete_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/complete")
                .json_body_includes(
                    r#"{"exitCode":0,"completion":{"cliAgentSessionHistoryDisposition":"native_only"}}"#,
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
    let telemetry = Telemetry::spawn_for_paths(
        config.run_id.clone(),
        &guest_paths,
        masker.clone(),
        http.clone(),
    );
    let runtime = test_guest_runtime(config, http.clone());
    let session_metadata =
        session_metadata::CapturedSessionMetadata::for_test("zero-turn-session", None);
    let exit_code = complete_execution(
        &masker,
        0,
        0,
        Duration::ZERO,
        CompletionState {
            last_event_sequence: None,
            failure_message: None,
            failure_diagnostic: None,
            session_metadata: Some(&session_metadata),
        },
        &telemetry,
        &runtime,
    )
    .await;
    telemetry.shutdown().await;

    assert_eq!(exit_code, 0);
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

    let complete_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .json_body_includes(
                serde_json::json!({
                    "exitCode": failure_exit_code,
                    "failureReason": failure_reason.as_str(),
                    "error": failure_message,
                    "completion": {
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
    let telemetry = Telemetry::spawn_for_paths(
        config.run_id.clone(),
        &guest_paths,
        masker.clone(),
        http.clone(),
    );
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
        &masker,
        failure_exit_code,
        failure_exit_code,
        Duration::ZERO,
        CompletionState {
            last_event_sequence: None,
            failure_message: Some(failure_message),
            failure_diagnostic: Some(failure_diagnostic.clone()),
            session_metadata: Some(&session_metadata),
        },
        &telemetry,
        &runtime,
    )
    .await;
    telemetry.shutdown().await;

    assert_eq!(exit_code, failure_exit_code);
    assert_eq!(
        std::fs::read_to_string(guest_paths.finalization_error_file()).unwrap(),
        failure_message
    );
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(guest_paths.failure_diagnostic_file()).unwrap())
            .unwrap();
    assert_eq!(diagnostic, failure_diagnostic);

    complete_mock
        .assert_calls_async(expected_completion_calls)
        .await;

    for path in cleanup_paths {
        let _ = std::fs::remove_file(path);
    }
}
