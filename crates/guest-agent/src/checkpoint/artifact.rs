//! Checkpoint-specific artifact snapshot planning and scheduling.
//!
//! Artifact checkpointing is intentionally split into two phases. The first
//! phase walks and plans every configured artifact locally, with at most
//! [`ARTIFACT_CHECKPOINT_CONCURRENCY`] walks in flight. Only after the complete
//! preflight succeeds does the second phase start remote VAS snapshot work.
//! Keeping that boundary prevents a later invalid artifact root from creating
//! a partial remote checkpoint. The second phase retains input indices so it
//! can overlap remote work without changing result order or error selection.

use super::{CheckpointMode, LOG_TAG};
use crate::artifact as vas;
use crate::content_hash;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use api_contracts::generated::types::{
    runners::storage::ArtifactEntryMissingRootPolicy, webhooks::agent::checkpoints,
};
use futures_util::stream::{self, FuturesUnordered, StreamExt};
use guest_telemetry::log_info;
use guest_telemetry::telemetry::record_sandbox_op;
use serde::Deserialize;
use std::path::Path;

const ARTIFACT_CHECKPOINT_CONCURRENCY: usize = 2;
const PI_MEMORY_PHASE2_VALIDATION_FILENAME: &str = "maintenance-validation.json";
const PI_MEMORY_PHASE2_VALIDATION_MAX_BYTES: u64 = 4096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaintenanceLaunch {
    schema_version: u8,
    memory_storage_id: String,
    claimed_revision: u32,
    claimed_base_version_id: String,
    lease_token: String,
    selection_digest: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceValidationMarker {
    schema_version: u8,
    run_id: String,
    memory_storage_id: String,
    claimed_revision: u32,
    claimed_base_version_id: String,
    lease_token: String,
    selection_digest: String,
    validated_version_id: String,
}

struct MaintenanceCheckpointGuard {
    launch: MaintenanceLaunch,
    attestation: Option<vas::PiMemoryPhase2CheckpointAttestation>,
}

fn maintenance_checkpoint_error() -> AgentError {
    AgentError::Checkpoint("Pi memory maintenance checkpoint validation failed".into())
}

fn maintenance_launch(raw: &str) -> Result<Option<MaintenanceLaunch>, AgentError> {
    if raw.is_empty() {
        return Ok(None);
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| maintenance_checkpoint_error())?;
    let Some(maintenance) = value.get("maintenance") else {
        return Ok(None);
    };
    serde_json::from_value(maintenance.clone())
        .map(Some)
        .map_err(|_| maintenance_checkpoint_error())
}

fn maintenance_checkpoint_guard(
    raw_launch: &str,
    launch_payload_file: &str,
    run_id: &str,
    mode: CheckpointMode,
) -> Result<Option<MaintenanceCheckpointGuard>, AgentError> {
    let Some(launch) = maintenance_launch(raw_launch)? else {
        return Ok(None);
    };
    if launch.schema_version != 1 {
        return Err(maintenance_checkpoint_error());
    }
    if mode == CheckpointMode::Recovery {
        return Ok(Some(MaintenanceCheckpointGuard {
            launch,
            attestation: None,
        }));
    }
    let marker_path =
        Path::new(launch_payload_file).with_file_name(PI_MEMORY_PHASE2_VALIDATION_FILENAME);
    let metadata =
        std::fs::symlink_metadata(&marker_path).map_err(|_| maintenance_checkpoint_error())?;
    if !metadata.file_type().is_file() || metadata.len() > PI_MEMORY_PHASE2_VALIDATION_MAX_BYTES {
        return Err(maintenance_checkpoint_error());
    }
    let marker: MaintenanceValidationMarker = serde_json::from_slice(
        &std::fs::read(marker_path).map_err(|_| maintenance_checkpoint_error())?,
    )
    .map_err(|_| maintenance_checkpoint_error())?;
    if marker.schema_version != 1
        || marker.run_id != run_id
        || marker.memory_storage_id != launch.memory_storage_id
        || marker.claimed_revision != launch.claimed_revision
        || marker.claimed_base_version_id != launch.claimed_base_version_id
        || marker.lease_token != launch.lease_token
        || marker.selection_digest != launch.selection_digest
    {
        return Err(maintenance_checkpoint_error());
    }
    let attestation = vas::PiMemoryPhase2CheckpointAttestation {
        // v2 requires commit receipts; an old API rejects prepare before upload.
        schema_version: 2,
        lease_token: marker.lease_token,
        claimed_revision: marker.claimed_revision,
        claimed_base_version_id: marker.claimed_base_version_id,
        selection_digest: marker.selection_digest,
        validated_version_id: marker.validated_version_id,
    };
    Ok(Some(MaintenanceCheckpointGuard {
        launch,
        attestation: Some(attestation),
    }))
}

/// Build an artifact snapshot using the type generated from the canonical
/// checkpoint webhook contract.
fn build_artifact_snapshot_entry(
    name: &str,
    version: &str,
    mount_path: &str,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
) -> checkpoints::ArtifactSnapshot {
    checkpoints::ArtifactSnapshot {
        name: name.to_string(),
        version: version.to_string(),
        mount_path: mount_path.to_string(),
        missing_root_policy,
    }
}

enum ArtifactSnapshotPlan<'a> {
    Snapshot {
        entry: &'a env::ArtifactEnv,
        files: Vec<vas::FileEntry>,
    },
    PreserveParentVersion {
        entry: &'a env::ArtifactEnv,
    },
}

