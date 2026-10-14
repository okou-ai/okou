use crate::session;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{env, io};
use uuid::Uuid;

pub(super) const MOCK_CODEX_SESSION_TIMESTAMP_ENV: &str = "MOCK_CODEX_SESSION_TIMESTAMP";

pub(super) struct InputEventContext<'a> {
    pub(super) artifact_thread_id: &'a str,
    pub(super) thread_id: &'a str,
    pub(super) turn_id: &'a str,
    pub(super) kind: &'a str,
    pub(super) thread_request_has_runtime_workspace_roots: bool,
    pub(super) thread_request_excludes_turns: bool,
    pub(super) thread_request_model: Option<&'a str>,
    pub(super) thread_request_model_provider: Option<&'a str>,
    pub(super) rollout_timestamp: &'a DateTime<Utc>,
    pub(super) turn_params: &'a Value,
}

pub(super) fn persist_input_events(
    context: &InputEventContext<'_>,
    inputs: &[String],
) -> io::Result<()> {
    let mut events = inputs
        .iter()
        .map(|text| {
            json!({
                "type": "mock.app_server.input",
                "kind": context.kind,
                "thread_id": context.thread_id,
                "turn_id": context.turn_id,
                "text": text,
                "thread_request_has_runtime_workspace_roots": context.thread_request_has_runtime_workspace_roots,
                "thread_request_excludes_turns": context.thread_request_excludes_turns,
                "thread_request_model": context.thread_request_model,
                "thread_request_model_provider": context.thread_request_model_provider,
                "turn_request_has_runtime_workspace_roots": context.turn_params.get("runtimeWorkspaceRoots").is_some(),
                "turn_request_cwd": context.turn_params.get("cwd"),
                "turn_request_effort": context.turn_params.get("effort"),
                "turn_request_approval_policy": context.turn_params.get("approvalPolicy"),
                "turn_request_approvals_reviewer": context.turn_params.get("approvalsReviewer"),
                "turn_request_sandbox_policy": context.turn_params.get("sandboxPolicy"),
                "turn_request_client_user_message_id": context.turn_params.get("clientUserMessageId"),
                "child_env_home": std::env::var("HOME").ok(),
                "child_env_api_url": std::env::var(guest_contracts::env::CANONICAL_API_URL_ENV).ok(),
                "child_env_custom_user_env": std::env::var("CUSTOM_USER_ENV").ok(),
                "child_env_openai_model": std::env::var("OPENAI_MODEL").ok(),
                "child_env_openai_base_url": std::env::var("OPENAI_BASE_URL").ok(),
                "child_env_has_pi_session_id": std::env::var_os(guest_contracts::env::PI_SESSION_ID_ENV).is_some(),
                "child_env_has_pi_launch_config": std::env::var_os(guest_contracts::env::PI_LAUNCH_CONFIG_ENV).is_some(),
                "child_env_has_pi_launch_payload_file": std::env::var_os(guest_contracts::env::PI_LAUNCH_PAYLOAD_FILE_ENV).is_some(),
                "child_env_has_pi_model_config": std::env::var_os(guest_contracts::env::PI_MODEL_CONFIG_ENV).is_some(),
            })
        })
        .collect::<Vec<_>>();
    events.extend(inputs.iter().map(|text| {
        json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": text}]
            }
        })
    }));
    let home = session::codex_home();
    session::persist_resume_session(
        &home,
        context.rollout_timestamp.to_owned(),
        context.artifact_thread_id,
        &events,
    )
}

pub(super) fn session_rollout_timestamp() -> io::Result<DateTime<Utc>> {
    let Some(value) = env::var_os(MOCK_CODEX_SESSION_TIMESTAMP_ENV) else {
        return Ok(Utc::now());
    };
    let value = value.into_string().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{MOCK_CODEX_SESSION_TIMESTAMP_ENV} must be valid UTF-8"),
        )
    })?;
    DateTime::parse_from_rfc3339(&value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
}

pub(super) fn session_artifact_thread_id(thread_id: &str) -> String {
    match Uuid::parse_str(thread_id) {
        Ok(uuid) if uuid.to_string() == thread_id => thread_id.to_string(),
        _ => Uuid::now_v7().to_string(),
    }
}
