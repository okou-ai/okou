//! Public facade for CLI setup and execution.
//!
//! This module keeps the external `guest_agent::cli` boundary stable while
//! private submodules own focused execution policies:
//!
//! - `codex_app_server_events`: Codex app-server notification compatibility mapping.
//! - `codex_setup`: pre-exec Codex auth/bootstrap.
//! - `command`: Claude Code command construction.
//! - `diagnostics`: bounded stderr tail collection.
//! - `event_delivery`: event sender watermark state.
//! - `provider_event_normalization`: provider semantic arrays before sequencing.
//! - `claude`: Claude Code tool tracking.
//! - `jsonl_result`: shared terminal result parsing for JSONL CLI backends.
//! - `termination`: process-group termination FSM.
//!
//! [`execute_cli_with_controls_for_config_started_at`] enters the shared Claude
//! Code/Pi JSONL subprocess orchestration implemented by the private
//! `execute_cli_inner`, while `codex_app_server_backend` owns the Codex JSON-RPC
//! lifecycle. Each path retains ownership of its process, event delivery,
//! heartbeat races, and child reaping until completion.

mod bounded_event_delivery;
mod child_env;
mod child_exit_notifier;
mod claude;
#[doc(hidden)]
pub mod codex_app_server;
mod codex_app_server_backend;
mod codex_app_server_events;
mod codex_citation_repair;
mod codex_citation_source;
mod codex_event_delivery;
mod codex_runtime_config;
mod codex_setup;
mod codex_startup;
mod command;
mod diagnostics;
mod event_delivery;
#[cfg(test)]
mod event_delivery_budget_tests;
mod exec_boundary;
mod jsonl_result;
mod line_reader;
mod pi_event_delivery;
mod pi_memory_citation;
mod pi_rpc;
mod pi_session_output;
mod process_group;
mod provider_event_normalization;
mod reasoning_effort;
mod termination;

pub use codex_setup::setup_codex_for_config;
pub use codex_startup::CodexStartupTiming;
pub use jsonl_result::{JsonlResultStatus, JsonlResultSummary};

use crate::active_input::{ActiveInputController, ActiveInputWriter, ReplayUserEventAction};
use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::failure_patterns;
use crate::heartbeat::HeartbeatFailure;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use crate::session_metadata::{SessionHistoryLaunchSource, SessionMetadataStore};
use crate::timing;
use api_contracts::generated::types::runners::runs::CodexRuntimeConfig;
use event_delivery::{EventDeliveryReport, EventDeliveryRuntime, EventDeliverySender};
use guest_contracts::diagnostics::{
    CliObservedExitDiagnostic, CliTerminationDiagnostic, EventDeliveryDiagnostic,
    FailureDetailSource, FailureReason, HeartbeatFailureDiagnostic,
};
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use guest_telemetry::telemetry::record_sandbox_op;
use guest_telemetry::{log_info, log_warn};
use process_group::ChildProcessGroup;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};
use termination::{
    CliTerminationRuntime, ControlTerminationLog, PostResultCleanupPolicy, TerminationReason,
};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::oneshot;
use tokio::time::Sleep;
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";
const AGENT_LOG_BUFFER_BYTES: usize = 8 * 1024;
const OPENAI_BASE_URL_ENV_KEY: &str = "OPENAI_BASE_URL";
const OKOU_AGENT_ID_ENV_KEY: &str = "OKOU_AGENT_ID";
const CODEX_SERVICE_TIER_CANONICAL_ENV: &str = "OKOU_CODEX_SERVICE_TIER";
const CLI_PACKAGE_URL_ENV_KEY: &str = "CLI_PKG_URL";
const PI_LANGFUSE_DEBUG_ENABLED_ENV_KEY: &str = "OKOU_PI_LANGFUSE_DEBUG_ENABLED";
const PI_LANGFUSE_CONFIG_FILE_ENV_KEY: &str = "OKOU_PI_LANGFUSE_CONFIG_FILE";
const LANGFUSE_PUBLIC_KEY_ENV_KEY: &str = "LANGFUSE_PUBLIC_KEY";
const LANGFUSE_SECRET_KEY_ENV_KEY: &str = "LANGFUSE_SECRET_KEY";
const LANGFUSE_BASE_URL_ENV_KEY: &str = "LANGFUSE_BASE_URL";
const LANGFUSE_USER_ID_ENV_KEY: &str = "LANGFUSE_USER_ID";
const LANGFUSE_TRACING_ENVIRONMENT_ENV_KEY: &str = "LANGFUSE_TRACING_ENVIRONMENT";
const PI_LANGFUSE_CONFIG_FILENAME: &str = "langfuse-bootstrap.json";
const WEB_SEARCH_TOOL_NAME: &str = "WebSearch";
const MAX_EVENT_SEQUENCE_NUMBER: u32 = i32::MAX as u32;
const CODEX_FIXED_STARTUP_CONFIGS: [&str; 5] = [
    "analytics.enabled=false",
    "features.plugins=false",
    "features.apps=false",
    "features.goals=false",
    "features.image_generation=false",
];
const CODEX_FAST_MODE_STARTUP_CONFIGS: [&str; 2] =
    ["features.fast_mode=true", r#"service_tier="fast""#];
const CODEX_WEB_SEARCH_DISABLED_CONFIG: &str = r#"web_search="disabled""#;

#[derive(serde::Serialize)]
struct ClaudeUserFrame<'a> {
    #[serde(rename = "type")]
    event_type: &'static str,
    uuid: String,
    parent_tool_use_id: Option<&'static str>,
    message: ClaudeUserMessage<'a>,
}

#[derive(serde::Serialize)]
struct ClaudeUserMessage<'a> {
    role: &'static str,
    content: &'a str,
}

fn claude_user_frame<'a>(uuid: &str, text: &'a str) -> ClaudeUserFrame<'a> {
    ClaudeUserFrame {
        event_type: "user",
        uuid: uuid.to_owned(),
        parent_tool_use_id: None,
        message: ClaudeUserMessage {
            role: "user",
            content: text,
        },
    }
}

#[cfg(test)]
fn claude_initial_prompt_frame<'a>(run_id: &str, prompt: &'a str) -> ClaudeUserFrame<'a> {
    let uuid = crate::active_input::claude_initial_prompt_uuid(run_id);
    claude_user_frame(&uuid, prompt)
}

async fn write_claude_user_frame_to_stdin(
    stdin: &mut tokio::process::ChildStdin,
    uuid: &str,
    text: &str,
) -> Result<(), AgentError> {
    let mut line = serde_json::to_vec(&claude_user_frame(uuid, text))?;
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

async fn write_claude_stream_json_to_stdin(
    mut stdin: tokio::process::ChildStdin,
    run_id: &str,
    prompt: &str,
    mut active_input: ActiveInputWriter,
) -> Result<(), AgentError> {
    let initial_uuid = crate::active_input::claude_initial_prompt_uuid(run_id);
    write_claude_user_frame_to_stdin(&mut stdin, &initial_uuid, prompt).await?;
    if !active_input.is_enabled() {
        active_input.close_terminal();
        return Ok(());
    }

    while let Some(frame) = active_input.next_frame().await {
        active_input.mark_writing(&frame.uuid);
        if let Err(error) =
            write_claude_user_frame_to_stdin(&mut stdin, &frame.uuid, &frame.text).await
        {
            active_input.mark_backend_failed(&frame);
            return Err(error);
        }
        active_input.mark_backend_accepted_with_replay(&frame)?;
    }

    active_input.close_terminal();
    Ok(())
}

/// Bounded terminal failure detail extracted from a CLI event stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliFailureDiagnostic {
    /// Terminal failure message selected from a CLI event.
    ///
    /// When produced by [`execute_cli_with_active_input_for_config`], this
    /// message has already been secret-masked, line-break escaped, and bounded
    /// before exposure.
    pub message: String,

    /// High-level source of the event-derived failure detail.
    ///
    /// Values produced by [`execute_cli_with_active_input_for_config`] use
    /// `ClaudeResult` for Claude Code terminal result events and `CodexJsonl`
    /// for Codex compatibility JSONL failure events. The final run diagnostic
    /// may still prefer stderr when this event message is generic.
    pub source: FailureDetailSource,

    /// Optional structured failure reason parsed from supported CLI payloads.
    ///
    /// `None` means no supported structured reason was observed. A reason may
    /// be carried independently from the selected display message, including
    /// when a generic stdout message is replaced by a more specific message or
    /// stderr fallback.
    pub failure_reason: Option<FailureReason>,
}

/// Result returned after the configured CLI process exits.
///
/// The guest agent uses this summary to report final run status and to persist
/// the event-drain watermark consumed by host/API clients.
#[derive(Debug)]
pub struct CliExecutionResult {
    /// Terminal outcome code for the configured CLI backend.
    ///
    /// For Claude Code execution, this is the CLI process exit code. On Unix,
    /// signal termination is mapped to `128 + signal`, matching shell
    /// convention, so SIGKILL is reported as `137`.
    ///
    /// For Codex app-server execution, completed turns map to `0`, while failed
    /// or interrupted turns and terminal non-retry errors map to `1`. These are
    /// protocol-level outcomes, not the child process wait status.
    pub exit_code: i32,

    /// Raw CLI process exit observation before signal exits are flattened, when
    /// available.
    ///
    /// `None` means raw process-exit attribution is unavailable. Codex
    /// app-server execution leaves this unset because its outcome is derived
    /// from terminal protocol events, not the child process wait status.
    pub cli_observed_exit: Option<CliObservedExitDiagnostic>,

    /// Best-effort, secret-masked stderr tail captured from the CLI.
    ///
    /// The guest agent keeps at most the last 200 stderr lines for failure
    /// diagnostics. Stderr lines longer than 16 KiB after CRLF normalization,
    /// or after lossy UTF-8 decoding, are replaced with an omission marker
    /// rather than partially returned, so secret masking never has to process a
    /// truncated secret. Invalid UTF-8 is decoded lossily into a valid string
    /// when the decoded diagnostic still fits the limit. It may be empty if the
    /// CLI wrote no stderr or stderr draining timed out after process exit, and
    /// it may be incomplete if stderr reading fails.
    pub stderr_lines: Vec<String>,

    /// Highest contiguous agent event sequence whose webhook POST succeeded.
    ///
    /// This is a terminal event-drain watermark, not merely the last event read
    /// from stdout. `None` means no contiguous event prefix was acknowledged,
    /// such as no-API mode, no emitted events, or failure before the first event
    /// was successfully posted.
    pub last_event_sequence: Option<u32>,

    /// Bounded event-delivery failure details, when delivery was terminally incomplete.
    pub event_delivery: Option<EventDeliveryDiagnostic>,

    /// Bounded heartbeat failure details, when the control path stopped making progress.
    pub heartbeat: Option<HeartbeatFailureDiagnostic>,

    /// Final JSONL result metadata, when a terminal result event was observed.
    /// Codex uses its own event schema and leaves this unset.
    pub jsonl_result: Option<JsonlResultSummary>,

    /// JSONL result that armed post-result cleanup, when cleanup was armed.
    /// This is intentionally separate from `jsonl_result` because late drained
    /// stdout may contain another result event after cleanup starts.
    pub post_result_cleanup_jsonl_result: Option<JsonlResultSummary>,

    /// Best-effort, secret-masked terminal failure diagnostic parsed from the
    /// framework event stream.
    ///
    /// Frameworks can report terminal failures as structured events rather
    /// than stderr. Keeping the diagnostic here lets the guest-agent surface
    /// the actual failure reason in its final run error.
    pub failure_diagnostic: Option<CliFailureDiagnostic>,

    /// Guest-agent control-path error that caused the CLI process group to be
    /// terminated after a meaningful process summary could still be collected.
    pub control_error: Option<AgentError>,

    /// Structured attribution for guest-agent initiated CLI process-group
    /// termination.
    pub cli_termination: Option<CliTerminationDiagnostic>,

    /// Backend-accepted delivery identities settled or recoverable at completion.
    pub active_input_delivery_ids: Vec<String>,
}

/// One-shot outcome reported by the heartbeat loop or task while CLI execution is in progress.
///
/// Heartbeat completion signal observed by CLI execution.
///
/// The top-level guest-agent owns the heartbeat task handle so shutdown can
/// stop it before final telemetry. CLI execution only needs this one-shot
/// status while the CLI process is running.
pub enum HeartbeatStatus {
    /// The heartbeat loop returned an error while CLI execution was running.
    ///
    /// CLI execution treats this as a guest-agent control-path failure and may
    /// terminate the CLI process group so final diagnostics can report the
    /// heartbeat failure.
    Failed(HeartbeatFailure),

    /// The heartbeat loop stopped cleanly.
    ///
    /// During CLI execution this is a non-error completion signal for the
    /// heartbeat race.
    Stopped,

    /// The heartbeat task itself failed, such as a task panic or join error.
    ///
    /// The shared [`execute_cli_with_controls_for_config_started_at`] execution
    /// path surfaces this as a guest-agent execution error and may terminate
    /// the CLI process group if no earlier control-path termination is already
    /// in progress.
    TaskFailed(String),
}

/// Optional heartbeat completion receiver for a CLI execution.
///
/// `Some(receiver)` races CLI execution against heartbeat completion. `None`
/// disables heartbeat monitoring for that run, which is useful for tests and
/// callers that do not own a heartbeat task.
pub type HeartbeatMonitor = Option<oneshot::Receiver<HeartbeatStatus>>;

#[derive(Clone, Copy)]
struct AgentExecutionDeadline {
    at: Instant,
    timeout_secs: u64,
}

