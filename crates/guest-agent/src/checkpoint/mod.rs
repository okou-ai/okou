//! Checkpoint preparation and post-completion local reconciliation.

mod artifact;
mod session_history;

use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::run_context::GuestRuntime;
use crate::session_metadata::CapturedSessionMetadata;
use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use api_contracts::generated::types::webhooks::agent::{checkpoints, complete};
use guest_telemetry::log_info;
use guest_telemetry::telemetry::record_sandbox_op;
use std::borrow::Cow;
use std::time::{Duration, Instant};

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Clone, Copy, PartialEq, Eq)]
enum CheckpointMode {
    Success,
    Recovery,
}

impl CheckpointMode {
    fn total_op(self) -> &'static str {
        match self {
            Self::Success => "checkpoint_total",
            Self::Recovery => "recovery_checkpoint_total",
        }
    }

    fn log_label(self) -> &'static str {
        match self {
            Self::Success => "checkpoint",
            Self::Recovery => "recovery checkpoint",
        }
    }

    fn can_prune_history(self) -> bool {
        matches!(self, Self::Success)
    }
}

struct CheckpointInputs<'a> {
    run_id: &'a str,
    framework: env::Framework,
    session_history_limits: session_history::CheckpointSessionHistoryLimits,
    artifact_entries: &'a [env::ArtifactEnv],
    session_metadata: &'a CapturedSessionMetadata,
    final_session_history_identity_file: Cow<'a, str>,
    pi_launch_config: &'a str,
    pi_launch_payload_file: &'a str,
}

impl<'a> CheckpointInputs<'a> {
    fn from_runtime(
        runtime: &'a GuestRuntime,
        session_metadata: &'a CapturedSessionMetadata,
    ) -> Self {
        Self {
            run_id: &runtime.config.run_id,
            framework: runtime.config.framework,
            session_history_limits: session_history::CheckpointSessionHistoryLimits::Production,
            artifact_entries: &runtime.config.artifacts,
            session_metadata,
            final_session_history_identity_file: Cow::Borrowed(
                runtime.paths.final_session_history_identity_file(),
            ),
            pi_launch_config: &runtime.config.pi_launch_config,
            pi_launch_payload_file: runtime.paths.pi_launch_payload_file(),
        }
    }
}

/// Checkpoint metadata and local state awaiting atomic completion acknowledgement.
pub struct PreparedCheckpoint {
    request: complete::RequestCheckpoint,
    mode: CheckpointMode,
    uploaded_history: Option<session_history::UploadedCheckpointSessionHistory>,
    framework: env::Framework,
    final_session_history_identity_file: String,
    total_started_at: Instant,
}

impl PreparedCheckpoint {
    pub(crate) fn request(&self) -> &complete::RequestCheckpoint {
        &self.request
    }

