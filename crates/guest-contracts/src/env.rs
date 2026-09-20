//! Runner-to-guest environment variable name contract.
//!
//! The runner uses these names to bootstrap the guest-agent process. User,
//! model-provider, and connector environment is a separate payload loaded
//! through [`CANONICAL_USER_ENV_FILE_ENV`], so user-provided keys cannot override runner
//! bootstrap controls directly.
//!
//! The `OKOU_` namespace is runner-owned, including keys defined in sibling
//! modules such as [`crate::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV`].
//! User env filtering protects every current and future `OKOU_` key. Bootstrap
//! keys outside that namespace are classified explicitly below.

/// Canonical backend API URL spelling written by the production Runner, read at
/// Guest root bootstrap, and exposed to managed CLI children.
pub const CANONICAL_API_URL_ENV: &str = "OKOU_API_BACKEND_URL";

/// Stable run identifier used by guest-agent logs, telemetry, and runtime
/// file path resolution.
pub const RUN_ID_ENV: &str = "OKOU_RUN_ID";

/// Sensitive backend API bearer token for guest-agent calls.
///
/// This value is runner-owned and must not be exposed through user-provided
/// environment or CLI child env.
pub const CANONICAL_API_TOKEN_ENV: &str = "OKOU_API_TOKEN";

/// Sandbox identifier assigned and written by the runner.
pub const CANONICAL_SANDBOX_ID_ENV: &str = "OKOU_SANDBOX_ID";

/// Wire value for the runner's sandbox-reuse decision.
///
/// `reused` means an idle sandbox was unparked. Other values describe why reuse did
/// not happen, such as `poolMiss` or `noReuseKey`.
pub const CANONICAL_SANDBOX_REUSE_RESULT_ENV: &str = "OKOU_SANDBOX_REUSE_RESULT";

/// Wire value for the runner's final workspace-reuse decision.
pub const CANONICAL_WORKSPACE_REUSE_RESULT_ENV: &str = "OKOU_WORKSPACE_REUSE_RESULT";

/// Logical run-payload field name for the user prompt.
pub const PROMPT_RUN_PAYLOAD_FIELD: &str = "OKOU_PROMPT";

/// Logical run-payload field name for optional extra system prompt text.
///
/// Unset or empty means there is no extra system prompt.
pub const APPEND_SYSTEM_PROMPT_RUN_PAYLOAD_FIELD: &str = "OKOU_APPEND_SYSTEM_PROMPT";

/// Sensitive Vercel protection bypass secret for guest API calls.
///
/// This runner-owned bootstrap key intentionally does not use the `OKOU_`
/// prefix because the guest-agent HTTP client uses this established name to
/// attach the Vercel bypass header. The runner omits this key when no bypass
/// secret is configured.
pub const VERCEL_PROTECTION_BYPASS_ENV: &str = "VERCEL_PROTECTION_BYPASS";

/// Optional CLI session or thread identifier used when resuming a prior agent
/// session.
///
/// The runner normalizes Codex thread ids before emitting this key.
pub const CANONICAL_RESUME_SESSION_ID_ENV: &str = "OKOU_RESUME_SESSION_ID";

/// Optional Unix epoch millisecond timestamp for when the API accepted the
/// run.
///
/// The runner emits an empty string when the timestamp is unavailable.
pub const CANONICAL_API_START_TIME_ENV: &str = "OKOU_API_START_TIME";

/// Maximum agent execution duration in seconds, written by the runner.
///
/// The runner owns this fixed lifecycle budget. Guest-agent uses it to stop
/// the CLI before the later sandbox supervisor deadline, leaving time for
/// recovery checkpointing and final telemetry. It is intentionally not a
/// local user-tuning key.
pub const CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV: &str = "OKOU_AGENT_EXECUTION_TIMEOUT_SECS";

/// Logical run-payload field name for sensitive values used by the guest-agent
/// masker.
///
/// The payload is a comma-separated list of base64-encoded secret values, not
/// secret names. The runner includes the sandbox token so event payloads and
/// CLI diagnostics can redact it.
pub const SECRET_VALUES_RUN_PAYLOAD_FIELD: &str = "OKOU_SECRET_VALUES";

/// Logical run-payload field name for comma-separated Claude Code tool names
/// that should be disallowed.
///
/// Unset or empty means there is no explicit deny list.
pub const DISALLOWED_TOOLS_RUN_PAYLOAD_FIELD: &str = "OKOU_DISALLOWED_TOOLS";

/// Logical run-payload field name for comma-separated Claude Code tool names
/// that should be allowed.
///
/// Unset or empty means there is no explicit allow list.
pub const TOOLS_RUN_PAYLOAD_FIELD: &str = "OKOU_TOOLS";

/// Logical run-payload field name for the raw Claude Code settings payload
/// passed to the guest-agent.
///
/// The runner treats this as an opaque string. Unset or empty means there is no
/// settings override.
pub const SETTINGS_RUN_PAYLOAD_FIELD: &str = "OKOU_SETTINGS";

