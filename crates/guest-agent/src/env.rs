//! Guest-agent startup configuration parsed from captured environment values.
//!
//! `GuestConfigRaw::from_process_env` is the only process-env capture boundary
//! in this module. After startup, callers should pass an owned [`GuestConfig`]
//! instead of rereading process globals through run-scoped facade functions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use api_contracts::generated::{
    constants::runners::paths::{CANONICAL_CLAUDE_CONFIG_DIR, CANONICAL_CODEX_HOME_DIR},
    types::runners::storage::ArtifactEntryMissingRootPolicy,
};
use guest_contracts::env::{CliAgentTypeSelection, CliFramework};

use crate::constants;
use guest_telemetry::log_warn;

const LOG_TAG: &str = "sandbox:guest-agent";
const USER_ENV_FILE_ENV_KEY: &str = guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV;
const RUN_PAYLOAD_FILE_ENV_KEY: &str = guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV;
const POST_RESULT_CLEANUP_MAX_SECS: u64 = 60 * 60;
pub(crate) const AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC: &str = "agent execution timeout";
#[cfg(debug_assertions)]
const TEST_CLAUDE_CONFIG_DIR_ENV_KEY: &str = "OKOU_TEST_CLAUDE_CONFIG_DIR";
#[cfg(debug_assertions)]
const TEST_CODEX_HOME_DIR_ENV_KEY: &str = "OKOU_TEST_CODEX_HOME_DIR";

fn env_or_empty(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// CLI framework dispatched by the runner via `CLI_AGENT_TYPE`. Unknown
/// values fall back to `ClaudeCode` so a misconfigured runner can't
/// crash the guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framework {
    ClaudeCode,
    Codex,
    Pi,
}

impl Framework {
    /// Stable CLI agent type string used in runner/web contracts and logs.
    pub fn agent_type(self) -> &'static str {
        CliFramework::from(self).as_cli_agent_type()
    }
}

impl From<CliFramework> for Framework {
    fn from(framework: CliFramework) -> Self {
        match framework {
            CliFramework::ClaudeCode => Self::ClaudeCode,
            CliFramework::Codex => Self::Codex,
            CliFramework::Pi => Self::Pi,
        }
    }
}

impl From<Framework> for CliFramework {
    fn from(framework: Framework) -> Self {
        match framework {
            Framework::ClaudeCode => Self::ClaudeCode,
            Framework::Codex => Self::Codex,
            Framework::Pi => Self::Pi,
        }
    }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/// Production install location for the mock-claude binary. Exposed so
/// tests can assert against a single source of truth when the
/// mock Claude path aliases are absent or non-Unicode.
pub const DEFAULT_MOCK_CLAUDE_PATH: &str = guest_contracts::guest_binary::CLAUDE_MOCK_PATH;

/// Production install location for the mock-codex binary, mirroring
/// `DEFAULT_MOCK_CLAUDE_PATH`.
pub const DEFAULT_MOCK_CODEX_PATH: &str = guest_contracts::guest_binary::CODEX_MOCK_PATH;

fn u64_value_or(name: &str, value: Option<&str>, default: u64) -> u64 {
    match value {
        Some(v) => v.parse().unwrap_or_else(|_| {
            log_warn!(
                LOG_TAG,
                "{name}={v:?} is not a valid u64, using default {default}s"
            );
            default
        }),
        None => default,
    }
}

fn bounded_duration_secs_value_or(
    name: &str,
    value: Option<&str>,
    default_secs: u64,
    max_secs: u64,
) -> Duration {
    match value {
        Some(v) => match v.parse::<u64>() {
            Ok(secs) if secs <= max_secs => Duration::from_secs(secs),
            Ok(secs) => {
                log_warn!(
                    LOG_TAG,
                    "{name}={secs}s exceeds maximum {max_secs}s, using default {default_secs}s"
                );
                Duration::from_secs(default_secs)
            }
            Err(_) => {
                log_warn!(
                    LOG_TAG,
                    "{name}={v:?} is not a valid u64, using default {default_secs}s"
                );
                Duration::from_secs(default_secs)
            }
        },
        None => Duration::from_secs(default_secs),
    }
}

fn optional_positive_duration_secs(
    name: &str,
    value: Option<&str>,
) -> Result<Option<Duration>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let seconds = value
        .parse::<u64>()
        .map_err(|_| format!("{name} must be a positive integer number of seconds"))?;
    if seconds == 0 {
        return Err(format!("{name} must be greater than zero"));
    }
    let duration = Duration::from_secs(seconds);
    if std::time::Instant::now().checked_add(duration).is_none() {
        return Err(format!("{name} is too large"));
    }
    Ok(Some(duration))
}

// ---------------------------------------------------------------------------
// Artifacts (multi-mount)
//
// The runner supplies a JSON array of
// `{name, mountPath, storageId, versionId, missingRootPolicy?}` entries through
// the run payload. If the value is unset or empty, there are no artifacts.
// ---------------------------------------------------------------------------

/// Checkpoint state materialized from one runner-provided artifact entry.
///
/// [`guest_contracts::env::RunArtifact`] owns the wire representation parsed
/// before this guest-agent type is constructed.
#[derive(Clone, Debug)]
pub struct ArtifactEnv {
    /// VAS storage name for the mounted artifact. This is also the artifact
    /// name reported in checkpoint snapshot payloads.
    pub name: String,
    /// Absolute path inside the guest where the artifact archive was mounted
    /// and where the guest-agent walks files during checkpointing.
    pub mount_path: String,
    /// VAS storage id used when recomputing the mounted artifact's content hash.
    pub storage_id: String,
    /// VAS version id mounted at startup. This is the expected content hash used
    /// to skip unchanged snapshots and the parent version for new snapshots.
    pub version_id: String,
    /// Optional internal checkpoint policy. Absence means strict failure on a
    /// missing or unreadable artifact root.
    pub missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
}

impl From<guest_contracts::env::RunArtifact> for ArtifactEnv {
    fn from(artifact: guest_contracts::env::RunArtifact) -> Self {
        Self {
            name: artifact.name,
            mount_path: artifact.mount_path,
            storage_id: artifact.storage_id,
            version_id: artifact.version_id,
            missing_root_policy: artifact
                .missing_root_policy
                .map(artifact_env_missing_root_policy),
        }
    }
}

fn artifact_env_missing_root_policy(
    policy: guest_contracts::env::RunArtifactMissingRootPolicy,
) -> ArtifactEntryMissingRootPolicy {
    match policy {
        guest_contracts::env::RunArtifactMissingRootPolicy::Fail => {
            ArtifactEntryMissingRootPolicy::Fail
        }
        guest_contracts::env::RunArtifactMissingRootPolicy::PreserveParentVersion => {
            ArtifactEntryMissingRootPolicy::PreserveParentVersion
        }
    }
}

