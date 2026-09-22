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
    let content = match crate::private_fs::read_private_file_to_string_with_max(
        &path,
        crate::private_fs::PRIVATE_STATUS_FILE_READ_MAX_BYTES,
    )
    .await
    {
        Ok(Some(content)) => content,
        Ok(None) => return Ok(None),
        Err(error) => {
            return Err(StatusFileReadError::Read { path, error });
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
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_missing_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();

        let status = read_as::<StatusForGate>(dir.path()).await.unwrap();

        assert!(status.is_none());
    }

    #[tokio::test]
    async fn read_malformed_json_returns_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("status.json"), "not json")
            .await
            .unwrap();

        let error = read_as::<StatusForGate>(dir.path()).await.unwrap_err();

        assert!(matches!(error, StatusFileReadError::ParseJson { .. }));
    }

    #[tokio::test]
    async fn read_full_writer_payload_preserves_doctor_fields() {
        let dir = tempfile::tempdir().unwrap();
        let content = r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {
                    "run_id":"0191c4e0-0000-7000-8000-000000000001",
                    "sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001",
                    "phase":"preparing",
                    "phase_started_at":"2026-04-13T00:00:01.000Z"
                }
            ],
            "idle_sandboxes": [
                {"reuse_key":"sess-1","sandbox_id":"bbbbbbbb-0000-7000-8000-000000000001"}
            ],
            "proxy_port": 8080,
            "dns_port": 5300,
            "started_at": "2026-04-13T00:00:00.000Z",
            "updated_at": "2026-04-13T00:05:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), content)
            .await
            .unwrap();

        let status = read_as::<StatusForDoctor>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(status.mode, "running");
        assert_eq!(status.started_at, "2026-04-13T00:00:00.000Z");
        assert_eq!(status.proxy_port, Some(8080));
        assert_eq!(status.dns_port, Some(5300));
        assert_eq!(status.active_runs.len(), 1);
        assert_eq!(
            status.active_runs[0].run_id,
            "0191c4e0-0000-7000-8000-000000000001"
        );
        assert_eq!(status.active_runs[0].phase, "preparing");
        assert_eq!(
            status.active_runs[0].phase_started_at,
            "2026-04-13T00:00:01.000Z"
        );
        assert_eq!(status.idle_sandboxes().len(), 1);
        assert_eq!(status.idle_sandboxes()[0].reuse_key, "sess-1");
    }

    #[tokio::test]
    async fn doctor_defaults_omitted_idle_sandboxes_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{"mode":"running","started_at":"2026-04-13T00:00:00.000Z"}"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusForDoctor>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert!(status.idle_sandboxes().is_empty());
    }

    #[tokio::test]
    async fn doctor_accepts_explicit_empty_idle_sandboxes() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{"mode":"running","started_at":"2026-04-13T00:00:00.000Z","idle_sandboxes":[]}"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusForDoctor>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert!(status.idle_sandboxes().is_empty());
    }

    #[tokio::test]
    async fn doctor_rejects_malformed_present_idle_sandboxes() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{
                "mode":"running",
                "started_at":"2026-04-13T00:00:00.000Z",
                "idle_sandboxes":null
            }"#,
        )
        .await
        .unwrap();

        let error = read_as::<StatusForDoctor>(dir.path()).await.unwrap_err();

        assert!(matches!(error, StatusFileReadError::ParseJson { .. }));
    }

    #[tokio::test]
    async fn active_runs_only_defaults_missing_active_runs_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{"mode":"running","started_at":"2026-04-13T00:00:00.000Z"}"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusActiveRunsOnly>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert!(status.active_runs.is_empty());
    }

    #[tokio::test]
    async fn gate_shape_ignores_unneeded_malformed_fields() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{
                "mode":"running",
                "active_runs":[],
                "started_at":"2026-04-13T00:00:00.000Z",
                "idle_sandboxes":null
            }"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusForGate>(dir.path()).await.unwrap().unwrap();

        assert_eq!(status.mode, "running");
    }

    #[tokio::test]
    async fn readiness_shape_reads_only_mode_and_max_concurrent() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{
                "mode":"running",
                "max_concurrent":4,
                "active_runs":null,
                "started_at":{}
            }"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusForReadiness>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(status.mode, "running");
        assert_eq!(status.max_concurrent, 4);
    }

    #[tokio::test]
    async fn active_runs_only_ignores_unneeded_malformed_top_level_fields() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{
                "mode": {},
                "active_runs": [
                    {"run_id":"run-a","sandbox_id":"sandbox-a"}
                ],
                "started_at": [],
                "idle_sandboxes": null
            }"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusActiveRunsOnly>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(status.active_runs.len(), 1);
        assert_eq!(status.active_runs[0].run_id, "run-a");
        assert_eq!(status.active_runs[0].sandbox_id, "sandbox-a");
    }

    #[tokio::test]
    async fn active_runs_only_rejects_null_active_runs() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{"mode":"running","active_runs":null}"#,
        )
        .await
        .unwrap();

        let error = read_as::<StatusActiveRunsOnly>(dir.path())
            .await
            .unwrap_err();

        assert!(matches!(error, StatusFileReadError::ParseJson { .. }));
    }

    #[tokio::test]
    async fn active_runs_only_ignores_unneeded_malformed_phase_fields() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{
                "active_runs": [
                    {
                        "run_id":"run-a",
                        "sandbox_id":"sandbox-a",
                        "phase":42,
                        "phase_started_at":{}
                    }
                ]
            }"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusActiveRunsOnly>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(status.active_runs.len(), 1);
        assert_eq!(status.active_runs[0].run_id, "run-a");
        assert_eq!(status.active_runs[0].sandbox_id, "sandbox-a");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_rejects_symlink_to_valid_status() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("outside-status.json");
        let path = dir.path().join("status.json");
        std::fs::write(
            &target,
            r#"{"mode":"running","active_runs":[],"started_at":"2026-04-13T00:00:00.000Z"}"#,
        )
        .unwrap();
        symlink(&target, &path).unwrap();

        let error = read_as::<StatusForGate>(dir.path()).await.unwrap_err();

        assert!(matches!(error, StatusFileReadError::Read { .. }));
    }
}
