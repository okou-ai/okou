use std::sync::Arc;
use std::time::{Duration, Instant};

use api_contracts::generated::types::runners::runs::CodexRuntimeConfig;
use sandbox::{
    ExecTermination, ProcessExit, ProcessOutputMode, SandboxError, SandboxOperation,
    SandboxOperationReason, SandboxOperationTimeoutStage,
};
use sandbox_mock::MockLifecycleGate;
use tokio::sync::Notify;

use crate::executor::EXIT_SIGKILL;
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::codex_model_catalog_prefetch::{
    CodexModelCatalogPrefetchStart, PREFETCH_HOST_START_TIMEOUT, StartedCodexModelCatalogPrefetch,
};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, minimal_context, sandbox_exec_error,
    sandbox_write_file_error, spawn_run_in_sandbox_test, test_executor_config, test_telemetry,
};
use runner_types::types::{ExecutionContext, Firewall, FirewallEntry, SandboxReuseResult};

const PREFETCH_ACTION: &str = "runner_codex_model_catalog_prefetch";

fn codex_oauth_context() -> ExecutionContext {
    let mut context = minimal_context();
    context.cli_agent_type = "codex".into();
    context.encrypted_secrets = Some("encrypted".into());
    context.firewalls = Some(vec![FirewallEntry::Builtin {
        name: "model-provider:codex-oauth-token".into(),
        base_url_vars: None,
        source_id: None,
    }]);
    context
}

fn sandbox_start_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::StartProcess,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

fn sandbox_start_timeout(stage: SandboxOperationTimeoutStage) -> SandboxError {
    SandboxError::OperationTimeout {
        operation: SandboxOperation::StartProcess,
        stage,
        timeout_ms: u64::try_from(PREFETCH_HOST_START_TIMEOUT.as_millis()).unwrap(),
    }
}

fn expect_usable_prefetch(
    start: CodexModelCatalogPrefetchStart,
) -> StartedCodexModelCatalogPrefetch {
    match start {
        CodexModelCatalogPrefetchStart::Usable(started) => started,
        CodexModelCatalogPrefetchStart::SandboxUnusable(_) => {
            panic!("prefetch start unexpectedly made the sandbox unusable")
        }
    }
}

fn process_exit(termination: ExecTermination, guest_duration_ms: Option<u32>) -> ProcessExit {
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.termination = termination;
    exit.guest_duration_ms = guest_duration_ms;
    exit
}

fn prefetch_ops(telemetry: &crate::telemetry::JobTelemetry) -> Vec<(String, bool, Option<String>)> {
    telemetry
        .pending_ops_snapshot()
        .into_iter()
        .filter(|(action, _, _)| action == PREFETCH_ACTION)
        .collect()
}

fn assert_prefetch_outcome(
    telemetry: &crate::telemetry::JobTelemetry,
    expected_success: bool,
    expected_error: Option<&str>,
    scenario: &str,
) {
    let ops = prefetch_ops(telemetry);
    assert_eq!(
        ops.len(),
        1,
        "{scenario}: expected exactly one prefetch event, got {ops:?}"
    );
    assert_eq!(ops[0].1, expected_success, "{scenario}: success");
    assert_eq!(ops[0].2.as_deref(), expected_error, "{scenario}: error");
}

async fn run_prefetch_state_machine(
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
    cancellation: tokio_util::sync::CancellationToken,
    scenario: &str,
    expected_success: bool,
    expected_error: Option<&str>,
) -> crate::telemetry::JobTelemetry {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = codex_oauth_context();
    let sandbox = Arc::new(sandbox_mock::MockSandbox::with_overrides(
        "test",
        Arc::clone(&overrides),
    ));
    let mut telemetry = test_telemetry(&config, &context);

    let started = expect_usable_prefetch(
        StartedCodexModelCatalogPrefetch::start(
            &*sandbox,
            &context,
            SandboxReuseResult::PoolMiss,
            &cancellation,
        )
        .await,
    );
    let mut prefetch = started.supervise(&*sandbox);
    prefetch.race(async {}).await;
    prefetch.record_outcome(&mut telemetry);
    prefetch.record_outcome(&mut telemetry);
    prefetch.finish(&mut telemetry).await;

    assert_prefetch_outcome(&telemetry, expected_success, expected_error, scenario);
    telemetry
}