async fn build_artifact_snapshot_plan(
    entry: &env::ArtifactEnv,
) -> Result<ArtifactSnapshotPlan<'_>, vas::WalkFilesError> {
    log_info!(
        LOG_TAG,
        "Processing artifact '{}' at {}",
        entry.name,
        entry.mount_path
    );
    match vas::walk_files_for_checkpoint(&entry.mount_path).await {
        Ok(files) => Ok(ArtifactSnapshotPlan::Snapshot { entry, files }),
        Err(error)
            if error.is_missing_root()
                && matches!(
                    entry.missing_root_policy,
                    Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion)
                ) =>
        {
            error.record_preserved_missing_root(&entry.name, &entry.mount_path);
            Ok(ArtifactSnapshotPlan::PreserveParentVersion { entry })
        }
        Err(error) => Err(error),
    }
}

fn compute_artifact_content_hash(entry: &env::ArtifactEnv, files: &[vas::FileEntry]) -> String {
    let content_hash_start = std::time::Instant::now();
    let content_hash = content_hash::compute_content_hash(
        &entry.storage_id,
        files
            .iter()
            .map(|file| (file.path.as_str(), file.hash.as_str())),
    );
    record_sandbox_op(
        "artifact_content_hash_compute",
        content_hash_start.elapsed(),
        true,
        None,
    );
    content_hash
}

async fn snapshot_artifact_plan(
    http: &HttpClient,
    run_id: &str,
    plan: ArtifactSnapshotPlan<'_>,
    maintenance_attestation: Option<vas::PiMemoryPhase2CheckpointAttestation>,
) -> Result<checkpoints::ArtifactSnapshot, AgentError> {
    let (entry, files) = match plan {
        ArtifactSnapshotPlan::Snapshot { entry, files } => (entry, files),
        ArtifactSnapshotPlan::PreserveParentVersion { entry } => {
            log_info!(
                LOG_TAG,
                "VAS artifact snapshot preserved parent version for missing root: {}@{}",
                entry.name,
                entry.version_id
            );
            return Ok(build_artifact_snapshot_entry(
                &entry.name,
                &entry.version_id,
                &entry.mount_path,
                entry.missing_root_policy,
            ));
        }
    };
    // Skip the VAS round-trips when the mount is byte-identical to what
    // was originally mounted. `version_id` in VAS *is* the content hash
    // (same SHA-256 the web producer emits), so an equality check on the
    // locally-recomputed hash is sufficient — no extra metadata needed.
    // See #10967 for the ~3.9s-per-checkpoint motivation.
    // Attested maintenance plans were already hash-validated before remote
    // scheduling and must always publish for server-side settlement.
    if maintenance_attestation.is_none() {
        let skip_check_start = std::time::Instant::now();
        let local_hash = compute_artifact_content_hash(entry, &files);
        if local_hash == entry.version_id {
            log_info!(
                LOG_TAG,
                "VAS artifact snapshot skipped (unchanged since mount): {}@{}",
                entry.name,
                entry.version_id
            );
            record_sandbox_op(
                "artifact_snapshot_skipped",
                skip_check_start.elapsed(),
                true,
                None,
            );
            return Ok(build_artifact_snapshot_entry(
                &entry.name,
                &entry.version_id,
                &entry.mount_path,
                entry.missing_root_policy,
            ));
        }
    }

    log_info!(
        LOG_TAG,
        "Creating VAS snapshot for artifact '{}'",
        entry.name
    );
    let message = format!("Checkpoint from run {run_id}");
    let snapshot = vas::create_snapshot_with_attestation(
        http,
        vas::CreateSnapshotRequest {
            mount_path: &entry.mount_path,
            files,
            storage_id: &entry.storage_id,
            run_id,
            message: &message,
            parent_version_id: &entry.version_id,
        },
        maintenance_attestation,
    )
    .await?;
    log_info!(
        LOG_TAG,
        "VAS artifact snapshot created: {}@{}",
        entry.name,
        snapshot.version_id
    );
    Ok(build_artifact_snapshot_entry(
        &entry.name,
        &snapshot.version_id,
        &entry.mount_path,
        entry.missing_root_policy,
    ))
}