pub(super) struct CliRuntimeConfig<'a> {
    framework: env::Framework,
    run_id: Cow<'a, str>,
    prompt: Cow<'a, str>,
    resume_session_id: Cow<'a, str>,
    append_system_prompt: Cow<'a, str>,
    disallowed_tools: Cow<'a, str>,
    tools: Cow<'a, str>,
    settings: Cow<'a, str>,
    use_mock_claude: bool,
    mock_claude_path: Cow<'a, str>,
    use_mock_codex: bool,
    mock_codex_path: Cow<'a, str>,
    home_dir: Cow<'a, str>,
    claude_config_dir: Cow<'a, str>,
    codex_home_dir: Cow<'a, str>,
    api_url: Cow<'a, str>,
    api_start_time: Cow<'a, str>,
    anthropic_model: Cow<'a, str>,
    openai_model: Cow<'a, str>,
    openai_base_url: Cow<'a, str>,
    codex_runtime_config: Option<CodexRuntimeConfig>,
    codex_oauth_mode: bool,
    codex_fast_mode: bool,
    reasoning_effort: Option<&'a str>,
    disable_builtin_web_search: bool,
    agent_execution_deadline: Option<AgentExecutionDeadline>,
    stuck_tool_timeout_secs: u64,
    post_result_cleanup_policy: PostResultCleanupPolicy,
    agent_log_file: Cow<'a, str>,
    session_id_file: Cow<'a, str>,
    session_history_launch_source: SessionHistoryLaunchSource,
    claude_append_system_prompt_file: Cow<'a, str>,
    pi_session_id: Cow<'a, str>,
    pi_launch_config: Cow<'a, str>,
    pi_launch_payload_file: Cow<'a, str>,
    pi_model_config: Cow<'a, str>,
    user_env: &'a HashMap<String, String>,
}

impl<'a> CliRuntimeConfig<'a> {
    fn from_config(
        config: &'a env::GuestConfig,
        paths: &'a paths::GuestPaths,
        execution_started_at: Instant,
    ) -> Result<Self, AgentError> {
        let codex_runtime_config = if matches!(config.framework, env::Framework::Codex) {
            codex_runtime_config::parse_raw(&config.codex_runtime_config)?
        } else {
            None
        };
        let disable_builtin_web_search = config.user_env.contains_key(OKOU_AGENT_ID_ENV_KEY);
        let disallowed_tools = disallowed_tools_with_builtin_web_search_disabled(
            &config.disallowed_tools,
            disable_builtin_web_search,
        );
        let agent_execution_deadline = config
            .agent_execution_timeout
            .map(|timeout| {
                execution_started_at
                    .checked_add(timeout)
                    .map(|at| AgentExecutionDeadline {
                        at,
                        timeout_secs: timeout.as_secs(),
                    })
                    .ok_or_else(|| {
                        AgentError::Execution(format!(
                            "{} is too large",
                            env::AGENT_EXECUTION_TIMEOUT_DIAGNOSTIC
                        ))
                    })
            })
            .transpose()?;
        Ok(Self {
            framework: config.framework,
            run_id: Cow::Borrowed(&config.run_id),
            prompt: Cow::Borrowed(&config.prompt),
            resume_session_id: Cow::Borrowed(&config.resume_session_id),
            append_system_prompt: Cow::Borrowed(&config.append_system_prompt),
            disallowed_tools,
            tools: Cow::Borrowed(&config.tools),
            settings: Cow::Borrowed(&config.settings),
            use_mock_claude: config.use_mock_claude,
            mock_claude_path: Cow::Borrowed(&config.mock_claude_path),
            use_mock_codex: config.use_mock_codex,
            mock_codex_path: Cow::Borrowed(&config.mock_codex_path),
            home_dir: Cow::Borrowed(&config.home_dir),
            claude_config_dir: Cow::Borrowed(&config.claude_config_dir),
            codex_home_dir: Cow::Borrowed(&config.codex_home_dir),
            api_url: Cow::Borrowed(&config.api_url),
            api_start_time: Cow::Borrowed(&config.api_start_time),
            anthropic_model: Cow::Borrowed(user_env_value(&config.user_env, "ANTHROPIC_MODEL")),
            openai_model: Cow::Borrowed(user_env_value(&config.user_env, "OPENAI_MODEL")),
            openai_base_url: Cow::Borrowed(user_env_value(
                &config.user_env,
                OPENAI_BASE_URL_ENV_KEY,
            )),
            codex_runtime_config,
            codex_oauth_mode: !user_env_value(&config.user_env, "CHATGPT_ACCOUNT_ID").is_empty(),
            codex_fast_mode: matches!(config.framework, env::Framework::Codex)
                && user_env_value(&config.user_env, CODEX_SERVICE_TIER_CANONICAL_ENV) == "fast",
            reasoning_effort: reasoning_effort::resolve(config.framework, &config.user_env)?,
            disable_builtin_web_search,
            agent_execution_deadline,
            stuck_tool_timeout_secs: config.stuck_tool_timeout_secs,
            post_result_cleanup_policy: PostResultCleanupPolicy::new(
                config.post_result_sigterm_grace,
                config.post_result_total_cap,
                config.post_result_sigkill_grace,
            ),
            agent_log_file: Cow::Borrowed(paths.agent_log_file()),
            session_id_file: Cow::Borrowed(paths.session_id_file()),
            session_history_launch_source: SessionHistoryLaunchSource::for_config(config),
            claude_append_system_prompt_file: Cow::Borrowed(
                paths.claude_append_system_prompt_file(),
            ),
            pi_session_id: Cow::Borrowed(&config.pi_session_id),
            pi_launch_config: Cow::Borrowed(&config.pi_launch_config),
            pi_launch_payload_file: Cow::Borrowed(paths.pi_launch_payload_file()),
            pi_model_config: Cow::Borrowed(&config.pi_model_config),
            user_env: &config.user_env,
        })
    }

    fn codex_home(&self) -> &str {
        self.codex_home_dir.as_ref()
    }

    fn codex_startup_config_overrides(&self) -> Vec<String> {
        let codex_home = self.codex_home();
        let mut overrides = codex_runtime_config::startup_config_overrides(
            self.codex_runtime_config.as_ref(),
            Path::new(codex_home),
        );
        if self.codex_runtime_config.is_none() && !self.openai_base_url.is_empty() {
            let base_url =
                codex_runtime_config::quote_toml_basic_string(self.openai_base_url.as_ref());
            overrides.push(format!("openai_base_url={base_url}"));
        }
        if self.disable_builtin_web_search {
            overrides.push(CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string());
        }
        overrides.extend(CODEX_FIXED_STARTUP_CONFIGS.map(str::to_string));
        if self.codex_fast_mode {
            overrides.extend(CODEX_FAST_MODE_STARTUP_CONFIGS.map(str::to_string));
        }
        overrides
    }

    fn codex_model_provider_id(&self) -> Option<&str> {
        self.codex_runtime_config
            .as_ref()
            .map(|config| config.provider_id.as_str())
    }

    fn child_user_env(&self) -> Cow<'_, HashMap<String, String>> {
        let remove_base_url = self.codex_runtime_config.is_some()
            && self.user_env.contains_key(OPENAI_BASE_URL_ENV_KEY);
        let remove_claude_effort = matches!(self.framework, env::Framework::ClaudeCode)
            && self.reasoning_effort.is_some()
            && self.user_env.contains_key("CLAUDE_CODE_EFFORT_LEVEL");
        let remove_pi_langfuse_credentials = matches!(self.framework, env::Framework::Pi)
            && user_env_value(self.user_env, PI_LANGFUSE_DEBUG_ENABLED_ENV_KEY) == "true";
        if !remove_base_url && !remove_claude_effort && !remove_pi_langfuse_credentials {
            return Cow::Borrowed(self.user_env);
        }
        // Structured Codex runtime config is authoritative; do not let stale
        // provider env leak a conflicting base URL into the child process.
        let mut user_env = self.user_env.clone();
        if remove_base_url {
            user_env.remove(OPENAI_BASE_URL_ENV_KEY);
        }
        // Claude's env override takes precedence over --effort, including
        // ultracode. An explicit chat choice must win over restored user env.
        if remove_claude_effort {
            user_env.remove("CLAUDE_CODE_EFFORT_LEVEL");
        }
        if remove_pi_langfuse_credentials {
            user_env.remove(LANGFUSE_PUBLIC_KEY_ENV_KEY);
            user_env.remove(LANGFUSE_SECRET_KEY_ENV_KEY);
        }
        Cow::Owned(user_env)
    }
}

fn user_env_value<'a>(user_env: &'a HashMap<String, String>, key: &str) -> &'a str {
    user_env.get(key).map(String::as_str).unwrap_or("")
}

fn build_pi_command_for_runtime(runtime: &CliRuntimeConfig<'_>) -> Result<Vec<String>, AgentError> {
    for (name, value) in [
        ("Pi session id", runtime.pi_session_id.as_ref()),
        ("Pi launch config", runtime.pi_launch_config.as_ref()),
        ("Pi model config", runtime.pi_model_config.as_ref()),
    ] {
        if value.is_empty() {
            return Err(AgentError::Execution(format!(
                "{name} is required for Pi execution"
            )));
        }
    }
    let package_url = runtime
        .user_env
        .get(CLI_PACKAGE_URL_ENV_KEY)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentError::Execution(format!(
                "{CLI_PACKAGE_URL_ENV_KEY} is required for Pi execution"
            ))
        })?;
    Ok(vec![
        "npx".to_string(),
        "--yes".to_string(),
        "--no-audit".to_string(),
        format!("--package={package_url}"),
        "okou".to_string(),
        "__agent-loop".to_string(),
    ])
}

fn is_pi_memory_maintenance(runtime: &CliRuntimeConfig<'_>) -> Result<bool, AgentError> {
    if !matches!(runtime.framework, env::Framework::Pi) {
        return Ok(false);
    }
    let launch_config: serde_json::Value = serde_json::from_str(runtime.pi_launch_config.as_ref())
        .map_err(|_| AgentError::Execution("Pi launch config is invalid".to_string()))?;
    Ok(launch_config
        .get("maintenance")
        .is_some_and(|value| !value.is_null()))
}

/// Write the private launch payload the Pi CLI child reads at startup.
///
/// Prompt-sized launch inputs travel through this file so the child's argv and
/// environment stay small. The file is created 0600 inside the run's 0700
/// private runtime directory.
fn write_pi_launch_payload_file(runtime: &CliRuntimeConfig<'_>) -> Result<(), AgentError> {
    let launch_config: serde_json::Value = serde_json::from_str(runtime.pi_launch_config.as_ref())
        .map_err(|e| AgentError::Execution(format!("parse Pi launch config: {e}")))?;
    let append_system_prompt = if runtime.append_system_prompt.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(runtime.append_system_prompt.to_string())
    };
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "appendSystemPrompt": append_system_prompt,
        "launchConfig": launch_config,
    });
    let path = runtime.pi_launch_payload_file.as_ref();
    paths::ensure_parent_dir(path)?;
    paths::write_private(path, serde_json::to_vec(&payload)?)?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PiLangfuseBootstrapConfig<'a> {
    public_key: &'a str,
    secret_key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    environment: Option<&'a str>,
}

fn nonempty_user_env_value<'a>(
    user_env: &'a HashMap<String, String>,
    key: &str,
) -> Option<&'a str> {
    user_env
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

struct PiLangfuseBootstrapFile {
    path: PathBuf,
    environment_value: String,
}

impl PiLangfuseBootstrapFile {
    fn environment_value(&self) -> &str {
        &self.environment_value
    }
}

impl Drop for PiLangfuseBootstrapFile {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log_warn!(LOG_TAG, "Pi Langfuse bootstrap cleanup failed: {error}"),
        }
    }
}

fn write_pi_langfuse_bootstrap_file(
    runtime: &CliRuntimeConfig<'_>,
) -> Result<Option<PiLangfuseBootstrapFile>, AgentError> {
    if user_env_value(runtime.user_env, PI_LANGFUSE_DEBUG_ENABLED_ENV_KEY) != "true" {
        return Ok(None);
    }
    let Some(public_key) = nonempty_user_env_value(runtime.user_env, LANGFUSE_PUBLIC_KEY_ENV_KEY)
    else {
        return Ok(None);
    };
    let Some(secret_key) = nonempty_user_env_value(runtime.user_env, LANGFUSE_SECRET_KEY_ENV_KEY)
    else {
        return Ok(None);
    };
    let parent = Path::new(runtime.pi_launch_payload_file.as_ref())
        .parent()
        .ok_or_else(|| AgentError::Execution("Pi Langfuse bootstrap path is invalid".into()))?;
    let path = parent.join(PI_LANGFUSE_CONFIG_FILENAME);
    let environment_value = path
        .to_str()
        .ok_or_else(|| AgentError::Execution("Pi Langfuse bootstrap path is invalid".into()))?
        .to_string();
    let mut payload = serde_json::to_vec(&PiLangfuseBootstrapConfig {
        public_key,
        secret_key,
        base_url: nonempty_user_env_value(runtime.user_env, LANGFUSE_BASE_URL_ENV_KEY),
        user_id: nonempty_user_env_value(runtime.user_env, LANGFUSE_USER_ID_ENV_KEY),
        environment: nonempty_user_env_value(
            runtime.user_env,
            LANGFUSE_TRACING_ENVIRONMENT_ENV_KEY,
        ),
    })?;
    let write_result = paths::write_private(&path, &payload);
    payload.fill(0);
    if let Err(error) = write_result {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {}
            Err(cleanup_error) => {
                return Err(AgentError::Execution(format!(
                    "Pi Langfuse bootstrap cleanup failed: {cleanup_error}"
                )));
            }
        }
        log_warn!(
            LOG_TAG,
            "Pi Langfuse bootstrap write failed; continuing without tracing: {error}"
        );
        return Ok(None);
    }
    Ok(Some(PiLangfuseBootstrapFile {
        path,
        environment_value,
    }))
}

fn write_claude_append_system_prompt_file(
    runtime: &CliRuntimeConfig<'_>,
) -> Result<(), AgentError> {
    if runtime.append_system_prompt.is_empty() {
        return Ok(());
    }

    let path = runtime.claude_append_system_prompt_file.as_ref();
    paths::ensure_parent_dir(path)?;
    paths::write_private(path, runtime.append_system_prompt.as_bytes())?;
    Ok(())
}