/// Raw runner bootstrap values used to build an owned guest-agent run config.
///
/// `String` fields captured by [`Self::from_process_env`] cannot distinguish an
/// absent or non-Unicode environment value from a present empty value: each
/// becomes an empty string. `Option` fields do not share that rule.
/// Variable-length run payload fields live in
/// [`guest_contracts::env::RunPayload`] and are loaded through
/// `run_payload_file`.
#[derive(Clone, Default)]
pub struct GuestConfigRaw {
    pub run_id: String,
    pub api_url: String,
    pub api_token: String,
    pub sandbox_id: String,
    pub sandbox_reuse_result: String,
    pub workspace_reuse_result: String,
    pub vercel_bypass: String,
    pub resume_session_id: String,
    pub api_start_time: String,
    pub agent_execution_timeout_secs: String,
    pub use_mock_claude: String,
    /// Optional canonical mock Claude executable override.
    ///
    /// [`Self::from_process_env`] captures an absent or non-Unicode value as
    /// `None` and a present empty value as `Some("")`. [`GuestConfig::from_raw`]
    /// selects [`DEFAULT_MOCK_CLAUDE_PATH`] only when this field is `None`.
    pub mock_claude_path: Option<String>,
    pub cli_agent_type: String,
    pub user_env_file: String,
    pub run_payload_file: String,
    pub use_mock_codex: String,
    /// Optional canonical mock Codex executable override.
    ///
    /// [`Self::from_process_env`] captures an absent or non-Unicode value as
    /// `None` and a present empty value as `Some("")`. [`GuestConfig::from_raw`]
    /// selects [`DEFAULT_MOCK_CODEX_PATH`] only when this field is `None`.
    pub mock_codex_path: Option<String>,
    pub home: Option<String>,
    pub runtime_home: Option<PathBuf>,
    pub guest_runtime_dir: Option<PathBuf>,
    #[cfg(debug_assertions)]
    pub test_claude_config_dir: Option<PathBuf>,
    #[cfg(debug_assertions)]
    pub test_codex_home_dir: Option<PathBuf>,
    pub stuck_tool_timeout_secs: String,
    pub post_result_sigterm_grace_secs: String,
    pub post_result_total_cap_secs: String,
    pub post_result_sigkill_grace_secs: String,
}

impl GuestConfigRaw {
    /// Capture raw startup values from the current process environment.
    ///
    /// Returns an error when the canonical runtime directory cannot be resolved.
    pub fn from_process_env() -> Result<Self, String> {
        let guest_runtime_dir =
            guest_contracts::runtime_paths::guest_runtime_dir_env_from_process_env()
                .map_err(|error| format!("failed to resolve guest runtime paths: {error}"))?;
        Self::from_process_env_with_guest_runtime_dir(guest_runtime_dir)
    }

    /// Capture all remaining startup values after the canonical runtime
    /// directory was resolved at the outer single-threaded bootstrap boundary.
    pub(crate) fn from_process_env_with_guest_runtime_dir(
        guest_runtime_dir: Option<PathBuf>,
    ) -> Result<Self, String> {
        let api_url = env_or_empty(guest_contracts::env::CANONICAL_API_URL_ENV);

        let stuck_tool_timeout_secs =
            env_or_empty(guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV);
        let post_result_sigterm_grace_secs =
            env_or_empty(guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV);
        let post_result_total_cap_secs =
            env_or_empty(guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV);
        let post_result_sigkill_grace_secs =
            env_or_empty(guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV);

        let user_env_file = env_or_empty(guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV);
        let run_payload_file = env_or_empty(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV);

        Ok(Self {
            run_id: env_or_empty(guest_contracts::env::RUN_ID_ENV),
            api_url,
            api_token: env_or_empty(guest_contracts::env::CANONICAL_API_TOKEN_ENV),
            sandbox_id: env_or_empty(guest_contracts::env::CANONICAL_SANDBOX_ID_ENV),
            sandbox_reuse_result: env_or_empty(
                guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            ),
            workspace_reuse_result: env_or_empty(
                guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
            ),
            vercel_bypass: env_or_empty(guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV),
            resume_session_id: env_or_empty(guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV),
            api_start_time: env_or_empty(guest_contracts::env::CANONICAL_API_START_TIME_ENV),
            agent_execution_timeout_secs: env_or_empty(
                guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            ),
            use_mock_claude: env_or_empty(guest_contracts::env::USE_MOCK_CLAUDE_ENV),
            mock_claude_path: std::env::var(guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV)
                .ok(),
            cli_agent_type: env_or_empty(guest_contracts::env::CLI_AGENT_TYPE_ENV),
            user_env_file,
            run_payload_file,
            use_mock_codex: env_or_empty(guest_contracts::env::USE_MOCK_CODEX_ENV),
            mock_codex_path: std::env::var(guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV)
                .ok(),
            home: std::env::var("HOME").ok(),
            runtime_home: std::env::var_os("HOME").map(PathBuf::from),
            guest_runtime_dir,
            #[cfg(debug_assertions)]
            test_claude_config_dir: std::env::var_os(TEST_CLAUDE_CONFIG_DIR_ENV_KEY)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            #[cfg(debug_assertions)]
            test_codex_home_dir: std::env::var_os(TEST_CODEX_HOME_DIR_ENV_KEY)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            stuck_tool_timeout_secs,
            post_result_sigterm_grace_secs,
            post_result_total_cap_secs,
            post_result_sigkill_grace_secs,
        })
    }

    pub(crate) fn require_run_payload_file(&self) -> Result<(), String> {
        if self.run_payload_file.is_empty() {
            return Err(format!("{RUN_PAYLOAD_FILE_ENV_KEY} is required"));
        }
        Ok(())
    }
}

