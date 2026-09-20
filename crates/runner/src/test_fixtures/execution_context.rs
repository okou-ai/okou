use crate::ids::RunId;
use crate::types::ExecutionContext;
use std::collections::HashMap;

pub(crate) fn execution_context_for_test(run_id: RunId) -> ExecutionContext {
    ExecutionContext {
        run_id,
        reuse_key: None,
        prompt: "test".into(),
        append_system_prompt: None,
        vars: None,
        sandbox_token: "tok".into(),
        storage_manifest: None,
        environment: None,
        platform_environment: HashMap::new(),
        resume_session: None,
        secret_values: None,
        local_secret_env_keys: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        cli_agent_type: String::new(),
        real_agent_in_preview: None,
        api_start_time: None,
        user_timezone: None,
        capture_network_bodies: None,
        firewalls: None,
        network_policies: None,
        network_policy_refreshes: None,
        connector_runtime_targets: Vec::new(),
        disallowed_tools: None,
        tools: None,
        settings: None,
        feature_flags: None,
        billable_firewalls: vec![],
        model_usage_provider: None,
        codex_runtime_config: None,
        pi_launch_config: None,
        pi_model_config: None,
        pi_session_id: None,
    }
}