fn pi_child_env_values(runtime: &CliRuntimeConfig<'_>) -> [(String, String); 4] {
    [
        (
            guest_contracts::env::RUN_ID_ENV.to_string(),
            runtime.run_id.to_string(),
        ),
        (
            guest_contracts::env::PI_SESSION_ID_ENV.to_string(),
            runtime.pi_session_id.to_string(),
        ),
        (
            guest_contracts::env::PI_LAUNCH_PAYLOAD_FILE_ENV.to_string(),
            runtime.pi_launch_payload_file.to_string(),
        ),
        (
            guest_contracts::env::PI_MODEL_CONFIG_ENV.to_string(),
            runtime.pi_model_config.to_string(),
        ),
    ]
}

fn disallowed_tools_with_builtin_web_search_disabled(
    disallowed_tools: &str,
    disable_builtin_web_search: bool,
) -> Cow<'_, str> {
    if !disable_builtin_web_search
        || disallowed_tools
            .split(',')
            .any(|tool| tool.trim() == WEB_SEARCH_TOOL_NAME)
    {
        return Cow::Borrowed(disallowed_tools);
    }
    if disallowed_tools.is_empty() {
        return Cow::Borrowed(WEB_SEARCH_TOOL_NAME);
    }
    Cow::Owned(format!("{disallowed_tools},{WEB_SEARCH_TOOL_NAME}"))
}

enum ParsedEventAction {
    Forward,
    Skip,
}

struct BestEffortAgentLog {
    file: Option<BufWriter<tokio::fs::File>>,
}

impl BestEffortAgentLog {
    fn open(path: &str) -> Self {
        match guest_contracts::runtime_paths::create_private(path) {
            Ok(file) => Self {
                file: Some(BufWriter::with_capacity(
                    AGENT_LOG_BUFFER_BYTES,
                    tokio::fs::File::from_std(file),
                )),
            },
            Err(error) => {
                Self::warn_failure("open", &error);
                Self { file: None }
            }
        }
    }

    async fn write_raw_line(&mut self, raw_line: impl AsRef<[u8]>) {
        let result = {
            let Some(file) = self.file.as_mut() else {
                return;
            };
            match file.write_all(raw_line.as_ref()).await {
                Ok(()) => file.write_all(b"\n").await,
                Err(error) => Err(error),
            }
        };
        if let Err(error) = result {
            self.disable("write", error);
        }
    }

    async fn flush(&mut self) {
        let result = match self.file.as_mut() {
            Some(file) => file.flush().await,
            None => return,
        };
        if let Err(error) = result {
            self.disable("flush", error);
        }
    }

    fn disable(&mut self, operation: &str, error: std::io::Error) {
        self.file = None;
        Self::warn_failure(operation, &error);
    }

    fn warn_failure(operation: &str, error: &std::io::Error) {
        log_warn!(
            LOG_TAG,
            "Agent log {operation} failed; continuing without local transcript: {error}"
        );
    }
}

struct CliEventIngestor<'a> {
    framework: env::Framework,
    seq: u32,
    api_start_time: String,
    last_read_event_at: Option<Instant>,
    first_event_seen: bool,
    session_metadata_capture: events::SessionMetadataCapture,
    failure_diagnostic: Option<CliFailureDiagnostic>,
    codex_startup: Option<&'a CodexStartupTiming>,
}

impl<'a> CliEventIngestor<'a> {
    fn new_with_session_metadata(
        runtime: &CliRuntimeConfig<'_>,
        codex_startup: Option<&'a CodexStartupTiming>,
        session_metadata: SessionMetadataStore,
        initial_sequence: u32,
    ) -> Self {
        Self {
            framework: runtime.framework,
            seq: initial_sequence,
            api_start_time: runtime.api_start_time.to_string(),
            last_read_event_at: None,
            first_event_seen: false,
            session_metadata_capture: events::SessionMetadataCapture::new(
                runtime.session_history_launch_source.clone(),
                session_metadata,
                runtime.session_id_file.as_ref(),
            ),
            failure_diagnostic: None,
            codex_startup,
        }
    }

    fn record_e2e_from_api_start_at(&self, op_name: &str, observed_at_ms: u64) {
        timing::record_e2e_from_api_start_at(op_name, &self.api_start_time, observed_at_ms);
    }

    async fn begin_event(
        &mut self,
        agent_log: &mut BestEffortAgentLog,
        raw_line: impl AsRef<[u8]>,
        event: &serde_json::Value,
        masker: &SecretMasker,
        framework: env::Framework,
    ) -> ParsedEventAction {
        let is_stream_event =
            event.get("type").and_then(serde_json::Value::as_str) == Some("stream_event");
        if !is_stream_event
            && matches!(framework, env::Framework::Codex)
            && event.get("type").and_then(serde_json::Value::as_str) == Some("turn.started")
            && let Some(codex_startup) = self.codex_startup
        {
            codex_startup.record_success_at(Instant::now());
        }
        agent_log.write_raw_line(raw_line).await;

        if is_stream_event {
            return ParsedEventAction::Skip;
        }
        self.last_read_event_at = Some(Instant::now());
        if !self.first_event_seen {
            timing::record_e2e_from_api_start("api_to_cli_init", &self.api_start_time);
            self.first_event_seen = true;
        }
        self.session_metadata_capture.capture_event(event);

        if matches!(framework, env::Framework::Codex)
            && let Some(diagnostic) = events::masked_codex_failure_diagnostic(event, masker)
        {
            let candidate = CliFailureDiagnostic {
                message: diagnostic.message,
                source: FailureDetailSource::CodexJsonl,
                failure_reason: diagnostic.failure_reason,
            };
            log_warn!(
                LOG_TAG,
                "Codex JSONL failure event seq={} type={}: {}",
                self.seq,
                diagnostic.event_type,
                candidate.message
            );
            if let Some(selected) =
                select_failure_diagnostic(self.failure_diagnostic.as_ref(), candidate)
            {
                self.failure_diagnostic = Some(selected);
            }
        }

        ParsedEventAction::Forward
    }

    fn replace_failure_diagnostic(&mut self, diagnostic: CliFailureDiagnostic) {
        self.failure_diagnostic = Some(diagnostic);
    }

    fn current_sequence(&self) -> u32 {
        self.seq
    }

    fn enqueue_event(
        &mut self,
        event: serde_json::Value,
        masker: &SecretMasker,
        should_send_events: bool,
        event_tx: &EventDeliverySender,
    ) -> Result<(), AgentError> {
        for event in provider_event_normalization::normalize_for_sequencing(self.framework, event) {
            let sequence = self.seq;
            if sequence > MAX_EVENT_SEQUENCE_NUMBER {
                return Err(AgentError::Execution(
                    "CLI event sequence exceeds the supported maximum".to_string(),
                ));
            }
            self.seq = sequence.checked_add(1).ok_or_else(|| {
                AgentError::Execution(
                    "CLI event sequence exceeds the supported maximum".to_string(),
                )
            })?;
            if should_send_events {
                let event = events::prepare_event_for_delivery(event, sequence, masker);
                event_tx.try_send_for_framework(sequence, event, self.framework)?;
            }
        }
        Ok(())
    }

    fn last_read_event_at(&self) -> Option<Instant> {
        self.last_read_event_at
    }

    fn failure_diagnostic(&self) -> Option<CliFailureDiagnostic> {
        self.failure_diagnostic.clone()
    }
}

struct CliEventPipeline<'a> {
    ingestor: CliEventIngestor<'a>,
    delivery: EventDeliveryRuntime,
}

impl<'a> CliEventPipeline<'a> {
    fn start(
        runtime: &CliRuntimeConfig<'_>,
        session_metadata: SessionMetadataStore,
        http: &HttpClient,
        initial_sequence: u32,
    ) -> Result<Self, AgentError> {
        let delivery = EventDeliveryRuntime::start(
            http.clone(),
            &runtime.run_id,
            initial_sequence,
            runtime.framework == env::Framework::Pi,
        )?;
        let ingestor = CliEventIngestor::new_with_session_metadata(
            runtime,
            None,
            session_metadata,
            initial_sequence,
        );
        Ok(Self { ingestor, delivery })
    }
}

/// Execute the CLI process using values captured in a [`env::GuestConfig`] and
/// [`paths::GuestPaths`].
pub async fn execute_cli_with_active_input_for_config(
    masker: &SecretMasker,
    heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    active_input: ActiveInputWriter,
    config: &env::GuestConfig,
    paths: &paths::GuestPaths,
) -> Result<CliExecutionResult, AgentError> {
    execute_cli_with_active_input_for_config_started_at(
        masker,
        heartbeat_monitor,
        http,
        active_input,
        config,
        paths,
        Instant::now(),
    )
    .await
}

/// Execute the CLI against an execution budget that started before guest
/// initialization.
///
/// Production guest-agent bootstrap uses this entry point so setup time counts
/// against the runner-owned execution budget.
pub async fn execute_cli_with_active_input_for_config_started_at(
    masker: &SecretMasker,
    heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    active_input: ActiveInputWriter,
    config: &env::GuestConfig,
    paths: &paths::GuestPaths,
    execution_started_at: Instant,
) -> Result<CliExecutionResult, AgentError> {
    execute_cli_with_controls_for_config_started_at(
        masker,
        heartbeat_monitor,
        http,
        CliExecutionControls::new(active_input, CancellationToken::new(), None),
        config,
        paths,
        execution_started_at,
    )
    .await
}

/// Run-scoped controls observed while the inner CLI is executing.
pub struct CliExecutionControls<'a> {
    active_input: ActiveInputWriter,
    user_cancellation: CancellationToken,
    codex_startup: Option<&'a CodexStartupTiming>,
    workload_containment: Option<&'a crate::workload_containment::WorkloadContainment>,
    session_metadata: SessionMetadataStore,
}

impl<'a> CliExecutionControls<'a> {
    /// Create controls for active input, cancellation, and optional Codex startup timing.
    #[must_use]
    pub fn new(
        active_input: ActiveInputWriter,
        user_cancellation: CancellationToken,
        codex_startup: Option<&'a CodexStartupTiming>,
    ) -> Self {
        Self {
            active_input,
            user_cancellation,
            codex_startup,
            workload_containment: None,
            session_metadata: SessionMetadataStore::default(),
        }
    }
    /// Supply the production workload placement capability for CLI children.
    #[must_use]
    pub fn with_workload_containment(
        mut self,
        containment: Option<&'a crate::workload_containment::WorkloadContainment>,
    ) -> Self {
        self.workload_containment = containment;
        self
    }

    /// Supply the guest-owned store used to retain first-event session metadata.
    #[must_use]
    pub fn with_session_metadata_store(mut self, store: SessionMetadataStore) -> Self {
        self.session_metadata = store;
        self
    }
}

/// Execute the CLI while observing run-scoped controls.
///
pub async fn execute_cli_with_controls_for_config_started_at(
    masker: &SecretMasker,
    heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    controls: CliExecutionControls<'_>,
    config: &env::GuestConfig,
    paths: &paths::GuestPaths,
    execution_started_at: Instant,
) -> Result<CliExecutionResult, AgentError> {
    let runtime = CliRuntimeConfig::from_config(config, paths, execution_started_at)?;
    execute_cli_inner(masker, heartbeat_monitor, http, controls, &runtime).await
}