async fn finish_started_prefetch(
    started: CodexModelCatalogPrefetchStart,
    sandbox: Arc<sandbox_mock::MockSandbox>,
    scenario: &str,
    expected_success: bool,
    expected_error: Option<&str>,
) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &context);
    let mut prefetch = expect_usable_prefetch(started).supervise(&*sandbox);
    prefetch.record_outcome(&mut telemetry);
    prefetch.record_outcome(&mut telemetry);
    prefetch.finish(&mut telemetry).await;

    assert_prefetch_outcome(&telemetry, expected_success, expected_error, scenario);
}
#[tokio::test]
async fn codex_catalog_prefetch_waits_for_guest_state_restore() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let prefetch_gate = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(prefetch_gate.clone());
    let sandbox = sandbox_mock::MockSandbox::with_overrides("test", overrides);
    sandbox.push_exec_result(Err(sandbox_exec_error("restore failed")));
    let ctx = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        run_in_sandbox(
            &sandbox,
            &ctx,
            &config,
            RunStart {
                sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
                restore_guest_state: true,
                reuse_result: SandboxReuseResult::PoolMiss,
                home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
        ),
    )
    .await
    .unwrap();

    assert!(result.is_err());
    assert_eq!(
        prefetch_gate.entered_count(),
        0,
        "prefetch must not start before guest state restoration succeeds",
    );
}

#[tokio::test]
async fn codex_catalog_prefetch_start_observes_run_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let prefetch_gate = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(prefetch_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = codex_oauth_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());

    prefetch_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("prefetch should enter process start");
    cancel.cancel();
    assert!(
        !run_task.is_finished(),
        "cancellation must not drop an in-flight process start"
    );
    prefetch_gate.release_one();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .expect("cancelled prefetch start should finish after provider ownership returns")
        .unwrap()
        .unwrap();

    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.wait_process_calls().len(), 1);
    assert!(overrides.process_cancel_calls().is_empty());
}

#[tokio::test]
async fn codex_catalog_prefetch_start_timeout_does_not_delay_agent() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(sandbox_start_timeout(
        SandboxOperationTimeoutStage::BeforeFrameWrite,
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let run_task = spawn_run_in_sandbox_test(
        sandbox,
        codex_oauth_context(),
        config,
        tokio_util::sync::CancellationToken::new(),
    );

    let result = run_task.await.unwrap().unwrap();
    assert!(result.failure.is_none());
    let process_calls = overrides.start_process_calls();
    assert_eq!(process_calls.len(), 1);
    assert_eq!(process_calls[0].start_timeout, PREFETCH_HOST_START_TIMEOUT);
    let start_calls = overrides.start_agent_process_calls();
    assert_eq!(start_calls.len(), 1);
}

#[tokio::test]
async fn codex_catalog_prefetch_post_write_timeout_stops_direct_run_before_agent() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(sandbox_start_timeout(
        SandboxOperationTimeoutStage::AwaitingTerminalResponse,
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let context = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &context);

    let error = run_in_sandbox(
        &*sandbox,
        &context,
        &config,
        RunStart {
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .err()
    .expect("direct run cannot replace a sandbox after post-write timeout");

    assert!(error.to_string().contains("awaiting terminal response"));
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
    assert!(overrides.process_cancel_calls().is_empty());
    assert_prefetch_outcome(
        &telemetry,
        false,
        Some("start_timed_out"),
        "post_write_timeout",
    );
}

#[tokio::test]
async fn codex_catalog_prefetch_partial_write_stops_direct_run_before_guest_work() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(SandboxError::OperationWrite {
        operation: SandboxOperation::StartProcess,
        stage: sandbox::SandboxOperationWriteStage::FrameWrite,
        source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "partial write"),
    });
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let context = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &context);

    let error = run_in_sandbox(
        &*sandbox,
        &context,
        &config,
        RunStart {
            sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .err()
    .expect("an owned sandbox must not continue after an unsafe write");

    assert!(matches!(
        error,
        crate::error::RunnerError::Sandbox(SandboxError::OperationWrite {
            stage: sandbox::SandboxOperationWriteStage::FrameWrite,
            ..
        })
    ));
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.storage_manifest_calls().is_empty());
    assert!(overrides.write_files_calls().is_empty());
    assert!(overrides.wait_process_calls().is_empty());
    assert!(overrides.process_cancel_calls().is_empty());
    assert_prefetch_outcome(&telemetry, false, Some("start_failed"), "partial_write");
}

#[tokio::test]
async fn codex_catalog_prefetch_records_start_cancellation() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let start_gate = MockLifecycleGate::new();
    overrides.set_start_process_lifecycle_gate(start_gate.clone());
    let sandbox = Arc::new(sandbox_mock::MockSandbox::with_overrides(
        "test",
        Arc::clone(&overrides),
    ));
    let cancel = tokio_util::sync::CancellationToken::new();
    let start_cancel = cancel.clone();
    let start_sandbox = Arc::clone(&sandbox);
    let start_task = tokio::spawn(async move {
        StartedCodexModelCatalogPrefetch::start(
            &*start_sandbox,
            &codex_oauth_context(),
            SandboxReuseResult::PoolMiss,
            &start_cancel,
        )
        .await
    });

    start_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("prefetch should enter process start");
    cancel.cancel();
    assert!(
        !start_task.is_finished(),
        "cancellation must retain the provider start future"
    );
    start_gate.release_one();

    let started = start_task.await.unwrap();
    finish_started_prefetch(
        started,
        sandbox,
        "start_cancelled",
        false,
        Some("start_cancelled"),
    )
    .await;
}