    pub(crate) fn acknowledge(self, api_elapsed: Duration) {
        record_sandbox_op("checkpoint_api_call", api_elapsed, true, None);
        if let Some(uploaded_history) = self.uploaded_history
            && session_history::reconcile_live_history_after_checkpoint(
                uploaded_history.live_history,
            )
        {
            session_history::write_final_session_history_identity(
                self.mode,
                &uploaded_history.cli_agent_session_id,
                &uploaded_history.history_hash,
                uploaded_history.history_size,
                &uploaded_history.history_source,
                self.framework,
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
        record_sandbox_op("checkpoint_api_call", api_elapsed, false, None);
        record_sandbox_op(
            self.mode.total_op(),
            self.total_started_at.elapsed(),
            false,
            None,
        );
    }
}

/// Prepare a checkpoint after a successful run using the explicit runtime snapshot.
pub async fn prepare_checkpoint_for_runtime(
    runtime: &GuestRuntime,
    session_metadata: &CapturedSessionMetadata,
) -> Result<PreparedCheckpoint, AgentError> {
    let inputs = CheckpointInputs::from_runtime(runtime, session_metadata);
    prepare_checkpoint_with_inputs(&runtime.http, &inputs).await
}

/// Prepare a checkpoint with bounded session-history limits for integration tests.
#[doc(hidden)]
pub async fn prepare_checkpoint_for_runtime_with_history_limits_for_test(
    runtime: &GuestRuntime,
    session_metadata: &CapturedSessionMetadata,
    candidate_max_bytes: u64,
    checkpoint_max_bytes: u64,
) -> Result<PreparedCheckpoint, AgentError> {
    let mut inputs = CheckpointInputs::from_runtime(runtime, session_metadata);
    inputs.session_history_limits =
        session_history::CheckpointSessionHistoryLimits::BoundedForTest {
            candidate_max_bytes,
            checkpoint_max_bytes,
        };
    prepare_checkpoint_with_inputs(&runtime.http, &inputs).await
}

/// Prepare a best-effort recovery checkpoint using the explicit runtime snapshot.
pub async fn prepare_recovery_checkpoint_for_runtime(
    runtime: &GuestRuntime,
    session_metadata: &CapturedSessionMetadata,
) -> Result<PreparedCheckpoint, AgentError> {
    let inputs = CheckpointInputs::from_runtime(runtime, session_metadata);
    prepare_recovery_checkpoint_with_inputs(&runtime.http, &inputs).await
}

/// Prepare a recovery checkpoint with bounded session-history limits for integration tests.
#[doc(hidden)]
pub async fn prepare_recovery_checkpoint_for_runtime_with_history_limits_for_test(
    runtime: &GuestRuntime,
    session_metadata: &CapturedSessionMetadata,
    candidate_max_bytes: u64,
    checkpoint_max_bytes: u64,
) -> Result<PreparedCheckpoint, AgentError> {
    let mut inputs = CheckpointInputs::from_runtime(runtime, session_metadata);
    inputs.session_history_limits =
        session_history::CheckpointSessionHistoryLimits::BoundedForTest {
            candidate_max_bytes,
            checkpoint_max_bytes,
        };
    prepare_recovery_checkpoint_with_inputs(&runtime.http, &inputs).await
}

async fn prepare_checkpoint_with_inputs(
    http: &HttpClient,
    inputs: &CheckpointInputs<'_>,
) -> Result<PreparedCheckpoint, AgentError> {
    prepare_checkpoint_for_mode(http, CheckpointMode::Success, inputs).await
}

async fn prepare_recovery_checkpoint_with_inputs(
    http: &HttpClient,
    inputs: &CheckpointInputs<'_>,
) -> Result<PreparedCheckpoint, AgentError> {
    prepare_checkpoint_for_mode(http, CheckpointMode::Recovery, inputs).await
}

async fn prepare_checkpoint_for_mode(
    http: &HttpClient,
    mode: CheckpointMode,
    inputs: &CheckpointInputs<'_>,
) -> Result<PreparedCheckpoint, AgentError> {
    let total_started_at = Instant::now();
    let result = prepare_checkpoint_impl(http, mode, inputs).await;
    if result.is_err() {
        record_sandbox_op(mode.total_op(), total_started_at.elapsed(), false, None);
    }
    result.map(|prepared| PreparedCheckpoint {
        request: prepared.request,
        mode,
        uploaded_history: prepared.uploaded_history,
        framework: inputs.framework,
        final_session_history_identity_file: inputs.final_session_history_identity_file.to_string(),
        total_started_at,
    })
}

struct PreparedCheckpointParts {
    request: complete::RequestCheckpoint,
    uploaded_history: Option<session_history::UploadedCheckpointSessionHistory>,
}

fn completion_history_disposition(
    disposition: checkpoints::RequestCliAgentSessionHistoryDisposition,
) -> complete::RequestCheckpointCliAgentSessionHistoryDisposition {
    match disposition {
        checkpoints::RequestCliAgentSessionHistoryDisposition::DiscardedOversized => {
            complete::RequestCheckpointCliAgentSessionHistoryDisposition::DiscardedOversized
        }
        checkpoints::RequestCliAgentSessionHistoryDisposition::Unavailable => {
            complete::RequestCheckpointCliAgentSessionHistoryDisposition::Unavailable
        }
    }
}

fn completion_missing_root_policy(
    policy: ArtifactEntryMissingRootPolicy,
) -> complete::RequestCheckpointArtifactSnapshotMissingRootPolicy {
    match policy {
        ArtifactEntryMissingRootPolicy::Fail => {
            complete::RequestCheckpointArtifactSnapshotMissingRootPolicy::Fail
        }
        ArtifactEntryMissingRootPolicy::PreserveParentVersion => {
            complete::RequestCheckpointArtifactSnapshotMissingRootPolicy::PreserveParentVersion
        }
    }
}

fn completion_artifact_snapshot(
    snapshot: checkpoints::ArtifactSnapshot,
) -> complete::RequestCheckpointArtifactSnapshot {
    complete::RequestCheckpointArtifactSnapshot {
        name: snapshot.name,
        version: snapshot.version,
        mount_path: snapshot.mount_path,
        missing_root_policy: snapshot
            .missing_root_policy
            .map(completion_missing_root_policy),
    }
}

async fn prepare_checkpoint_impl(
    http: &HttpClient,
    mode: CheckpointMode,
    inputs: &CheckpointInputs<'_>,
) -> Result<PreparedCheckpointParts, AgentError> {
    log_info!(LOG_TAG, "Preparing {}...", mode.log_label());

    // History upload and artifact snapshots are independent pre-requisites
    // of the final combined completion, so run them concurrently. The history
    // path performs blocking local preparation before web API work; the
    // artifact path performs blocking file preparation before VAS work. Wait
    // for both results even after one fails so a started blocking operation is
    // not detached from the checkpoint future.
    let history_inputs =
        session_history::CheckpointSessionHistoryInputs::from_checkpoint(mode, inputs);
    let (artifact_snapshots, checkpoint_history) = tokio::join!(
        artifact::snapshot_artifact_entries_for_checkpoint(
            http,
            inputs.run_id,
            inputs.artifact_entries,
            mode,
            inputs.pi_launch_config,
            inputs.pi_launch_payload_file,
        ),
        session_history::prepare_and_upload_session_history(http, inputs.run_id, history_inputs),
    );
    let checkpoint_history = checkpoint_history?;
    let artifact_snapshots = artifact_snapshots?;

    let cli_agent_type = inputs.framework.agent_type();
    let (
        cli_agent_session_id,
        cli_agent_session_history_hash,
        cli_agent_session_history_disposition,
        uploaded_history,
    ) = match checkpoint_history {
        session_history::CheckpointSessionHistory::Uploaded(history) => {
            let session_id = history.cli_agent_session_id.clone();
            let history_hash = history.history_hash.clone();
            (session_id, Some(history_hash), None, Some(history))
        }
        session_history::CheckpointSessionHistory::DiscardedOversized {
            cli_agent_session_id,
        } => (
            cli_agent_session_id,
            None,
            Some(completion_history_disposition(
                checkpoints::RequestCliAgentSessionHistoryDisposition::DiscardedOversized,
            )),
            None,
        ),
        session_history::CheckpointSessionHistory::Unavailable {
            cli_agent_session_id,
        } => (
            cli_agent_session_id,
            None,
            Some(completion_history_disposition(
                checkpoints::RequestCliAgentSessionHistoryDisposition::Unavailable,
            )),
            None,
        ),
    };
    let request = complete::RequestCheckpoint {
        cli_agent_type: cli_agent_type.to_string(),
        cli_agent_session_id,
        cli_agent_session_history_hash,
        cli_agent_session_history_disposition,
        artifact_snapshots: artifact_snapshots.map(|snapshots| {
            snapshots
                .into_iter()
                .map(completion_artifact_snapshot)
                .collect()
        }),
        volume_versions_snapshot: None,
    };
    Ok(PreparedCheckpointParts {
        request,
        uploaded_history,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use api_contracts::generated::constants::runners::SESSION_HISTORY_ENCODING_ZSTD;
    use httpmock::prelude::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    #[cfg(unix)]
    use std::process::Stdio;
    use std::time::Duration;
    #[cfg(unix)]
    use tokio::io::{AsyncBufReadExt, BufReader};

    struct CheckpointFilesGuard {
        guest_paths: crate::paths::GuestPaths,
    }

    impl CheckpointFilesGuard {
        fn new(guest_paths: &crate::paths::GuestPaths) -> Self {
            cleanup_checkpoint_files(guest_paths);
            Self {
                guest_paths: guest_paths.clone(),
            }
        }
    }

    impl Drop for CheckpointFilesGuard {
        fn drop(&mut self) {
            cleanup_checkpoint_files(&self.guest_paths);
        }
    }

    fn cleanup_checkpoint_files(guest_paths: &crate::paths::GuestPaths) {
        let _ = std::fs::remove_file(guest_paths.session_id_file());
    }

    fn http_status(status: u16) -> HttpMockResponse {
        HttpMockResponse::builder().status(status).build()
    }

    fn request_header_eq(req: &HttpMockRequest, name: &str, expected: &str) -> bool {
        req.headers_vec()
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case(name) && value == expected)
    }

    fn session_history_upload_response(
        req: &HttpMockRequest,
        expected_body: &[u8],
    ) -> HttpMockResponse {
        if request_header_eq(req, "content-type", "application/octet-stream")
            && req.body_ref() == expected_body
        {
            http_status(200)
        } else {
            http_status(400)
        }
    }

    #[tokio::test]
    async fn checkpoint_missing_mount_fails_before_final_completion() {
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);

        let _history_prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history");
            then.status(200).json_body(json!({"existing": true}));
        });
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
            CapturedSessionMetadata::for_test("session-checkpoint-missing-mount", None);

        let inputs = CheckpointInputs {
            run_id: "checkpoint-missing-mount",
            framework: env::Framework::ClaudeCode,
            session_history_limits: session_history::CheckpointSessionHistoryLimits::Production,
            artifact_entries: &entries,
            session_metadata: &session_metadata,
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
            pi_launch_config: "",
            pi_launch_payload_file: guest_paths.pi_launch_payload_file(),
        };

        let err = prepare_checkpoint_impl(&http, CheckpointMode::Success, &inputs)
            .await
            .err()
            .expect("missing artifact mount should fail checkpoint preparation");

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn maintenance_success_rejects_partial_tree_before_storage_publication() {
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        let server = MockServer::start();
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
            "maintenance-run-success",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
        let memory_root = dir.path().join("memory");
        std::fs::create_dir_all(&memory_root).unwrap();
        std::fs::write(memory_root.join("MEMORY.md"), "partially applied").unwrap();
        let storage_id = "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63";
        let base_version = "a".repeat(64);
        let launch = json!({
            "schemaVersion": 2,
            "maintenance": {
                "schemaVersion": 1,
                "memoryStorageId": storage_id,
                "claimedRevision": 7,
                "claimedBaseVersionId": base_version,
                "leaseToken": "44754115-d375-4c46-aea7-a55bd1b61ec7",
                "selectionDigest": "b".repeat(64),
                "selected": [],
            }
        });
        let entries = vec![env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: memory_root.to_string_lossy().into_owned(),
            storage_id: storage_id.to_string(),
            version_id: base_version,
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::Fail),
        }];
        let session_metadata = CapturedSessionMetadata::for_test("maintenance-run-success", None);
        let launch_json = launch.to_string();
        let inputs = CheckpointInputs {
            run_id: "maintenance-run-success",
            framework: env::Framework::Pi,
            session_history_limits: session_history::CheckpointSessionHistoryLimits::Production,
            artifact_entries: &entries,
            session_metadata: &session_metadata,
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
            pi_launch_config: &launch_json,
            pi_launch_payload_file: guest_paths.pi_launch_payload_file(),
        };