async fn execute_cli_inner(
    masker: &SecretMasker,
    mut heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    controls: CliExecutionControls<'_>,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    if matches!(runtime.framework, env::Framework::Codex) {
        return codex_app_server_backend::execute_codex_app_server_for_runtime(
            masker,
            heartbeat_monitor,
            http,
            controls,
            runtime,
        )
        .await;
    }

    let CliExecutionControls {
        active_input,
        user_cancellation,
        codex_startup: _,
        workload_containment,
        session_metadata,
    } = controls;

    let maintenance_execution = is_pi_memory_maintenance(runtime)?;
    if maintenance_execution
        && !session_metadata.capture_maintenance_launch(runtime.pi_session_id.as_ref())
    {
        return Err(AgentError::Execution(
            "Invalid private maintenance session identity".into(),
        ));
    }

    let replay_user_messages =
        active_input.is_enabled() && matches!(runtime.framework, env::Framework::ClaudeCode);
    log_info!(
        LOG_TAG,
        "Starting {} execution...",
        runtime.framework.agent_type()
    );

    if matches!(runtime.framework, env::Framework::ClaudeCode) {
        write_claude_append_system_prompt_file(runtime)?;
    }

    let cmd = if matches!(runtime.framework, env::Framework::Pi) {
        build_pi_command_for_runtime(runtime)?
    } else {
        command::build_claude_command_for_runtime(runtime, replay_user_messages)
    };
    let (bin, args) = cmd
        .split_first()
        .ok_or_else(|| AgentError::Execution("empty command".into()))?;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        // If a future setup step fails after spawn, dropping `Child` must not
        // leave a CLI process running in the VM.
        .kill_on_drop(true);

    let pi_langfuse_bootstrap = if matches!(runtime.framework, env::Framework::Pi) {
        write_pi_launch_payload_file(runtime)?;
        write_pi_langfuse_bootstrap_file(runtime)?
    } else {
        None
    };
    let mut child_env_values = child_env::values_for_runtime(runtime);
    match runtime.framework {
        env::Framework::ClaudeCode => child_env_values.push((
            "CLAUDE_CONFIG_DIR".to_string(),
            runtime.claude_config_dir.to_string(),
        )),
        env::Framework::Pi => {
            child_env_values.extend(pi_child_env_values(runtime));
            if let Some(bootstrap) = pi_langfuse_bootstrap.as_ref() {
                child_env_values.push((
                    PI_LANGFUSE_CONFIG_FILE_ENV_KEY.to_string(),
                    bootstrap.environment_value().to_string(),
                ));
            }
        }
        env::Framework::Codex => {}
    }
    // Suppress Claude CLI features that are unnecessary or harmful in a
    // sandbox: startup network calls (statsig, Datadog, Segment, GCS update
    // check, GitHub) add ~2s latency, background tasks can keep a one-shot run
    // alive after its final result, telemetry has no receiver, and the CLI
    // version is baked into the rootfs image.
    child_env_values.extend([
        (
            "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS".to_string(),
            "1".to_string(),
        ),
        (
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(),
            "1".to_string(),
        ),
        (
            "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY".to_string(),
            "1".to_string(),
        ),
        (
            "CLAUDE_CODE_DISABLE_TERMINAL_TITLE".to_string(),
            "1".to_string(),
        ),
        ("DISABLE_AUTOUPDATER".to_string(), "1".to_string()),
        ("DISABLE_ERROR_REPORTING".to_string(), "1".to_string()),
        ("DISABLE_INSTALLATION_CHECKS".to_string(), "1".to_string()),
        ("DISABLE_TELEMETRY".to_string(), "1".to_string()),
    ]);
    if let Some(workload_containment) = workload_containment {
        let (key, value) = workload_containment.tool_placement_env();
        child_env_values.push((key.to_string(), value));
    }
    let child_env_values = child_env::normalize_values(child_env_values);
    exec_boundary::validate_process_argv_env(
        "CLI child argv/env too large",
        bin,
        args.iter().map(String::as_str),
        &child_env_values,
    )
    .map_err(AgentError::Execution)?;
    cmd.stdin(Stdio::piped());
    child_env::apply_values_to_tokio_command(&mut cmd, &child_env_values);
    // Set the child cwd explicitly at spawn time so the CLI observes the
    // current canonical workspace mount instead of relying on inherited cwd.
    set_cli_current_dir(&mut cmd, paths::CANONICAL_WORKING_DIR)?;
    if let Some(workload_containment) = workload_containment {
        workload_containment.configure_command(&mut cmd)?;
    }

    // The local transcript is best-effort observability. A backend must not
    // fail an otherwise healthy run because this sink is unavailable.
    let mut agent_log = BestEffortAgentLog::open(runtime.agent_log_file.as_ref());

    let mut child = cmd.spawn()?;

    let Some(cli_stdin) = child.stdin.take() else {
        let _ = child.start_kill();
        return Err(AgentError::Execution("no stdin".into()));
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::Execution("no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AgentError::Execution("no stderr".into()))?;

    // Stderr collector
    let mut stderr_handle =
        tokio::spawn(async move { diagnostics::collect_stderr_result_tail(stderr).await });

    let active_input_controller = active_input.controller();
    let pi_execution = matches!(runtime.framework, env::Framework::Pi);
    let pi_rpc_execution = pi_execution && !maintenance_execution;
    let (pi_rpc_response_tx, pi_rpc_response_rx) = pi_rpc::response_channel();
    let (pi_rpc_startup_tx, pi_rpc_startup_rx) = tokio::sync::oneshot::channel();
    let mut pi_rpc_startup_tx = pi_rpc_execution.then_some(pi_rpc_startup_tx);
    let pi_rpc_cancellation = CancellationToken::new();
    let pi_session_output = pi_rpc_execution
        .then(|| {
            pi_session_output::start(
                http.clone(),
                runtime.run_id.as_ref(),
                runtime.pi_session_id.as_ref(),
            )
        })
        .flatten();
    let mut pi_rpc_projection = pi_rpc_execution.then(|| {
        let projection =
            pi_rpc::PiRpcProjection::new(runtime.run_id.as_ref(), runtime.pi_session_id.as_ref());
        match pi_session_output {
            Some(output) => projection.with_session_output(output),
            None => projection,
        }
    });
    let mut pi_rpc_startup_boundary = pi_rpc_execution.then(pi_rpc::PiRpcStartupBoundary::default);
    let mut stdin_write_handle = Some({
        let run_id = runtime.run_id.to_string();
        let prompt = runtime.prompt.to_string();
        let pi_rpc_cancellation = pi_rpc_cancellation.clone();
        tokio::spawn(async move {
            if pi_rpc_execution {
                pi_rpc::write_commands(
                    cli_stdin,
                    &run_id,
                    &prompt,
                    active_input,
                    pi_rpc_response_rx,
                    pi_rpc_startup_rx,
                    pi_rpc_cancellation,
                )
                .await
            } else if pi_execution {
                drop(cli_stdin);
                Ok(())
            } else {
                drop(pi_rpc_response_rx);
                write_claude_stream_json_to_stdin(cli_stdin, &run_id, &prompt, active_input).await
            }
        })
    });

    // Stream CLI stdout JSONL, racing against heartbeat and process exit.
    //
    // Event sending is decoupled from stdout reading via an mpsc channel
    // to prevent a deadlock: Bun (Claude CLI runtime) uses blocking stdout
    // writes, so if the agent's HTTP POSTs are slow and the pipe buffer
    // fills, the CLI's entire event loop blocks — including TCP I/O.
    // See: https://github.com/vm0-ai/vm0/issues/3645
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut stdout_partial_line = Vec::new();
    let mut stdout_closed = false;

    // Capture the process group ID before wait() reaps the child, since
    // child.id() returns None after the process has been reaped.
    let process_group = ChildProcessGroup::from_group_leader_child_id(child.id());

    let mut cli_status: Option<std::process::ExitStatus> = None;

    // Drain deadline: after child.wait() fires, allow up to N seconds for
    // stdout EOF before breaking the loop.  Prevents indefinite hangs when
    // orphaned child processes hold the stdout fd open.
    let drain_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(drain_deadline);

    // Forced termination: some conditions require reaping the CLI process
    // group before returning. For Claude Code --print mode, post-result
    // reap arms a delayed SIGTERM after `type=result`; fatal watchdog /
    // heartbeat paths send SIGTERM immediately. Both paths share the same
    // SIGKILL escalation deadline so no forced termination can fall through
    // to an unbounded child.wait().
    // See: https://github.com/vm0-ai/vm0/issues/10879
    // See: https://github.com/vm0-ai/vm0/issues/11667
    let termination_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(termination_deadline);
    let mut termination_runtime =
        CliTerminationRuntime::new(process_group, runtime.post_result_cleanup_policy);

    let agent_execution_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(agent_execution_deadline);
    let mut agent_execution_deadline_armed = false;
    let mut agent_execution_timeout_secs = 0;
    if let Some(deadline) = runtime.agent_execution_deadline {
        agent_execution_deadline
            .as_mut()
            .reset(tokio::time::Instant::from_std(deadline.at));
        agent_execution_deadline_armed = true;
        agent_execution_timeout_secs = deadline.timeout_secs;
    }

    // Stuck-tool watchdog: workaround for Claude Code bug where
    // WebSearch/WebFetch hang indefinitely. Track bounded in-flight network
    // tool calls; if one exceeds STUCK_TOOL_TIMEOUT_SECS without producing a
    // tool_result, kill the process. Keyed by tool_use_id to handle parallel
    // tool calls correctly. Tracker admission is best-effort: an oversized ID
    // or a full tracker is ignored without affecting the run.
    // See: https://github.com/anthropics/claude-code/issues/11650
    let mut stuck_tool_tracker = claude::StuckToolTracker::new();
    let stuck_tool_interval = Duration::from_secs(constants::STUCK_TOOL_CHECK_INTERVAL_SECS);
    let mut stuck_tool_check = tokio::time::interval_at(
        tokio::time::Instant::now() + stuck_tool_interval,
        stuck_tool_interval,
    );

    // Background event sender: HTTP POSTs happen here, never in the stdout
    // reading loop. Admission is non-blocking and bounded by count and bytes;
    // the serial worker greedily batches only existing FIFO backlog. There is
    // no collection delay or concurrent POST path. Overload enters controlled
    // CLI termination rather than blocking stdout.
    let mut should_send_events = http.has_api();
    let mut event_pipeline = if pi_execution {
        None
    } else {
        Some(CliEventPipeline::start(
            runtime,
            session_metadata.clone(),
            &http,
            0,
        )?)
    };

    let mut heartbeat_done = false;
    let mut heartbeat_failure = None;
    let mut user_cancellation_handled = false;
    let mut pi_user_cancelled = false;
    let mut cli_exit_at: Option<Instant> = None;
    let mut jsonl_result = None;
    let mut post_result_cleanup_jsonl_result = None;
    let event_result: Result<(), AgentError> = loop {
        tokio::select! {
            () = user_cancellation.cancelled(), if !user_cancellation_handled && cli_status.is_none() => {
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => {
                        user_cancellation_handled = true;
                        continue;
                    }
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                }
                user_cancellation_handled = true;
                if pi_rpc_execution {
                    pi_user_cancelled = true;
                    active_input_controller.close_terminal();
                    pi_rpc_cancellation.cancel();
                    continue;
                }
                active_input_controller.close_terminal();
                termination_runtime.begin_control_failure(
                    TerminationReason::UserCancellation,
                    AgentError::Execution("Run cancelled by user".to_string()),
                    ControlTerminationLog::UserCancellation,
                    termination_deadline.as_mut(),
                );
            }
            () = &mut agent_execution_deadline, if agent_execution_deadline_armed && cli_status.is_none() => {
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => {
                        agent_execution_deadline_armed = false;
                        continue;
                    }
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                }
                agent_execution_deadline_armed = false;
                if termination_runtime
                    .preserve_post_result_cleanup_at_execution_deadline(
                        termination_deadline.as_mut(),
                    )
                {
                    // A terminal result already ended semantic execution.
                    // Preserve its classification and, when SIGTERM has not
                    // already been sent, advance its bounded reaper.
                    continue;
                }
                active_input_controller.close_terminal();
                let timeout_error = AgentError::Execution(format!(
                    "Agent execution timed out after {agent_execution_timeout_secs} seconds"
                ));
                termination_runtime.begin_control_failure(
                    TerminationReason::ExecutionTimeout,
                    timeout_error,
                    ControlTerminationLog::ExecutionTimeout {
                        timeout_secs: agent_execution_timeout_secs,
                    },
                    termination_deadline.as_mut(),
                );
            }
            stdin_write_result = async {
                match stdin_write_handle.as_mut() {
                    Some(handle) => Some(handle.await),
                    None => std::future::pending().await,
                }
            }, if stdin_write_handle.is_some() => {
                stdin_write_handle = None;
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                }
                let can_terminate_for_stdin_error = termination_runtime
                    .can_begin_initial_prompt_stdin_control_failure(cli_status.is_some());
                match stdin_write_result {
                    Some(Ok(Ok(()))) => {}
                    Some(Ok(Err(error))) if can_terminate_for_stdin_error => {
                        active_input_controller.close_terminal();
                        let error_log = error.to_string();
                        termination_runtime.begin_control_failure(
                            TerminationReason::InitialPromptStdin,
                            error,
                            ControlTerminationLog::StdinWriterFailed { error: error_log },
                            termination_deadline.as_mut(),
                        );
                    }
                    Some(Ok(Err(_))) => {
                        active_input_controller.close_terminal();
                    }
                    Some(Err(error)) if can_terminate_for_stdin_error => {
                        active_input_controller.close_terminal();
                        let error_log = error.to_string();
                        let control_error =
                            AgentError::Execution(format!("CLI stdin writer task failed: {error_log}"));
                        termination_runtime.begin_control_failure(
                            TerminationReason::InitialPromptStdin,
                            control_error,
                            ControlTerminationLog::StdinWriterTaskFailed { error: error_log },
                            termination_deadline.as_mut(),
                        );
                    }
                    Some(Err(_)) => {
                        active_input_controller.close_terminal();
                    }
                    None => {}
                }
            }
            line_result = line_reader::read_bounded_utf8_line(
                &mut reader,
                &mut stdout_partial_line,
                ORDINARY_CLI_STDOUT_MAX_LINE_BYTES,
            ), if !stdout_closed => {
                match line_result {
                    Ok(Some(line)) => {
                        let stripped = line.trim();
                        if stripped.is_empty() {
                            continue;
                        }

                        if let Ok(mut event) = serde_json::from_str::<serde_json::Value>(stripped) {
                            if let Some(startup_boundary) = pi_rpc_startup_boundary.as_mut() {
                                match startup_boundary.admit(&event) {
                                    Ok(pi_rpc::PiRpcRecordAdmission::InstallBoundary(startup)) => {
                                        match CliEventPipeline::start(
                                            runtime,
                                            session_metadata.clone(),
                                            &http,
                                            startup.sandbox_event_sequence_start,
                                        ) {
                                            Ok(pipeline) => {
                                                event_pipeline = Some(pipeline);
                                                if let Some(sender) = pi_rpc_startup_tx.take() {
                                                    let _ = sender.send(
                                                        startup.ownership_transfer_mode,
                                                    );
                                                }
                                            }
                                            Err(error) => {
                                                pi_rpc_startup_tx.take();
                                                startup_boundary.discard_remaining();
                                                active_input_controller.close_terminal();
                                                if cli_status.is_some() {
                                                    break Err(error);
                                                }
                                                let error_log = error.to_string();
                                                termination_runtime.begin_control_failure(
                                                    TerminationReason::StdoutIngestion,
                                                    error,
                                                    ControlTerminationLog::StdoutIngestionFailed {
                                                        error: error_log,
                                                    },
                                                    termination_deadline.as_mut(),
                                                );
                                            }
                                        }
                                        // The startup control is private CLI/guest state. It is
                                        // consumed before official RPC projection and is never
                                        // written to the agent transcript or public delivery.
                                        continue;
                                    }
                                    Ok(pi_rpc::PiRpcRecordAdmission::Project) => {
                                        if event_pipeline.is_none() {
                                            startup_boundary.discard_remaining();
                                            let error = AgentError::Execution(
                                                "CLI event pipeline was not initialized before Pi RPC projection"
                                                    .to_string(),
                                            );
                                            active_input_controller.close_terminal();
                                            if cli_status.is_some() {
                                                break Err(error);
                                            }
                                            let error_log = error.to_string();
                                            termination_runtime.begin_control_failure(
                                                TerminationReason::StdoutIngestion,
                                                error,
                                                ControlTerminationLog::StdoutIngestionFailed {
                                                    error: error_log,
                                                },
                                                termination_deadline.as_mut(),
                                            );
                                            continue;
                                        }
                                    }
                                    Ok(pi_rpc::PiRpcRecordAdmission::Discard) => continue,
                                    Err(error) => {
                                        pi_rpc_startup_tx.take();
                                        active_input_controller.close_terminal();
                                        if cli_status.is_some() {
                                            break Err(error);
                                        }
                                        let error_log = error.to_string();
                                        termination_runtime.begin_control_failure(
                                            TerminationReason::StdoutIngestion,
                                            error,
                                            ControlTerminationLog::StdoutIngestionFailed {
                                                error: error_log,
                                            },
                                            termination_deadline.as_mut(),
                                        );
                                        continue;
                                    }
                                }
                            }
                            if let Some(projection) = pi_rpc_projection.as_mut() {
                                match projection.project(event, &pi_rpc_response_tx, line.len()) {
                                    Ok(Some(projected)) => event = projected,
                                    Ok(None) => {
                                        agent_log.write_raw_line(line.as_bytes()).await;
                                        continue;
                                    }
                                    Err(error) => {
                                        agent_log.write_raw_line(line.as_bytes()).await;
                                        active_input_controller.close_terminal();
                                        if cli_status.is_some() {
                                            break Err(error);
                                        }
                                        let error_log = error.to_string();
                                        termination_runtime.begin_control_failure(
                                            TerminationReason::StdoutIngestion,
                                            error,
                                            ControlTerminationLog::StdoutIngestionFailed {
                                                error: error_log,
                                            },
                                            termination_deadline.as_mut(),
                                        );
                                        continue;
                                    }
                                }
                            }
                            let replay_marker: Option<&[u8]> = if replay_user_messages {
                                match active_input_controller.replay_user_event_action(&event) {
                                    ReplayUserEventAction::External => None,
                                    ReplayUserEventAction::InternalInitialPrompt => Some(
                                        br#"{"type":"vm0_internal","event":"filtered_replayed_initial_prompt"}"#,
                                    ),
                                    ReplayUserEventAction::InternalActiveInput => Some(
                                        br#"{"type":"vm0_internal","event":"filtered_replayed_active_input"}"#,
                                    ),
                                    ReplayUserEventAction::UnknownPromptUser => {
                                        log_warn!(
                                            LOG_TAG,
                                            "Filtered unknown top-level Claude user replay event"
                                        );
                                        Some(
                                            br#"{"type":"vm0_internal","event":"filtered_unknown_prompt_user"}"#,
                                        )
                                    }
                                }
                            } else {
                                None
                            };
                            if let Some(replay_marker) = replay_marker {
                                agent_log.write_raw_line(replay_marker).await;
                                continue;
                            }

                            let Some(event_pipeline) = event_pipeline.as_mut() else {
                                let error = AgentError::Execution(
                                    "CLI event pipeline was not initialized before projection"
                                        .to_string(),
                                );
                                active_input_controller.close_terminal();
                                if cli_status.is_some() {
                                    break Err(error);
                                }
                                let error_log = error.to_string();
                                termination_runtime.begin_control_failure(
                                    TerminationReason::StdoutIngestion,
                                    error,
                                    ControlTerminationLog::StdoutIngestionFailed {
                                        error: error_log,
                                    },
                                    termination_deadline.as_mut(),
                                );
                                continue;
                            };

                            let post_result_cleanup_was_armed =
                                termination_runtime.has_post_result_cleanup();
                            let event_action = event_pipeline
                                .ingestor
                                .begin_event(
                                    &mut agent_log,
                                    line.as_bytes(),
                                    &event,
                                    masker,
                                    runtime.framework,
                                )
                                .await;
                            match event_action {
                                ParsedEventAction::Forward => {}
                                ParsedEventAction::Skip => continue,
                            }
                            let is_terminal_result_event = event
                                .get("type")
                                .and_then(serde_json::Value::as_str)
                                == Some("result")
                                && event
                                    .pointer("/origin/kind")
                                    .and_then(serde_json::Value::as_str)
                                    != Some("task-notification");
                            if post_result_cleanup_was_armed || is_terminal_result_event {
                                match try_observe_cli_exit(
                                    &mut child,
                                    &mut cli_status,
                                    &mut cli_exit_at,
                                    &active_input_controller,
                                    &mut termination_runtime,
                                    stdout_closed,
                                    drain_deadline.as_mut(),
                                )? {
                                    CliExitObservation::NoNewExit
                                    | CliExitObservation::ExitedDrainingStdout => {}
                                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                                }
                            }
                            // Print the terminal JSONL result to stdout if applicable.
                            if is_terminal_result_event {
                                let result_summary = JsonlResultSummary::from_event(&event);
                                jsonl_result = Some(result_summary);
                                if let Some(diagnostic) =
                                    events::masked_jsonl_result_failure_diagnostic(&event, masker)
                                {
                                    let subtype = diagnostic.subtype.unwrap_or("unknown");
                                    let (source, result_owner) = match runtime.framework {
                                        env::Framework::ClaudeCode => {
                                            (FailureDetailSource::ClaudeResult, "Claude")
                                        }
                                        env::Framework::Pi => {
                                            (FailureDetailSource::PiResult, "Pi")
                                        }
                                        env::Framework::Codex => {
                                            (FailureDetailSource::CodexJsonl, "Codex")
                                        }
                                    };
                                    let candidate = CliFailureDiagnostic {
                                        message: diagnostic.message,
                                        source,
                                        failure_reason: None,
                                    };
                                    log_warn!(
                                        LOG_TAG,
                                        "{result_owner} JSONL failure result seq={} subtype={subtype}: {}",
                                        event_pipeline.ingestor.current_sequence(),
                                        candidate.message
                                    );
                                    event_pipeline
                                        .ingestor
                                        .replace_failure_diagnostic(candidate);
                                }
                                if let Some(result) = event.get("result").and_then(|v| v.as_str())
                                {
                                    // Guest-agent stdout is captured as
                                    // system-stream logs, so mask before
                                    // printing the final result.
                                    println!("{}", masker.mask_string(result));
                                }
                                let active_input_idle =
                                    active_input_controller.close_for_result_if_idle();
                                if pi_rpc_execution && active_input_idle {
                                    active_input_controller.close_terminal();
                                }
                                // Arm the post-result reap deadline once per
                                // run when no active follow-up input is still
                                // pending.
                                if active_input_idle
                                    && termination_runtime.arm_post_result_cleanup(
                                        cli_status.is_some(),
                                        termination_deadline.as_mut(),
                                    )
                                {
                                    post_result_cleanup_jsonl_result = Some(result_summary);
                                }
                            }
                            // Extract tool info BEFORE masking (masker may replace tool names).
                            // Watchdog tracking is auxiliary state and must never make the
                            // ordinary event stream or the run fail.
                            if matches!(runtime.framework, env::Framework::ClaudeCode) {
                                claude::track_claude_tool_events(&event, &mut stuck_tool_tracker);
                            }
                            termination_runtime.record_post_result_activity(
                                post_result_cleanup_was_armed,
                                termination_deadline.as_mut(),
                            );
                            // Prepare event payload (mask secrets, add seq) and enqueue
                            // for background sending. Network I/O stays off the reading loop.
                            if let Err(error) = event_pipeline.ingestor.enqueue_event(
                                event,
                                masker,
                                should_send_events,
                                event_pipeline.delivery.sender(),
                            ) {
                                should_send_events = false;
                                if cli_status.is_some() {
                                    break Err(error);
                                }
                                let error_log = error.to_string();
                                termination_runtime.begin_control_failure(
                                    TerminationReason::EventDelivery,
                                    error,
                                    ControlTerminationLog::EventDeliveryFailed { error: error_log },
                                    termination_deadline.as_mut(),
                                );
                            }
                        } else if pi_rpc_startup_boundary
                            .as_ref()
                            .is_some_and(|boundary| {
                                boundary.requires_boundary()
                                    || pi_rpc::PiRpcStartupBoundary::looks_like_control(stripped)
                            })
                        {
                            if let Some(boundary) = pi_rpc_startup_boundary.as_mut() {
                                boundary.discard_remaining();
                            }
                            pi_rpc_startup_tx.take();
                            let error = pi_rpc::PiRpcStartupBoundary::malformed_record_error();
                            active_input_controller.close_terminal();
                            if cli_status.is_some() {
                                break Err(error);
                            }
                            let error_log = error.to_string();
                            termination_runtime.begin_control_failure(
                                TerminationReason::StdoutIngestion,
                                error,
                                ControlTerminationLog::StdoutIngestionFailed {
                                    error: error_log,
                                },
                                termination_deadline.as_mut(),
                            );
                        } else {
                            agent_log.write_raw_line(line.as_bytes()).await;
                        }
                    }
                    Ok(None) => {
                        stdout_closed = true;
                        active_input_controller.close_terminal();
                        if pi_rpc_startup_boundary
                            .as_ref()
                            .is_some_and(pi_rpc::PiRpcStartupBoundary::requires_boundary)
                        {
                            if let Some(boundary) = pi_rpc_startup_boundary.as_mut() {
                                boundary.discard_remaining();
                            }
                            pi_rpc_startup_tx.take();
                            let error = pi_rpc::PiRpcStartupBoundary::missing_error();
                            if cli_status.is_some() {
                                break Err(error);
                            }
                            let error_log = error.to_string();
                            termination_runtime.begin_control_failure(
                                TerminationReason::StdoutIngestion,
                                error,
                                ControlTerminationLog::StdoutIngestionFailed {
                                    error: error_log,
                                },
                                termination_deadline.as_mut(),
                            );
                            continue;
                        }
                        if cli_status.is_some() {
                            break Ok(());
                        }
                    }
                    Err(error) => {
                        stdout_closed = true;
                        active_input_controller.close_terminal();
                        let error = match error {
                            line_reader::BoundedLineError::Io(error) => AgentError::Io(error),
                            line_reader::BoundedLineError::TooLong => AgentError::Execution(
                                format!(
                                    "CLI stdout line exceeded {ORDINARY_CLI_STDOUT_MAX_LINE_BYTES} bytes"
                                ),
                            ),
                            line_reader::BoundedLineError::InvalidUtf8 {
                                valid_up_to,
                                error_len,
                                line_bytes,
                            } => {
                                let utf8_error = match error_len {
                                    Some(error_len) => format!(
                                        "invalid utf-8 sequence of {error_len} bytes from index {valid_up_to}"
                                    ),
                                    None => format!(
                                        "incomplete utf-8 byte sequence from index {valid_up_to}"
                                    ),
                                };
                                AgentError::Execution(format!(
                                    "CLI stdout line is not UTF-8: {utf8_error}; line_bytes={line_bytes}"
                                ))
                            }
                        };

                        if cli_status.is_some() {
                            break Err(error);
                        }
                        match try_observe_cli_exit(
                            &mut child,
                            &mut cli_status,
                            &mut cli_exit_at,
                            &active_input_controller,
                            &mut termination_runtime,
                            stdout_closed,
                            drain_deadline.as_mut(),
                        )? {
                            CliExitObservation::NoNewExit => {
                                let error_log = error.to_string();
                                termination_runtime.begin_control_failure(
                                    TerminationReason::StdoutIngestion,
                                    error,
                                    ControlTerminationLog::StdoutIngestionFailed {
                                        error: error_log,
                                    },
                                    termination_deadline.as_mut(),
                                );
                            }
                            CliExitObservation::ExitedDrainingStdout
                            | CliExitObservation::ExitedAndStdoutClosed => break Err(error),
                        }
                    }
                }
            }
            status = child.wait(), if cli_status.is_none() => {
                match status {
                    Ok(s) => {
                        if matches!(
                            record_cli_exit(
                                s,
                                &mut cli_status,
                                &mut cli_exit_at,
                                &active_input_controller,
                                &mut termination_runtime,
                                stdout_closed,
                                drain_deadline.as_mut(),
                            ),
                            CliExitObservation::ExitedAndStdoutClosed
                        ) {
                            break Ok(());
                        }
                    }
                    Err(e) => break Err(AgentError::Io(e)),
                }
            }
            () = &mut termination_deadline, if termination_runtime.has_pending_deadline() && cli_status.is_none() => {
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                }
                termination_runtime.handle_deadline(termination_deadline.as_mut());
            }
            () = &mut drain_deadline, if cli_status.is_some() => {
                log_warn!(
                    LOG_TAG,
                    "Stdout drain deadline reached after {}s, possible orphaned child process",
                    constants::STDOUT_DRAIN_DEADLINE_SECS,
                );
                break Ok(());
            }
            _ = stuck_tool_check.tick(), if cli_status.is_none() => {
                let timeout_secs = runtime.stuck_tool_timeout_secs;
                // Find the oldest network tool that has exceeded the timeout.
                let stuck = stuck_tool_tracker.oldest_expired(timeout_secs);
                if let Some((name, elapsed)) = stuck
                {
                    match try_observe_cli_exit(
                        &mut child,
                        &mut cli_status,
                        &mut cli_exit_at,
                        &active_input_controller,
                        &mut termination_runtime,
                        stdout_closed,
                        drain_deadline.as_mut(),
                    )? {
                        CliExitObservation::NoNewExit => {}
                        CliExitObservation::ExitedDrainingStdout => continue,
                        CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                    }
                    let timeout_error = AgentError::Execution(format!(
                        "Tool timeout: {} exceeded {timeout_secs}s without returning a result",
                        name.as_str()
                    ));
                    termination_runtime.begin_control_failure(
                        TerminationReason::StuckTool,
                        timeout_error,
                        ControlTerminationLog::StuckTool {
                            name: name.as_str().to_owned(),
                            elapsed,
                        },
                        termination_deadline.as_mut(),
                    );
                }
            }
            heartbeat_result = async {
                match heartbeat_monitor.as_mut() {
                    Some(receiver) => receiver.await,
                    None => {
                        std::future::pending::<Result<HeartbeatStatus, oneshot::error::RecvError>>()
                            .await
                    }
                }
            }, if !heartbeat_done && cli_status.is_none() => {
                heartbeat_done = true;
                match try_observe_cli_exit(
                    &mut child,
                    &mut cli_status,
                    &mut cli_exit_at,
                    &active_input_controller,
                    &mut termination_runtime,
                    stdout_closed,
                    drain_deadline.as_mut(),
                )? {
                    CliExitObservation::NoNewExit => {}
                    CliExitObservation::ExitedDrainingStdout => continue,
                    CliExitObservation::ExitedAndStdoutClosed => break Ok(()),
                }
                match heartbeat_result {
                    Ok(HeartbeatStatus::Failed(failure)) => {
                        // Heartbeat failed — kill process group
                        heartbeat_failure = Some(failure.diagnostic);
                        termination_runtime.begin_control_failure(
                            TerminationReason::HeartbeatError,
                            failure.error,
                            ControlTerminationLog::HeartbeatFailed,
                            termination_deadline.as_mut(),
                        );
                    }
                    Ok(HeartbeatStatus::Stopped) => {
                        // Heartbeat shutdown (should not happen before CLI exits)
                        break Ok(());
                    }
                    Ok(HeartbeatStatus::TaskFailed(message)) => {
                        let error = AgentError::Execution(format!("heartbeat task panicked: {message}"));
                        termination_runtime.begin_control_failure(
                            TerminationReason::HeartbeatPanic,
                            error,
                            ControlTerminationLog::HeartbeatTaskPanicked,
                            termination_deadline.as_mut(),
                        );
                    }
                    Err(e) => {
                        let error = AgentError::Execution(format!("heartbeat task stopped before reporting status: {e}"));
                        termination_runtime.begin_control_failure(
                            TerminationReason::HeartbeatPanic,
                            error,
                            ControlTerminationLog::HeartbeatStoppedBeforeStatus,
                            termination_deadline.as_mut(),
                        );
                    }
                }
            }
        }
    };

    // Publish buffered transcript bytes and finish any in-flight file write
    // before callers observe the completed execution and read the run log.
    agent_log.flush().await;

    active_input_controller.close_terminal();
    let mut active_input_error = None;
    if let Some(handle) = stdin_write_handle.take() {
        if handle.is_finished() {
            match handle.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    log_warn!(
                        LOG_TAG,
                        "CLI stdin writer finished after CLI loop with error: {error}"
                    );
                    if active_input_controller.has_activity() {
                        active_input_error = Some(error);
                    }
                }
                Err(error) => {
                    log_warn!(LOG_TAG, "CLI stdin writer failed after CLI loop: {error}");
                    if active_input_controller.has_activity() {
                        active_input_error = Some(AgentError::Execution(format!(
                            "CLI stdin writer task failed during active-input quiescence: {error}"
                        )));
                    }
                }
            }
        } else if active_input_controller.has_activity() {
            let mut handle = handle;
            match tokio::time::timeout(
                Duration::from_secs(constants::ACTIVE_INPUT_SINK_QUIESCENCE_TIMEOUT_SECS),
                &mut handle,
            )
            .await
            {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) => active_input_error = Some(error),
                Ok(Err(error)) => {
                    active_input_error = Some(AgentError::Execution(format!(
                        "CLI stdin writer task failed during active-input quiescence: {error}"
                    )));
                }
                Err(_) => {
                    handle.abort();
                    let _ = handle.await;
                    active_input_error = Some(AgentError::Execution(
                        "CLI stdin writer did not quiesce after terminal close".to_string(),
                    ));
                }
            }
        } else {
            handle.abort();
            let _ = handle.await;
            log_info!(LOG_TAG, "Stopped CLI stdin writer after CLI loop");
        }
    }

    let active_input_delivery_ids = match active_input_controller.finalize_receipts().await {
        Ok(delivery_ids) => delivery_ids,
        Err(error) => {
            if active_input_error.is_none() {
                active_input_error = Some(error);
            }
            Vec::new()
        }
    };

    let has_control_error = termination_runtime.has_control_error();
    let event_error = if active_input_error.is_some() {
        active_input_error
    } else if has_control_error {
        None
    } else {
        event_result.err()
    };
    let last_read_event_at = event_pipeline
        .as_ref()
        .and_then(|pipeline| pipeline.ingestor.last_read_event_at());
    let failure_diagnostic = event_pipeline
        .as_ref()
        .and_then(|pipeline| pipeline.ingestor.failure_diagnostic());

    // On success, boundedly drain accepted events. On any execution or
    // control error, abort unsent delivery rather than stalling on retries.
    let delivery_report = match event_pipeline {
        Some(pipeline) if event_error.is_none() && !has_control_error => {
            pipeline.delivery.finish().await?
        }
        Some(pipeline) => pipeline.delivery.abort().await,
        None => EventDeliveryReport {
            last_acknowledged_sequence: None,
            diagnostic: None,
        },
    };
    let status = match cli_status {
        Some(s) => s,
        None => {
            let status = child.wait().await?;
            cli_exit_at = Some(Instant::now());
            status
        }
    };
    if let (Some(last_read_event_at), Some(cli_exit_at)) = (last_read_event_at, cli_exit_at) {
        record_sandbox_op(
            "last_read_event_to_cli_exit",
            cli_exit_at
                .checked_duration_since(last_read_event_at)
                .unwrap_or(Duration::ZERO),
            true,
            None,
        );
    }
    let (mut exit_code, cli_observed_exit) = cli_exit_summary_from_status(&status);
    if pi_rpc_execution
        && jsonl_result.is_some_and(|result| result.status == JsonlResultStatus::Error)
    {
        exit_code = 1;
    }

    // Apply the same drain deadline to stderr — orphaned child processes
    // may hold the stderr fd open just like stdout.
    let stderr_timeout =
        tokio::time::sleep(Duration::from_secs(constants::STDOUT_DRAIN_DEADLINE_SECS));
    tokio::pin!(stderr_timeout);
    let stderr_lines = tokio::select! {
        result = &mut stderr_handle => match result {
            Ok(lines) => lines,
            Err(e) => {
                log_warn!(LOG_TAG, "stderr collector panicked: {e}");
                Vec::new()
            }
        },
        () = &mut stderr_timeout => {
            log_warn!(
                LOG_TAG,
                "stderr drain timeout, possible orphaned child process"
            );
            stderr_handle.abort();
            let _ = stderr_handle.await;
            Vec::new()
        },
    };
    let masked_stderr_lines = masker.mask_diagnostic_lines(stderr_lines);

    let (mut control_error, mut cli_termination) = termination_runtime.finish(exit_code);
    if pi_user_cancelled {
        control_error = Some(AgentError::Execution("Run cancelled by user".to_string()));
        cli_termination = Some(CliTerminationDiagnostic::new(
            guest_contracts::diagnostics::CliTerminationReason::UserCancellation,
        ));
    }

    if let Some(err) = event_error {
        return Err(err);
    }

    Ok(CliExecutionResult {
        exit_code,
        cli_observed_exit,
        stderr_lines: masked_stderr_lines,
        last_event_sequence: delivery_report.last_acknowledged_sequence,
        event_delivery: delivery_report.diagnostic,
        heartbeat: heartbeat_failure,
        jsonl_result,
        post_result_cleanup_jsonl_result,
        failure_diagnostic,
        control_error,
        cli_termination,
        active_input_delivery_ids,
    })
}

