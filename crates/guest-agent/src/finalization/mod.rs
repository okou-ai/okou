//! Prepare native history and published file outputs, then reconcile local history after completion acknowledgement.

mod artifact;
mod session_history;

use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::run_context::GuestRuntime;
use crate::session_history_identity::build_final_session_history_identity;
use crate::session_metadata::CapturedSessionMetadata;
use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use api_contracts::generated::types::webhooks::agent::complete;
use guest_telemetry::log_info;
use guest_telemetry::telemetry::record_sandbox_op;
use std::borrow::Cow;
use std::time::{Duration, Instant};

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Clone, Copy, PartialEq, Eq)]
enum FinalizationMode {
    Success,
    Recovery,
}

impl FinalizationMode {
    fn total_op(self) -> &'static str {
        match self {
            Self::Success => "finalization_total",
            Self::Recovery => "recovery_finalization_total",
        }
    }

    fn log_label(self) -> &'static str {
        match self {
            Self::Success => "completion",
            Self::Recovery => "recovery finalization",
        }
    }
}

struct FinalizationInputs<'a> {
    run_id: &'a str,
    framework: env::Framework,
    artifact_entries: &'a [env::ArtifactEnv],
    session_metadata: &'a CapturedSessionMetadata,
    final_session_history_identity_file: Cow<'a, str>,
}

impl<'a> FinalizationInputs<'a> {
    fn from_runtime(
        runtime: &'a GuestRuntime,
        session_metadata: &'a CapturedSessionMetadata,
    ) -> Self {
        Self {
            run_id: &runtime.config.run_id,
            framework: runtime.config.framework,
            artifact_entries: &runtime.config.artifacts,
            session_metadata,
            final_session_history_identity_file: Cow::Borrowed(
                runtime.paths.final_session_history_identity_file(),
            ),
        }
    }
}

/// Native history and output metadata and local state awaiting atomic completion acknowledgement.
pub struct PreparedFinalization {
    request: complete::RequestCompletion,
    mode: FinalizationMode,
    retained_history: Option<session_history::RetainedSessionHistory>,
    framework: env::Framework,
    final_session_history_identity_file: String,
    total_started_at: Instant,
}

impl PreparedFinalization {
    pub(crate) fn request(&self) -> &complete::RequestCompletion {
        &self.request
    }

    pub(crate) fn acknowledge(self, api_elapsed: Duration) {
        record_sandbox_op("completion_api_call", api_elapsed, true, None);
        if let Some(history) = self.retained_history {
            session_history::write_final_session_history_identity(
                build_final_session_history_identity(
                    self.framework,
                    &history.cli_agent_session_id,
                    &history.history_hash,
                    history.history_size,
                    &history.history_source,
                ),
                &self.final_session_history_identity_file,
            );
        }
        log_info!(LOG_TAG, "{} persisted successfully", self.mode.log_label());
        record_sandbox_op(
            self.mode.total_op(),
            self.total_started_at.elapsed(),
            true,
            None,
        );
    }

    pub(crate) fn record_persistence_failure(self, api_elapsed: Duration) {
        record_sandbox_op("completion_api_call", api_elapsed, false, None);
        record_sandbox_op(
            self.mode.total_op(),
            self.total_started_at.elapsed(),
            false,
            None,
        );
    }
}

/// Prepare finalization after a successful run using the explicit runtime snapshot.
pub async fn prepare_finalization_for_runtime(
    runtime: &GuestRuntime,
    session_metadata: &CapturedSessionMetadata,
) -> Result<PreparedFinalization, AgentError> {
    let inputs = FinalizationInputs::from_runtime(runtime, session_metadata);
    prepare_finalization_with_inputs(&runtime.http, &inputs).await
}

/// Prepare best-effort recovery finalization using the explicit runtime snapshot.
pub async fn prepare_recovery_finalization_for_runtime(
    runtime: &GuestRuntime,
    session_metadata: &CapturedSessionMetadata,
) -> Result<PreparedFinalization, AgentError> {
    let inputs = FinalizationInputs::from_runtime(runtime, session_metadata);
    prepare_recovery_finalization_with_inputs(&runtime.http, &inputs).await
}

async fn prepare_finalization_with_inputs(
    http: &HttpClient,
    inputs: &FinalizationInputs<'_>,
) -> Result<PreparedFinalization, AgentError> {
    prepare_finalization_for_mode(http, FinalizationMode::Success, inputs).await
}

async fn prepare_recovery_finalization_with_inputs(
    http: &HttpClient,
    inputs: &FinalizationInputs<'_>,
) -> Result<PreparedFinalization, AgentError> {
    prepare_finalization_for_mode(http, FinalizationMode::Recovery, inputs).await
}

async fn prepare_finalization_for_mode(
    http: &HttpClient,
    mode: FinalizationMode,
    inputs: &FinalizationInputs<'_>,
) -> Result<PreparedFinalization, AgentError> {
    let total_started_at = Instant::now();
    let result = prepare_finalization_impl(http, mode, inputs).await;
    if result.is_err() {
        record_sandbox_op(mode.total_op(), total_started_at.elapsed(), false, None);
    }
    result.map(|prepared| PreparedFinalization {
        request: prepared.request,
        mode,
        retained_history: prepared.retained_history,
        framework: inputs.framework,
        final_session_history_identity_file: inputs.final_session_history_identity_file.to_string(),
        total_started_at,
    })
}