/// Immutable guest-agent startup configuration for a single run.
///
/// Fixed bootstrap values are captured by [`GuestConfigRaw`], variable-length
/// values are loaded from [`guest_contracts::env::RunPayload`], and derived
/// values are normalized while building this type. The fields preserve the
/// runner's wire representation where a downstream consumer owns the contract.
#[derive(Clone)]
pub struct GuestConfig {
    /// Stable run identifier from [`guest_contracts::env::RUN_ID_ENV`]. It
    /// correlates logs, telemetry, API requests, runtime paths, and completion
    /// state.
    pub run_id: String,
    /// Backend API base URL from
    /// [`guest_contracts::env::CANONICAL_API_URL_ENV`]. It is used to build the
    /// guest-agent HTTP client and the managed CLI runtime configuration.
    pub api_url: String,
    /// Backend API bearer token from
    /// [`guest_contracts::env::CANONICAL_API_TOKEN_ENV`]. An empty token
    /// disables backend API configuration in the guest-agent HTTP client.
    pub api_token: String,
    /// Runner-assigned sandbox identifier from
    /// [`guest_contracts::env::CANONICAL_SANDBOX_ID_ENV`]. It is included in
    /// completion and user-cancellation reports.
    pub sandbox_id: String,
    /// Wire-format outcome of the runner's sandbox-reuse decision from
    /// [`guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV`]. `reused`
    /// means the sandbox was unparked; other values explain why reuse did not
    /// happen. The value is retained for completion and cancellation reports.
    pub sandbox_reuse_result: String,
    /// Final wire-format outcome of workspace preparation from
    /// [`guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV`]. Values
    /// such as `reused` and `sandboxReused` identify the reuse path, while the
    /// other values describe why workspace reuse did not happen.
    pub workspace_reuse_result: String,
    /// User prompt loaded from [`guest_contracts::env::RunPayload`] and passed
    /// to the selected CLI protocol and active-input runtime.
    pub prompt: String,
    /// Optional additional system-prompt text from
    /// [`guest_contracts::env::RunPayload`]. An empty string means no extra
    /// system prompt; non-empty content is transferred through the selected
    /// CLI's launch payload or private prompt file.
    pub append_system_prompt: String,
    /// Optional Vercel protection-bypass secret from
    /// [`guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV`]. A non-empty
    /// value is attached to guest-agent API requests as the bypass header.
    pub vercel_bypass: String,
    /// Optional CLI session or thread identifier from
    /// [`guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV`]. An empty
    /// string means that the selected CLI starts without resuming a session.
    pub resume_session_id: String,
    /// Optional Unix epoch timestamp in milliseconds from
    /// [`guest_contracts::env::CANONICAL_API_START_TIME_ENV`]. It is retained
    /// as a string; timing telemetry ignores empty, non-numeric, implausible,
    /// or seconds-shaped values.
    pub api_start_time: String,
    /// Optional CLI execution budget materialized from the runner-owned
    /// second-based value in
    /// [`guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV`].
    /// Absence or an empty value is `None`; a present value must be a positive
    /// `u64` that fits the process `Instant` range. The resulting duration
    /// bounds CLI execution.
    pub agent_execution_timeout: Option<Duration>,
    /// Comma-separated base64-encoded secret values from
    /// [`guest_contracts::env::RunPayload`]. The secret masker decodes these
    /// values and uses them to redact telemetry and diagnostics; an empty
    /// string means there are no values to mask.
    pub secret_values: String,
    /// Comma-separated Claude Code tool names from
    /// [`guest_contracts::env::RunPayload`] that should be denied. An empty
    /// string means there is no explicit deny list; the values become repeated
    /// `--disallowed-tools` arguments.
    pub disallowed_tools: String,
    /// Comma-separated Claude Code tool names from
    /// [`guest_contracts::env::RunPayload`] that should be allowed. An empty
    /// string means there is no explicit allow list; the values become repeated
    /// `--tools` arguments.
    pub tools: String,
    /// Opaque raw Claude Code settings payload from
    /// [`guest_contracts::env::RunPayload`]. An empty string means there is no
    /// settings override; a non-empty value is passed as `--settings`.
    pub settings: String,
    /// Whether to launch the mock Claude binary. This is materialized from
    /// [`guest_contracts::env::USE_MOCK_CLAUDE_ENV`] and is true only for the
    /// exact string `"true"`.
    pub use_mock_claude: bool,
    /// Mock Claude executable path from the optional
    /// [`guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV`] override. An
    /// absent override selects [`DEFAULT_MOCK_CLAUDE_PATH`]; a present value,
    /// including an empty string, is preserved.
    pub mock_claude_path: String,
    /// Captured `CLI_AGENT_TYPE` wire value from
    /// [`guest_contracts::env::CLI_AGENT_TYPE_ENV`]. This string is preserved,
    /// including empty or unknown values, alongside the normalized
    /// [`framework`](Self::framework) field.
    pub cli_agent_type: String,
    /// Normalized CLI framework derived from `cli_agent_type`. `"claude-code"`
    /// and an empty value map to [`Framework::ClaudeCode`], `"codex"` maps to
    /// [`Framework::Codex`], and `"pi"` maps to [`Framework::Pi`]. Unknown
    /// values emit a warning and also fall back to `ClaudeCode`.
    pub framework: Framework,
    /// User, model-provider, and connector environment loaded from the private
    /// JSON file named by
    /// [`guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV`]. An absent or
    /// empty file pointer produces an empty map. Runner-owned keys are removed
    /// before the map is passed to managed CLI children.
    pub user_env: HashMap<String, String>,
    /// Whether to launch the mock Codex binary. This is materialized from
    /// [`guest_contracts::env::USE_MOCK_CODEX_ENV`] and is true for exactly
    /// `"true"` or `"1"`.
    pub use_mock_codex: bool,
    /// Mock Codex executable path from the optional
    /// [`guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV`] override. An
    /// absent override selects [`DEFAULT_MOCK_CODEX_PATH`]; a present value,
    /// including an empty string, is preserved.
    pub mock_codex_path: String,
    /// Effective home directory for the managed CLI child. `HOME` from
    /// `user_env` takes precedence over the captured process `HOME`; missing
    /// both values is a materialization error.
    pub home_dir: String,
    /// Effective Claude configuration directory. Production uses the
    /// canonical generated runner path; debug builds may use a non-empty
    /// test-only override. Session metadata uses this path to identify Claude
    /// Code history.
    pub claude_config_dir: String,
    /// Effective Codex home directory. Production uses the canonical generated
    /// runner path; debug builds may use a non-empty test-only override. Codex
    /// setup and session metadata use this path.
    pub codex_home_dir: String,
    /// Artifact mounts parsed from the camelCase JSON array in
    /// [`guest_contracts::env::RunPayload`]. Empty input produces an empty
    /// vector; checkpoint creation uses the entries for artifact snapshots.
    pub artifacts: Vec<ArtifactEnv>,
    /// Feature flags parsed from the JSON object in
    /// [`guest_contracts::env::RunPayload`]. Empty input produces an empty map
    /// keyed by flag name with boolean enabled states.
    pub feature_flags: HashMap<String, bool>,
    /// JSON object containing API-owned Codex provider and runtime metadata
    /// from [`guest_contracts::env::RunPayload`]. The value is parsed for
    /// Codex startup configuration and is otherwise retained in its wire form.
    pub codex_runtime_config: String,
    /// Serialized Pi launch configuration from
    /// [`guest_contracts::env::RunPayload::pi_launch_config`] in the private
    /// run-payload file named by
    /// [`guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV`]. The guest-agent
    /// parses this value and writes it as `launchConfig` in a separate private
    /// Pi launch-payload file, whose path is passed to the Pi child through
    /// [`guest_contracts::env::PI_LAUNCH_PAYLOAD_FILE_ENV`].
    pub pi_launch_config: String,
    /// JSON object containing non-secret Pi model metadata from
    /// [`guest_contracts::env::RunPayload::pi_model_config`] in the incoming
    /// run payload. The guest-agent passes it to the Pi child through the
    /// [`guest_contracts::env::PI_MODEL_CONFIG_ENV`] environment variable.
    pub pi_model_config: String,
    /// Chat Thread identifier from
    /// [`guest_contracts::env::RunPayload::pi_session_id`] in the incoming run
    /// payload. It is passed to the Pi child through the
    /// [`guest_contracts::env::PI_SESSION_ID_ENV`] environment variable and used
    /// as Pi's native session identifier and for session-history lookup.
    pub pi_session_id: String,
    /// JSON object with the installed-CLI launch requirements from
    /// [`guest_contracts::env::RunPayload::pi_installed_cli_requirement`].
    /// Empty when the execution context carries none; the guest then launches
    /// the commit-addressed CLI through `npx`.
    pub pi_installed_cli_requirement: String,
    /// Stuck-tool timeout in seconds parsed from
    /// [`guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV`]. Empty
    /// or invalid input uses the 300-second compiled default; the CLI loop
    /// uses this value to terminate a tool call that produces no result.
    pub stuck_tool_timeout_secs: u64,
    /// Grace period after the CLI reports its final result before the process
    /// group receives SIGTERM. The value is parsed from
    /// [`guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV`]
    /// in seconds; empty, invalid, or over-3600-second input uses the
    /// 10-second compiled default.
    pub post_result_sigterm_grace: Duration,
    /// Absolute post-result cleanup cap after the CLI reports its final result.
    /// The value is parsed from
    /// [`guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV`] in
    /// seconds; empty, invalid, or over-3600-second input uses the 120-second
    /// compiled default.
    pub post_result_total_cap: Duration,
    /// Grace period after SIGTERM before escalation to SIGKILL when the CLI
    /// process group does not exit. The value is parsed from
    /// [`guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV`]
    /// in seconds; empty, invalid, or over-3600-second input uses the
    /// 5-second compiled default.
    pub post_result_sigkill_grace: Duration,
}

