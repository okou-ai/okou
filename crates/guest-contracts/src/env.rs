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

/// Wire value for the actual sandbox startup resource after preparation settles.
pub const CANONICAL_SANDBOX_STARTUP_PATH_ENV: &str = "OKOU_SANDBOX_STARTUP_PATH";

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
/// recovery history uploads and final telemetry. It is intentionally not a
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
    /// VAS storage name reported in artifact manifests.
    pub name: String,
    /// Absolute guest path containing the mounted artifact.
    pub mount_path: String,
    /// VAS storage identifier used to recompute the artifact content hash.
    pub storage_id: String,
    /// VAS version identifier mounted at startup.
    pub version_id: String,
    /// Behavior when the artifact root is absent while saving artifacts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_root_policy: Option<RunArtifactMissingRootPolicy>,
}

/// Runner-to-guest policy for an artifact root missing while saving artifacts.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunArtifactMissingRootPolicy {
    /// Treat the missing artifact root as an artifact-save error.
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

/// Guest-owned capability key telling the Pi CLI child to report its session
/// preparation phases on stderr.
///
/// The guest agent owns the sandbox operation log, so it also owns whether a
/// child reports into it. The key is set only by a guest agent that recognizes
/// the `pi_preparation_timing` envelope; a child that does not observe `"1"`
/// stays silent, which keeps a newer CLI package from adding unrecognized
/// lines to an older guest agent's failure diagnostics.
pub const PI_PREPARATION_TIMING_ENV: &str = "OKOU_PI_PREPARATION_TIMING";

/// Value of [`PI_PREPARATION_TIMING_ENV`] that enables child reporting.
pub const PI_PREPARATION_TIMING_ENABLED: &str = "1";

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

/// API-owned native continuation intent. No remote history reference is carried.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NativeContinuation {
    /// Exact native identity to look for in the intended retained home.
    pub session_id: Option<String>,
    /// Existing Run that produced that retained generation.
    pub generation_run_id: Option<String>,
    /// Mandatory recovery item for a later round, enabled only after a miss.
    pub recovery_prompt: Option<String>,
}

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
    /// Serialized native continuation intent; empty for captured legacy work.
    #[serde(default)]
    pub native_continuation: String,
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
    pub fn fields(&self) -> [RunPayloadField<'_>; 13] {
        let Self {
            prompt,
            append_system_prompt,
            native_continuation,
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
                name: "nativeContinuation",
                value: native_continuation,
            },
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
    CANONICAL_SANDBOX_STARTUP_PATH_ENV,
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
mod tests;
