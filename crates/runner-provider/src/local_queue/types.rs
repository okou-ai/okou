use std::collections::HashMap;

use runner_types::ids::RunId;

/// Job request written by `runner local submit` as a `{job_id}.job` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub struct JobRequest {
    pub job_id: RunId,
    pub prompt: String,
    pub cli_agent_type: String,
    #[serde(default)]
    pub vars: Option<HashMap<String, String>>,
    #[serde(default)]
    pub environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub secret_environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub user_timezone: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    /// Enqueue-time snapshot for sandbox and workspace reuse ownership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reuse_key: Option<String>,
    /// Provider-native session ID to resume.
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub feature_flags: Option<HashMap<String, bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_input: Option<bool>,
}

/// Job response written by the runner as a `{job_id}.result` file.
#[derive(serde::Deserialize, serde::Serialize)]
pub struct JobResponse {
    pub run_id: RunId,
    pub exit_code: i32,
    pub error: Option<String>,
}

/// Active input written by local producers for a claimed live run.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveInputEntry {
    pub run_id: RunId,
    pub sequence: u64,
    pub text: String,
}