/// CLI framework selector, for example `claude-code` or `codex`.
///
/// This runner-owned bootstrap key intentionally does not use the `OKOU_`
/// prefix because the runner and guest-agent framework selection contract uses
/// this exact name.
pub const CLI_AGENT_TYPE_ENV: &str = "CLI_AGENT_TYPE";

/// Canonical CLI framework selected by [`CLI_AGENT_TYPE_ENV`].
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum CliFramework {
    /// Anthropic Claude Code.
    ClaudeCode,
    /// OpenAI Codex CLI.
    Codex,
    /// Pi native agent loop.
    Pi,
}

impl CliFramework {
    /// Return the stable selector spelling used by [`CLI_AGENT_TYPE_ENV`].
    #[must_use]
    pub const fn as_cli_agent_type(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }
}

/// Parsed [`CLI_AGENT_TYPE_ENV`] selection shared by runner and guest-agent.
///
/// Unknown non-empty values remain available through
/// [`Self::normalized_cli_agent_type`] while selecting Claude Code effectively.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CliAgentTypeSelection<'a> {
    framework: CliFramework,
    normalized_cli_agent_type: &'a str,
    unknown: bool,
}

impl<'a> CliAgentTypeSelection<'a> {
    /// Parse a raw CLI framework selector.
    ///
    /// Empty input selects and normalizes to Claude Code without being marked
    /// unknown. Unknown non-empty input remains unchanged for transport, is
    /// marked unknown, and also selects Claude Code effectively.
    #[must_use]
    pub fn parse(value: &'a str) -> Self {
        match value {
            "" => Self {
                framework: CliFramework::ClaudeCode,
                normalized_cli_agent_type: CliFramework::ClaudeCode.as_cli_agent_type(),
                unknown: false,
            },
            "claude-code" => Self {
                framework: CliFramework::ClaudeCode,
                normalized_cli_agent_type: value,
                unknown: false,
            },
            "codex" => Self {
                framework: CliFramework::Codex,
                normalized_cli_agent_type: value,
                unknown: false,
            },
            "pi" => Self {
                framework: CliFramework::Pi,
                normalized_cli_agent_type: value,
                unknown: false,
            },
            _ => Self {
                framework: CliFramework::ClaudeCode,
                normalized_cli_agent_type: value,
                unknown: true,
            },
        }
    }

    /// Return the effective framework after applying fallback semantics.
    #[must_use]
    pub const fn framework(self) -> CliFramework {
        self.framework
    }

    /// Return the selector spelling transported to downstream consumers.
    #[must_use]
    pub const fn normalized_cli_agent_type(self) -> &'a str {
        self.normalized_cli_agent_type
    }

    /// Return whether the raw non-empty selector was unknown.
    #[must_use]
    pub const fn is_unknown(self) -> bool {
        self.unknown
    }
}

/// Canonical private user-environment file pointer written by the runner.
///
/// The guest-agent validates that the path points at its per-run private
/// runtime directory, parses it as a `HashMap<String, String>`, and removes the
/// file after loading. Unset or empty means there is no user environment
/// payload.
pub const CANONICAL_USER_ENV_FILE_ENV: &str = "OKOU_USER_ENV_FILE";

/// Private runtime subdirectory used by [`CANONICAL_USER_ENV_FILE_ENV`].
pub const USER_ENV_PRIVATE_DIR_NAME: &str = "user-env";

/// Private runtime filename used by [`CANONICAL_USER_ENV_FILE_ENV`].
pub const USER_ENV_FILENAME: &str = "env.json";

/// Path to the non-secret connector account context for the current run.
///
/// The runner adds this key to the filtered user environment after removing
/// untrusted runner-owned keys. Managed CLI children may read the referenced
/// file for self-inspection; authorization does not consume it.
pub const CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV: &str = "OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE";

/// Private runtime subdirectory used by [`CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV`].
pub const CONNECTOR_ACCOUNT_CONTEXT_PRIVATE_DIR_NAME: &str = "connector-account-context";

/// Private runtime filename used by [`CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV`].
pub const CONNECTOR_ACCOUNT_CONTEXT_FILENAME: &str = "context.json";

/// Canonical private runner-owned run-payload file pointer written by the runner.
///
/// Large prompt-like and configuration payloads use this file instead of
/// bootstrap environment values so guest-agent startup does not hit Linux
/// argv/env limits. Production guest-agent startup requires this pointer.
pub const CANONICAL_RUN_PAYLOAD_FILE_ENV: &str = "OKOU_RUN_PAYLOAD_FILE";

/// Private runtime subdirectory used by [`CANONICAL_RUN_PAYLOAD_FILE_ENV`].
pub const RUN_PAYLOAD_PRIVATE_DIR_NAME: &str = "run-payload";

/// Private runtime filename used by [`CANONICAL_RUN_PAYLOAD_FILE_ENV`].
pub const RUN_PAYLOAD_FILENAME: &str = "payload.json";

/// Logical run-payload field name for the JSON array describing artifact mounts
/// prepared by the runner.
///
/// Each entry uses camelCase wire keys: `name`, `mountPath`, `storageId`,
/// `versionId`, and optional `missingRootPolicy`. Unset or empty means there
/// are no artifact mounts.
pub const ARTIFACTS_RUN_PAYLOAD_FIELD: &str = "OKOU_ARTIFACTS";

