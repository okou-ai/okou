//! VAS artifact upload — SHA-256 hashing, tar.gz creation, S3 presigned upload.
//!
//! Flow (caller first walks the mount via [`walk_files_for_snapshot`], then
//! invokes [`create_snapshot_with_attestation`] with the pre-walked file list):
//! 1. POST `/storages/prepare` with file list to get version/upload metadata
//! 2. If prepare found an existing version, validate the local archive inputs,
//!    then POST `/storages/commit` to update HEAD
//! 3. Otherwise, create tar.gz archive and manifest.json
//! 4. PUT archive + manifest to S3
//! 5. POST `/storages/commit`
//!
//! The pre-walked list intentionally defines artifact membership from files
//! readable at finalization time. An unreadable descendant is omitted so one
//! file or subtree does not fail the entire finalization; a new version can thus
//! omit a path that existed in the mounted parent version. The list is not a
//! completeness proof. The configured mount root must be opened and its
//! directory listing initialized, but failures while enumerating descendants,
//! opening child entries, reading metadata, or hashing file contents can omit an
//! entry or subtree while the walk succeeds. The finalization caller at
//! `crate::finalization::artifact::snapshot_artifact_entries` consumes this list
//! as the snapshot input; it does not add information about omitted entries.

use crate::error::AgentError;
use crate::http::HttpClient;
use guest_telemetry::telemetry::record_sandbox_op;
use guest_telemetry::{log_error, log_info, log_warn};
use serde::Serialize;

mod api;
mod archive;

use api::{
    CommitSnapshotRequest, PrepareSnapshotRequest, PreparedSnapshot, PreparedUploads,
    commit_snapshot, prepare_snapshot,
};
#[cfg(all(test, target_os = "linux"))]
pub(crate) use archive::{
    ARTIFACT_TRAVERSAL_MAX_DEPTH, ARTIFACT_TRAVERSAL_MAX_ENTRIES, ARTIFACT_TRAVERSAL_MAX_PATH_BYTES,
};
use archive::{collect_file_metadata, create_archive, validate_archive_inputs};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Debug, Serialize, Clone)]
pub(crate) struct FileEntry {
    /// UTF-8 relative protocol path used in prepare/commit payloads, manifests,
    /// and archive creation. Do not derive this from lossy filesystem conversion.
    pub(crate) path: String,
    pub(crate) hash: String,
    pub(crate) size: u64,
}

pub(crate) struct SnapshotResult {
    pub(crate) version_id: String,
    pub(crate) publication: SnapshotPublication,
}

pub(crate) enum SnapshotPublication {
    Published,
    Conflict(AgentError),
}

pub(crate) struct CreateSnapshotRequest<'a> {
    pub(crate) mount_path: &'a str,
    pub(crate) files: Vec<FileEntry>,
    pub(crate) storage_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) message: &'a str,
    pub(crate) parent_version_id: &'a str,
}

struct SnapshotRequest<'a> {
    mount_path: &'a str,
    files: Arc<[FileEntry]>,
    storage_id: &'a str,
    run_id: &'a str,
    message: &'a str,
    parent_version_id: &'a str,
}