impl GuestConfig {
    /// Build an owned config from the current process environment.
    pub fn from_process_env() -> Result<Self, String> {
        let raw = GuestConfigRaw::from_process_env()?;
        raw.require_run_payload_file()?;
        Self::from_raw(raw)
    }

    /// Build an owned config from explicit captured startup values.
    ///
    /// This validates and destructively loads the required run-payload file and
    /// the optional user-env file against the captured runtime directory. Each
    /// private file is removed after it is read, before parsing and validation
    /// finish.
    ///
    /// # Errors
    ///
    /// A referenced private file may already have been removed when this returns
    /// an error from parsing, validation, or later config materialization.
    pub fn from_raw(raw: GuestConfigRaw) -> Result<Self, String> {
        let payload = load_run_payload_from_raw(&raw)?;
        let user_env = load_user_env_from_raw(&raw)?;
        Self::from_raw_with_user_env(raw, payload, user_env)
    }

    fn from_raw_with_user_env(
        raw: GuestConfigRaw,
        payload: guest_contracts::env::RunPayload,
        user_env: HashMap<String, String>,
    ) -> Result<Self, String> {
        let home_dir = resolve_home_dir(&user_env, raw.home.as_deref())?;
        let claude_config_dir = resolve_claude_config_dir(&raw);
        let codex_home_dir = resolve_codex_home_dir(&raw);
        let artifacts = parse_artifacts_value(&payload.artifacts).map_err(|e| {
            format!(
                "parse {} JSON: {e}",
                guest_contracts::env::ARTIFACTS_RUN_PAYLOAD_FIELD
            )
        })?;
        let feature_flags = parse_feature_flags_value(&payload.feature_flags).map_err(|e| {
            format!(
                "parse {} JSON: {e}",
                guest_contracts::env::FEATURE_FLAGS_RUN_PAYLOAD_FIELD
            )
        })?;

        Ok(Self {
            run_id: raw.run_id,
            api_url: raw.api_url,
            api_token: raw.api_token,
            sandbox_id: raw.sandbox_id,
            sandbox_reuse_result: raw.sandbox_reuse_result,
            workspace_reuse_result: raw.workspace_reuse_result,
            prompt: payload.prompt,
            append_system_prompt: payload.append_system_prompt,
            vercel_bypass: raw.vercel_bypass,
            resume_session_id: raw.resume_session_id,
            api_start_time: raw.api_start_time,
            agent_execution_timeout: optional_positive_duration_secs(
                AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC,
                non_empty(&raw.agent_execution_timeout_secs),
            )?,
            secret_values: payload.secret_values,
            disallowed_tools: payload.disallowed_tools,
            tools: payload.tools,
            settings: payload.settings,
            use_mock_claude: bool_true_value(Some(&raw.use_mock_claude)),
            mock_claude_path: default_mock_path(
                raw.mock_claude_path.as_deref(),
                DEFAULT_MOCK_CLAUDE_PATH,
            ),
            framework: framework_from_cli_agent_type(&raw.cli_agent_type),
            cli_agent_type: raw.cli_agent_type,
            user_env,
            use_mock_codex: bool_true_or_one_value(Some(&raw.use_mock_codex)),
            mock_codex_path: default_mock_path(
                raw.mock_codex_path.as_deref(),
                DEFAULT_MOCK_CODEX_PATH,
            ),
            home_dir,
            claude_config_dir,
            codex_home_dir,
            artifacts,
            feature_flags,
            codex_runtime_config: payload.codex_runtime_config,
            pi_launch_config: payload.pi_launch_config,
            pi_model_config: payload.pi_model_config,
            pi_session_id: payload.pi_session_id,
            pi_installed_cli_requirement: payload.pi_installed_cli_requirement,
            stuck_tool_timeout_secs: u64_value_or(
                guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
                non_empty(&raw.stuck_tool_timeout_secs),
                constants::STUCK_TOOL_TIMEOUT_SECS,
            ),
            post_result_sigterm_grace: bounded_duration_secs_value_or(
                guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
                non_empty(&raw.post_result_sigterm_grace_secs),
                constants::POST_RESULT_SIGTERM_GRACE_SECS,
                POST_RESULT_CLEANUP_MAX_SECS,
            ),
            post_result_total_cap: bounded_duration_secs_value_or(
                guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
                non_empty(&raw.post_result_total_cap_secs),
                constants::POST_RESULT_TOTAL_CAP_SECS,
                POST_RESULT_CLEANUP_MAX_SECS,
            ),
            post_result_sigkill_grace: bounded_duration_secs_value_or(
                guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
                non_empty(&raw.post_result_sigkill_grace_secs),
                constants::POST_RESULT_SIGKILL_GRACE_SECS,
                POST_RESULT_CLEANUP_MAX_SECS,
            ),
        })
    }
}

fn framework_from_cli_agent_type(value: &str) -> Framework {
    let selection = CliAgentTypeSelection::parse(value);
    if selection.is_unknown() {
        log_warn!(
            LOG_TAG,
            "Unknown CLI_AGENT_TYPE={value:?}, defaulting to claude-code"
        );
    }
    selection.framework().into()
}

fn non_empty(value: &str) -> Option<&str> {
    if value.is_empty() { None } else { Some(value) }
}

fn bool_true_value(value: Option<&str>) -> bool {
    matches!(value, Some("true"))
}

fn bool_true_or_one_value(value: Option<&str>) -> bool {
    matches!(value, Some("true" | "1"))
}

fn default_mock_path(value: Option<&str>, default: &str) -> String {
    value.map_or_else(|| default.to_string(), str::to_string)
}

fn parse_artifacts_value(raw: &str) -> Result<Vec<ArtifactEnv>, serde_json::Error> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<guest_contracts::env::RunArtifact>>(raw)
        .map(|artifacts| artifacts.into_iter().map(ArtifactEnv::from).collect())
}

fn parse_feature_flags_value(raw: &str) -> Result<HashMap<String, bool>, serde_json::Error> {
    if raw.is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(raw)
}

#[derive(Clone, Copy)]
struct PrivateRuntimeFileSpec {
    env_key: &'static str,
    private_dir_name: &'static str,
    filename: &'static str,
}

const RUN_PAYLOAD_PRIVATE_FILE: PrivateRuntimeFileSpec = PrivateRuntimeFileSpec {
    env_key: RUN_PAYLOAD_FILE_ENV_KEY,
    private_dir_name: guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME,
    filename: guest_contracts::env::RUN_PAYLOAD_FILENAME,
};

const USER_ENV_PRIVATE_FILE: PrivateRuntimeFileSpec = PrivateRuntimeFileSpec {
    env_key: USER_ENV_FILE_ENV_KEY,
    private_dir_name: guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME,
    filename: guest_contracts::env::USER_ENV_FILENAME,
};

