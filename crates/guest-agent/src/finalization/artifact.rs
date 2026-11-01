//! Artifact snapshot planning and publication for Run finalization.
//!
//! Artifact snapshot publication is intentionally split into two phases. The first
//! phase walks and plans every configured artifact locally, with at most
//! [`ARTIFACT_SNAPSHOT_CONCURRENCY`] walks in flight. Only after the complete
//! preflight succeeds does the second phase start remote VAS snapshot work.
//! Keeping that boundary prevents a later invalid artifact root from creating
//! a partial remote publication. The second phase retains input indices so it
//! can overlap remote work without changing result order or error selection.

use super::LOG_TAG;
use crate::artifact as vas;
use crate::content_hash;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use api_contracts::generated::types::{
    runners::storage::ArtifactEntryMissingRootPolicy, webhooks::agent::complete,
};
use futures_util::stream::{self, FuturesUnordered, StreamExt};
use guest_telemetry::telemetry::record_sandbox_op;
use guest_telemetry::{log_info, log_warn};

const ARTIFACT_SNAPSHOT_CONCURRENCY: usize = 2;
const MEMORY_ARTIFACT_NAME: &str = "memory";
/// Build a Storage output using the type generated from the canonical
/// completion webhook contract.
fn build_artifact_snapshot_entry(
    name: &str,
    version: &str,
    mount_path: &str,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
) -> complete::RequestCompletionStorageOutput {
    complete::RequestCompletionStorageOutput {
        name: name.to_string(),
        version: version.to_string(),
        mount_path: mount_path.to_string(),
        missing_root_policy: missing_root_policy.map(super::completion_missing_root_policy),
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
    // A successful walk is the artifact's readable subset by policy. Use it
    // even when an unreadable descendant was present in the parent version.
    match vas::walk_files_for_snapshot(&entry.mount_path).await {
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
) -> Result<complete::RequestCompletionStorageOutput, AgentError> {
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
    // See #10967 for the ~3.9s-per-finalization motivation.
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

    log_info!(
        LOG_TAG,
        "Creating VAS snapshot for artifact '{}'",
        entry.name
    );
    let message = format!("Artifact snapshot from run {run_id}");
    let snapshot = vas::create_snapshot(
        http,
        vas::CreateSnapshotRequest {
            mount_path: &entry.mount_path,
            files,
            storage_id: &entry.storage_id,
            run_id,
            message: &message,
            parent_version_id: &entry.version_id,
        },
    )
    .await?;
    if let vas::SnapshotPublication::Conflict(error) = snapshot.publication {
        if entry.name != MEMORY_ARTIFACT_NAME {
            return Err(error);
        }
        // The commit retained this candidate without publishing it. Keep the
        // Run's captured version as output; future Runs select the current HEAD.
        log_warn!(
            LOG_TAG,
            "Memory publication conflicted; retained candidate {} and preserved Run parent {}",
            snapshot.version_id,
            entry.version_id
        );
        return Ok(build_artifact_snapshot_entry(
            &entry.name,
            &entry.version_id,
            &entry.mount_path,
            entry.missing_root_policy,
        ));
    }
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
/// separate memory arm. The generated completion contract preserves the
/// optional missing-root policy for every snapshot path.
///
/// This is a two-phase operation. First, every entry is walked and converted
/// into a local snapshot plan with at most
/// [`ARTIFACT_SNAPSHOT_CONCURRENCY`] walks in flight. The complete preflight
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
/// The finalization caller in `finalization/mod.rs` runs this prerequisite with
/// session-history preparation in `prepare_finalization_impl` via
/// `tokio::join!` and waits for both results before constructing the combined
/// completion request.
pub(super) async fn snapshot_artifact_entries(
    http: &HttpClient,
    run_id: &str,
    entries: &[env::ArtifactEnv],
) -> Result<Option<Vec<complete::RequestCompletionStorageOutput>>, AgentError> {
    if entries.is_empty() {
        log_info!(
            LOG_TAG,
            "No artifact configured, creating finalization without artifact snapshot"
        );
        return Ok(None);
    }

    let mut indexed_plans = stream::iter(entries.iter().enumerate())
        .map(|(index, entry)| async move { (index, build_artifact_snapshot_plan(entry).await) })
        .buffer_unordered(ARTIFACT_SNAPSHOT_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    indexed_plans.sort_unstable_by_key(|(index, _)| *index);
    let plans = indexed_plans
        .into_iter()
        .map(|(_, result)| result.map_err(vas::WalkFilesError::into_agent_error))
        .collect::<Result<Vec<_>, _>>()?;

    let mut pending = plans.into_iter().enumerate();
    let snapshot =
        |(index, plan)| async move { (index, snapshot_artifact_plan(http, run_id, plan).await) };
    let mut in_flight = FuturesUnordered::new();
    for _ in 0..ARTIFACT_SNAPSHOT_CONCURRENCY {
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
async fn snapshot_artifact_entries_for_test(
    http: &HttpClient,
    run_id: &str,
    entries: &[env::ArtifactEnv],
) -> Result<Option<Vec<complete::RequestCompletionStorageOutput>>, AgentError> {
    snapshot_artifact_entries(http, run_id, entries).await
}

#[cfg(test)]
mod tests;