impl<'a> From<CreateSnapshotRequest<'a>> for SnapshotRequest<'a> {
    fn from(request: CreateSnapshotRequest<'a>) -> Self {
        Self {
            mount_path: request.mount_path,
            files: request.files.into(),
            storage_id: request.storage_id,
            run_id: request.run_id,
            message: request.message,
            parent_version_id: request.parent_version_id,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifest<'a> {
    version: u8,
    files: &'a [FileEntry],
    created_at: String,
}

#[derive(Debug, thiserror::Error)]
enum ArchiveBundleError {
    #[error(transparent)]
    Archive(#[from] archive::ArchiveError),
    #[error(transparent)]
    Manifest(#[from] ManifestWriteError),
}

#[derive(Debug, thiserror::Error)]
enum ManifestWriteError {
    #[error("failed to create manifest output {}: {source}", path.display())]
    Create {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to serialize manifest: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to flush manifest: {0}")]
    Flush(std::io::Error),
}

#[derive(Debug)]
pub(crate) enum WalkFilesError {
    Execution(String),
    Finalization {
        message: String,
        elapsed: std::time::Duration,
        missing_root: bool,
    },
}

impl WalkFilesError {
    pub(crate) fn is_missing_root(&self) -> bool {
        matches!(
            self,
            Self::Finalization {
                missing_root: true,
                ..
            }
        )
    }

    pub(crate) fn record_preserved_missing_root(self, storage_name: &str, mount_path: &str) {
        if let Self::Finalization {
            message, elapsed, ..
        } = self
        {
            log_warn!(
                LOG_TAG,
                "Artifact root missing for '{}' at {}; preserving parent version: {message}",
                storage_name,
                mount_path
            );
            record_sandbox_op("artifact_missing_root_preserved", elapsed, true, None);
        }
    }

    pub(crate) fn into_agent_error(self) -> AgentError {
        match self {
            Self::Execution(message) => AgentError::Execution(message),
            Self::Finalization {
                message, elapsed, ..
            } => {
                record_sandbox_op("artifact_hash_compute", elapsed, false, Some(&message));
                log_error!(LOG_TAG, "{message}");
                AgentError::Finalization(message)
            }
        }
    }
}

pub(crate) async fn walk_files_for_snapshot(
    mount_path: &str,
) -> Result<Vec<FileEntry>, WalkFilesError> {
    log_info!(LOG_TAG, "Computing file hashes...");
    let hash_start = std::time::Instant::now();
    let mount = mount_path.to_string();
    let files_result =
        match tokio::task::spawn_blocking(move || collect_file_metadata(&mount)).await {
            Ok(result) => result,
            Err(e) => {
                let message = format!("hash task panicked: {e}");
                record_sandbox_op(
                    "artifact_hash_compute",
                    hash_start.elapsed(),
                    false,
                    Some(&message),
                );
                return Err(WalkFilesError::Execution(message));
            }
        };
    let files = match files_result {
        Ok(files) => files,
        Err(e) => {
            let message = format!("Failed to walk artifact files: {e}");
            return Err(WalkFilesError::Finalization {
                message,
                elapsed: hash_start.elapsed(),
                missing_root: e.is_root_not_found(),
            });
        }
    };
    record_sandbox_op("artifact_hash_compute", hash_start.elapsed(), true, None);
    log_info!(LOG_TAG, "Found {} files", files.len());
    Ok(files)
}

/// Create a VAS snapshot using direct S3 upload. Caller provides the
/// pre-walked file list (see [`walk_files_for_snapshot`]) — this lets the
/// finalization step share one walk between its skip-check fingerprint and the
/// snapshot upload.
pub(crate) async fn create_snapshot(
    http: &HttpClient,
    request: CreateSnapshotRequest<'_>,
) -> Result<SnapshotResult, AgentError> {
    let request = SnapshotRequest::from(request);
    log_info!(
        LOG_TAG,
        "Creating direct upload snapshot for Storage {}",
        request.storage_id
    );

    let prep = prepare_snapshot_step(http, &request).await?;
    let version_id = prep.version_id;

    if prep.existing {
        log_info!(
            LOG_TAG,
            "Version already exists (deduplicated), updating HEAD"
        );
        // Validate the local manifest inputs before committing the existing
        // version as HEAD, since this branch does not build an archive.
        validate_dedup_snapshot(request.mount_path, Arc::clone(&request.files)).await?;
        let publication = commit_snapshot_step(http, &request, &version_id, None).await?;
        return Ok(SnapshotResult {
            version_id,
            publication,
        });
    }

    let uploads = extract_uploads(prep.uploads)?;
    let archive = create_archive_bundle(request.mount_path, Arc::clone(&request.files)).await?;
    upload_archive_bundle(http, &uploads, &archive).await?;
    let publication =
        commit_snapshot_step(http, &request, &version_id, Some(request.message)).await?;

    let short_id = version_id.get(..8).unwrap_or(&version_id);
    log_info!(LOG_TAG, "Direct upload snapshot created: {short_id}");

    Ok(SnapshotResult {
        version_id,
        publication,
    })
}

struct ArchiveBundle {
    _temp_dir: tempfile::TempDir,
    archive_path: PathBuf,
    manifest_path: PathBuf,
}

async fn prepare_snapshot_step(
    http: &HttpClient,
    request: &SnapshotRequest<'_>,
) -> Result<PreparedSnapshot, AgentError> {
    log_info!(LOG_TAG, "Calling prepare endpoint...");
    let prep_start = std::time::Instant::now();
    match prepare_snapshot(
        http,
        PrepareSnapshotRequest {
            run_id: request.run_id,
            storage_id: request.storage_id,
            files: request.files.as_ref(),
            parent_version_id: request.parent_version_id,
        },
    )
    .await
    {
        Ok(prep) => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), true, None);
            Ok(prep)
        }
        Err(error) => {
            let (error, telemetry_error) = error.into_parts();
            record_sandbox_op(
                "artifact_prepare_api",
                prep_start.elapsed(),
                false,
                telemetry_error.as_deref(),
            );
            Err(error)
        }
    }
}

async fn validate_dedup_snapshot(
    mount_path: &str,
    files: Arc<[FileEntry]>,
) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Validating deduplicated artifact inputs...");
    let validate_start = std::time::Instant::now();
    let validate_mount = mount_path.to_string();
    let validate_result = match tokio::task::spawn_blocking(move || {
        validate_archive_inputs(&validate_mount, files.as_ref())
    })
    .await
    {
        Ok(result) => result,
        Err(e) => {
            record_sandbox_op(
                "artifact_archive_validate",
                validate_start.elapsed(),
                false,
                None,
            );
            return Err(AgentError::Execution(format!(
                "archive validation task panicked: {e}"
            )));
        }
    };
    if let Err(e) = validate_result {
        log_error!(LOG_TAG, "Failed to validate deduplicated archive: {e}");
        record_sandbox_op(
            "artifact_archive_validate",
            validate_start.elapsed(),
            false,
            None,
        );
        return Err(AgentError::Finalization(
            "Failed to validate archive inputs".into(),
        ));
    }
    record_sandbox_op(
        "artifact_archive_validate",
        validate_start.elapsed(),
        true,
        None,
    );
    Ok(())
}