fn cli_exit_summary_from_status(status: &ExitStatus) -> (i32, Option<CliObservedExitDiagnostic>) {
    if let Some(code) = status.code() {
        return (code, Some(CliObservedExitDiagnostic::from_exit_code(code)));
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            log_warn!(LOG_TAG, "Process killed by signal {sig}");
            let observed_exit = CliObservedExitDiagnostic::from_signal(sig);
            return (observed_exit.mapped_exit_code, Some(observed_exit));
        }
    }

    (1, None)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliExitObservation {
    NoNewExit,
    ExitedDrainingStdout,
    ExitedAndStdoutClosed,
}

fn try_observe_cli_exit(
    child: &mut tokio::process::Child,
    cli_status: &mut Option<ExitStatus>,
    cli_exit_at: &mut Option<Instant>,
    active_input_controller: &ActiveInputController,
    termination_runtime: &mut CliTerminationRuntime,
    stdout_closed: bool,
    drain_deadline: Pin<&mut Sleep>,
) -> Result<CliExitObservation, AgentError> {
    if cli_status.is_some() {
        return Ok(CliExitObservation::NoNewExit);
    }

    let Some(status) = child.try_wait().map_err(AgentError::Io)? else {
        return Ok(CliExitObservation::NoNewExit);
    };

    Ok(record_cli_exit(
        status,
        cli_status,
        cli_exit_at,
        active_input_controller,
        termination_runtime,
        stdout_closed,
        drain_deadline,
    ))
}