/// One artifact mount in the runner-to-guest run payload.
///
/// The complete artifact list is serialized as a JSON array inside
/// [`RunPayload::artifacts`].
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArtifact {
    /// VAS storage name reported in artifact checkpoint snapshots.
    pub name: String,
    /// Absolute guest path containing the mounted artifact.
    pub mount_path: String,
    /// VAS storage identifier used to recompute the artifact content hash.
    pub storage_id: String,
    /// VAS version identifier mounted at startup.
    pub version_id: String,
    /// Behavior when the artifact root is absent during checkpointing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_root_policy: Option<RunArtifactMissingRootPolicy>,
}

/// Runner-to-guest policy for an artifact root missing during checkpointing.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunArtifactMissingRootPolicy {
    /// Treat the missing artifact root as a checkpoint error.
    Fail,
    /// Preserve the artifact version mounted at startup.
    PreserveParentVersion,
}

/// Logical run-payload field name for the JSON map of feature flag names to
/// enabled states.
///
/// Unset or empty means there are no feature flags.
pub const FEATURE_FLAGS_RUN_PAYLOAD_FIELD: &str = "OKOU_FEATURE_FLAGS";

/// Logical run-payload field name for API-owned Codex runtime metadata.
pub const CODEX_RUNTIME_CONFIG_RUN_PAYLOAD_FIELD: &str = "OKOU_CODEX_RUNTIME_CONFIG";

/// Runner-owned bootstrap key reserved for the schema-v2 Pi launch config
/// marker.
///
/// The value is the serialized `{"schemaVersion":2}` version marker. Pi's
/// runtime resources are discovered from canonical filesystem locations by the
/// official loader. The value never reaches the Pi CLI child as an environment
/// value; the guest-agent republishes it through
/// [`PI_LAUNCH_PAYLOAD_FILE_ENV`]. The name is still classified as an env key
/// so user env carrying it is scrubbed before the guest-agent starts. See
/// `piLaunchConfigSchema` in
/// `turbo/packages/api-contracts/src/contracts/runners.ts` for the canonical
/// wire schema.
pub const PI_LAUNCH_CONFIG_ENV: &str = "OKOU_PI_LAUNCH_CONFIG";

/// Logical run-payload field name for the schema-v2 Pi launch config marker.
///
/// Same spelling as the reserved bootstrap key [`PI_LAUNCH_CONFIG_ENV`]; this
/// alias names the [`RunPayload::fields`] role so diagnostics read as payload
/// fields rather than environment keys.
pub const PI_LAUNCH_CONFIG_RUN_PAYLOAD_FIELD: &str = PI_LAUNCH_CONFIG_ENV;

/// Path to the private guest-agent-owned Pi launch payload JSON file.
///
/// Prompt-sized Pi launch inputs use this file instead of the child's argv or
/// environment. The guest-agent writes it inside the per-run private runtime
/// directory before spawning its own Pi CLI. See `piLaunchPayloadSchema` in
/// `turbo/packages/api-contracts/src/contracts/runners.ts` for the reader side.
pub const PI_LAUNCH_PAYLOAD_FILE_ENV: &str = "OKOU_PI_LAUNCH_PAYLOAD_FILE";

/// Private runtime subdirectory used by [`PI_LAUNCH_PAYLOAD_FILE_ENV`].
pub const PI_LAUNCH_PAYLOAD_PRIVATE_DIR_NAME: &str = "pi-launch-payload";

/// Private runtime filename used by [`PI_LAUNCH_PAYLOAD_FILE_ENV`].
pub const PI_LAUNCH_PAYLOAD_FILENAME: &str = "payload.json";

/// Runner-owned bootstrap key carrying non-secret Pi model metadata into the
/// Pi CLI child environment.
pub const PI_MODEL_CONFIG_ENV: &str = "OKOU_PI_MODEL_CONFIG";

/// Logical run-payload field name for non-secret Pi model metadata.
///
/// Same spelling as the bootstrap key [`PI_MODEL_CONFIG_ENV`]; this alias
/// names the [`RunPayload::fields`] role so diagnostics read as payload fields
/// rather than environment keys.
pub const PI_MODEL_CONFIG_RUN_PAYLOAD_FIELD: &str = PI_MODEL_CONFIG_ENV;

/// Runner-owned bootstrap key carrying the Chat Thread-owned Pi session id
/// into the Pi CLI child environment.
pub const PI_SESSION_ID_ENV: &str = "OKOU_PI_SESSION_ID";

/// Logical run-payload field name for the Chat Thread-owned Pi session id.
///
/// Same spelling as the bootstrap key [`PI_SESSION_ID_ENV`]; this alias names
/// the [`RunPayload::fields`] role so diagnostics read as payload fields
/// rather than environment keys.
pub const PI_SESSION_ID_RUN_PAYLOAD_FIELD: &str = PI_SESSION_ID_ENV;

