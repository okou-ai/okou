//! File outcomes describe final publication separately from possible staging residue.

use runner_rpc_proto::stream::{MAX_DURATION_MS, MAX_STREAM_BYTES};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::super::FailureReason;

pub(super) const CAPACITY: usize = 2;
pub(super) const PATH_BYTES: usize = 4096;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Direction {
    Upload,
    Download,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Upload {
    pub(super) ssh_connection_id: String,
    pub(super) remote_path: String,
    pub(super) size: u64,
    pub(super) overwrite: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Download {
    pub(super) ssh_connection_id: String,
    pub(super) remote_path: String,
}

pub(super) struct Request {
    pub(super) direction: Direction,
    pub(super) connection: Uuid,
    pub(super) path: String,
    pub(super) size: Option<u64>,
    pub(super) overwrite: bool,
}

impl Request {
    pub(super) fn parse(method: &str, json: &str) -> Option<Self> {
        let (direction, id, path, size, overwrite) = match method {
            "ssh.file.upload" => {
                let p: Upload = serde_json::from_str(json).ok()?;
                (
                    Direction::Upload,
                    p.ssh_connection_id,
                    p.remote_path,
                    Some(p.size),
                    p.overwrite,
                )
            }
            "ssh.file.download" => {
                let p: Download = serde_json::from_str(json).ok()?;
                (
                    Direction::Download,
                    p.ssh_connection_id,
                    p.remote_path,
                    None,
                    false,
                )
            }
            _ => return None,
        };
        if id.len() != 36 || !valid_path(&path) {
            return None;
        }
        Some(Self {
            direction,
            connection: id.parse().ok()?,
            path,
            size,
            overwrite,
        })
    }
}

pub(super) fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= PATH_BYTES
        && !path.contains('\0')
        && !matches!(path.rsplit('/').next(), None | Some("" | "." | ".."))
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(untagged)]
pub(super) enum Failure {
    Ssh(FailureReason),
    File(FileFailure),
}

impl From<FailureReason> for Failure {
    fn from(value: FailureReason) -> Self {
        Self::Ssh(value)
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum FileFailure {
    InvalidPath,
    FileTooLarge,
    TransferLimit,
    PathNotFound,
    PermissionDenied,
    DestinationExists,
    NotRegularFile,
    SourceChanged,
    SubsystemUnavailable,
    UnsupportedOperation,
    FileOperationFailed,
}

impl From<FileFailure> for Failure {
    fn from(value: FileFailure) -> Self {
        Self::File(value)
    }
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Effects {
    NotStarted,
    Unknown,
    Completed,
}

#[derive(Serialize)]
pub(super) struct Limits {
    max_file_bytes: u64,
    timeout_ms: u64,
    max_concurrent_transfers: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: MAX_STREAM_BYTES,
            timeout_ms: MAX_DURATION_MS,
            max_concurrent_transfers: CAPACITY,
        }
    }
}

#[derive(Serialize)]
pub(super) struct Outcome {
    #[serde(rename = "type")]
    pub(super) kind: &'static str,
    pub(super) direction: Direction,
    pub(super) ssh_connection_id: Uuid,
    pub(super) bytes: u64,
    pub(super) sha256: Option<String>,
    pub(super) effects: Effects,
    pub(super) failure_reason: Option<Failure>,
    pub(super) residue: Option<String>,
    pub(super) actual_bytes: Option<u64>,
    pub(super) limits: Limits,
}

impl Outcome {
    pub(super) fn new(request: &Request) -> Self {
        Self {
            kind: "failed",
            direction: request.direction,
            ssh_connection_id: request.connection,
            bytes: 0,
            sha256: None,
            effects: Effects::NotStarted,
            failure_reason: None,
            residue: None,
            actual_bytes: request.size,
            limits: Limits::default(),
        }
    }
}