        let error = prepare_checkpoint_with_inputs(&http, &inputs)
            .await
            .err()
            .expect("success checkpoint without a validation marker must fail");

        assert!(
            error
                .to_string()
                .contains("maintenance checkpoint validation")
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn maintenance_recovery_checkpoint_preserves_parent_after_partial_apply() {
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        let server = MockServer::start();
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
            "maintenance-run-recovery",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
        let memory_root = dir.path().join("memory");
        std::fs::create_dir_all(memory_root.join("skills/interrupted")).unwrap();
        // Block in the shell itself so interruption cannot orphan a sleeper.
        let mut child = tokio::process::Command::new("sh")
            .args([
                "-ec",
                r#"printf partial > "$1/MEMORY.md"
printf half > "$1/skills/interrupted/SKILL.md"
printf 'started\n'
IFS= read -r _ || exit 1
printf late > "$1/memory_summary.md""#,
                "sh",
                &memory_root.to_string_lossy(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut started = String::new();
        let fixture_timeout = Duration::from_secs(5);
        let readiness = tokio::time::timeout(fixture_timeout, reader.read_line(&mut started)).await;

        // Reap the fixture even if readiness failed before asserting its result.
        child.start_kill().unwrap();
        let status = tokio::time::timeout(fixture_timeout, child.wait())
            .await
            .expect("interrupted fixture should exit")
            .unwrap();
        readiness.expect("fixture should become ready").unwrap();
        assert_eq!(started, "started\n");
        assert!(!status.success());
        started.clear();
        assert_eq!(
            tokio::time::timeout(fixture_timeout, reader.read_line(&mut started))
                .await
                .expect("fixture stdout should close without surviving descendants")
                .unwrap(),
            0
        );
        assert_eq!(
            std::fs::read_to_string(memory_root.join("MEMORY.md")).unwrap(),
            "partial"
        );
        assert_eq!(
            std::fs::read_to_string(memory_root.join("skills/interrupted/SKILL.md")).unwrap(),
            "half"
        );
        assert!(!memory_root.join("memory_summary.md").exists());
        let storage_id = "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63";
        let base_version = "a".repeat(64);
        let launch = json!({
            "schemaVersion": 2,
            "maintenance": {
                "schemaVersion": 1,
                "memoryStorageId": storage_id,
                "claimedRevision": 7,
                "claimedBaseVersionId": base_version,
                "leaseToken": "44754115-d375-4c46-aea7-a55bd1b61ec7",
                "selectionDigest": "b".repeat(64),
                "selected": [],
            }
        });
        let entries = vec![env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: memory_root.to_string_lossy().into_owned(),
            storage_id: storage_id.to_string(),
            version_id: base_version.clone(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::Fail),
        }];
        let session_metadata = CapturedSessionMetadata::for_test("maintenance-run-recovery", None);
        let launch_json = launch.to_string();
        let inputs = CheckpointInputs {
            run_id: "maintenance-run-recovery",
            framework: env::Framework::Pi,
            session_history_limits: session_history::CheckpointSessionHistoryLimits::Production,
            artifact_entries: &entries,
            session_metadata: &session_metadata,
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
            pi_launch_config: &launch_json,
            pi_launch_payload_file: guest_paths.pi_launch_payload_file(),
        };

        let prepared = prepare_recovery_checkpoint_with_inputs(&http, &inputs)
            .await
            .unwrap();
        let snapshots = prepared
            .request()
            .artifact_snapshots
            .as_ref()
            .expect("maintenance recovery should preserve its memory mount");

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].version, base_version);
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn ordinary_recovery_checkpoint_still_snapshots_changed_artifacts() {
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
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
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
        let inputs = CheckpointInputs {
            run_id: "ordinary-recovery-run",
            framework: env::Framework::ClaudeCode,
            session_history_limits: session_history::CheckpointSessionHistoryLimits::Production,
            artifact_entries: &entries,
            session_metadata: &session_metadata,
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
            pi_launch_config: "",
            pi_launch_payload_file: guest_paths.pi_launch_payload_file(),
        };

        prepare_recovery_checkpoint_with_inputs(&http, &inputs)
            .await
            .err()
            .expect("fixture intentionally rejects the ordinary upload");

        assert!(prepare.calls() > 0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn checkpoint_reuses_codex_zstd_session_history() {
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let history =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-02T10:00:00Z\"}}\n";
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        let history_hash = hex::encode(Sha256::digest(history));
        let home_dir = dir.path().join("home");
        let codex_day_dir = home_dir
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("07")
            .join("02");
        std::fs::create_dir_all(&codex_day_dir).unwrap();
        std::fs::write(
            codex_day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst"),
            &compressed,
        )
        .unwrap();
        let upload_url = server.url("/test/session-history-upload");
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history")
                .json_body(json!({
                    "runId": "checkpoint-codex-zstd-reuse",
                    "hash": history_hash,
                    "rawSize": history.len() as u64,
                    "encodedSize": compressed.len() as u64,
                    "encoding": SESSION_HISTORY_ENCODING_ZSTD,
                }));
            then.status(200).json_body(json!({
                "presignedUrl": upload_url,
                "existing": false,
                "encoding": SESSION_HISTORY_ENCODING_ZSTD,
            }));
        });
        let expected_upload = compressed.clone();
        let upload = server.mock(|when, then| {
            when.method(PUT).path("/test/session-history-upload");
            then.respond_with(move |req| session_history_upload_response(req, &expected_upload));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let home_dir = home_dir.to_string_lossy().into_owned();
        let session_metadata = CapturedSessionMetadata::for_test(
            thread_id,
            Some(
                guest_contracts::session_history_identity::SessionHistorySourceRef::Codex {
                    sessions_dir: std::path::Path::new(&home_dir)
                        .join(".codex/sessions")
                        .to_string_lossy()
                        .into_owned(),
                    thread_id: thread_id.to_string(),
                },
            ),
        );
        let inputs = CheckpointInputs {
            run_id: "checkpoint-codex-zstd-reuse",
            framework: env::Framework::Codex,
            session_history_limits: session_history::CheckpointSessionHistoryLimits::Production,
            artifact_entries: &[],
            session_metadata: &session_metadata,
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
            pi_launch_config: "",
            pi_launch_payload_file: guest_paths.pi_launch_payload_file(),
        };

        let prepared = prepare_checkpoint_impl(&http, CheckpointMode::Success, &inputs)
            .await
            .unwrap();

        prepare.assert_calls(1);
        upload.assert_calls(1);
        assert_eq!(prepared.request.cli_agent_type, "codex");
        assert_eq!(prepared.request.cli_agent_session_id, thread_id);
        assert_eq!(
            prepared.request.cli_agent_session_history_hash.as_deref(),
            Some(history_hash.as_str())
        );
    }
}