async fn commit_snapshot_step(
    http: &HttpClient,
    request: &SnapshotRequest<'_>,
    version_id: &str,
    message: Option<&str>,
) -> Result<SnapshotPublication, AgentError> {
    log_info!(LOG_TAG, "Calling commit endpoint...");
    let commit_start = std::time::Instant::now();
    let result = match commit_snapshot(
        http,
        CommitSnapshotRequest {
            run_id: request.run_id,
            storage_id: request.storage_id,
            version_id,
            parent_version_id: request.parent_version_id,
            files: request.files.as_ref(),
            message,
        },
        "Failed to parse commit response",
    )
    .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err(AgentError::Finalization("Commit failed".into())),
        Err(error) => Err(error),
    };
    record_sandbox_op(
        "artifact_commit_api",
        commit_start.elapsed(),
        result.is_ok(),
        None,
    );
    match result {
        Ok(()) => Ok(SnapshotPublication::Published),
        Err(error @ AgentError::HttpStatus { status: 409, .. }) => {
            Ok(SnapshotPublication::Conflict(error))
        }
        Err(error) => Err(error),
    }
}

fn extract_uploads(uploads: Option<PreparedUploads>) -> Result<PreparedUploads, AgentError> {
    uploads.ok_or_else(|| AgentError::Finalization("No upload URLs in prepare response".into()))
}

async fn create_archive_bundle(
    mount_path: &str,
    files: Arc<[FileEntry]>,
) -> Result<ArchiveBundle, AgentError> {
    let temp_dir = tempfile::tempdir().map_err(AgentError::Io)?;
    let archive_path = temp_dir.path().join("archive.tar.gz");
    let manifest_path = temp_dir.path().join("manifest.json");

    log_info!(LOG_TAG, "Creating archive...");
    let arc_start = std::time::Instant::now();
    let archive_mount = mount_path.to_string();
    let archive_path_for_task = archive_path.clone();
    let manifest_path_for_task = manifest_path.clone();
    let archive_result = tokio::task::spawn_blocking(move || {
        create_archive_bundle_files(
            &archive_mount,
            &archive_path_for_task,
            &manifest_path_for_task,
            files.as_ref(),
        )
    })
    .await
    .map_err(|e| AgentError::Execution(format!("archive task panicked: {e}")))?;
    if let Err(error) = archive_result {
        record_sandbox_op("artifact_archive_create", arc_start.elapsed(), false, None);
        match error {
            ArchiveBundleError::Archive(e) => {
                log_error!(LOG_TAG, "Failed to create archive: {e}");
                return Err(AgentError::Finalization("Failed to create archive".into()));
            }
            ArchiveBundleError::Manifest(e) => {
                log_error!(LOG_TAG, "Failed to write manifest: {e}");
                return Err(AgentError::Finalization(format!(
                    "Failed to write manifest: {e}"
                )));
            }
        }
    }
    record_sandbox_op("artifact_archive_create", arc_start.elapsed(), true, None);

    Ok(ArchiveBundle {
        _temp_dir: temp_dir,
        archive_path,
        manifest_path,
    })
}

fn create_archive_bundle_files(
    mount_path: &str,
    archive_path: &Path,
    manifest_path: &Path,
    files: &[FileEntry],
) -> Result<(), ArchiveBundleError> {
    create_archive(mount_path, archive_path, files)?;
    write_manifest(manifest_path, files)?;
    Ok(())
}

fn write_manifest(manifest_path: &Path, files: &[FileEntry]) -> Result<(), ManifestWriteError> {
    let file = File::create(manifest_path).map_err(|source| ManifestWriteError::Create {
        path: manifest_path.to_owned(),
        source,
    })?;
    let mut writer = BufWriter::new(file);
    let manifest = ArtifactManifest {
        version: 1,
        files,
        created_at: guest_telemetry::log::timestamp(),
    };

    serde_json::to_writer(&mut writer, &manifest).map_err(ManifestWriteError::Serialize)?;
    writer.flush().map_err(ManifestWriteError::Flush)
}

async fn upload_archive_bundle(
    http: &HttpClient,
    uploads: &PreparedUploads,
    archive: &ArchiveBundle,
) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Uploading archive to S3...");
    let s3_start = std::time::Instant::now();
    if let Err(e) = http
        .put_presigned_file(
            &uploads.archive_url,
            &archive.archive_path,
            "application/gzip",
        )
        .await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(AgentError::Finalization(format!(
            "artifact archive upload failed: {e}"
        )));
    }

    log_info!(LOG_TAG, "Uploading manifest to S3...");
    if let Err(e) = http
        .put_presigned_file(
            &uploads.manifest_url,
            &archive.manifest_path,
            "application/json",
        )
        .await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(AgentError::Finalization(format!(
            "artifact manifest upload failed: {e}"
        )));
    }
    record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), true, None);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests;