struct PreparedFinalizationParts {
    request: complete::RequestCompletion,
    retained_history: Option<session_history::RetainedSessionHistory>,
}

fn completion_missing_root_policy(
    policy: ArtifactEntryMissingRootPolicy,
) -> complete::RequestCompletionStorageOutputMissingRootPolicy {
    match policy {
        ArtifactEntryMissingRootPolicy::Fail => {
            complete::RequestCompletionStorageOutputMissingRootPolicy::Fail
        }
        ArtifactEntryMissingRootPolicy::PreserveParentVersion => {
            complete::RequestCompletionStorageOutputMissingRootPolicy::PreserveParentVersion
        }
    }
}

async fn prepare_finalization_impl(
    http: &HttpClient,
    mode: FinalizationMode,
    inputs: &FinalizationInputs<'_>,
) -> Result<PreparedFinalizationParts, AgentError> {
    log_info!(LOG_TAG, "Preparing {}...", mode.log_label());

    // Local history evidence and artifact snapshots are independent prerequisites
    // of the final combined completion, so run them concurrently. The history
    // path performs bounded blocking local preparation; the
    // artifact path performs blocking file preparation before VAS work. Wait
    // for both results even after one fails so a started blocking operation is
    // not detached from the finalization future.
    let (storage_outputs, finalization_history) = tokio::join!(
        artifact::snapshot_artifact_entries(http, inputs.run_id, inputs.artifact_entries,),
        session_history::prepare_retained_session_history(inputs.session_metadata),
    );
    let finalization_history = finalization_history?;
    let storage_outputs = storage_outputs?;

    let cli_agent_type = inputs.framework.agent_type();
    let cli_agent_session_id = inputs.session_metadata.cli_agent_session_id().to_string();
    let retained_history = finalization_history;
    let request = complete::RequestCompletion {
        cli_agent_type: cli_agent_type.to_string(),
        cli_agent_session_id,
        cli_agent_session_history_disposition:
            complete::RequestCompletionCliAgentSessionHistoryDisposition::NativeOnly,
        storage_outputs,
        volume_versions_snapshot: None,
    };
    Ok(PreparedFinalizationParts {
        request,
        retained_history,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;
    use std::time::Duration;

    struct FinalizationFilesGuard {
        guest_paths: crate::paths::GuestPaths,
    }

    impl FinalizationFilesGuard {
        fn new(guest_paths: &crate::paths::GuestPaths) -> Self {
            cleanup_finalization_files(guest_paths);
            Self {
                guest_paths: guest_paths.clone(),
            }
        }
    }

    impl Drop for FinalizationFilesGuard {
        fn drop(&mut self) {
            cleanup_finalization_files(&self.guest_paths);
        }
    }

    fn cleanup_finalization_files(guest_paths: &crate::paths::GuestPaths) {
        let _ = std::fs::remove_file(guest_paths.session_id_file());
    }

    #[tokio::test]
    async fn finalization_reports_native_identity_for_success_and_recovery() {
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        let server = MockServer::start();
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "native-finalization",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let session_metadata = CapturedSessionMetadata::for_test("native-session", None);
        let inputs = FinalizationInputs {
            run_id: "native-finalization",
            framework: env::Framework::ClaudeCode,
            artifact_entries: &[],
            session_metadata: &session_metadata,
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
        };
        for mode in [FinalizationMode::Success, FinalizationMode::Recovery] {
            let prepared = prepare_finalization_impl(&http, mode, &inputs)
                .await
                .unwrap();
            assert_eq!(prepared.request.cli_agent_session_id, "native-session");
            assert_eq!(
                prepared.request.cli_agent_session_history_disposition,
                complete::RequestCompletionCliAgentSessionHistoryDisposition::NativeOnly
            );
        }
    }

    #[tokio::test]
    async fn finalization_missing_mount_fails_before_final_completion() {
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = FinalizationFilesGuard::new(&guest_paths);

        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: None,
        }];
        let session_metadata =
            CapturedSessionMetadata::for_test("session-finalization-missing-mount", None);

        let inputs = FinalizationInputs {
            run_id: "finalization-missing-mount",
            framework: env::Framework::ClaudeCode,
            artifact_entries: &entries,
            session_metadata: &session_metadata,
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
        };

        let err = prepare_finalization_impl(&http, FinalizationMode::Success, &inputs)
            .await
            .err()
            .expect("missing artifact mount should fail finalization preparation");

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn ordinary_recovery_finalization_still_snapshots_changed_artifacts() {
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(500);
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"success": true}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "ordinary-recovery-run",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = FinalizationFilesGuard::new(&guest_paths);
        let workspace_root = dir.path().join("workspace");
        std::fs::create_dir_all(&workspace_root).unwrap();
        std::fs::write(workspace_root.join("result.txt"), "recover me").unwrap();
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: workspace_root.to_string_lossy().into_owned(),
            storage_id: "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63".to_string(),
            version_id: "a".repeat(64),
            missing_root_policy: None,
        }];
        let session_metadata = CapturedSessionMetadata::for_test("ordinary-recovery-run", None);
        let inputs = FinalizationInputs {
            run_id: "ordinary-recovery-run",
            framework: env::Framework::ClaudeCode,
            artifact_entries: &entries,
            session_metadata: &session_metadata,
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
        };

        prepare_recovery_finalization_with_inputs(&http, &inputs)
            .await
            .err()
            .expect("fixture intentionally rejects the ordinary upload");

        assert!(prepare.calls() > 0);
        commit.assert_calls(0);
    }
}