/// Runner-owned variable-length run payload sent through
/// [`CANONICAL_RUN_PAYLOAD_FILE_ENV`].
///
/// Empty strings mean "no value" for optional fields.
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPayload {
    /// User prompt payload sent to the guest-agent.
    pub prompt: String,
    /// Optional extra system prompt text.
    #[serde(default)]
    pub append_system_prompt: String,
    /// Sensitive values used by the guest-agent masker.
    #[serde(default)]
    pub secret_values: String,
    /// Comma-separated Claude Code tool names that should be disallowed.
    #[serde(default)]
    pub disallowed_tools: String,
    /// Comma-separated Claude Code tool names that should be allowed.
    #[serde(default)]
    pub tools: String,
    /// Raw Claude Code settings payload passed to the guest-agent.
    #[serde(default)]
    pub settings: String,
    /// JSON array describing artifact mounts prepared by the runner.
    #[serde(default)]
    pub artifacts: String,
    /// JSON map of feature flag names to enabled states.
    #[serde(default)]
    pub feature_flags: String,
    /// JSON object describing API-owned Codex provider/runtime metadata.
    #[serde(default)]
    pub codex_runtime_config: String,
    /// Serialized schema-v2 Pi launch config marker.
    #[serde(default)]
    pub pi_launch_config: String,
    /// JSON object describing non-secret Pi model metadata.
    #[serde(default)]
    pub pi_model_config: String,
    /// Chat Thread id used as Pi's native session id.
    #[serde(default)]
    pub pi_session_id: String,
}

/// Borrowed logical string field from [`RunPayload`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunPayloadField<'a> {
    /// Logical field name used in diagnostics.
    pub name: &'static str,
    /// Field value carried in the run payload.
    pub value: &'a str,
}

impl RunPayload {
    /// Return all logical string fields carried by this run payload.
    pub fn fields(&self) -> [RunPayloadField<'_>; 12] {
        let Self {
            prompt,
            append_system_prompt,
            secret_values,
            disallowed_tools,
            tools,
            settings,
            artifacts,
            feature_flags,
            codex_runtime_config,
            pi_launch_config,
            pi_model_config,
            pi_session_id,
        } = self;

        [
            RunPayloadField {
                name: PROMPT_RUN_PAYLOAD_FIELD,
                value: prompt,
            },
            RunPayloadField {
                name: APPEND_SYSTEM_PROMPT_RUN_PAYLOAD_FIELD,
                value: append_system_prompt,
            },
            RunPayloadField {
                name: SECRET_VALUES_RUN_PAYLOAD_FIELD,
                value: secret_values,
            },
            RunPayloadField {
                name: DISALLOWED_TOOLS_RUN_PAYLOAD_FIELD,
                value: disallowed_tools,
            },
            RunPayloadField {
                name: TOOLS_RUN_PAYLOAD_FIELD,
                value: tools,
            },
            RunPayloadField {
                name: SETTINGS_RUN_PAYLOAD_FIELD,
                value: settings,
            },
            RunPayloadField {
                name: ARTIFACTS_RUN_PAYLOAD_FIELD,
                value: artifacts,
            },
            RunPayloadField {
                name: FEATURE_FLAGS_RUN_PAYLOAD_FIELD,
                value: feature_flags,
            },
            RunPayloadField {
                name: CODEX_RUNTIME_CONFIG_RUN_PAYLOAD_FIELD,
                value: codex_runtime_config,
            },
            RunPayloadField {
                name: PI_LAUNCH_CONFIG_RUN_PAYLOAD_FIELD,
                value: pi_launch_config,
            },
            RunPayloadField {
                name: PI_MODEL_CONFIG_RUN_PAYLOAD_FIELD,
                value: pi_model_config,
            },
            RunPayloadField {
                name: PI_SESSION_ID_RUN_PAYLOAD_FIELD,
                value: pi_session_id,
            },
        ]
    }

    /// Return the first logical field name whose value contains a NUL byte.
    pub fn first_nul_field(&self) -> Option<&'static str> {
        self.fields()
            .into_iter()
            .find(|field| field.value.contains('\0'))
            .map(|field| field.name)
    }
}

/// Canonical Guest Agent stuck-tool timeout bootstrap key.
///
/// The Guest Agent parses the value as `u64`; unset or unparseable values use
/// the compiled default.
pub const CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV: &str = "OKOU_STUCK_TOOL_TIMEOUT_SECS";

/// Canonical Guest Agent post-result SIGTERM grace bootstrap key.
///
/// Unset, unparseable, or out-of-range values use the Guest Agent's compiled
/// default.
pub const CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV: &str =
    "OKOU_POST_RESULT_SIGTERM_GRACE_SECS";

/// Canonical Guest Agent post-result total-cap bootstrap key.
///
/// The value is the absolute cap before SIGTERM after the CLI reports a final
/// result. Unset, unparseable, or out-of-range values use the Guest Agent's
/// compiled default.
pub const CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV: &str = "OKOU_POST_RESULT_TOTAL_CAP_SECS";