#[tokio::test]
async fn codex_catalog_prefetch_records_start_timeout() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(sandbox_start_timeout(
        SandboxOperationTimeoutStage::BeforeFrameWrite,
    ));
    let sandbox = Arc::new(sandbox_mock::MockSandbox::with_overrides(
        "test",
        Arc::clone(&overrides),
    ));
    let started = StartedCodexModelCatalogPrefetch::start(
        &*sandbox,
        &codex_oauth_context(),
        SandboxReuseResult::PoolMiss,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await;
    finish_started_prefetch(
        started,
        sandbox,
        "start_timed_out",
        false,
        Some("start_timed_out"),
    )
    .await;
}

#[tokio::test]
async fn codex_catalog_prefetch_records_start_failure() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(sandbox_start_error("start failed"));
    let sandbox = Arc::new(sandbox_mock::MockSandbox::with_overrides(
        "test",
        Arc::clone(&overrides),
    ));

    let started = StartedCodexModelCatalogPrefetch::start(
        &*sandbox,
        &codex_oauth_context(),
        SandboxReuseResult::PoolMiss,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await;
    finish_started_prefetch(
        started,
        sandbox,
        "start_failed",
        false,
        Some("start_failed"),
    )
    .await;
}

#[tokio::test]
async fn codex_catalog_prefetch_records_process_outcomes() {
    let cases = [
        (
            "success",
            ExecTermination::Exited { exit_code: 0 },
            true,
            None,
        ),
        (
            "process_exit",
            ExecTermination::Exited { exit_code: 7 },
            false,
            Some("process_exit"),
        ),
        (
            "process_timed_out",
            ExecTermination::TimedOut,
            false,
            Some("process_timed_out"),
        ),
        (
            "process_cancelled",
            ExecTermination::Cancelled,
            false,
            Some("process_cancelled"),
        ),
        (
            "process_start_failed",
            ExecTermination::StartFailed,
            false,
            Some("process_start_failed"),
        ),
        (
            "process_wait_failed",
            ExecTermination::WaitFailed,
            false,
            Some("process_wait_failed"),
        ),
    ];

    for (scenario, termination, expected_success, expected_error) in cases {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_wait_process_exit(process_exit(termination, Some(1_234)));
        let telemetry = run_prefetch_state_machine(
            overrides,
            tokio_util::sync::CancellationToken::new(),
            scenario,
            expected_success,
            expected_error,
        )
        .await;
        let ops: Vec<_> = telemetry
            .pending_ops_with_duration_snapshot()
            .into_iter()
            .filter(|(action, _, _, _)| action == PREFETCH_ACTION)
            .collect();
        assert_eq!(
            ops,
            vec![(
                PREFETCH_ACTION.to_string(),
                1_234,
                expected_success,
                expected_error.map(str::to_string),
            )],
            "{scenario}: telemetry details",
        );
    }

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_error(
        "wait failed",
    ));
    let _telemetry = run_prefetch_state_machine(
        overrides,
        tokio_util::sync::CancellationToken::new(),
        "wait_failed",
        false,
        Some("wait_failed"),
    )
    .await;
}

