use super::{FileEntry, PiMemoryPhase2PublicationAttestation};
use crate::constants;
use crate::error::AgentError;
use crate::http::HttpClient;
use api_contracts::generated::types::webhooks::agent::storages::{
    commit as storage_commit, prepare as storage_prepare,
};
use guest_telemetry::log_warn;
use serde::Serialize;

const LOG_TAG: &str = "sandbox:guest-agent";

pub(super) struct PrepareSnapshotRequest<'a> {
    pub(super) run_id: &'a str,
    pub(super) storage_id: &'a str,
    pub(super) files: &'a [FileEntry],
    pub(super) parent_version_id: &'a str,
    pub(super) maintenance_attestation: Option<&'a PiMemoryPhase2PublicationAttestation>,
}

pub(super) struct PreparedSnapshot {
    pub(super) version_id: String,
    pub(super) existing: bool,
    pub(super) uploads: Option<PreparedUploads>,
}

pub(super) struct PreparedUploads {
    pub(super) archive_url: String,
    pub(super) manifest_url: String,
}

pub(super) struct PrepareSnapshotError {
    error: AgentError,
    telemetry_error: Option<String>,
}

impl PrepareSnapshotError {
    pub(super) fn into_parts(self) -> (AgentError, Option<String>) {
        (self.error, self.telemetry_error)
    }
}

pub(super) struct CommitSnapshotRequest<'a> {
    pub(super) run_id: &'a str,
    pub(super) storage_id: &'a str,
    pub(super) version_id: &'a str,
    pub(super) parent_version_id: &'a str,
    pub(super) files: &'a [FileEntry],
    pub(super) message: Option<&'a str>,
    pub(super) maintenance_attestation: Option<&'a PiMemoryPhase2PublicationAttestation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareSnapshotPayload<'a> {
    run_id: &'a str,
    storage_id: &'a str,
    files: &'a [FileEntry],
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_version_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maintenance_attestation: Option<&'a PiMemoryPhase2PublicationAttestation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitSnapshotPayload<'a> {
    run_id: &'a str,
    storage_id: &'a str,
    version_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_version_id: Option<&'a str>,
    files: &'a [FileEntry],
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maintenance_attestation: Option<&'a PiMemoryPhase2PublicationAttestation>,
}

pub(super) async fn prepare_snapshot(
    http: &HttpClient,
    request: PrepareSnapshotRequest<'_>,
) -> Result<PreparedSnapshot, PrepareSnapshotError> {
    let payload = PrepareSnapshotPayload {
        run_id: request.run_id,
        storage_id: request.storage_id,
        files: request.files,
        parent_version_id: non_empty_str(request.parent_version_id),
        maintenance_attestation: request.maintenance_attestation,
    };

    let url = http
        .storage_prepare_url()
        .map_err(|error| PrepareSnapshotError {
            error,
            telemetry_error: None,
        })?;
    let response = match http
        .post_json(url, &payload, constants::HTTP_MAX_ATTEMPTS)
        .await
    {
        Ok(Some(value)) => value,
        Ok(None) => {
            return Err(PrepareSnapshotError {
                error: AgentError::Finalization("Empty prepare response".into()),
                telemetry_error: None,
            });
        }
        Err(error) => {
            return Err(PrepareSnapshotError {
                error,
                telemetry_error: None,
            });
        }
    };

    let response: storage_prepare::Response =
        serde_json::from_value(response).map_err(|error| {
            let message = error.to_string();
            PrepareSnapshotError {
                error: AgentError::Finalization(message.clone()),
                telemetry_error: Some(message),
            }
        })?;

    Ok(PreparedSnapshot {
        version_id: response.version_id,
        existing: response.existing,
        uploads: response.uploads.map(|uploads| PreparedUploads {
            archive_url: uploads.archive.presigned_url,
            manifest_url: uploads.manifest.presigned_url,
        }),
    })
}

pub(super) async fn commit_snapshot(
    http: &HttpClient,
    request: CommitSnapshotRequest<'_>,
    parse_error_log: &str,
) -> Result<bool, AgentError> {
    let payload = CommitSnapshotPayload {
        run_id: request.run_id,
        storage_id: request.storage_id,
        version_id: request.version_id,
        parent_version_id: non_empty_str(request.parent_version_id),
        files: request.files,
        message: request.message,
        maintenance_attestation: request.maintenance_attestation,
    };

    let url = http.storage_commit_url()?;
    let response = http
        .post_json(url, &payload, constants::HTTP_MAX_ATTEMPTS)
        .await?;

    Ok(response
        .map(|value| {
            serde_json::from_value::<storage_commit::Response>(value)
                .map(|commit| commit.success)
                .unwrap_or_else(|error| {
                    log_warn!(LOG_TAG, "{parse_error_log}: {error}");
                    false
                })
        })
        .unwrap_or(false))
}

fn non_empty_str(value: &str) -> Option<&str> {
    if value.is_empty() { None } else { Some(value) }
}