fn load_run_payload_from_raw(
    raw: &GuestConfigRaw,
) -> Result<guest_contracts::env::RunPayload, String> {
    raw.require_run_payload_file()?;

    let path = Path::new(&raw.run_payload_file);
    let runtime_dir = guest_runtime_dir_for_private_file_values(
        RUN_PAYLOAD_FILE_ENV_KEY,
        &raw.run_id,
        raw.guest_runtime_dir.as_deref(),
        raw.runtime_home
            .as_deref()
            .or_else(|| raw.home.as_deref().map(Path::new)),
    )?;
    validate_private_runtime_file_path_for_runtime(path, &runtime_dir, RUN_PAYLOAD_PRIVATE_FILE)?;
    load_run_payload_from_path(path)
}

fn load_run_payload_from_path(path: &Path) -> Result<guest_contracts::env::RunPayload, String> {
    let raw = read_and_remove_private_runtime_file(path, RUN_PAYLOAD_PRIVATE_FILE)?;

    let payload: guest_contracts::env::RunPayload = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {RUN_PAYLOAD_FILE_ENV_KEY} JSON: {e}"))?;
    validate_run_payload(&payload)?;

    Ok(payload)
}

fn validate_run_payload(payload: &guest_contracts::env::RunPayload) -> Result<(), String> {
    if let Some(name) = payload.first_nul_field() {
        return Err(format!(
            "{RUN_PAYLOAD_FILE_ENV_KEY} contains NUL byte for {name}"
        ));
    }

    Ok(())
}

fn load_user_env_from_raw(raw: &GuestConfigRaw) -> Result<HashMap<String, String>, String> {
    if raw.user_env_file.is_empty() {
        return Ok(HashMap::new());
    }

    let path = Path::new(&raw.user_env_file);
    let runtime_dir = guest_runtime_dir_for_private_file_values(
        USER_ENV_FILE_ENV_KEY,
        &raw.run_id,
        raw.guest_runtime_dir.as_deref(),
        raw.runtime_home
            .as_deref()
            .or_else(|| raw.home.as_deref().map(Path::new)),
    )?;
    validate_private_runtime_file_path_for_runtime(path, &runtime_dir, USER_ENV_PRIVATE_FILE)?;
    load_user_env_from_path(path)
}

fn load_user_env_from_path(path: &Path) -> Result<HashMap<String, String>, String> {
    let raw = read_and_remove_private_runtime_file(path, USER_ENV_PRIVATE_FILE)?;

    let user_env: HashMap<String, String> = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {USER_ENV_FILE_ENV_KEY} JSON: {e}"))?;
    validate_user_env(&user_env)?;

    Ok(user_env)
}

fn read_and_remove_private_runtime_file(
    path: &Path,
    spec: PrivateRuntimeFileSpec,
) -> Result<String, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read {} {}: {e}", spec.env_key, path.display()))?;
    remove_private_runtime_file(path, spec)?;
    Ok(raw)
}

fn remove_private_runtime_file(path: &Path, spec: PrivateRuntimeFileSpec) -> Result<(), String> {
    std::fs::remove_file(path)
        .map_err(|e| format!("remove {} {}: {e}", spec.env_key, path.display()))?;
    if let Some(parent) = path.parent()
        && is_private_runtime_dir(parent, spec)
    {
        std::fs::remove_dir(parent)
            .map_err(|e| format!("remove {} parent {}: {e}", spec.env_key, parent.display()))?;
    }

    Ok(())
}

fn is_private_runtime_dir(path: &Path, spec: PrivateRuntimeFileSpec) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == spec.private_dir_name)
}

fn guest_runtime_dir_for_private_file_values(
    env_key: &str,
    run_id: &str,
    runtime_dir: Option<&Path>,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    guest_contracts::runtime_paths::validate_run_id(run_id)
        .map_err(|e| format!("resolve guest runtime dir for {env_key}: {e}"))?;

    if let Some(runtime_dir) = runtime_dir {
        if !runtime_dir.is_absolute() {
            return Err(format!(
                "resolve guest runtime dir for {env_key}: {}",
                guest_contracts::runtime_paths::RuntimePathError::InvalidRuntimeDir
            ));
        }
        return Ok(runtime_dir.to_path_buf());
    }

    let Some(home) = home.filter(|value| !value.as_os_str().is_empty()) else {
        return Err(format!(
            "resolve guest runtime dir for {env_key}: {}",
            guest_contracts::runtime_paths::RuntimePathError::MissingHome
        ));
    };

    guest_contracts::runtime_paths::run_dir_for_home(home, run_id)
        .map_err(|e| format!("resolve guest runtime dir for {env_key}: {e}"))
}

fn private_runtime_file_path_for_runtime(
    runtime_dir: &Path,
    spec: PrivateRuntimeFileSpec,
) -> PathBuf {
    runtime_dir.join(spec.private_dir_name).join(spec.filename)
}

fn validate_private_runtime_file_path_for_runtime(
    path: &Path,
    runtime_dir: &Path,
    spec: PrivateRuntimeFileSpec,
) -> Result<(), String> {
    if path == private_runtime_file_path_for_runtime(runtime_dir, spec) {
        return Ok(());
    }

    Err(format!(
        "{} must point to guest runtime {}/{}",
        spec.env_key, spec.private_dir_name, spec.filename
    ))
}

fn validate_user_env(user_env: &HashMap<String, String>) -> Result<(), String> {
    let mut entries: Vec<(&String, &String)> = user_env.iter().collect();
    entries.sort_by_key(|(key, _)| *key);

    for (key, value) in entries {
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            return Err(format!(
                "{USER_ENV_FILE_ENV_KEY} contains invalid env key {:?}",
                guest_contracts::env::sanitize_env_key_for_diagnostic(key)
            ));
        }
        if value.contains('\0') {
            return Err(format!(
                "{USER_ENV_FILE_ENV_KEY} contains NUL byte for env key {:?}",
                guest_contracts::env::sanitize_env_key_for_diagnostic(key)
            ));
        }
    }

    Ok(())
}

fn resolve_home_dir(
    user_env: &HashMap<String, String>,
    process_home: Option<&str>,
) -> Result<String, String> {
    if let Some(home) = user_env.get("HOME") {
        return Ok(home.clone());
    }
    process_home
        .map(str::to_string)
        .ok_or_else(|| "HOME must be set in guest sandbox (rootfs init contract)".to_string())
}

#[cfg(debug_assertions)]
fn resolve_claude_config_dir(raw: &GuestConfigRaw) -> String {
    if let Some(path) = raw
        .test_claude_config_dir
        .as_deref()
        .filter(|path| !path.as_os_str().is_empty())
    {
        return path.to_string_lossy().into_owned();
    }

    CANONICAL_CLAUDE_CONFIG_DIR.to_string()
}

#[cfg(not(debug_assertions))]
fn resolve_claude_config_dir(_raw: &GuestConfigRaw) -> String {
    CANONICAL_CLAUDE_CONFIG_DIR.to_string()
}