#[tokio::test]
async fn codex_catalog_prefetch_prefers_guest_duration_and_falls_back_to_host_elapsed() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(process_exit(
        ExecTermination::Exited { exit_code: 0 },
        Some(7_200_084),
    ));
    let telemetry = run_prefetch_state_machine(
        overrides,
        tokio_util::sync::CancellationToken::new(),
        "guest_duration",
        true,
        None,
    )
    .await;
    let guest_duration_ops: Vec<_> = telemetry
        .pending_ops_with_duration_snapshot()
        .into_iter()
        .filter(|(action, _, _, _)| action == PREFETCH_ACTION)
        .collect();
    assert_eq!(guest_duration_ops[0].1, 7_200_084);

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(process_exit(ExecTermination::Exited { exit_code: 0 }, None));
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = codex_oauth_context();
    let sandbox = Arc::new(sandbox_mock::MockSandbox::with_overrides(
        "test",
        Arc::clone(&overrides),
    ));
    let mut telemetry = test_telemetry(&config, &context);
    let before_start = Instant::now();
    let started = expect_usable_prefetch(
        StartedCodexModelCatalogPrefetch::start(
            &*sandbox,
            &context,
            SandboxReuseResult::PoolMiss,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await,
    );
    let after_start = Instant::now();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let before_supervise = Instant::now();
    let prefetch = started.supervise(&*sandbox);
    let after_supervise = Instant::now();
    prefetch.finish(&mut telemetry).await;
    let waits = overrides.wait_process_calls();
    assert_eq!(waits.len(), 1);
    let timeout = waits[0].timeout;
    let original_budget = Duration::from_secs(18);
    assert!(
        timeout <= original_budget.saturating_sub(before_supervise.duration_since(after_start)),
        "supervision must retain the wait budget consumed during preparation",
    );
    assert!(
        timeout >= original_budget.saturating_sub(after_supervise.duration_since(before_start)),
        "supervision must retain the remaining original wait budget",
    );
    assert_prefetch_outcome(&telemetry, true, None, "host_duration");
    let host_duration_ops: Vec<_> = telemetry
        .pending_ops_with_duration_snapshot()
        .into_iter()
        .filter(|(action, _, _, _)| action == PREFETCH_ACTION)
        .collect();
    assert!(
        host_duration_ops[0].1 > 0,
        "host elapsed duration should be recorded"
    );
}

async fn assert_codex_catalog_prefetch_skipped(
    context: ExecutionContext,
    reuse_result: SandboxReuseResult,
    scenario: &str,
) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut telemetry = test_telemetry(&config, &context);

    let result = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        run_in_sandbox(
            &*sandbox,
            &context,
            &config,
            RunStart {
                sandbox_startup_path: if reuse_result == SandboxReuseResult::Reused {
                    runner_types::types::SandboxStartupPath::Sandbox
                } else {
                    runner_types::types::SandboxStartupPath::Cold
                },
                restore_guest_state: false,
                reuse_result,
                home_reuse_result: if reuse_result == SandboxReuseResult::Reused {
                    runner_types::types::HomeReuseResult::SandboxReused
                } else {
                    runner_types::types::HomeReuseResult::NotConfigured
                },
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
        ),
    )
    .await
    .unwrap()
    .unwrap();

    assert!(result.failure.is_none(), "{scenario}");
    let start_calls = overrides.start_agent_process_calls();
    assert_eq!(start_calls.len(), 1, "{scenario}");
    assert!(
        overrides.start_process_calls().is_empty(),
        "{scenario}: ineligible runs must not start a prefetch process"
    );
    assert!(
        prefetch_ops(&telemetry).is_empty(),
        "{scenario}: ineligible runs must not record prefetch telemetry"
    );
}