/// Canonical Guest Agent post-result SIGKILL grace bootstrap key.
///
/// Unset, unparseable, or out-of-range values use the Guest Agent's compiled
/// default.
pub const CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV: &str =
    "OKOU_POST_RESULT_SIGKILL_GRACE_SECS";

/// Test/debug bootstrap switch that makes the guest-agent use the mock Claude
/// binary.
///
/// This runner-owned bootstrap key intentionally does not use the `OKOU_`
/// prefix because the mock launcher contract uses this exact name. The
/// guest-agent treats exactly `true` as enabled.
pub const USE_MOCK_CLAUDE_ENV: &str = "USE_MOCK_CLAUDE";

/// Test/debug bootstrap switch that makes the guest-agent use the mock Codex
/// binary.
///
/// This runner-owned bootstrap key intentionally does not use the `OKOU_`
/// prefix because the mock launcher contract uses this exact name. The
/// guest-agent treats `true` or `1` as enabled.
pub const USE_MOCK_CODEX_ENV: &str = "USE_MOCK_CODEX";

/// Optional test/debug override for the mock Claude binary path.
///
/// Unset means the guest-agent uses its compiled default mock binary path.
pub const CANONICAL_MOCK_CLAUDE_PATH_ENV: &str = "OKOU_MOCK_CLAUDE_PATH";

/// Optional test/debug override for the mock Codex binary path.
///
/// Unset means the guest-agent uses its compiled default mock binary path.
pub const CANONICAL_MOCK_CODEX_PATH_ENV: &str = "OKOU_MOCK_CODEX_PATH";

const EXPLICIT_RUNNER_OWNED_ENV_KEYS: &[&str] = &[
    RUN_ID_ENV,
    CANONICAL_SANDBOX_ID_ENV,
    CANONICAL_SANDBOX_REUSE_RESULT_ENV,
    CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
    CANONICAL_API_START_TIME_ENV,
    PI_SESSION_ID_ENV,
    PI_LAUNCH_CONFIG_ENV,
    PI_LAUNCH_PAYLOAD_FILE_ENV,
    PI_MODEL_CONFIG_ENV,
    CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV,
    CLI_AGENT_TYPE_ENV,
    USE_MOCK_CLAUDE_ENV,
    USE_MOCK_CODEX_ENV,
    VERCEL_PROTECTION_BYPASS_ENV,
];

const ENV_KEY_DIAGNOSTIC_MAX_CHARS: usize = 128;

/// Returns whether `key` is supported by guest shell exec env injection.
///
/// This is the shell identifier format accepted by the guest env script's
/// `export KEY=VALUE` lines. It is intentionally not a general definition of
/// every environment variable name an operating system can carry.
pub fn is_shell_identifier_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// Returns whether `key` belongs to the runner-owned bootstrap namespace.
///
/// This covers every `OKOU_` key and the explicit bootstrap keys required by
/// established runner, guest-agent, or integration contracts. Runner and
/// local-submit code use this predicate to scrub or reject those keys before
/// the guest-agent starts.
pub fn is_runner_owned_env_key(key: &str) -> bool {
    key.starts_with("OKOU_") || EXPLICIT_RUNNER_OWNED_ENV_KEYS.contains(&key)
}

