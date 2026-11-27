//! Launch the official Antigravity CLI in ACP (`agy acp`) mode.

mod acp;
mod auth;
mod backend;
mod events;

pub(super) use backend::execute_antigravity_acp_for_runtime;

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde_json::json;
use tempfile::TempDir;

use super::CliRuntimeConfig;
use crate::error::AgentError;

const MODEL_ENV: &str = "OKOU_ANTIGRAVITY_MODEL";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ModelSpec {
    pub(super) family: String,
    pub(super) effort: String,
    pub(super) slug: String,
}

pub(super) struct Launch {
    pub(super) argv: Vec<String>,
    pub(super) model: ModelSpec,
    // Keep the tool-policy hooks directory alive until the child has exited.
    _rules: TempDir,
}

impl Launch {
    pub(super) fn prepare(runtime: &CliRuntimeConfig<'_>) -> Result<Self, AgentError> {
        let family = runtime.user_env.get(MODEL_ENV).map(String::as_str);
        let effort = runtime
            .user_env
            .get("OKOU_REASONING_EFFORT")
            .map(String::as_str);
        let model = model_spec(family, effort)?;
        let rules = tempfile::Builder::new()
            .prefix("okou-antigravity-")
            .tempdir_in("/tmp")?;
        let binary = "/usr/local/bin/agy";
        #[cfg(feature = "test-support")]
        let binary = runtime.test_antigravity_cli_path.unwrap_or(binary);

        write_tool_policy(rules.path(), &runtime.disallowed_tools)?;

        // `agy acp` reads settings from `~/.gemini/antigravity-cli/settings.json`
        // rather than a `--settings` CLI flag.
        auth::write_settings(runtime.home_dir.as_ref(), &settings())?;

        // Install the member's personal Google credential (or clear a stale one
        // from a reused sandbox) before agy reads its local credential store.
        let credential = runtime
            .user_env
            .get(auth::CREDENTIAL_ENV)
            .map(|raw| auth::AntigravityCredential::parse(raw))
            .transpose()?;
        auth::reconcile_credential(runtime.home_dir.as_ref(), credential.as_ref())?;

        let argv = vec![
            binary.to_owned(),
            "acp".into(),
            "--dangerously-skip-permissions".into(),
            "--disable-telemetry".into(),
            "--add-dir".into(),
            rules.path().display().to_string(),
            "--add-dir".into(),
            crate::paths::CANONICAL_WORKING_DIR.into(),
        ];

        Ok(Self {
            argv,
            model,
            _rules: rules,
        })
    }
}

/// Run like Claude Code (`--dangerously-skip-permissions`) inside the Okou
/// sandbox, which is the isolation boundary. agy's terminal sandbox cuts off
/// networking on Linux, and its requests to run outside it wait for an
/// approval that a headless Run cannot give. Tool-policy deny rules still
/// apply.
fn settings() -> serde_json::Value {
    json!({
        "modelProvider": "",
        "useG1Credits": false,
        "enableTerminalSandbox": false,
        "toolPermission": "always-proceed",
        "allowNonWorkspaceAccess": true,
        "artifactReviewPolicy": "always-proceed",
    })
}

fn model_spec(model: Option<&str>, effort: Option<&str>) -> Result<ModelSpec, AgentError> {
    let family = match model {
        Some(model @ ("gemini-4-carbon" | "gemini-4-neon" | "gemini-4-hydrogen")) => model,
        _ => {
            return Err(AgentError::Execution(
                "Missing or unsupported Antigravity model".into(),
            ));
        }
    };
    let effort = effort.unwrap_or("medium");
    if !matches!(effort, "low" | "medium" | "high")
        && !(effort == "xhigh" && family != "gemini-4-carbon")
    {
        return Err(AgentError::Execution(
            "Unsupported reasoning effort for the selected Antigravity model".into(),
        ));
    }
    Ok(ModelSpec {
        family: family.to_owned(),
        effort: effort.to_owned(),
        slug: format!("{family}-{effort}"),
    })
}

fn write_tool_policy(dir: &Path, disallowed: &str) -> Result<(), AgentError> {
    let mut names = BTreeSet::new();
    for tool in disallowed
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let targets: &[&str] = match tool {
            "CronCreate" | "CronList" | "CronDelete" | "ScheduleWakeup" => &["schedule"],
            "AskUserQuestion" => &["ask_question"],
            "WebSearch" => &["search_web"],
            "WebFetch" => &["read_url_content"],
            "Bash" => &["run_command", "send_command_input"],
            "Skill(loop)" | "Skill(loop *)" => &[],
            _ => {
                return Err(AgentError::Execution(
                    "Unsupported Antigravity tool restriction".into(),
                ));
            }
        };
        names.extend(targets.iter().copied());
    }
    if names.is_empty() {
        return Ok(());
    }
    let hooks = dir.join(".agents");
    fs::create_dir(&hooks)?;
    let matcher = names.into_iter().collect::<Vec<_>>().join("|");
    let policy = json!({"okou-tool-policy": {"PreToolUse": [{
        "matcher": format!("^({matcher})$"),
        "hooks": [{"type": "command", "command": "echo '{\"decision\":\"deny\",\"reason\":\"This tool is disabled for this Run.\"}'"}]
    }]}});
    fs::write(hooks.join("hooks.json"), serde_json::to_vec(&policy)?)?;
    Ok(())
}

pub(super) fn configure_env(values: &mut Vec<(String, String)>) {
    values.retain(|(key, _)| {
        // The native credential reaches agy through its private on-disk store
        // only; never leave the raw grant in the child process environment.
        key.as_str() != auth::CREDENTIAL_ENV
            && !matches!(
                key.as_str(),
                "GEMINI_API_KEY"
                    | "GOOGLE_API_KEY"
                    | "GOOGLE_GEMINI_BASE_URL"
                    | "GOOGLE_APPLICATION_CREDENTIALS"
                    | "GOOGLE_GENAI_USE_VERTEXAI"
                    | "AGY_ADC_AUTH"
                    | "AGY_CLI_DISABLE_AUTO_UPDATE"
            )
    });
    values.push(("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "true".into()));
}

#[cfg(test)]
mod tests;