#[tokio::test]
async fn codex_catalog_prefetch_skips_ineligible_runs() {
    let mut unrelated_framework = codex_oauth_context();
    unrelated_framework.cli_agent_type = "claude-code".into();

    let mut missing_secrets = codex_oauth_context();
    missing_secrets.encrypted_secrets = None;

    let mut empty_secrets = codex_oauth_context();
    empty_secrets.encrypted_secrets = Some(String::new());

    let mut missing_firewall = codex_oauth_context();
    missing_firewall.firewalls = None;

    let mut empty_firewalls = codex_oauth_context();
    empty_firewalls.firewalls = Some(Vec::new());

    let mut unrelated_builtin_firewall = codex_oauth_context();
    unrelated_builtin_firewall.firewalls = Some(vec![FirewallEntry::Builtin {
        name: "test-subdomain".into(),
        base_url_vars: None,
        source_id: None,
    }]);

    let mut matching_inline_firewall = codex_oauth_context();
    matching_inline_firewall.firewalls = Some(vec![FirewallEntry::Inline {
        firewall: Firewall {
            name: "model-provider:codex-oauth-token".into(),
            apis: Vec::new(),
        },
        custom_connector_id: None,
        source_id: None,
    }]);

    let mut custom_runtime = codex_oauth_context();
    custom_runtime.codex_runtime_config = Some(CodexRuntimeConfig {
        provider_id: "provider".into(),
        name: "custom".into(),
        base_url: "https://provider.example".into(),
        env_key: "TOKEN".into(),
        requires_openai_auth: None,
        wire_api: "responses".into(),
        supports_websockets: false,
        model_catalog: None,
    });

    let scenarios = [
        (
            unrelated_framework,
            SandboxReuseResult::PoolMiss,
            "unrelated framework",
        ),
        (
            missing_secrets,
            SandboxReuseResult::PoolMiss,
            "missing encrypted secrets",
        ),
        (
            empty_secrets,
            SandboxReuseResult::PoolMiss,
            "empty encrypted secrets",
        ),
        (
            missing_firewall,
            SandboxReuseResult::PoolMiss,
            "missing Codex OAuth firewall",
        ),
        (
            empty_firewalls,
            SandboxReuseResult::PoolMiss,
            "empty firewall collection",
        ),
        (
            unrelated_builtin_firewall,
            SandboxReuseResult::PoolMiss,
            "unrelated builtin firewall",
        ),
        (
            matching_inline_firewall,
            SandboxReuseResult::PoolMiss,
            "matching inline firewall",
        ),
        (
            custom_runtime,
            SandboxReuseResult::PoolMiss,
            "custom Codex runtime",
        ),
        (
            codex_oauth_context(),
            SandboxReuseResult::Reused,
            "reused sandbox",
        ),
    ];

    for (context, reuse_result, scenario) in scenarios {
        assert_codex_catalog_prefetch_skipped(context, reuse_result, scenario).await;
    }
}

#[tokio::test]
async fn codex_catalog_prefetch_records_one_event_through_executor_wiring() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let context = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &context);

    let result = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        run_in_sandbox(
            &*sandbox,
            &context,
            &config,
            RunStart {
                sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
        ),
    )
    .await
    .unwrap()
    .unwrap();

    assert!(result.failure.is_none());
    assert_prefetch_outcome(
        &telemetry,
        true,
        None,
        "executor wiring should record one prefetch event",
    );
}

#[tokio::test]
async fn codex_catalog_prefetch_is_cancelled_on_pre_spawn_exit() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let private_write_gate = MockLifecycleGate::new();
    overrides.set_private_write_file_lifecycle_gate(private_write_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = codex_oauth_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());

    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("prefetch should enter process wait");
    private_write_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter private-file preparation");
    cancel.cancel();

    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .expect("prefetch cleanup should be bounded")
        .unwrap()
        .unwrap();

    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert_eq!(overrides.wait_process_calls().len(), 1);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
}