fn record_cli_exit(
    status: ExitStatus,
    cli_status: &mut Option<ExitStatus>,
    cli_exit_at: &mut Option<Instant>,
    active_input_controller: &ActiveInputController,
    termination_runtime: &mut CliTerminationRuntime,
    stdout_closed: bool,
    mut drain_deadline: Pin<&mut Sleep>,
) -> CliExitObservation {
    debug_assert!(cli_status.is_none(), "CLI exit recorded more than once");
    *cli_exit_at = Some(Instant::now());
    log_info!(
        LOG_TAG,
        "CLI process exited (status: {status}), draining stdout"
    );
    *cli_status = Some(status);
    active_input_controller.close_terminal();
    // CLI exited on its own (possibly in response to our SIGTERM). Park the
    // termination FSM so it can't re-arm on late result/control events while
    // stdout is draining.
    termination_runtime.mark_child_exited();
    if stdout_closed {
        return CliExitObservation::ExitedAndStdoutClosed;
    }

    drain_deadline.as_mut().reset(
        tokio::time::Instant::now() + Duration::from_secs(constants::STDOUT_DRAIN_DEADLINE_SECS),
    );
    CliExitObservation::ExitedDrainingStdout
}

fn set_cli_current_dir(cmd: &mut tokio::process::Command, path: &str) -> Result<(), AgentError> {
    let path = Path::new(path);
    let metadata = std::fs::metadata(path).map_err(|e| {
        AgentError::Execution(format!(
            "canonical working directory unavailable before CLI spawn: {}: {e}",
            path.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(AgentError::Execution(format!(
            "canonical working directory is not a directory before CLI spawn: {}",
            path.display()
        )));
    }
    cmd.current_dir(path);
    Ok(())
}

fn select_failure_diagnostic(
    existing: Option<&CliFailureDiagnostic>,
    candidate: CliFailureDiagnostic,
) -> Option<CliFailureDiagnostic> {
    if candidate.source != FailureDetailSource::CodexJsonl {
        return Some(candidate);
    }

    match existing {
        None => Some(candidate),
        Some(existing) => {
            if has_specific_failure_message(&candidate) {
                return Some(with_carried_failure_reason(Some(existing), candidate));
            }
            if candidate.failure_reason.is_some() {
                let mut selected = existing.clone();
                selected.failure_reason = candidate.failure_reason;
                return Some(selected);
            }
            if existing.source == FailureDetailSource::CodexJsonl
                && !has_specific_failure_diagnostic(existing)
            {
                return Some(candidate);
            }
            None
        }
    }
}

fn has_specific_failure_diagnostic(diagnostic: &CliFailureDiagnostic) -> bool {
    diagnostic.failure_reason.is_some() || has_specific_failure_message(diagnostic)
}

fn has_specific_failure_message(diagnostic: &CliFailureDiagnostic) -> bool {
    !failure_patterns::is_generic_codex_failure_diagnostic(&diagnostic.message)
}

fn with_carried_failure_reason(
    existing: Option<&CliFailureDiagnostic>,
    mut candidate: CliFailureDiagnostic,
) -> CliFailureDiagnostic {
    if candidate.failure_reason.is_none() {
        candidate.failure_reason = existing.and_then(|diagnostic| diagnostic.failure_reason);
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::termination::{CliTerminationRuntime, PostResultCleanupPolicy};
    use super::{
        CliExitObservation, CliFailureDiagnostic, CliRuntimeConfig, child_env,
        claude_initial_prompt_frame, cli_exit_summary_from_status, command, exec_boundary,
        pi_child_env_values, record_cli_exit, select_failure_diagnostic, set_cli_current_dir,
        with_carried_failure_reason, write_pi_langfuse_bootstrap_file,
        write_pi_launch_payload_file,
    };
    use crate::active_input::ActiveInputRuntime;
    use crate::paths;
    use crate::session_metadata::SessionHistoryLaunchSource;
    use crate::{constants, env};
    use api_contracts::generated::types::runners::runs::CodexRuntimeConfig;
    use guest_contracts::diagnostics::{FailureDetailSource, FailureReason};
    use std::borrow::Cow;
    use std::collections::HashMap;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    use std::path::Path;
    use std::time::{Duration, Instant};

    struct SystemLogOverrideGuard;

    impl SystemLogOverrideGuard {
        fn set(path: &Path) -> Self {
            guest_telemetry::log::set_system_log_file(path);
            Self
        }
    }

    impl Drop for SystemLogOverrideGuard {
        fn drop(&mut self) {
            guest_telemetry::log::clear_system_log_file();
        }
    }

    fn guest_config_for_agent_context(user_env: HashMap<String, String>) -> env::GuestConfig {
        env::GuestConfig {
            run_id: "run-okou-env-test".to_string(),
            api_url: "https://runner.example".to_string(),
            api_token: "test-token".to_string(),
            sandbox_id: String::new(),
            sandbox_reuse_result: String::new(),
            workspace_reuse_result: String::new(),
            prompt: "prompt".to_string(),
            append_system_prompt: String::new(),
            vercel_bypass: String::new(),
            resume_session_id: String::new(),
            api_start_time: String::new(),
            agent_execution_timeout: None,
            secret_values: String::new(),
            disallowed_tools: String::new(),
            tools: String::new(),
            settings: String::new(),
            use_mock_claude: false,
            mock_claude_path: String::new(),
            cli_agent_type: "codex".to_string(),
            framework: env::Framework::Codex,
            user_env,
            use_mock_codex: false,
            mock_codex_path: String::new(),
            home_dir: "/tmp/home".to_string(),
            claude_config_dir: "/tmp/claude-config".to_string(),
            codex_home_dir: "/tmp/codex-home".to_string(),
            artifacts: Vec::new(),
            feature_flags: HashMap::new(),
            codex_runtime_config: String::new(),
            pi_launch_config: String::new(),
            pi_model_config: String::new(),
            pi_session_id: String::new(),
            stuck_tool_timeout_secs: constants::STUCK_TOOL_TIMEOUT_SECS,
            post_result_sigterm_grace: Duration::from_secs(
                constants::POST_RESULT_SIGTERM_GRACE_SECS,
            ),
            post_result_total_cap: Duration::from_secs(constants::POST_RESULT_TOTAL_CAP_SECS),
            post_result_sigkill_grace: Duration::from_secs(
                constants::POST_RESULT_SIGKILL_GRACE_SECS,
            ),
        }
    }

    fn assert_codex_service_tier_fast_mode(
        user_env: HashMap<String, String>,
        expected_fast_mode: bool,
    ) {
        let config = guest_config_for_agent_context(user_env);
        let paths =
            crate::paths::GuestPaths::from_runtime_dir("/tmp/codex-service-tier-resolution-test");
        let runtime = CliRuntimeConfig::from_config(&config, &paths, Instant::now()).unwrap();

        assert_eq!(runtime.codex_fast_mode, expected_fast_mode);
        let startup_configs = runtime.codex_startup_config_overrides();
        for config in super::CODEX_FAST_MODE_STARTUP_CONFIGS {
            assert_eq!(
                startup_configs.contains(&config.to_string()),
                expected_fast_mode
            );
        }
    }

    fn runtime_for_command_test<'a>(
        framework: env::Framework,
        prompt: &'a str,
        append_system_prompt: &'a str,
        user_env: &'a HashMap<String, String>,
    ) -> CliRuntimeConfig<'a> {
        CliRuntimeConfig {
            framework,
            run_id: Cow::Borrowed("run-exec-boundary-test"),
            prompt: Cow::Borrowed(prompt),
            resume_session_id: Cow::Borrowed(""),
            append_system_prompt: Cow::Borrowed(append_system_prompt),
            disallowed_tools: Cow::Borrowed(""),
            tools: Cow::Borrowed(""),
            settings: Cow::Borrowed(""),
            use_mock_claude: false,
            mock_claude_path: Cow::Borrowed(""),
            use_mock_codex: false,
            mock_codex_path: Cow::Borrowed(""),
            home_dir: Cow::Borrowed("/tmp/home"),
            claude_config_dir: Cow::Borrowed("/tmp/claude-config"),
            codex_home_dir: Cow::Borrowed("/tmp/codex-home"),
            api_url: Cow::Borrowed(""),
            api_start_time: Cow::Borrowed(""),
            anthropic_model: Cow::Borrowed(""),
            openai_model: Cow::Borrowed(""),
            openai_base_url: Cow::Borrowed(""),
            codex_runtime_config: None,
            codex_oauth_mode: false,
            codex_fast_mode: false,
            reasoning_effort: None,
            disable_builtin_web_search: false,
            agent_execution_deadline: None,
            stuck_tool_timeout_secs: constants::STUCK_TOOL_TIMEOUT_SECS,
            post_result_cleanup_policy: PostResultCleanupPolicy::new(
                Duration::from_secs(constants::POST_RESULT_SIGTERM_GRACE_SECS),
                Duration::from_secs(constants::POST_RESULT_TOTAL_CAP_SECS),
                Duration::from_secs(constants::POST_RESULT_SIGKILL_GRACE_SECS),
            ),
            agent_log_file: Cow::Borrowed("/tmp/agent.log"),
            session_id_file: Cow::Borrowed("/tmp/session-id"),
            session_history_launch_source: match framework {
                env::Framework::ClaudeCode => SessionHistoryLaunchSource::ClaudeCode {
                    config_dir: Some("/tmp/home/.claude".to_string()),
                    working_dir: paths::CANONICAL_WORKING_DIR.to_string(),
                },
                env::Framework::Codex => SessionHistoryLaunchSource::Codex {
                    sessions_dir: Some("/tmp/codex-home/sessions".to_string()),
                },
                env::Framework::Pi => SessionHistoryLaunchSource::Pi,
            },
            claude_append_system_prompt_file: Cow::Borrowed("/tmp/claude-append-system-prompt"),
            pi_session_id: Cow::Borrowed(""),
            pi_launch_config: Cow::Borrowed(""),
            pi_launch_payload_file: Cow::Borrowed("/tmp/pi-launch-payload/payload.json"),
            pi_model_config: Cow::Borrowed(""),
            user_env,
        }
    }

    #[test]
    fn explicit_claude_effort_overrides_user_env_without_mutating_it() {
        let user_env = HashMap::from([
            ("CLAUDE_CODE_EFFORT_LEVEL".to_string(), "low".to_string()),
            ("CUSTOM_USER_ENV".to_string(), "keep".to_string()),
        ]);
        let mut runtime =
            runtime_for_command_test(env::Framework::ClaudeCode, "prompt", "", &user_env);
        assert_eq!(
            runtime.child_user_env().get("CLAUDE_CODE_EFFORT_LEVEL"),
            Some(&"low".to_string())
        );
        runtime.reasoning_effort = Some("ultracode");
        assert!(
            !runtime
                .child_user_env()
                .contains_key("CLAUDE_CODE_EFFORT_LEVEL")
        );
        assert_eq!(
            runtime.child_user_env().get("CUSTOM_USER_ENV"),
            Some(&"keep".to_string())
        );
        assert_eq!(
            user_env.get("CLAUDE_CODE_EFFORT_LEVEL"),
            Some(&"low".to_string())
        );
    }

    #[test]
    fn codex_web_search_override_is_in_app_server_startup_config() {
        let user_env = HashMap::new();
        let mut runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);

        assert!(
            !runtime
                .codex_startup_config_overrides()
                .contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string())
        );

        runtime.disable_builtin_web_search = true;

        assert!(
            runtime
                .codex_startup_config_overrides()
                .contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string())
        );
    }

    #[test]
    fn pi_langfuse_credentials_use_a_private_bootstrap_file_not_child_env() {
        let directory = tempfile::tempdir().unwrap();
        let launch_payload = directory.path().join("pi-launch/payload.json");
        let user_env = HashMap::from([
            (
                super::PI_LANGFUSE_DEBUG_ENABLED_ENV_KEY.to_string(),
                "true".to_string(),
            ),
            (
                super::LANGFUSE_PUBLIC_KEY_ENV_KEY.to_string(),
                "pk-lf-private".to_string(),
            ),
            (
                super::LANGFUSE_SECRET_KEY_ENV_KEY.to_string(),
                "sk-lf-private".to_string(),
            ),
            (
                super::LANGFUSE_BASE_URL_ENV_KEY.to_string(),
                "https://us.cloud.langfuse.com".to_string(),
            ),
        ]);
        let mut runtime = runtime_for_command_test(env::Framework::Pi, "prompt", "", &user_env);
        runtime.pi_launch_payload_file = Cow::Owned(launch_payload.to_string_lossy().into_owned());

        let child_values = child_env::values_for_runtime(&runtime);
        assert!(
            !child_values
                .iter()
                .any(|(key, _)| key == super::LANGFUSE_PUBLIC_KEY_ENV_KEY)
        );
        assert!(
            !child_values
                .iter()
                .any(|(key, _)| key == super::LANGFUSE_SECRET_KEY_ENV_KEY)
        );
        assert!(child_values.iter().any(|(key, value)| key
            == super::PI_LANGFUSE_DEBUG_ENABLED_ENV_KEY
            && value == "true"));
        #[cfg(target_os = "linux")]
        {
            let mut child = std::process::Command::new("/bin/sh");
            child
                .arg("-c")
                .arg("tr '\\0' '\\n' < /proc/self/environ")
                .env_clear()
                .envs(child_values.iter().cloned());
            let output = child.output().unwrap();
            assert!(output.status.success());
            let initial_environment = String::from_utf8(output.stdout).unwrap();
            assert!(!initial_environment.contains("pk-lf-private"));
            assert!(!initial_environment.contains("sk-lf-private"));
        }

        let bootstrap = write_pi_langfuse_bootstrap_file(&runtime)
            .unwrap()
            .expect("complete credentials should create a bootstrap file");
        let path = bootstrap.environment_value().to_string();
        let payload: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(payload["publicKey"], "pk-lf-private");
        assert_eq!(payload["secretKey"], "sk-lf-private");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(bootstrap);
        assert!(!Path::new(&path).exists());
    }

    #[test]
    fn pi_langfuse_credentials_remain_user_owned_when_tracing_gate_is_off() {
        let user_env = HashMap::from([
            (
                super::LANGFUSE_PUBLIC_KEY_ENV_KEY.to_string(),
                "user-public-key".to_string(),
            ),
            (
                super::LANGFUSE_SECRET_KEY_ENV_KEY.to_string(),
                "user-secret-key".to_string(),
            ),
        ]);
        let runtime = runtime_for_command_test(env::Framework::Pi, "prompt", "", &user_env);
        let child_values = child_env::values_for_runtime(&runtime);

        assert!(child_values.iter().any(|(key, value)| {
            key == super::LANGFUSE_PUBLIC_KEY_ENV_KEY && value == "user-public-key"
        }));
        assert!(child_values.iter().any(|(key, value)| {
            key == super::LANGFUSE_SECRET_KEY_ENV_KEY && value == "user-secret-key"
        }));
        assert!(
            write_pi_langfuse_bootstrap_file(&runtime)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pi_child_env_passes_v2_model_config_with_canonical_run_id() {
        let user_env = HashMap::new();
        let mut runtime = runtime_for_command_test(env::Framework::Pi, "prompt", "", &user_env);
        runtime.pi_session_id = Cow::Borrowed("22222222-2222-4222-8222-222222222222");
        runtime.pi_launch_config = Cow::Borrowed(r#"{"schemaVersion":2}"#);
        runtime.pi_model_config = Cow::Borrowed(
            r#"{"schemaVersion":2,"dialect":"openai-codex-responses","transport":"sse","provider":"openai-codex","baseUrl":"https://chatgpt.com/backend-api/codex","model":"gpt-5.3-codex","credentialBindings":[{"kind":"access-token","environment":"CHATGPT_ACCESS_TOKEN","secretName":"CHATGPT_ACCESS_TOKEN"},{"kind":"account-id","environment":"CHATGPT_ACCOUNT_ID","secretName":"CHATGPT_ACCOUNT_ID"}]}"#,
        );
        let mut values = child_env::values_for_runtime(&runtime);
        values.extend(pi_child_env_values(&runtime));
        let values = child_env::normalize_values(values);

        let canonical_run_id = values
            .iter()
            .find(|(key, _)| key == guest_contracts::env::RUN_ID_ENV)
            .map(|(_, value)| value.as_str());
        assert_eq!(canonical_run_id, Some(runtime.run_id.as_ref()));
        for (key, expected) in [
            (
                guest_contracts::env::PI_SESSION_ID_ENV,
                runtime.pi_session_id.as_ref(),
            ),
            (
                guest_contracts::env::PI_LAUNCH_PAYLOAD_FILE_ENV,
                runtime.pi_launch_payload_file.as_ref(),
            ),
            (
                guest_contracts::env::PI_MODEL_CONFIG_ENV,
                runtime.pi_model_config.as_ref(),
            ),
        ] {
            assert_eq!(
                values
                    .iter()
                    .find(|(candidate, _)| candidate == key)
                    .map(|(_, value)| value.as_str()),
                Some(expected)
            );
        }
    }

    #[test]
    fn pi_child_env_omits_launch_config_value() {
        let user_env = HashMap::new();
        let mut runtime = runtime_for_command_test(env::Framework::Pi, "prompt", "", &user_env);
        runtime.pi_launch_config = Cow::Borrowed(
            r#"{"schemaVersion":2,"maintenance":{"rawMemory":"PRIVATE_MAINTENANCE_CANDIDATE_31891"}}"#,
        );
        let mut values = child_env::values_for_runtime(&runtime);
        values.extend(pi_child_env_values(&runtime));
        let values = child_env::normalize_values(values);

        assert!(
            !values
                .iter()
                .any(|(key, _)| key == guest_contracts::env::PI_LAUNCH_CONFIG_ENV)
        );
        assert!(
            !values
                .iter()
                .any(|(_, value)| value.contains("schemaVersion")
                    || value.contains("PRIVATE_MAINTENANCE_CANDIDATE_31891"))
        );
    }

    #[test]
    fn pi_launch_payload_file_merges_append_system_prompt_privately() {
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::paths::GuestPaths::from_runtime_dir(dir.path());
        let user_env = HashMap::new();
        let mut runtime = runtime_for_command_test(
            env::Framework::Pi,
            "prompt",
            "Your name is Okou.",
            &user_env,
        );
        runtime.pi_launch_config = Cow::Borrowed(r#"{"schemaVersion":2}"#);
        runtime.pi_launch_payload_file = Cow::Borrowed(paths.pi_launch_payload_file());

        write_pi_launch_payload_file(&runtime).unwrap();

        let path = Path::new(paths.pi_launch_payload_file());
        let payload: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["appendSystemPrompt"], "Your name is Okou.");
        assert_eq!(payload["launchConfig"]["schemaVersion"], 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn pi_launch_payload_file_uses_null_for_absent_append_system_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::paths::GuestPaths::from_runtime_dir(dir.path());
        let user_env = HashMap::new();
        let mut runtime = runtime_for_command_test(env::Framework::Pi, "prompt", "", &user_env);
        runtime.pi_launch_config = Cow::Borrowed(r#"{"schemaVersion":2}"#);
        runtime.pi_launch_payload_file = Cow::Borrowed(paths.pi_launch_payload_file());

        write_pi_launch_payload_file(&runtime).unwrap();

        let raw = std::fs::read(paths.pi_launch_payload_file()).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert!(payload["appendSystemPrompt"].is_null());
    }

    #[test]
    fn codex_runtime_accepts_okou_agent_context() {
        let config = guest_config_for_agent_context(HashMap::from([(
            super::OKOU_AGENT_ID_ENV_KEY.to_string(),
            "agent-test".to_string(),
        )]));
        let paths = crate::paths::GuestPaths::from_runtime_dir("/tmp/okou-env-test");

        let runtime = CliRuntimeConfig::from_config(&config, &paths, Instant::now()).unwrap();

        assert!(runtime.disable_builtin_web_search);
        assert!(
            runtime
                .codex_startup_config_overrides()
                .contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string())
        );
    }

    #[test]
    fn codex_service_tier_preserves_canonical_semantics() {
        assert_codex_service_tier_fast_mode(HashMap::new(), false);
        for (value, expected_fast_mode) in [("fast", true), ("", false), ("priority", false)] {
            assert_codex_service_tier_fast_mode(
                HashMap::from([(
                    super::CODEX_SERVICE_TIER_CANONICAL_ENV.to_string(),
                    value.to_string(),
                )]),
                expected_fast_mode,
            );
        }
    }

    #[test]
    fn codex_service_tier_value_is_not_logged() {
        let _system_log_state_guard = crate::lock_system_log_test_state();
        let tmp = tempfile::tempdir().unwrap();
        let system_log_path = tmp.path().join("system.log");
        std::fs::File::create(&system_log_path).unwrap();
        let system_log_guard = SystemLogOverrideGuard::set(&system_log_path);
        let paths = crate::paths::GuestPaths::from_runtime_dir(tmp.path());
        let value = "canonical-value-must-not-log";
        let config = guest_config_for_agent_context(HashMap::from([(
            super::CODEX_SERVICE_TIER_CANONICAL_ENV.to_string(),
            value.to_string(),
        )]));
        CliRuntimeConfig::from_config(&config, &paths, Instant::now()).unwrap();

        drop(system_log_guard);
        let system_log = std::fs::read_to_string(&system_log_path).unwrap();
        assert!(!system_log.contains(value));
    }

    #[test]
    fn codex_web_search_override_composes_with_provider_config() {
        let user_env = HashMap::new();
        let mut runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);
        runtime.disable_builtin_web_search = true;
        runtime.codex_runtime_config = Some(CodexRuntimeConfig {
            provider_id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: "https://api.deepseek.com/".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            http_headers: None,
            requires_openai_auth: None,
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: None,
        });

        let overrides = runtime.codex_startup_config_overrides();

        assert!(overrides.contains(&r#"model_provider="deepseek""#.to_string()));
        assert!(overrides.contains(&super::CODEX_WEB_SEARCH_DISABLED_CONFIG.to_string()));
    }

    #[test]
    fn claude_large_prompt_is_not_rejected_by_process_argv_guard() {
        let user_env = HashMap::new();
        let prompt = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
        let runtime = runtime_for_command_test(env::Framework::ClaudeCode, &prompt, "", &user_env);

        let cmd = command::build_claude_command_for_runtime(&runtime, false);
        let (bin, args) = cmd.split_first().unwrap();
        let env_values = child_env::values_for_runtime(&runtime);

        exec_boundary::validate_process_argv_env(
            "test cli child",
            bin,
            args.iter().map(String::as_str),
            &env_values,
        )
        .unwrap();
    }

    #[test]
    fn codex_app_server_large_prompt_is_not_part_of_process_argv_guard() {
        let user_env = HashMap::new();
        let prompt = "x".repeat(guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1);
        let runtime = runtime_for_command_test(env::Framework::Codex, &prompt, "", &user_env);
        let mut env_values = child_env::values_for_runtime(&runtime);
        env_values.push(("CODEX_HOME".to_string(), runtime.codex_home().to_string()));

        exec_boundary::validate_process_argv_env(
            "test codex app-server",
            "codex",
            ["app-server", "--listen", "stdio://"],
            &env_values,
        )
        .unwrap();
    }

    #[test]
    fn codex_child_env_keeps_openai_base_url_without_structured_runtime_config() {
        let user_env = HashMap::from([
            ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
            ("OPENAI_MODEL".to_string(), "gpt-5".to_string()),
            (
                "OPENAI_BASE_URL".to_string(),
                "https://api.legacy-provider.test/v1".to_string(),
            ),
        ]);
        let runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);

        let env_values = child_env::values_for_runtime(&runtime);

        assert!(env_values.iter().any(|(key, value)| {
            key == "OPENAI_BASE_URL" && value == "https://api.legacy-provider.test/v1"
        }));
    }

    #[test]
    fn structured_codex_runtime_config_omits_stale_openai_base_url_from_child_env() {
        let user_env = HashMap::from([
            ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
            ("OPENAI_MODEL".to_string(), "deepseek-v4-flash".to_string()),
            (
                "OPENAI_BASE_URL".to_string(),
                "https://api.should-not-win.test/v1".to_string(),
            ),
        ]);
        let mut runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);
        runtime.codex_runtime_config = Some(CodexRuntimeConfig {
            provider_id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            base_url: "https://api.deepseek.com/".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            http_headers: None,
            requires_openai_auth: None,
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: None,
        });

        let env_values = child_env::values_for_runtime(&runtime);

        assert!(
            env_values
                .iter()
                .any(|(key, value)| { key == "OPENAI_API_KEY" && value == "sk-test" })
        );
        assert!(
            env_values
                .iter()
                .any(|(key, value)| { key == "OPENAI_MODEL" && value == "deepseek-v4-flash" })
        );
        assert!(!env_values.iter().any(|(key, _)| key == "OPENAI_BASE_URL"));
    }

    #[test]
    fn claude_initial_prompt_frame_matches_stream_json_user_shape() {
        let frame = serde_json::to_value(claude_initial_prompt_frame("run_123", "hello stdin"))
            .expect("serialize prompt frame");

        assert_eq!(
            frame.get("type").and_then(serde_json::Value::as_str),
            Some("user")
        );
        assert_eq!(
            frame
                .pointer("/message/role")
                .and_then(serde_json::Value::as_str),
            Some("user")
        );
        assert_eq!(
            frame
                .pointer("/message/content")
                .and_then(serde_json::Value::as_str),
            Some("hello stdin")
        );
        assert!(
            frame
                .get("parent_tool_use_id")
                .is_some_and(serde_json::Value::is_null)
        );
        let uuid = frame
            .get("uuid")
            .and_then(serde_json::Value::as_str)
            .expect("uuid");
        uuid::Uuid::parse_str(uuid).expect("valid uuid");
    }

    #[test]
    fn codex_home_is_independent_of_child_home() {
        let user_env = HashMap::new();
        let runtime = runtime_for_command_test(env::Framework::Codex, "prompt", "", &user_env);

        assert_eq!(runtime.home_dir, "/tmp/home");
        assert_eq!(runtime.codex_home(), "/tmp/codex-home");
        let SessionHistoryLaunchSource::Codex { sessions_dir } =
            &runtime.session_history_launch_source
        else {
            panic!("expected Codex session-history source");
        };
        assert_eq!(sessions_dir.as_deref(), Some("/tmp/codex-home/sessions"));
    }

    #[tokio::test]
    async fn cli_current_dir_helper_sets_child_working_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cmd = tokio::process::Command::new("pwd");
        cmd.stdout(std::process::Stdio::piped());

        set_cli_current_dir(&mut cmd, dir.path().to_str().expect("utf8 temp path"))
            .expect("set cwd");
        let output = cmd.output().await.expect("pwd");

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            dir.path().to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn cli_exit_summary_preserves_normal_exit_137() {
        let status = std::process::ExitStatus::from_raw(137 << 8);

        let (exit_code, observed_exit) = cli_exit_summary_from_status(&status);

        let observed_exit = observed_exit.expect("normal exit should be observed");
        assert_eq!(exit_code, 137);
        assert_eq!(
            observed_exit,
            guest_contracts::diagnostics::CliObservedExitDiagnostic::from_exit_code(137)
        );
        assert!(!observed_exit.is_sigkill());
    }

    #[cfg(unix)]
    #[test]
    fn cli_exit_summary_preserves_signal_exit_before_mapping() {
        let status = std::process::ExitStatus::from_raw(libc::SIGKILL);

        let (exit_code, observed_exit) = cli_exit_summary_from_status(&status);

        let observed_exit = observed_exit.expect("signal exit should be observed");
        assert_eq!(exit_code, 137);
        assert_eq!(
            observed_exit,
            guest_contracts::diagnostics::CliObservedExitDiagnostic::from_signal(libc::SIGKILL)
        );
        assert!(observed_exit.is_sigkill());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cli_exit_observation_distinguishes_stdout_drain_from_loop_completion() {
        let active_input = ActiveInputRuntime::new_disabled("run-exit-observation", "");
        let controller = active_input.controller();
        let termination_deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(termination_deadline);
        let drain_deadline = tokio::time::sleep(Duration::MAX);
        tokio::pin!(drain_deadline);
        let mut runtime = CliTerminationRuntime::new(
            None,
            PostResultCleanupPolicy::new(
                Duration::from_secs(3),
                Duration::from_secs(60),
                Duration::from_secs(1),
            ),
        );
        assert!(runtime.arm_post_result_cleanup(false, termination_deadline.as_mut()));

        let mut cli_status = None;
        let mut cli_exit_at = None;
        let observation = record_cli_exit(
            std::process::ExitStatus::from_raw(0),
            &mut cli_status,
            &mut cli_exit_at,
            &controller,
            &mut runtime,
            false,
            drain_deadline.as_mut(),
        );

        assert_eq!(observation, CliExitObservation::ExitedDrainingStdout);
        assert!(cli_status.is_some());
        assert!(cli_exit_at.is_some());
        assert!(!runtime.has_pending_deadline());
        assert!(!runtime.has_post_result_cleanup());
        assert!(!runtime.arm_post_result_cleanup(false, termination_deadline.as_mut()));
    }

    #[test]
    fn cli_current_dir_helper_errors_for_missing_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing");
        let mut cmd = tokio::process::Command::new("pwd");

        let err = set_cli_current_dir(&mut cmd, missing.to_str().expect("utf8 temp path"))
            .expect_err("missing cwd should fail");

        assert!(
            err.to_string()
                .contains("canonical working directory unavailable")
        );
    }

    #[test]
    fn cli_current_dir_helper_errors_for_non_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("workspace-file");
        std::fs::write(&file, b"not a directory").expect("write file");
        let mut cmd = tokio::process::Command::new("pwd");

        let err = set_cli_current_dir(&mut cmd, file.to_str().expect("utf8 temp path"))
            .expect_err("non-directory cwd should fail");

        assert!(err.to_string().contains("is not a directory"));
    }

    #[test]
    fn specific_codex_failure_diagnostic_survives_later_generic_event() {
        for generic_message in [
            "turn failed",
            "Turn failed.",
            "Unknown error",
            "codex error",
        ] {
            assert_eq!(
                select_failure_diagnostic(
                    Some(&CliFailureDiagnostic {
                        message: "You've hit your usage limit.".to_string(),
                        source: FailureDetailSource::CodexJsonl,
                        failure_reason: None,
                    }),
                    CliFailureDiagnostic {
                        message: generic_message.to_string(),
                        source: FailureDetailSource::CodexJsonl,
                        failure_reason: None,
                    },
                ),
                None,
                "generic message should not replace specific diagnostic: {generic_message}"
            );
        }
    }

    #[test]
    fn generic_codex_failure_diagnostic_replaces_prior_generic_event() {
        let selected = select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            }),
            CliFailureDiagnostic {
                message: "Unknown error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            },
        );

        assert_eq!(
            selected,
            Some(CliFailureDiagnostic {
                message: "Unknown error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            })
        );
    }

    #[test]
    fn generic_codex_failure_diagnostic_does_not_replace_specific_claude_result() {
        assert_eq!(
            select_failure_diagnostic(
                Some(&CliFailureDiagnostic {
                    message: "Claude result failure".to_string(),
                    source: FailureDetailSource::ClaudeResult,
                    failure_reason: None,
                }),
                CliFailureDiagnostic {
                    message: "Unknown error".to_string(),
                    source: FailureDetailSource::CodexJsonl,
                    failure_reason: None,
                },
            ),
            None,
        );
    }

    #[test]
    fn specific_codex_failure_diagnostic_replaces_generic_event() {
        let selected = select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            }),
            CliFailureDiagnostic {
                message: "You've hit your usage limit.".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            },
        );

        assert_eq!(
            selected.map(|diagnostic| diagnostic.message),
            Some("You've hit your usage limit.".to_string())
        );
    }

    #[test]
    fn codex_failure_reason_replaces_generic_diagnostic() {
        let selected = select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "error".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            }),
            CliFailureDiagnostic {
                message: "turn failed".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: Some(FailureReason::InvalidApiKey),
            },
        );

        assert_eq!(
            selected.map(|diagnostic| diagnostic.failure_reason),
            Some(Some(FailureReason::InvalidApiKey))
        );
    }

    #[test]
    fn generic_codex_reason_preserves_existing_specific_message() {
        let selected = select_failure_diagnostic(
            Some(&CliFailureDiagnostic {
                message: "request failed before shutdown".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            }),
            CliFailureDiagnostic {
                message: "turn failed".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: Some(FailureReason::InvalidApiKey),
            },
        )
        .expect("reason-bearing generic diagnostic should update existing diagnostic");

        assert_eq!(selected.message, "request failed before shutdown");
        assert_eq!(selected.failure_reason, Some(FailureReason::InvalidApiKey));
    }

    #[test]
    fn carried_failure_reason_survives_message_replacement() {
        let candidate = with_carried_failure_reason(
            Some(&CliFailureDiagnostic {
                message: "turn failed".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: Some(FailureReason::InvalidApiKey),
            }),
            CliFailureDiagnostic {
                message: "request failed".to_string(),
                source: FailureDetailSource::CodexJsonl,
                failure_reason: None,
            },
        );

        assert_eq!(candidate.message, "request failed");
        assert_eq!(candidate.failure_reason, Some(FailureReason::InvalidApiKey));
    }
}
