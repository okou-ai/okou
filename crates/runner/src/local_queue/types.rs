use std::collections::HashMap;

use runner_types::ids::RunId;

/// Job request written by `runner local submit` as a `{job_id}.job` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobRequest {
    pub(crate) job_id: RunId,
    pub(crate) prompt: String,
    pub(crate) cli_agent_type: String,
    #[serde(default)]
    pub(crate) vars: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) secret_environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) user_timezone: Option<String>,
    #[serde(default)]
    pub(crate) profile: Option<String>,
    /// Enqueue-time snapshot for sandbox and workspace reuse ownership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reuse_key: Option<String>,
    /// Provider-native session ID to resume.
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) feature_flags: Option<HashMap<String, bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) active_input: Option<bool>,
}

/// Job response written by the runner as a `{job_id}.result` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JobResponse {
    pub(crate) run_id: RunId,
    pub(crate) exit_code: i32,
    pub(crate) error: Option<String>,
}

/// Active input written by local producers for a claimed live run.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveInputEntry {
    pub(crate) run_id: RunId,
    pub(crate) sequence: u64,
    pub(crate) text: String,
}