#[tokio::test]
async fn codex_catalog_prefetch_is_joined_on_private_preparation_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_process_cancel_releases_wait_gate(false);
    let private_write_gate = MockLifecycleGate::new();
    overrides.set_private_write_file_lifecycle_gate(private_write_gate.clone());
    let message = "required private preparation failed";
    let expected = format!("sandbox error: {}", sandbox_write_file_error(message));
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(message)));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let run_task = spawn_run_in_sandbox_test(
        sandbox,
        codex_oauth_context(),
        config,
        tokio_util::sync::CancellationToken::new(),
    );

    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("prefetch should enter process wait");
    private_write_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .expect("run should enter required private preparation");
    private_write_gate.release_one();
    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    assert!(
        !run_task.is_finished(),
        "preparation failure must retain the unfinished prefetch wait"
    );
    wait_gate.release_one();
    let error = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .expect("prefetch teardown should finish after terminal release")
        .unwrap()
        .err()
        .expect("required private preparation must fail");

    assert_eq!(error.to_string(), expected);
    assert!(matches!(
        &error,
        crate::ExecutorError::Sandbox(SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::Guest,
            message: actual,
        }) if actual == message
    ));
    assert_eq!(overrides.private_write_files_calls().len(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.start_process_calls().len(), 1);
    assert_eq!(overrides.wait_process_calls().len(), 1);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
}

#[tokio::test]
async fn codex_catalog_prefetch_guest_timeout_preserves_successful_agent_run() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(process_exit(ExecTermination::TimedOut, Some(10_075)));
    let start_gate = MockLifecycleGate::new();
    start_gate.release_one();
    overrides.set_start_process_lifecycle_gate(start_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let context = codex_oauth_context();
    let mut telemetry = test_telemetry(&config, &context);

    let (result, ()) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        tokio::join!(
            run_in_sandbox(
                &*sandbox,
                &context,
                &config,
                RunStart {
                    sandbox_startup_path: runner_types::types::SandboxStartupPath::Cold,
                    restore_guest_state: false,
                    reuse_result: SandboxReuseResult::PoolMiss,
                    home_reuse_result: runner_types::types::HomeReuseResult::NotConfigured,
                    prev_storage: None,
                },
                &mut telemetry,
                RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            ),
            async {
                start_gate
                    .wait_entered(2, RUN_IN_SANDBOX_TEST_TIMEOUT)
                    .await
                    .unwrap();
                // The Agent cannot consume the queued result while its start is
                // held. Let the prefetch's ready terminal wait complete first.
                while overrides.wait_process_calls().is_empty() {
                    tokio::task::yield_now().await;
                }
                start_gate.release_one();
            },
        )
    })
    .await
    .expect("prefetch timeout must not block the main run");

    assert!(result.unwrap().failure.is_none());
    assert_prefetch_outcome(
        &telemetry,
        false,
        Some("process_timed_out"),
        "guest timeout",
    );
    let prefetch = overrides.start_process_calls();
    assert_eq!(prefetch.len(), 1);
    assert!(prefetch[0].timeout_is_expected);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert!(overrides.process_cancel_calls().is_empty());
}

