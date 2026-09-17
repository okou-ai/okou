use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use futures_util::FutureExt;
use guest_contracts::diagnostics::{
    AgentFramework, CliObservedExitDiagnostic, FailureClass, FailureDetailSource,
    FailureDiagnostic, PromptMetadata,
};
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecResult, ExecTermination, ProcessExit, ProcessOutputChunk,
    ProcessOutputMode, Sandbox, SandboxError, SandboxFactory, SandboxGuestDnsReadinessReason,
    SandboxId, SandboxOperationReason,
};
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxFactory};

use super::super::agent_run::{PreparedRunInputs, ProcessCancelTimeouts, RunControls, RunStart};
use super::super::env::{
    guest_connector_account_context_file_path, guest_run_payload_file_path,
    guest_user_env_file_path, prepare_run_payload_for_run,
};
use super::super::reused_sandbox::{ReusedSandboxRun, execute_reused_sandbox};
use super::super::sandbox_run::{
    NewSandboxHooks, PreparedSandboxRun, execute_new_sandbox,
    execute_new_sandbox_with_prepared_notifier, execute_prepared_sandbox_run,
    execute_prepared_sandbox_run_with_process_cancel_timeouts, log_proxy_register_failure,
    log_proxy_register_success, register_proxy,
};
use super::super::{
    AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT, EXIT_SIGKILL, ExecutionFailureKind, JOB_TIMEOUT,
    JobParams, NewSandboxDispatch, ResourceFailureKind, STDOUT_STREAM_INCOMPLETE_MARKER,
    STDOUT_STREAM_LIMIT_MARKER, STDOUT_STREAM_OVERFLOW_MARKER, SandboxPreparedNotifier,
    execute_job, execute_job_reuse, job_supervisor_timeout, job_terminal_wait_timeout,
};
use super::support::{
    CapturedEvent, CapturedEvents, DestroyPanicFactory, api_artifact, api_storage,
    assert_proxy_registry_empty, create_overridden_sandbox, default_params,
    make_reusable_idle_sandbox, minimal_context, run_new_sandbox_outcome, run_new_sandbox_status,
    sandbox_create_error, sandbox_exec_error, sandbox_write_file_error, seed_workspace_image_cache,
    seed_workspace_image_cache_with_fingerprints, seed_workspace_image_cache_with_sidecar,
    test_budget_lease, test_device_rate_limits, test_executor_config, test_telemetry,
};
use crate::ids::RunId;
use crate::paths::{RunnerPaths, scoped_workspace_image_cache_key};
use crate::storage_manifest::StorageManifest;
use crate::types::{
    ConnectorRuntimeTargetRegistration, FirewallEntry, ResumeSession, SandboxReuseResult,
};
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImageCache,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
};
use tracing::Level;
use tracing_subscriber::prelude::*;

mod blank_prefetch;
mod execution_diagnostics;
mod fresh_sandbox;
mod idle_pool;
mod proxy_registry;
mod registry_observation;
mod reuse;
mod ssh;
mod workspace_cache;

fn storage_archive(content: &[u8]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut tar = tar::Builder::new(encoder);
    let mut header = tar::Header::new_ustar();
    header.set_size(content.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(1);
    header.set_cksum();
    tar.append_data(&mut header, "file", content).unwrap();
    tar.into_inner().unwrap().finish().unwrap()
}

fn codex_oauth_context() -> crate::types::ExecutionContext {
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

fn assert_telemetry_action(
    telemetry: &crate::telemetry::JobTelemetry,
    action: &str,
    success: bool,
    error: Option<&str>,
) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().any(|(op_action, op_success, op_error)| {
            op_action == action && *op_success == success && op_error.as_deref() == error
        }),
        "expected telemetry action {action} success={success} error={error:?}, got: {ops:?}"
    );
}

fn assert_no_telemetry_action(telemetry: &crate::telemetry::JobTelemetry, action: &str) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().all(|(op_action, _, _)| op_action != action),
        "unexpected telemetry action {action}, got: {ops:?}"
    );
}

async fn capture_sandbox_run_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

fn captured_events_named<'a>(events: &'a [CapturedEvent], message: &str) -> Vec<&'a CapturedEvent> {
    events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .collect()
}

fn assert_captured_field(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
    assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
}

fn telemetry_action_outcomes(
    telemetry: &crate::telemetry::JobTelemetry,
    action: &str,
) -> Vec<(bool, Option<String>)> {
    telemetry
        .pending_ops_snapshot()
        .into_iter()
        .filter_map(|(op_action, success, error)| (op_action == action).then_some((success, error)))
        .collect()
}