#[cfg(debug_assertions)]
fn resolve_codex_home_dir(raw: &GuestConfigRaw) -> String {
    if let Some(path) = raw
        .test_codex_home_dir
        .as_deref()
        .filter(|path| !path.as_os_str().is_empty())
    {
        return path.to_string_lossy().into_owned();
    }

    CANONICAL_CODEX_HOME_DIR.to_string()
}

#[cfg(not(debug_assertions))]
fn resolve_codex_home_dir(_raw: &GuestConfigRaw) -> String {
    CANONICAL_CODEX_HOME_DIR.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_DEFAULT_SECS: u64 = 10;
    const TEST_MAX_SECS: u64 = 60;

    fn raw_config_fixture() -> GuestConfigRaw {
        GuestConfigRaw {
            run_id: "run-123".to_string(),
            home: Some("/home/vm0".to_string()),
            ..GuestConfigRaw::default()
        }
    }

    fn write_user_env_fixture(json: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp
            .path()
            .join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
        std::fs::write(&path, json).unwrap();
        (tmp, path)
    }

    fn write_run_payload_fixture(
        runtime_dir: &Path,
        payload: &guest_contracts::env::RunPayload,
    ) -> std::path::PathBuf {
        let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
        std::fs::write(&path, serde_json::to_vec(payload).unwrap()).unwrap();
        path
    }

    fn raw_config_fixture_with_run_payload(
        payload: &guest_contracts::env::RunPayload,
    ) -> (tempfile::TempDir, GuestConfigRaw) {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let run_payload_file = write_run_payload_fixture(&runtime_dir, payload);
        let raw = GuestConfigRaw {
            run_payload_file: run_payload_file.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            ..raw_config_fixture()
        };
        (tmp, raw)
    }

    fn raw_config_fixture_with_default_run_payload() -> (tempfile::TempDir, GuestConfigRaw) {
        raw_config_fixture_with_run_payload(&guest_contracts::env::RunPayload::default())
    }

    #[test]
    fn bounded_duration_secs_value_defaults_when_unset() {
        assert_eq!(
            bounded_duration_secs_value_or("TEST_TIMEOUT", None, TEST_DEFAULT_SECS, TEST_MAX_SECS),
            Duration::from_secs(TEST_DEFAULT_SECS)
        );
    }

    #[test]
    fn bounded_duration_secs_value_defaults_when_invalid() {
        assert_eq!(
            bounded_duration_secs_value_or(
                "TEST_TIMEOUT",
                Some("not-a-number"),
                TEST_DEFAULT_SECS,
                TEST_MAX_SECS,
            ),
            Duration::from_secs(TEST_DEFAULT_SECS)
        );
    }

    #[test]
    fn bounded_duration_secs_value_defaults_when_above_max() {
        assert_eq!(
            bounded_duration_secs_value_or(
                "TEST_TIMEOUT",
                Some("61"),
                TEST_DEFAULT_SECS,
                TEST_MAX_SECS,
            ),
            Duration::from_secs(TEST_DEFAULT_SECS)
        );
    }

    #[test]
    fn bounded_duration_secs_value_accepts_zero() {
        assert_eq!(
            bounded_duration_secs_value_or(
                "TEST_TIMEOUT",
                Some("0"),
                TEST_DEFAULT_SECS,
                TEST_MAX_SECS,
            ),
            Duration::ZERO
        );
    }

    #[test]
    fn bounded_duration_secs_value_accepts_value_at_max() {
        assert_eq!(
            bounded_duration_secs_value_or(
                "TEST_TIMEOUT",
                Some("60"),
                TEST_DEFAULT_SECS,
                TEST_MAX_SECS,
            ),
            Duration::from_secs(TEST_MAX_SECS)
        );
    }

    #[test]
    fn agent_execution_timeout_is_optional_and_strict() {
        assert_eq!(
            optional_positive_duration_secs(AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC, None,).unwrap(),
            None
        );
        assert_eq!(
            optional_positive_duration_secs(AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC, Some("7200"),)
                .unwrap(),
            Some(Duration::from_secs(7200))
        );

        for invalid in ["0", "-1", "not-a-number", "18446744073709551615"] {
            let error =
                optional_positive_duration_secs(AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC, Some(invalid))
                    .unwrap_err();
            assert!(
                error.contains(AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC),
                "{error}"
            );
            assert!(
                !error.contains(guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV),
                "{error}"
            );
        }
    }

    #[test]
    fn framework_from_cli_agent_type_accepts_known_values_and_defaults_unknown() {
        assert_eq!(framework_from_cli_agent_type(""), Framework::ClaudeCode);
        assert_eq!(
            framework_from_cli_agent_type("claude-code"),
            Framework::ClaudeCode
        );
        assert_eq!(framework_from_cli_agent_type("codex"), Framework::Codex);
        assert_eq!(framework_from_cli_agent_type("pi"), Framework::Pi);
        assert_eq!(
            framework_from_cli_agent_type("unexpected"),
            Framework::ClaudeCode
        );
    }

    #[test]
    fn guest_config_preserves_unknown_cli_agent_type_while_falling_back() {
        let (_tmp, raw) =
            raw_config_fixture_with_run_payload(&guest_contracts::env::RunPayload::default());
        let raw = GuestConfigRaw {
            cli_agent_type: "custom-agent".to_string(),
            ..raw
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.cli_agent_type, "custom-agent");
        assert_eq!(config.framework, Framework::ClaudeCode);
    }

    #[test]
    fn guest_config_from_raw_builds_owned_config_without_process_env_mutation() {
        let payload = guest_contracts::env::RunPayload {
            prompt: "hello".to_string(),
            append_system_prompt: "extra system".to_string(),
            secret_values: "encoded-secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts:
                r#"[{"name":"artifact","mountPath":"/mnt/a","storageId":"storage","versionId":"v1"}]"#
                    .to_string(),
            ..guest_contracts::env::RunPayload::default()
        };
        let (_tmp, raw) = raw_config_fixture_with_run_payload(&payload);
        let raw = GuestConfigRaw {
            api_url: "https://api.example.test".to_string(),
            api_token: String::new(),
            sandbox_id: "sandbox-1".to_string(),
            sandbox_reuse_result: "reused".to_string(),
            workspace_reuse_result: "sandboxReused".to_string(),
            vercel_bypass: "bypass".to_string(),
            resume_session_id: "session-1".to_string(),
            api_start_time: "123".to_string(),
            agent_execution_timeout_secs: "11".to_string(),
            use_mock_claude: "true".to_string(),
            cli_agent_type: "codex".to_string(),
            use_mock_codex: "1".to_string(),
            stuck_tool_timeout_secs: "7".to_string(),
            post_result_sigterm_grace_secs: "8".to_string(),
            post_result_total_cap_secs: "9".to_string(),
            post_result_sigkill_grace_secs: "10".to_string(),
            ..raw
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.run_id, "run-123");
        assert_eq!(config.api_url, "https://api.example.test");
        assert_eq!(config.api_token, "");
        assert_eq!(config.sandbox_id, "sandbox-1");
        assert_eq!(config.sandbox_reuse_result, "reused");
        assert_eq!(config.workspace_reuse_result, "sandboxReused");
        assert_eq!(config.prompt, "hello");
        assert_eq!(config.append_system_prompt, "extra system");
        assert_eq!(config.vercel_bypass, "bypass");
        assert_eq!(config.resume_session_id, "session-1");
        assert_eq!(config.api_start_time, "123");
        assert_eq!(
            config.agent_execution_timeout,
            Some(Duration::from_secs(11))
        );
        assert_eq!(config.secret_values, "encoded-secret");
        assert_eq!(config.disallowed_tools, "WebFetch");
        assert_eq!(config.tools, "Bash");
        assert_eq!(config.settings, "{}");
        assert!(config.use_mock_claude);
        assert_eq!(config.mock_claude_path, DEFAULT_MOCK_CLAUDE_PATH);
        assert_eq!(config.cli_agent_type, "codex");
        assert_eq!(config.framework, Framework::Codex);
        assert!(config.use_mock_codex);
        assert_eq!(config.mock_codex_path, DEFAULT_MOCK_CODEX_PATH);
        assert_eq!(config.home_dir, "/home/vm0");
        assert_eq!(config.claude_config_dir, CANONICAL_CLAUDE_CONFIG_DIR);
        assert_eq!(config.codex_home_dir, CANONICAL_CODEX_HOME_DIR);
        assert_eq!(config.stuck_tool_timeout_secs, 7);
        assert_eq!(config.post_result_sigterm_grace, Duration::from_secs(8));
        assert_eq!(config.post_result_total_cap, Duration::from_secs(9));
        assert_eq!(config.post_result_sigkill_grace, Duration::from_secs(10));
        let artifact = config.artifacts.first().unwrap();
        assert_eq!(artifact.name, "artifact");
        assert_eq!(artifact.mount_path, "/mnt/a");
        assert_eq!(artifact.storage_id, "storage");
        assert_eq!(artifact.version_id, "v1");
    }

    #[test]
    fn guest_config_from_raw_loads_user_env_and_removes_private_file() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
        std::fs::create_dir_all(&user_env_dir).unwrap();
        let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
        std::fs::write(
            &user_env_path,
            r#"{"HOME":"/home/from-user-env","OPENAI_MODEL":"gpt-test"}"#,
        )
        .unwrap();
        let run_payload_file =
            write_run_payload_fixture(&runtime_dir, &guest_contracts::env::RunPayload::default());

        let raw = GuestConfigRaw {
            user_env_file: user_env_path.to_string_lossy().into_owned(),
            run_payload_file: run_payload_file.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            home: Some("/home/from-process".to_string()),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.home_dir, "/home/from-user-env");
        assert_eq!(config.claude_config_dir, CANONICAL_CLAUDE_CONFIG_DIR);
        assert_eq!(config.codex_home_dir, CANONICAL_CODEX_HOME_DIR);
        assert_eq!(
            config.user_env.get("OPENAI_MODEL").map(String::as_str),
            Some("gpt-test")
        );
        assert!(!user_env_path.exists());
        assert!(!user_env_dir.exists());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn guest_config_from_raw_uses_captured_test_claude_config_dir() {
        let (_tmp, raw) = raw_config_fixture_with_default_run_payload();
        let raw = GuestConfigRaw {
            test_claude_config_dir: Some(PathBuf::from("/tmp/captured-claude-config")),
            ..raw
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.claude_config_dir, "/tmp/captured-claude-config");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn guest_config_from_raw_uses_captured_test_codex_home() {
        let (_tmp, raw) = raw_config_fixture_with_default_run_payload();
        let raw = GuestConfigRaw {
            test_codex_home_dir: Some(PathBuf::from("/tmp/captured-codex-home")),
            ..raw
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.codex_home_dir, "/tmp/captured-codex-home");
    }

    #[test]
    fn guest_config_from_raw_loads_run_payload_and_removes_private_file() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let payload = guest_contracts::env::RunPayload {
            prompt: "payload prompt".to_string(),
            append_system_prompt: "payload system".to_string(),
            secret_values: "payload-secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts:
                r#"[{"name":"artifact","mountPath":"/mnt/a","storageId":"storage","versionId":"v1"}]"#
                    .to_string(),
            feature_flags: r#"{"flag":true}"#.to_string(),
            codex_runtime_config: r#"{"providerId":"openrouter-codex"}"#.to_string(),
            pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
            pi_model_config: r#"{"provider":"openrouter"}"#.to_string(),
            pi_session_id: "22222222-2222-4222-8222-222222222222".to_string(),
            pi_installed_cli_requirement: r#"{"minCliVersion":"9.352.7"}"#.to_string(),
        };
        let path = write_run_payload_fixture(&runtime_dir, &payload);
        let parent = path.parent().unwrap().to_path_buf();

        let raw = GuestConfigRaw {
            run_payload_file: path.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.prompt, "payload prompt");
        assert_eq!(config.append_system_prompt, "payload system");
        assert_eq!(config.secret_values, "payload-secret");
        assert_eq!(config.disallowed_tools, "WebFetch");
        assert_eq!(config.tools, "Bash");
        assert_eq!(config.settings, "{}");
        assert_eq!(config.artifacts.len(), 1);
        assert_eq!(config.feature_flags.get("flag"), Some(&true));
        assert_eq!(
            config.codex_runtime_config,
            r#"{"providerId":"openrouter-codex"}"#
        );
        assert_eq!(config.pi_launch_config, r#"{"schemaVersion":2}"#);
        assert_eq!(config.pi_model_config, r#"{"provider":"openrouter"}"#);
        assert_eq!(config.pi_session_id, "22222222-2222-4222-8222-222222222222");
        assert_eq!(
            config.pi_installed_cli_requirement,
            r#"{"minCliVersion":"9.352.7"}"#
        );
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn guest_config_from_raw_rejects_run_payload_outside_runtime_dir_without_path_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let unexpected = tmp
            .path()
            .join("other")
            .join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME)
            .join(guest_contracts::env::RUN_PAYLOAD_FILENAME);

        let raw = GuestConfigRaw {
            run_payload_file: unexpected.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            ..raw_config_fixture()
        };

        let err = GuestConfig::from_raw(raw).err().unwrap();

        assert!(err.contains("run-payload/payload.json"));
        assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
    }

    #[test]
    fn load_run_payload_from_path_rejects_nul_without_value_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let payload = guest_contracts::env::RunPayload {
            prompt: "secret\0prompt".to_string(),
            ..guest_contracts::env::RunPayload::default()
        };
        let path = write_run_payload_fixture(&runtime_dir, &payload);
        let parent = path.parent().unwrap().to_path_buf();

        let err = load_run_payload_from_path(&path).unwrap_err();

        assert!(err.contains(guest_contracts::env::PROMPT_RUN_PAYLOAD_FIELD));
        assert!(!err.contains("secret"));
        assert!(!err.contains("prompt"));
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn load_run_payload_from_path_removes_file_before_parse_error() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
        std::fs::write(&path, r#"{"prompt":"secret""#).unwrap();

        let err = load_run_payload_from_path(&path).unwrap_err();

        assert!(err.contains("parse"));
        assert!(!err.contains("secret"));
        assert!(!path.exists());
        assert!(!dir.exists());
    }

    #[test]
    fn guest_config_from_raw_validates_user_env_with_runtime_home_when_home_string_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_home = tmp.path().join("home");
        let runtime_dir =
            guest_contracts::runtime_paths::run_dir_for_home(&runtime_home, "run-123").unwrap();
        let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
        std::fs::create_dir_all(&user_env_dir).unwrap();
        let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
        std::fs::write(
            &user_env_path,
            r#"{"HOME":"/home/from-user-env","OPENAI_MODEL":"gpt-runtime-home"}"#,
        )
        .unwrap();
        let run_payload_file =
            write_run_payload_fixture(&runtime_dir, &guest_contracts::env::RunPayload::default());

        let raw = GuestConfigRaw {
            user_env_file: user_env_path.to_string_lossy().into_owned(),
            run_payload_file: run_payload_file.to_string_lossy().into_owned(),
            home: None,
            runtime_home: Some(runtime_home),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.home_dir, "/home/from-user-env");
        assert_eq!(config.claude_config_dir, CANONICAL_CLAUDE_CONFIG_DIR);
        assert_eq!(
            config.user_env.get("OPENAI_MODEL").map(String::as_str),
            Some("gpt-runtime-home")
        );
        assert!(!user_env_path.exists());
        assert!(!user_env_dir.exists());
    }

    #[test]
    fn guest_config_from_raw_preserves_empty_process_home() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let run_payload_file =
            write_run_payload_fixture(&runtime_dir, &guest_contracts::env::RunPayload::default());
        let raw = GuestConfigRaw {
            home: Some(String::new()),
            run_payload_file: run_payload_file.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.home_dir, "");
        assert_eq!(config.claude_config_dir, CANONICAL_CLAUDE_CONFIG_DIR);
        assert_eq!(config.codex_home_dir, CANONICAL_CODEX_HOME_DIR);
    }

    #[test]
    fn guest_config_from_raw_preserves_explicit_empty_mock_paths() {
        let (_tmp, raw) = raw_config_fixture_with_default_run_payload();
        let raw = GuestConfigRaw {
            mock_claude_path: Some(String::new()),
            mock_codex_path: Some(String::new()),
            ..raw
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.mock_claude_path, "");
        assert_eq!(config.mock_codex_path, "");
    }

    #[test]
    fn guest_config_from_raw_reports_invalid_artifacts() {
        let payload = guest_contracts::env::RunPayload {
            artifacts: "{not-json".to_string(),
            ..guest_contracts::env::RunPayload::default()
        };
        let (_tmp, raw) = raw_config_fixture_with_run_payload(&payload);

        let err = GuestConfig::from_raw(raw).err().unwrap();

        assert!(err.contains(guest_contracts::env::ARTIFACTS_RUN_PAYLOAD_FIELD));
    }

    #[test]
    fn guest_config_from_raw_rejects_user_env_outside_runtime_dir_without_path_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let unexpected = tmp
            .path()
            .join("other")
            .join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME)
            .join(guest_contracts::env::USER_ENV_FILENAME);
        let run_payload_file =
            write_run_payload_fixture(&runtime_dir, &guest_contracts::env::RunPayload::default());

        let raw = GuestConfigRaw {
            user_env_file: unexpected.to_string_lossy().into_owned(),
            run_payload_file: run_payload_file.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            ..raw_config_fixture()
        };

        let err = GuestConfig::from_raw(raw).err().unwrap();

        assert!(err.contains("user-env/env.json"));
        assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
    }

    #[test]
    fn load_user_env_from_path_loads_provider_values_and_removes_file() {
        let (_tmp, path) = write_user_env_fixture(
            r#"{"OPENAI_API_KEY":"sk-test","OPENAI_MODEL":"gpt-test","CHATGPT_ACCOUNT_ID":"acct"}"#,
        );
        let parent = path.parent().unwrap().to_path_buf();

        let user_env = load_user_env_from_path(&path).unwrap();

        assert_eq!(user_env.get("OPENAI_API_KEY").unwrap(), "sk-test");
        assert_eq!(user_env.get("OPENAI_MODEL").unwrap(), "gpt-test");
        assert_eq!(user_env.get("CHATGPT_ACCOUNT_ID").unwrap(), "acct");
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn load_user_env_from_path_rejects_invalid_key_without_value_leak() {
        let (_tmp, path) =
            write_user_env_fixture(r#"{"BAD-KEY":"secret-value","OPENAI_API_KEY":"sk-test"}"#);
        let parent = path.parent().unwrap().to_path_buf();

        let err = load_user_env_from_path(&path).unwrap_err();

        assert!(err.contains("BAD-KEY"));
        assert!(!err.contains("secret-value"));
        assert!(!err.contains("sk-test"));
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn load_user_env_from_path_removes_file_before_parse_error() {
        let (_tmp, path) = write_user_env_fixture(r#"{"OPENAI_API_KEY":"sk-test""#);
        let parent = path.parent().unwrap().to_path_buf();

        let err = load_user_env_from_path(&path).unwrap_err();

        assert!(err.contains("parse"));
        assert!(!err.contains("sk-test"));
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn load_user_env_from_path_keeps_unexpected_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("unexpected-user-env-dir");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
        std::fs::write(&path, r#"{"OPENAI_MODEL":"gpt-test"}"#).unwrap();

        let user_env = load_user_env_from_path(&path).unwrap();

        assert_eq!(user_env.get("OPENAI_MODEL").unwrap(), "gpt-test");
        assert!(!path.exists());
        assert!(dir.exists());
    }

    #[test]
    fn load_run_payload_from_path_keeps_unexpected_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("unexpected-run-payload-dir");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
        let payload = guest_contracts::env::RunPayload {
            prompt: "payload prompt".to_string(),
            ..guest_contracts::env::RunPayload::default()
        };
        std::fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();

        let loaded = load_run_payload_from_path(&path).unwrap();

        assert_eq!(loaded.prompt, "payload prompt");
        assert!(!path.exists());
        assert!(dir.exists());
    }

    #[test]
    fn validate_user_env_file_path_rejects_unexpected_path() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let unexpected = tmp
            .path()
            .join("other")
            .join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME)
            .join(guest_contracts::env::USER_ENV_FILENAME);

        let err = validate_private_runtime_file_path_for_runtime(
            &unexpected,
            &runtime_dir,
            USER_ENV_PRIVATE_FILE,
        )
        .unwrap_err();

        assert!(err.contains("user-env/env.json"));
        assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
        assert!(
            validate_private_runtime_file_path_for_runtime(
                &private_runtime_file_path_for_runtime(&runtime_dir, USER_ENV_PRIVATE_FILE),
                &runtime_dir,
                USER_ENV_PRIVATE_FILE,
            )
            .is_ok()
        );
    }

    #[test]
    fn guest_runtime_dir_for_user_env_returns_error_when_run_id_missing() {
        let err = guest_runtime_dir_for_private_file_values(
            USER_ENV_FILE_ENV_KEY,
            "",
            None,
            Some(Path::new("/home/vm0")),
        )
        .unwrap_err();

        assert!(err.contains("OKOU_RUN_ID is required"));
    }

    #[test]
    fn load_user_env_from_path_rejects_nul_value_without_value_leak() {
        let (_tmp, path) = write_user_env_fixture("{\"OPENAI_API_KEY\":\"sk-test\\u0000secret\"}");
        let parent = path.parent().unwrap().to_path_buf();

        let err = load_user_env_from_path(&path).unwrap_err();

        assert!(err.contains("OPENAI_API_KEY"));
        assert!(!err.contains("sk-test"));
        assert!(!err.contains("secret"));
        assert!(!path.exists());
        assert!(!parent.exists());
    }
}