/// Snapshot artifact entries.
///
/// Memory rides in the private run-payload artifact list, so there is no
/// separate memory arm. The generated checkpoint contract preserves the
/// optional missing-root policy for every snapshot path.
///
/// This is a two-phase operation. First, every entry is walked and converted
/// into a local snapshot plan with at most
/// [`ARTIFACT_CHECKPOINT_CONCURRENCY`] walks in flight. The complete preflight
/// result set is collected before any plan can call VAS prepare, upload, or
/// commit APIs. This separation is what makes a later invalid entry fail
/// without remote side effects; see
/// `artifact_snapshot_later_missing_mount_fails_before_any_storage_api_calls`.
///
/// After preflight succeeds, remote snapshot plans may overlap within the same
/// concurrency bound. Futures can finish out of input order, so input indices
/// are retained and successful snapshots are returned in input order. A
/// remote error stops admitting new pending plans, but futures that were
/// already started are drained. Errors are retained by input index so the
/// lowest-index error is returned deterministically. The overlap and ordering
/// guarantee is covered by
/// `artifact_snapshot_pipelines_overlap_and_preserve_result_order`.
///
/// The checkpoint caller in `checkpoint/mod.rs` runs this prerequisite with
/// session-history preparation in `prepare_checkpoint_impl` via
/// `tokio::join!` and waits for both results before constructing the combined
/// completion request.
pub(super) async fn snapshot_artifact_entries_for_checkpoint(
    http: &HttpClient,
    run_id: &str,
    entries: &[env::ArtifactEnv],
    mode: CheckpointMode,
    pi_launch_config: &str,
    pi_launch_payload_file: &str,
) -> Result<Option<Vec<checkpoints::ArtifactSnapshot>>, AgentError> {
    if entries.is_empty() {
        log_info!(
            LOG_TAG,
            "No artifact configured, creating checkpoint without artifact snapshot"
        );
        return Ok(None);
    }

    let maintenance =
        maintenance_checkpoint_guard(pi_launch_config, pi_launch_payload_file, run_id, mode)?;
    if let Some(guard) = maintenance.as_ref() {
        let [entry] = entries else {
            return Err(maintenance_checkpoint_error());
        };
        if entry.name != "memory"
            || entry.storage_id != guard.launch.memory_storage_id
            || entry.version_id != guard.launch.claimed_base_version_id
        {
            return Err(maintenance_checkpoint_error());
        }
        if mode == CheckpointMode::Recovery {
            return Ok(Some(vec![build_artifact_snapshot_entry(
                &entry.name,
                &entry.version_id,
                &entry.mount_path,
                entry.missing_root_policy,
            )]));
        }
    }

    let mut indexed_plans = stream::iter(entries.iter().enumerate())
        .map(|(index, entry)| async move { (index, build_artifact_snapshot_plan(entry).await) })
        .buffer_unordered(ARTIFACT_CHECKPOINT_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    indexed_plans.sort_unstable_by_key(|(index, _)| *index);
    let plans = indexed_plans
        .into_iter()
        .map(|(_, result)| result.map_err(vas::WalkFilesError::into_agent_error))
        .collect::<Result<Vec<_>, _>>()?;

    if let Some(guard) = maintenance.as_ref() {
        let Some(attestation) = guard.attestation.as_ref() else {
            return Err(maintenance_checkpoint_error());
        };
        let [ArtifactSnapshotPlan::Snapshot { entry, files }] = plans.as_slice() else {
            return Err(maintenance_checkpoint_error());
        };
        let local_hash = compute_artifact_content_hash(entry, files);
        if local_hash != attestation.validated_version_id {
            return Err(maintenance_checkpoint_error());
        }
    }

    let mut pending = plans.into_iter().enumerate();
    let snapshot = |(index, plan)| {
        let attestation = maintenance
            .as_ref()
            .and_then(|guard| guard.attestation.clone());
        async move {
            (
                index,
                snapshot_artifact_plan(http, run_id, plan, attestation).await,
            )
        }
    };
    let mut in_flight = FuturesUnordered::new();
    for _ in 0..ARTIFACT_CHECKPOINT_CONCURRENCY {
        if let Some(plan) = pending.next() {
            in_flight.push(snapshot(plan));
        }
    }

    let mut indexed_results = Vec::with_capacity(entries.len());
    let mut first_error: Option<(usize, AgentError)> = None;
    while let Some((index, result)) = in_flight.next().await {
        match result {
            Ok(snapshot_result) => {
                indexed_results.push((index, snapshot_result));
                if first_error.is_none()
                    && let Some(plan) = pending.next()
                {
                    in_flight.push(snapshot(plan));
                }
            }
            Err(error) => {
                if first_error
                    .as_ref()
                    .is_none_or(|(error_index, _)| index < *error_index)
                {
                    first_error = Some((index, error));
                }
            }
        }
    }
    if let Some((_, error)) = first_error {
        return Err(error);
    }

    indexed_results.sort_unstable_by_key(|(index, _)| *index);
    Ok(Some(
        indexed_results
            .into_iter()
            .map(|(_, result)| result)
            .collect(),
    ))
}

#[cfg(test)]
async fn snapshot_artifact_entries(
    http: &HttpClient,
    run_id: &str,
    entries: &[env::ArtifactEnv],
) -> Result<Option<Vec<checkpoints::ArtifactSnapshot>>, AgentError> {
    snapshot_artifact_entries_for_checkpoint(http, run_id, entries, CheckpointMode::Success, "", "")
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
    use httpmock::prelude::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    #[cfg(target_os = "linux")]
    use std::ffi::CString;
    #[cfg(target_os = "linux")]
    use std::os::unix::ffi::OsStrExt;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const REQUEST_OVERLAP_TIMEOUT: Duration = Duration::from_secs(5);

    fn assert_artifact_hash_failure(telemetry_path: &std::path::Path, expected_error: &str) {
        let expected_error = expected_error
            .strip_prefix("checkpoint: ")
            .unwrap_or(expected_error);
        let telemetry_entries = std::fs::read_to_string(telemetry_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        let matching_failure = telemetry_entries.iter().any(|entry| {
            entry.get("action_type").and_then(serde_json::Value::as_str)
                == Some("artifact_hash_compute")
                && entry.get("success").and_then(serde_json::Value::as_bool) == Some(false)
                && entry.get("error").and_then(serde_json::Value::as_str) == Some(expected_error)
        });
        assert!(
            matching_failure,
            "missing failed artifact_hash_compute telemetry for {expected_error:?}"
        );
    }

    #[cfg(target_os = "linux")]
    fn make_fifo(path: &std::path::Path) -> std::io::Result<()> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        // SAFETY: `path` is a NUL-terminated filesystem path owned for the call.
        let result = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    #[cfg(target_os = "linux")]
    async fn artifact_snapshot_preflight_error(mount: &std::path::Path) -> String {
        let telemetry_dir = tempfile::tempdir().unwrap();
        let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;
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
        let upload = server.mock(|when, then| {
            when.method(PUT);
            then.status(200);
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: None,
        }];

        let error = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();
        let message = error.to_string();
        prepare.assert_calls(0);
        upload.assert_calls(0);
        commit.assert_calls(0);
        assert_artifact_hash_failure(&telemetry_path, &message);
        message
    }

    async fn start_artifact_checkpoint_test_server(
        artifact_count: usize,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut prepare_requests = Vec::with_capacity(artifact_count);
            for _ in 0..artifact_count {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (path, payload) = read_test_json_request(&mut socket).await;
                assert_eq!(path, "/api/webhooks/agent/storages/prepare");
                let storage_id = payload["storageId"].as_str().unwrap().to_string();
                prepare_requests.push((socket, storage_id));
            }
            let prepare_storage_ids = prepare_requests
                .iter()
                .map(|(_, storage_id)| storage_id.clone())
                .collect();
            for (mut socket, storage_id) in prepare_requests {
                let logical_name = storage_id
                    .strip_suffix("-storage-id")
                    .unwrap_or(&storage_id);
                write_test_json_response(
                    &mut socket,
                    &json!({
                        "versionId": format!("snapshot-{logical_name}"),
                        "existing": true,
                    }),
                )
                .await;
            }
            for _ in 0..artifact_count {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (path, _) = read_test_json_request(&mut socket).await;
                assert_eq!(path, "/api/webhooks/agent/storages/commit");
                write_test_json_response(
                    &mut socket,
                    &json!({
                        "success": true,
                        "versionId": "ignored",
                        "storageName": "ignored",
                        "size": 0,
                        "fileCount": 0,
                    }),
                )
                .await;
            }
            prepare_storage_ids
        });
        (format!("http://{address}"), handle)
    }

    async fn read_test_json_request(socket: &mut TcpStream) -> (String, serde_json::Value) {
        let mut request = Vec::new();
        let header_end = loop {
            if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break index;
            }
            let mut chunk = [0_u8; 1024];
            let read = socket.read(&mut chunk).await.unwrap();
            assert!(read > 0, "connection closed before request headers");
            request.extend_from_slice(&chunk[..read]);
        };
        let headers = std::str::from_utf8(&request[..header_end]).unwrap();
        let path = headers
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .to_string();
        let content_length = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
            .unwrap_or_default();
        let body_start = header_end + 4;
        while request.len() < body_start + content_length {
            let mut chunk = [0_u8; 1024];
            let read = socket.read(&mut chunk).await.unwrap();
            assert!(read > 0, "connection closed before request body");
            request.extend_from_slice(&chunk[..read]);
        }
        let payload =
            serde_json::from_slice(&request[body_start..body_start + content_length]).unwrap();
        (path, payload)
    }

    async fn write_test_json_response(socket: &mut TcpStream, body: &serde_json::Value) {
        let body = serde_json::to_vec(body).unwrap();
        let headers = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(headers.as_bytes()).await.unwrap();
        socket.write_all(&body).await.unwrap();
        socket.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn maintenance_recovery_preserves_parent_before_any_storage_publication() {
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
            "maintenance-run",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let memory_root = dir.path().join("memory");
        std::fs::create_dir_all(&memory_root).unwrap();
        // Model a process killed halfway through a multi-file writeback. The
        // recovery branch must not walk or publish this partial tree.
        std::fs::write(memory_root.join("MEMORY.md"), "partial").unwrap();
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
        let launch_payload_file = dir.path().join("pi-launch-payload/payload.json");

        let snapshots = snapshot_artifact_entries_for_checkpoint(
            &http,
            "maintenance-run",
            &entries,
            CheckpointMode::Recovery,
            &launch.to_string(),
            &launch_payload_file.to_string_lossy(),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].version, base_version);
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn maintenance_success_computes_hash_once_and_forwards_exact_validation_attestation() {
        let telemetry_dir = tempfile::tempdir().unwrap();
        let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let storage_id = "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63";
        let base_version = "a".repeat(64);
        let selection_digest = "b".repeat(64);
        let lease_token = "44754115-d375-4c46-aea7-a55bd1b61ec7";
        let content = b"# Task Group: validated\n";
        let secondary_content = b"Validated maintenance details\n";
        let file_hash = hex::encode(Sha256::digest(content));
        let secondary_file_hash = hex::encode(Sha256::digest(secondary_content));
        let validated_version = content_hash::compute_content_hash(
            storage_id,
            [
                ("MEMORY.md", file_hash.as_str()),
                ("details.md", secondary_file_hash.as_str()),
            ],
        );
        let expected_attestation = json!({
            "schemaVersion": 2,
            "leaseToken": lease_token,
            "claimedRevision": 7,
            "claimedBaseVersionId": base_version,
            "selectionDigest": selection_digest,
            "validatedVersionId": validated_version,
        });
        let server_version = validated_version.clone();
        let server_attestation = expected_attestation.clone();
        let server = tokio::spawn(async move {
            let (mut prepare_socket, _) = listener.accept().await.unwrap();
            let (prepare_path, prepare_body) = read_test_json_request(&mut prepare_socket).await;
            assert_eq!(prepare_path, "/api/webhooks/agent/storages/prepare");
            assert_eq!(prepare_body["maintenanceAttestation"], server_attestation);
            write_test_json_response(
                &mut prepare_socket,
                &json!({
                    "versionId": server_version,
                    "existing": true,
                }),
            )
            .await;

            let (mut commit_socket, _) = listener.accept().await.unwrap();
            let (commit_path, commit_body) = read_test_json_request(&mut commit_socket).await;
            assert_eq!(commit_path, "/api/webhooks/agent/storages/commit");
            assert_eq!(commit_body["maintenanceAttestation"], server_attestation);
            assert_eq!(commit_body["versionId"], server_version);
            write_test_json_response(
                &mut commit_socket,
                &json!({
                    "success": true,
                    "versionId": server_version,
                    "storageName": "memory",
                    "size": content.len() + secondary_content.len(),
                    "fileCount": 2,
                }),
            )
            .await;
        });

        let http = HttpClient::with_api_config(
            format!("http://{address}"),
            "test-token",
            "",
            "maintenance-run-success",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let memory_root = dir.path().join("memory");
        std::fs::create_dir_all(&memory_root).unwrap();
        std::fs::write(memory_root.join("MEMORY.md"), content).unwrap();
        std::fs::write(memory_root.join("details.md"), secondary_content).unwrap();
        let launch_payload_file = dir.path().join("pi-launch-payload/payload.json");
        std::fs::create_dir_all(launch_payload_file.parent().unwrap()).unwrap();
        std::fs::write(
            launch_payload_file.with_file_name(PI_MEMORY_PHASE2_VALIDATION_FILENAME),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "runId": "maintenance-run-success",
                "memoryStorageId": storage_id,
                "claimedRevision": 7,
                "claimedBaseVersionId": base_version,
                "leaseToken": lease_token,
                "selectionDigest": selection_digest,
                "validatedVersionId": validated_version,
            }))
            .unwrap(),
        )
        .unwrap();
        let launch = json!({
            "schemaVersion": 2,
            "maintenance": {
                "schemaVersion": 1,
                "memoryStorageId": storage_id,
                "claimedRevision": 7,
                "claimedBaseVersionId": base_version,
                "leaseToken": lease_token,
                "selectionDigest": selection_digest,
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

        let snapshots = snapshot_artifact_entries_for_checkpoint(
            &http,
            "maintenance-run-success",
            &entries,
            CheckpointMode::Success,
            &launch.to_string(),
            &launch_payload_file.to_string_lossy(),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].version, validated_version);
        server.await.unwrap();

        let content_hash_compute_count = std::fs::read_to_string(telemetry_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|entry| {
                entry.get("action_type").and_then(serde_json::Value::as_str)
                    == Some("artifact_content_hash_compute")
            })
            .count();
        assert_eq!(content_hash_compute_count, 1);
    }

    #[test]
    fn artifact_snapshot_entry_shape_matches_receiver_schema() {
        let entry = build_artifact_snapshot_entry("workspace", "v-abc-123", "/workspace", None);
        let value = serde_json::to_value(entry).unwrap();
        assert_eq!(
            value,
            json!({
                "name": "workspace",
                "version": "v-abc-123",
                "mountPath": "/workspace",
            })
        );
    }

    #[test]
    fn artifact_snapshot_entry_uses_camel_case_keys() {
        let entry = build_artifact_snapshot_entry(
            "n",
            "v",
            "/m",
            Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        );
        let value = serde_json::to_value(entry).unwrap();
        let obj = value.as_object().expect("entry must be a JSON object");
        // Contract-boundary invariant: the web Zod receiver requires camelCase
        // `mountPath` and `missingRootPolicy`; a snake_case slip would
        // silently cause a 400 on the webhook side.
        assert!(obj.contains_key("name"));
        assert!(obj.contains_key("version"));
        assert!(obj.contains_key("mountPath"));
        assert!(obj.contains_key("missingRootPolicy"));
        assert!(!obj.contains_key("mount_path"));
        assert!(!obj.contains_key("missing_root_policy"));
    }

    #[tokio::test]
    async fn artifact_snapshot_missing_mount_fails_before_storage_api_calls() {
        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
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
        let upload = server.mock(|when, then| {
            when.method(PUT);
            then.status(200);
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: None,
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        upload.assert_calls(0);
        commit.assert_calls(0);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn artifact_snapshot_descendant_io_faults_fail_before_any_storage_api_calls() {
        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let upload = server.mock(|when, then| {
            when.method(PUT);
            then.status(200);
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

        let dir = tempfile::tempdir().unwrap();
        let healthy_mount = dir.path().join("healthy");
        std::fs::create_dir(&healthy_mount).unwrap();
        std::fs::write(healthy_mount.join("updated.txt"), "updated").unwrap();
        let fault_mount = dir.path().join("faulting");
        std::fs::create_dir(&fault_mount).unwrap();
        std::fs::create_dir(fault_mount.join("nested")).unwrap();
        std::fs::write(fault_mount.join("nested/kept.txt"), "parent content").unwrap();
        let entries = vec![
            env::ArtifactEnv {
                name: "workspace".to_string(),
                mount_path: healthy_mount.to_string_lossy().into_owned(),
                storage_id: "workspace-storage-id".to_string(),
                version_id: "old-workspace-version".to_string(),
                missing_root_policy: None,
            },
            env::ArtifactEnv {
                name: "memory".to_string(),
                mount_path: fault_mount.to_string_lossy().into_owned(),
                storage_id: "memory-storage-id".to_string(),
                version_id: "old-memory-version".to_string(),
                missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
            },
        ];

        for (stage, relative, expected) in [
            (
                vas::WalkFaultStage::DirectoryRead,
                "nested",
                "failed to read artifact directory",
            ),
            (
                vas::WalkFaultStage::DirectoryEntry,
                "nested",
                "failed to iterate artifact directory",
            ),
            (
                vas::WalkFaultStage::FileOpen,
                "nested/kept.txt",
                "failed to open artifact file",
            ),
            (
                vas::WalkFaultStage::FileRead,
                "nested/kept.txt",
                "failed to hash artifact file",
            ),
        ] {
            let fault = vas::inject_walk_fault_for_test(&fault_mount, relative, stage);
            let error = snapshot_artifact_entries(&http, "test-run", &entries)
                .await
                .expect_err("an incomplete manifest must fail checkpoint preflight");
            drop(fault);

            assert!(matches!(error, AgentError::Checkpoint(_)), "got: {error}");
            let message = error.to_string();
            assert!(message.contains(expected), "got: {message}");
            assert!(message.contains(relative), "got: {message}");
            prepare.assert_calls(0);
            upload.assert_calls(0);
            commit.assert_calls(0);
        }
    }

    #[tokio::test]
    async fn artifact_snapshot_enforces_manifest_boundaries_before_storage_api_calls() {
        use api_contracts::generated::constants::storages::{
            STORAGE_MANIFEST_MAX_FILES, STORAGE_MANIFEST_MAX_PATH_BYTES,
        };

        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
        let mut sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        guest_telemetry::log::clear_system_log_file();

        let dir = tempfile::tempdir().unwrap();
        let first_prefix = "a".repeat(200);
        let second_prefix = "b".repeat(200);
        let mount = dir
            .path()
            .join(first_prefix)
            .join(second_prefix)
            .join("files");
        std::fs::create_dir_all(&mount).unwrap();
        let max_files = usize::try_from(STORAGE_MANIFEST_MAX_FILES).unwrap();
        for index in 0..max_files {
            std::fs::File::create(mount.join(format!("{index:05}"))).unwrap();
        }

        let exact_files = vas::walk_files_for_checkpoint(mount.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(exact_files.len(), max_files);
        drop(exact_files);

        let over_limit_path = mount.join("over-limit");
        std::fs::File::create(&over_limit_path).unwrap();

        let telemetry_dir = tempfile::tempdir().unwrap();
        let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
        sandbox_ops_guard.install_override(&telemetry_path);
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
        let upload = server.mock(|when, then| {
            when.method(PUT);
            then.status(200);
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: None,
        }];

        let count_error = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();
        let count_message = count_error.to_string();
        assert!(
            count_message.contains(&format!(
                "candidate files {}/{STORAGE_MANIFEST_MAX_FILES}",
                STORAGE_MANIFEST_MAX_FILES + 1
            )),
            "got: {count_message}"
        );
        assert!(
            count_message.contains("candidate UTF-8 path bytes"),
            "got: {count_message}"
        );
        assert!(
            count_message.contains(&format!("/{STORAGE_MANIFEST_MAX_PATH_BYTES}")),
            "got: {count_message}"
        );
        prepare.assert_calls(0);
        upload.assert_calls(0);
        commit.assert_calls(0);

        assert_artifact_hash_failure(&telemetry_path, &count_message);

        std::fs::remove_file(over_limit_path).unwrap();
        let path_error = vas::walk_files_for_checkpoint(dir.path().to_str().unwrap())
            .await
            .unwrap_err()
            .into_agent_error();
        let path_message = path_error.to_string();
        assert!(
            path_message.contains("candidate UTF-8 path bytes"),
            "got: {path_message}"
        );
        assert!(
            path_message.contains(&format!("/{STORAGE_MANIFEST_MAX_PATH_BYTES}")),
            "got: {path_message}"
        );
        assert!(
            !path_message.contains(&format!(
                "candidate files {}/{STORAGE_MANIFEST_MAX_FILES}",
                STORAGE_MANIFEST_MAX_FILES + 1
            )),
            "path-byte limit must fail before the file-count limit: {path_message}"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn artifact_snapshot_enforces_traversal_entry_limit_before_storage_api_calls() {
        const PARENT_COUNT: usize = 2;

        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
        guest_telemetry::log::clear_system_log_file();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("wide");
        std::fs::create_dir(&mount).unwrap();
        std::fs::create_dir(mount.join(".git")).unwrap();
        let max_entries = usize::try_from(vas::ARTIFACT_TRAVERSAL_MAX_ENTRIES).unwrap();
        let links_per_parent = (max_entries - PARENT_COUNT) / PARENT_COUNT - 1;
        assert_eq!(
            PARENT_COUNT * (links_per_parent + 2),
            max_entries,
            "fixture must contain exactly the traversal limit before .git"
        );
        for parent_index in 0..PARENT_COUNT {
            let parent = mount.join(format!("p{parent_index:03}"));
            std::fs::create_dir(&parent).unwrap();
            let source = parent.join("source");
            make_fifo(&source).unwrap();
            for link_index in 0..links_per_parent {
                std::fs::hard_link(&source, parent.join(format!("l{link_index:05}"))).unwrap();
            }
        }

        let message = artifact_snapshot_preflight_error(&mount).await;
        assert!(
            message.contains(&format!(
                "observed entries {}/{}",
                vas::ARTIFACT_TRAVERSAL_MAX_ENTRIES + 1,
                vas::ARTIFACT_TRAVERSAL_MAX_ENTRIES
            )),
            "got: {message}"
        );
        assert!(
            message.contains(&format!("/{}", vas::ARTIFACT_TRAVERSAL_MAX_DEPTH)),
            "got: {message}"
        );
        assert!(
            message.contains(&format!("/{}", vas::ARTIFACT_TRAVERSAL_MAX_PATH_BYTES)),
            "got: {message}"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn artifact_snapshot_enforces_traversal_depth_before_storage_api_calls() {
        use std::os::unix::ffi::OsStringExt;

        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
        guest_telemetry::log::clear_system_log_file();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("deep");
        std::fs::create_dir(&mount).unwrap();
        let mut deepest = mount.clone();
        for _ in 0..=vas::ARTIFACT_TRAVERSAL_MAX_DEPTH {
            deepest.push("d");
            std::fs::create_dir(&deepest).unwrap();
        }
        std::fs::File::create(deepest.join(std::ffi::OsString::from_vec(vec![0xff]))).unwrap();

        let message = artifact_snapshot_preflight_error(&mount).await;
        assert!(
            message.contains(&format!(
                "directory depth {}/{}",
                vas::ARTIFACT_TRAVERSAL_MAX_DEPTH + 1,
                vas::ARTIFACT_TRAVERSAL_MAX_DEPTH
            )),
            "got: {message}"
        );
        assert!(
            message.contains(&format!(
                "active UTF-8 path bytes {}/{}",
                2 * vas::ARTIFACT_TRAVERSAL_MAX_DEPTH + 1,
                vas::ARTIFACT_TRAVERSAL_MAX_PATH_BYTES
            )),
            "got: {message}"
        );
    }

    #[tokio::test]
    async fn artifact_snapshot_explicit_fail_policy_missing_mount_fails() {
        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
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
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::Fail),
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_later_missing_mount_fails_before_any_storage_api_calls() {
        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
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
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let valid_mount = dir.path().join("valid");
        std::fs::create_dir(&valid_mount).unwrap();
        std::fs::write(valid_mount.join("changed.txt"), "changed").unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![
            env::ArtifactEnv {
                name: "workspace".to_string(),
                mount_path: valid_mount.to_string_lossy().into_owned(),
                storage_id: "workspace-storage-id".to_string(),
                version_id: "old-workspace-version".to_string(),
                missing_root_policy: None,
            },
            env::ArtifactEnv {
                name: "memory".to_string(),
                mount_path: missing_mount.to_string_lossy().into_owned(),
                storage_id: "memory-storage-id".to_string(),
                version_id: "old-memory-version".to_string(),
                missing_root_policy: None,
            },
        ];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_pipelines_overlap_and_preserve_result_order() {
        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
        let _sandbox_ops_guard = crate::SandboxOpsTestGuard::lock().await;
        let dir = tempfile::tempdir().unwrap();
        let workspace_mount = dir.path().join("workspace");
        let memory_mount = dir.path().join("memory");
        std::fs::create_dir(&workspace_mount).unwrap();
        std::fs::create_dir(&memory_mount).unwrap();
        std::fs::write(workspace_mount.join("workspace.txt"), "workspace").unwrap();
        std::fs::write(memory_mount.join("memory.txt"), "memory").unwrap();
        let entries = vec![
            env::ArtifactEnv {
                name: "workspace".to_string(),
                mount_path: workspace_mount.to_string_lossy().into_owned(),
                storage_id: "workspace-storage-id".to_string(),
                version_id: "old-workspace-version".to_string(),
                missing_root_policy: None,
            },
            env::ArtifactEnv {
                name: "memory".to_string(),
                mount_path: memory_mount.to_string_lossy().into_owned(),
                storage_id: "memory-storage-id".to_string(),
                version_id: "old-memory-version".to_string(),
                missing_root_policy: None,
            },
        ];
        let (base_url, server) = start_artifact_checkpoint_test_server(entries.len()).await;
        let http =
            HttpClient::with_api_config(base_url, "test-token", "", "test-run-001", Duration::ZERO)
                .unwrap();

        let snapshots = tokio::time::timeout(
            REQUEST_OVERLAP_TIMEOUT,
            snapshot_artifact_entries(&http, "test-run", &entries),
        )
        .await
        .expect("both artifact pipelines must reach prepare concurrently")
        .unwrap()
        .unwrap();
        let mut prepare_storage_ids = server.await.unwrap();
        prepare_storage_ids.sort_unstable();
        assert_eq!(
            prepare_storage_ids,
            ["memory-storage-id", "workspace-storage-id"]
        );
        assert_eq!(
            serde_json::to_value(snapshots).unwrap(),
            json!([
                {
                    "name": "workspace",
                    "version": "snapshot-workspace",
                    "mountPath": workspace_mount.to_string_lossy(),
                },
                {
                    "name": "memory",
                    "version": "snapshot-memory",
                    "mountPath": memory_mount.to_string_lossy(),
                },
            ])
        );
    }

    #[tokio::test]
    async fn artifact_snapshot_preserve_policy_missing_mount_preserves_parent_version() {
        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
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
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("memory");
        let entries = vec![env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "memory-storage-id".to_string(),
            version_id: "old-memory-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        }];

        let snapshots = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            serde_json::to_value(snapshots).unwrap(),
            json!([
                {
                    "name": "memory",
                    "version": "old-memory-version",
                    "mountPath": missing_mount.to_string_lossy(),
                    "missingRootPolicy": "preserveParentVersion",
                }
            ])
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_policy_still_fails_on_non_not_found_root_error() {
        let _system_log_state_guard = crate::lock_system_log_test_state_async().await;
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
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file_mount = dir.path().join("memory");
        std::fs::write(&file_mount, "not a directory").unwrap();
        let entries = vec![env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: file_mount.to_string_lossy().into_owned(),
            storage_id: "memory-storage-id".to_string(),
            version_id: "old-memory-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }
}