/// Escapes and bounds an environment key for diagnostics.
///
/// The returned string contains `escape_debug` output truncated to 128
/// characters, with `...` appended when truncation happens. This keeps control
/// characters and very long keys from producing confusing errors or log lines.
pub fn sanitize_env_key_for_diagnostic(key: &str) -> String {
    let mut chars = key.escape_debug();
    let mut truncated = String::new();
    for _ in 0..ENV_KEY_DIAGNOSTIC_MAX_CHARS {
        let Some(ch) = chars.next() else {
            return truncated;
        };
        truncated.push(ch);
    }
    if chars.next().is_some() {
        truncated.push_str("...");
    }
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_agent_type_selection_covers_known_empty_and_unknown_values() {
        for (value, framework) in [
            ("claude-code", CliFramework::ClaudeCode),
            ("codex", CliFramework::Codex),
            ("pi", CliFramework::Pi),
        ] {
            let selection = CliAgentTypeSelection::parse(value);

            assert_eq!(selection.framework(), framework);
            assert_eq!(selection.normalized_cli_agent_type(), value);
            assert!(!selection.is_unknown());
            assert_eq!(framework.as_cli_agent_type(), value);
        }

        let empty = CliAgentTypeSelection::parse("");
        assert_eq!(empty.framework(), CliFramework::ClaudeCode);
        assert_eq!(empty.normalized_cli_agent_type(), "claude-code");
        assert!(!empty.is_unknown());

        let unknown = CliAgentTypeSelection::parse("custom-agent");
        assert_eq!(unknown.framework(), CliFramework::ClaudeCode);
        assert_eq!(unknown.normalized_cli_agent_type(), "custom-agent");
        assert!(unknown.is_unknown());
    }

    #[test]
    fn run_artifacts_round_trip_with_and_without_missing_root_policy() {
        let artifacts = vec![
            RunArtifact {
                name: "plain".to_string(),
                mount_path: "/plain".to_string(),
                storage_id: "storage-plain".to_string(),
                version_id: "version-plain".to_string(),
                missing_root_policy: None,
            },
            RunArtifact {
                name: "memory".to_string(),
                mount_path: "/memory".to_string(),
                storage_id: "storage-memory".to_string(),
                version_id: "version-memory".to_string(),
                missing_root_policy: Some(RunArtifactMissingRootPolicy::PreserveParentVersion),
            },
        ];

        let json = serde_json::to_value(&artifacts).unwrap();

        assert_eq!(
            json,
            serde_json::json!([
                {
                    "name": "plain",
                    "mountPath": "/plain",
                    "storageId": "storage-plain",
                    "versionId": "version-plain"
                },
                {
                    "name": "memory",
                    "mountPath": "/memory",
                    "storageId": "storage-memory",
                    "versionId": "version-memory",
                    "missingRootPolicy": "preserveParentVersion"
                }
            ])
        );
        assert_eq!(
            serde_json::from_value::<Vec<RunArtifact>>(json).unwrap(),
            artifacts
        );
    }

    #[test]
    fn run_artifact_requires_all_string_fields() {
        let artifact = serde_json::json!({
            "name": "artifact",
            "mountPath": "/artifact",
            "storageId": "storage",
            "versionId": "version"
        });

        for field in ["name", "mountPath", "storageId", "versionId"] {
            let mut missing = artifact.clone();
            missing.as_object_mut().unwrap().remove(field);

            assert!(serde_json::from_value::<RunArtifact>(missing).is_err());
        }
    }

    #[test]
    fn contract_names_match_wire_values() {
        assert_eq!(CANONICAL_API_URL_ENV, "OKOU_API_BACKEND_URL");
        assert_eq!(RUN_ID_ENV, "OKOU_RUN_ID");
        assert_eq!(CANONICAL_API_TOKEN_ENV, "OKOU_API_TOKEN");
        assert_eq!(CANONICAL_SANDBOX_ID_ENV, "OKOU_SANDBOX_ID");
        assert_eq!(
            CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "OKOU_SANDBOX_REUSE_RESULT"
        );
        assert_eq!(
            CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
            "OKOU_WORKSPACE_REUSE_RESULT"
        );
        assert_eq!(CANONICAL_RESUME_SESSION_ID_ENV, "OKOU_RESUME_SESSION_ID");
        assert_eq!(CANONICAL_API_START_TIME_ENV, "OKOU_API_START_TIME");
        assert_eq!(PI_SESSION_ID_ENV, "OKOU_PI_SESSION_ID");
        assert_eq!(PI_LAUNCH_CONFIG_ENV, "OKOU_PI_LAUNCH_CONFIG");
        assert_eq!(PI_LAUNCH_PAYLOAD_FILE_ENV, "OKOU_PI_LAUNCH_PAYLOAD_FILE");
        assert_eq!(PI_LAUNCH_PAYLOAD_PRIVATE_DIR_NAME, "pi-launch-payload");
        assert_eq!(PI_LAUNCH_PAYLOAD_FILENAME, "payload.json");
        assert_eq!(PI_MODEL_CONFIG_ENV, "OKOU_PI_MODEL_CONFIG");
        assert_eq!(CLI_AGENT_TYPE_ENV, "CLI_AGENT_TYPE");
        assert_eq!(
            CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "OKOU_AGENT_EXECUTION_TIMEOUT_SECS"
        );
        assert_eq!(CANONICAL_USER_ENV_FILE_ENV, "OKOU_USER_ENV_FILE");
        assert_eq!(USER_ENV_PRIVATE_DIR_NAME, "user-env");
        assert_eq!(USER_ENV_FILENAME, "env.json");
        assert_eq!(
            CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV,
            "OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE"
        );
        assert_eq!(
            CONNECTOR_ACCOUNT_CONTEXT_PRIVATE_DIR_NAME,
            "connector-account-context"
        );
        assert_eq!(CONNECTOR_ACCOUNT_CONTEXT_FILENAME, "context.json");
        assert_eq!(CANONICAL_RUN_PAYLOAD_FILE_ENV, "OKOU_RUN_PAYLOAD_FILE");
        assert_eq!(RUN_PAYLOAD_PRIVATE_DIR_NAME, "run-payload");
        assert_eq!(RUN_PAYLOAD_FILENAME, "payload.json");
        assert_eq!(
            CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
            "OKOU_STUCK_TOOL_TIMEOUT_SECS"
        );
        assert_eq!(
            CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "OKOU_POST_RESULT_SIGTERM_GRACE_SECS"
        );
        assert_eq!(
            CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "OKOU_POST_RESULT_TOTAL_CAP_SECS"
        );
        assert_eq!(
            CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "OKOU_POST_RESULT_SIGKILL_GRACE_SECS"
        );
        assert_eq!(CANONICAL_MOCK_CLAUDE_PATH_ENV, "OKOU_MOCK_CLAUDE_PATH");
        assert_eq!(CANONICAL_MOCK_CODEX_PATH_ENV, "OKOU_MOCK_CODEX_PATH");
    }

    #[test]
    fn run_payload_uses_camel_case_wire_keys() {
        let payload = RunPayload {
            prompt: "hello".to_string(),
            append_system_prompt: "system".to_string(),
            secret_values: "secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts: "[]".to_string(),
            feature_flags: r#"{"flag":true}"#.to_string(),
            codex_runtime_config: r#"{"providerId":"deepseek"}"#.to_string(),
            pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
            pi_model_config: r#"{"provider":"deepseek"}"#.to_string(),
            pi_session_id: "22222222-2222-4222-8222-222222222222".to_string(),
        };

        let json = serde_json::to_value(&payload).unwrap();

        assert_eq!(json["prompt"], "hello");
        assert_eq!(json["appendSystemPrompt"], "system");
        assert_eq!(json["secretValues"], "secret");
        assert_eq!(json["disallowedTools"], "WebFetch");
        assert_eq!(json["featureFlags"], r#"{"flag":true}"#);
        assert_eq!(json["codexRuntimeConfig"], r#"{"providerId":"deepseek"}"#);
        assert_eq!(json["piLaunchConfig"], r#"{"schemaVersion":2}"#);
        assert_eq!(json["piModelConfig"], r#"{"provider":"deepseek"}"#);
        assert_eq!(json["piSessionId"], "22222222-2222-4222-8222-222222222222");
    }

    #[test]
    fn run_payload_fields_returns_logical_names_and_values() {
        let payload = RunPayload {
            prompt: "prompt".to_string(),
            append_system_prompt: "system".to_string(),
            secret_values: "secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts: "[]".to_string(),
            feature_flags: r#"{"flag":true}"#.to_string(),
            codex_runtime_config: r#"{"providerId":"deepseek"}"#.to_string(),
            pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
            pi_model_config: r#"{"provider":"deepseek"}"#.to_string(),
            pi_session_id: "22222222-2222-4222-8222-222222222222".to_string(),
        };

        let fields = payload.fields();

        assert_eq!(
            fields,
            [
                RunPayloadField {
                    name: PROMPT_RUN_PAYLOAD_FIELD,
                    value: "prompt"
                },
                RunPayloadField {
                    name: APPEND_SYSTEM_PROMPT_RUN_PAYLOAD_FIELD,
                    value: "system"
                },
                RunPayloadField {
                    name: SECRET_VALUES_RUN_PAYLOAD_FIELD,
                    value: "secret"
                },
                RunPayloadField {
                    name: DISALLOWED_TOOLS_RUN_PAYLOAD_FIELD,
                    value: "WebFetch"
                },
                RunPayloadField {
                    name: TOOLS_RUN_PAYLOAD_FIELD,
                    value: "Bash"
                },
                RunPayloadField {
                    name: SETTINGS_RUN_PAYLOAD_FIELD,
                    value: "{}"
                },
                RunPayloadField {
                    name: ARTIFACTS_RUN_PAYLOAD_FIELD,
                    value: "[]"
                },
                RunPayloadField {
                    name: FEATURE_FLAGS_RUN_PAYLOAD_FIELD,
                    value: r#"{"flag":true}"#
                },
                RunPayloadField {
                    name: CODEX_RUNTIME_CONFIG_RUN_PAYLOAD_FIELD,
                    value: r#"{"providerId":"deepseek"}"#
                },
                RunPayloadField {
                    name: PI_LAUNCH_CONFIG_RUN_PAYLOAD_FIELD,
                    value: r#"{"schemaVersion":2}"#
                },
                RunPayloadField {
                    name: PI_MODEL_CONFIG_RUN_PAYLOAD_FIELD,
                    value: r#"{"provider":"deepseek"}"#
                },
                RunPayloadField {
                    name: PI_SESSION_ID_RUN_PAYLOAD_FIELD,
                    value: "22222222-2222-4222-8222-222222222222"
                },
            ]
        );
    }

    #[test]
    fn run_payload_first_nul_field_reports_logical_name() {
        let payload = RunPayload {
            settings: "bad\0settings".to_string(),
            ..RunPayload::default()
        };

        assert_eq!(payload.first_nul_field(), Some(SETTINGS_RUN_PAYLOAD_FIELD));
    }

    #[test]
    fn run_payload_first_nul_field_accepts_clean_payload() {
        let payload = RunPayload {
            prompt: "prompt".to_string(),
            append_system_prompt: "system".to_string(),
            secret_values: "secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts: "[]".to_string(),
            feature_flags: r#"{"flag":true}"#.to_string(),
            codex_runtime_config: r#"{"providerId":"deepseek"}"#.to_string(),
            ..RunPayload::default()
        };

        assert_eq!(payload.first_nul_field(), None);
    }

    #[test]
    fn shell_identifier_env_key_accepts_supported_keys() {
        for key in ["FOO", "_FOO", "FOO_1", "_", "A1_B2"] {
            assert!(
                is_shell_identifier_env_key(key),
                "{key} should be a supported shell exec env key"
            );
        }
    }

    #[test]
    fn shell_identifier_env_key_rejects_unsupported_keys() {
        for key in [
            "",
            "1BAD",
            "BAD-NAME",
            "BAD.NAME",
            "BAD NAME",
            "ÅKEY",
            "\u{00e9}clair",
        ] {
            assert!(
                !is_shell_identifier_env_key(key),
                "{key} should not be a supported shell exec env key"
            );
        }
    }

    #[test]
    fn env_key_diagnostic_escapes_and_truncates() {
        let key = format!("BAD\n{}", "X".repeat(200));
        let diagnostic = sanitize_env_key_for_diagnostic(&key);

        assert!(diagnostic.starts_with(r"BAD\n"));
        assert!(diagnostic.ends_with("..."));
        assert!(!diagnostic.contains('\n'));
    }

    #[test]
    fn runner_owned_key_detection_covers_terminal_contract() {
        for key in [
            CANONICAL_API_URL_ENV,
            RUN_ID_ENV,
            CANONICAL_API_TOKEN_ENV,
            CANONICAL_SANDBOX_ID_ENV,
            CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
            CANONICAL_RESUME_SESSION_ID_ENV,
            CANONICAL_API_START_TIME_ENV,
            PI_SESSION_ID_ENV,
            PI_LAUNCH_CONFIG_ENV,
            PI_LAUNCH_PAYLOAD_FILE_ENV,
            PI_MODEL_CONFIG_ENV,
            CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV,
            CANONICAL_USER_ENV_FILE_ENV,
            CANONICAL_RUN_PAYLOAD_FILE_ENV,
            CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
            CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            CLI_AGENT_TYPE_ENV,
            USE_MOCK_CLAUDE_ENV,
            USE_MOCK_CODEX_ENV,
            VERCEL_PROTECTION_BYPASS_ENV,
        ] {
            assert!(is_runner_owned_env_key(key), "{key} should be runner-owned");
        }
        assert!(is_runner_owned_env_key("OKOU_TOKEN"));
        assert!(is_runner_owned_env_key("OKOU_UNRELATED"));
        assert!(
            !is_runner_owned_env_key("CUSTOM_ENV"),
            "CUSTOM_ENV should be user-owned"
        );
    }

    /// Contract sources scanned for declared environment key constants.
    ///
    /// Every module declaring a `*_ENV` bootstrap key must be listed here, or
    /// its keys escape the protection check below.
    const CONTRACT_ENV_SOURCES: &[(&str, &str)] = &[
        ("env.rs", include_str!("env.rs")),
        ("runtime_paths.rs", include_str!("runtime_paths.rs")),
        (
            "process_containment.rs",
            include_str!("process_containment.rs"),
        ),
    ];

    /// Extracts every `pub const NAME_ENV: &str = "VALUE";` declaration from a
    /// contract source as a `(name, value)` pair.
    ///
    /// Reading declarations out of the source keeps the check exhaustive. A
    /// hand-maintained list would only cover the keys someone remembered to
    /// register, which is the failure this check exists to prevent.
    ///
    /// Only declarations starting a line are matched, so prose mentioning the
    /// pattern inside a comment is not treated as a declaration.
    ///
    /// Rustfmt may keep the string literal on the declaration line or move it
    /// to the immediately following line. A `_ENV` declaration this cannot
    /// parse yields an empty value, which fails the protection check rather
    /// than being skipped, so an unparsed declaration fails closed.
    fn declared_env_key_constants(source: &str) -> Vec<(&str, &str)> {
        let lines = source.lines().collect::<Vec<_>>();
        lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                let declaration = line.trim_start().strip_prefix("pub const ")?;
                let (name, rest) = declaration.split_once(':')?;
                let name = name.trim();
                if !name.ends_with("_ENV") {
                    return None;
                }
                let (_, rest) = rest.split_once('=')?;
                let literal_source = if rest.trim_start().starts_with('"') {
                    rest
                } else {
                    lines.get(index + 1).copied().unwrap_or("")
                };
                let value = literal_source
                    .trim_start()
                    .strip_prefix('"')
                    .and_then(|literal| literal.split_once('"'))
                    .map_or("", |(value, _)| value);
                Some((name, value))
            })
            .collect()
    }

    #[test]
    fn every_declared_env_key_is_classified_for_user_env_protection() {
        let mut unprotected = Vec::new();
        let mut total = 0;

        for (file, source) in CONTRACT_ENV_SOURCES {
            let declared = declared_env_key_constants(source);
            assert!(
                !declared.is_empty(),
                "{file} yielded no *_ENV declarations; the source scan is broken"
            );
            total += declared.len();

            for (name, value) in declared {
                if !is_runner_owned_env_key(value) {
                    unprotected.push(format!("{file}: {name} = {value:?}"));
                }
            }
        }

        assert!(
            total >= 29,
            "expected at least 29 declared *_ENV keys across the contract sources, found {total}; \
             lower this bound only when a key is deliberately removed"
        );
        assert!(
            unprotected.is_empty(),
            "these bootstrap env keys are not protected from user env injection. Add each to \
             EXPLICIT_RUNNER_OWNED_ENV_KEYS or keep an OKOU_ prefix:\n  {}",
            unprotected.join("\n  ")
        );
    }
}
