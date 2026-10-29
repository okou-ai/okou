use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::error::RunnerError;
use runner_types::ids::RunId;

const STATUS_FILE_NAME: &str = "status.json";

#[derive(Debug)]
pub(crate) enum StatusFileReadError {
    Read {
        path: PathBuf,
        error: RunnerError,
    },
    ParseJson {
        path: PathBuf,
        error: serde_json::Error,
    },
}

impl std::fmt::Display for StatusFileReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read { path, error } => write!(f, "read {}: {error}", path.display()),
            Self::ParseJson { path, error } => write!(f, "parse {}: {error}", path.display()),
        }
    }
}

pub(crate) fn path(base_dir: &Path) -> PathBuf {
    base_dir.join(STATUS_FILE_NAME)
}

/// Read and deserialize `status.json` into the caller-selected wire shape.
///
/// Callers intentionally use different shapes below so fields irrelevant to one
/// command cannot make that command reject an otherwise usable status file.
pub(crate) async fn read_as<T>(base_dir: &Path) -> Result<Option<T>, StatusFileReadError>
where
    T: DeserializeOwned,
{
    let path = path(base_dir);
    let content = match runner_host::private_fs::read_private_file_to_string_with_max(
        &path,
        runner_host::private_fs::PRIVATE_STATUS_FILE_READ_MAX_BYTES,
    )
    .await
    {
        Ok(Some(content)) => content,
        Ok(None) => return Ok(None),
        Err(error) => {
            return Err(StatusFileReadError::Read {
                path,
                error: error.into(),
            });
        }
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| StatusFileReadError::ParseJson { path, error })
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusForGate {
    pub(crate) mode: String,
    // Gate intentionally requires this field so malformed active-job status
    // never looks like an empty runner.
    pub(crate) active_runs: Vec<StatusGateActiveRun>,
    pub(crate) started_at: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusForReadiness {
    pub(crate) mode: String,
    pub(crate) max_concurrent: usize,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusGateActiveRun {
    pub(crate) run_id: RunId,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusForDoctor {
    pub(crate) mode: String,
    // Defaulting collections preserves doctor reports across rolling schema
    // skew while keeping required per-entry identifiers strict.
    #[serde(default)]
    pub(crate) active_runs: Vec<StatusActiveRun>,
    pub(crate) started_at: String,
    #[serde(default)]
    idle_sandboxes: Vec<StatusIdleSandbox>,
    #[serde(default)]
    pub(crate) blank_sandboxes: Vec<StatusBlankSandbox>,
    #[serde(default)]
    pub(crate) proxy_port: Option<u16>,
    #[serde(default)]
    pub(crate) dns_port: Option<u16>,
}

impl StatusForDoctor {
    pub(crate) fn idle_sandboxes(&self) -> &[StatusIdleSandbox] {
        &self.idle_sandboxes
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusActiveRunsOnly {
    // Run resolution only needs mappings. Missing active_runs has historically
    // meant "no active runs", but malformed entries still invalidate the file.
    #[serde(default)]
    pub(crate) active_runs: Vec<StatusActiveRunMapping>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusActiveRunMapping {
    pub(crate) run_id: String,
    pub(crate) sandbox_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusActiveRun {
    pub(crate) run_id: String,
    pub(crate) sandbox_id: String,
    pub(crate) phase: String,
    pub(crate) phase_started_at: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusIdleSandbox {
    pub(crate) reuse_key: String,
    pub(crate) sandbox_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusBlankSandbox {
    pub(crate) sandbox_id: String,
}

#[cfg(test)]
mod tests;