#[tokio::test]
async fn disk_recovery_retires_prefetch_before_cleanup_and_agent_start() {
    use guest_contracts::disk_cleanup::{DiskCleanupFilesystem, DiskCleanupReport};

    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = MockLifecycleGate::new();
    let write_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_process_cancel_releases_wait_gate(false);
    overrides.set_private_write_file_lifecycle_gate(write_gate.clone());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".into(),
        exit_code: 0,
        stdout: b"VM0_DF_BLOCKS_V1\n/dev/root 12000000 6000000 6000000 50% /\n/dev/vdb 24000000 24000000 0 100% /home/user\n".to_vec(),
        stderr: Vec::new(),
    });
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "recover-disk-space home".into(),
        exit_code: 0,
        stdout: serde_json::to_vec(&DiskCleanupReport {
            filesystem: DiskCleanupFilesystem::Home,
            available_bytes_before: 0,
            available_bytes_after: 256 * 1024 * 1024,
            available_inodes_before: 1000,
            available_inodes_after: 1010,
            removed_entries: 10,
        })
        .unwrap(),
        stderr: Vec::new(),
    });
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let task = spawn_run_in_sandbox_test(
        sandbox,
        codex_oauth_context(),
        config,
        tokio_util::sync::CancellationToken::new(),
    );

    wait_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    write_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    write_gate.release_one();
    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    assert!(
        !task.is_finished(),
        "recovery must retain prefetch terminal custody"
    );
    assert!(
        !overrides
            .exec_calls()
            .iter()
            .any(|call| call.cmd.contains("recover-disk-space"))
    );
    assert!(overrides.start_agent_process_calls().is_empty());

    wait_gate.release_one();
    write_gate.release_one();
    wait_gate.release_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none(), "{:?}", result.failure);
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(overrides.private_write_files_calls().len(), 2);
    assert_eq!(overrides.process_cancel_calls().len(), 1);
    assert_eq!(
        overrides
            .exec_calls()
            .iter()
            .filter(|call| call.cmd.contains("recover-disk-space"))
            .count(),
        1
    );
}

#[tokio::test]
async fn cancellation_during_disk_recovery_prevents_retry_and_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let write_gate = MockLifecycleGate::new();
    let exec_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_private_write_file_lifecycle_gate(write_gate.clone());
    overrides.push_private_write_files_result(Err(sandbox_write_file_error(
        "No space left on device (os error 28)",
    )));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".into(),
        exit_code: 0,
        stdout: b"VM0_DF_BLOCKS_V1\n/dev/root 12000000 6000000 6000000 50% /\n/dev/vdb 24000000 24000000 0 100% /home/user\n".to_vec(),
        stderr: Vec::new(),
    });
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "recover-disk-space home".into(),
        exit_code: 0,
        stdout: serde_json::to_vec(&guest_contracts::disk_cleanup::DiskCleanupReport {
            filesystem: guest_contracts::disk_cleanup::DiskCleanupFilesystem::Home,
            available_bytes_before: 0,
            available_bytes_after: 256 * 1024 * 1024,
            available_inodes_before: 1000,
            available_inodes_after: 1010,
            removed_entries: 10,
        })
        .unwrap(),
        stderr: Vec::new(),
    });
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let task = spawn_run_in_sandbox_test(sandbox, minimal_context(), config, cancel.clone());
    write_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    overrides.set_exec_lifecycle_gate(exec_gate.clone());
    write_gate.release_one();
    exec_gate
        .wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    exec_gate.release_one();
    exec_gate
        .wait_entered(2, RUN_IN_SANDBOX_TEST_TIMEOUT)
        .await
        .unwrap();
    assert!(
        overrides
            .exec_calls()
            .last()
            .unwrap()
            .cmd
            .contains("recover-disk-space")
    );
    cancel.cancel();
    exec_gate.release_one();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.failure.unwrap().exit_code, EXIT_SIGKILL);
    assert_eq!(overrides.private_write_files_calls().len(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
}

#[tokio::test]
async fn fresh_codex_oauth_run_prefetches_catalog_while_agent_prepares() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = codex_oauth_context();
    let run_task = spawn_run_in_sandbox_test(
        sandbox,
        ctx,
        config,
        tokio_util::sync::CancellationToken::new(),
    );

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, async {
        loop {
            if overrides.start_process_calls().len() == 1
                && overrides.start_agent_process_calls().len() == 1
                && overrides.wait_process_calls().len() == 2
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let start_calls = overrides.start_process_calls();
    assert!(start_calls[0].cmd.contains("codex --version"));
    assert!(
        start_calls[0]
            .cmd
            .contains("X-Okou-Codex-Model-Catalog-Prefetch: 1")
    );
    assert!(matches!(
        start_calls[0].output,
        ProcessOutputMode::Buffered { .. }
    ));
    let agent_calls = overrides.start_agent_process_calls();
    assert_eq!(agent_calls.len(), 1);

    wait_gate.notify_waiters();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
}
