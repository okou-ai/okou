//! Launch the official Antigravity CLI in its signed-in Google account mode.

mod auth;
mod stream;
pub(super) use stream::Projection;

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde_json::json;
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;

use super::CliRuntimeConfig;
use crate::error::AgentError;

const RULE_FILE_BYTES: usize = 24_000;
const MODEL_ENV: &str = "OKOU_ANTIGRAVITY_MODEL";

pub(super) struct Launch {
    pub(super) argv: Vec<String>,
    pub(super) model: String,
    // Keep the rules and hook alive until the child has exited.
    _rules: TempDir,
}

impl Launch {
    pub(super) fn prepare(runtime: &CliRuntimeConfig<'_>) -> Result<Self, AgentError> {
        let family = runtime.user_env.get(MODEL_ENV).map(String::as_str);
        let effort = runtime
            .user_env
            .get("OKOU_REASONING_EFFORT")
            .map(String::as_str);
        let model = model_slug(family, effort)?;
        if !runtime.resume_session_id.is_empty() {
            return Err(AgentError::Execution(
                "Antigravity requires an independently verified account and conversation to resume"
                    .into(),
            ));
        }
        let rules = tempfile::Builder::new()
            .prefix("okou-antigravity-")
            .tempdir_in("/tmp")?;
        let binary = "/usr/local/bin/agy";
        #[cfg(feature = "test-support")]
        let binary = runtime.test_antigravity_cli_path.unwrap_or(binary);
        let mut argv = vec![
            binary.to_owned(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--disable-slash-commands".into(),
            "--mode".into(),
            "accept-edits".into(),
            "--dangerously-skip-permissions".into(),
            "--settings".into(),
            settings().to_string(),
            "--model".into(),
            model.clone(),
        ];
        write_tool_policy(rules.path(), &runtime.disallowed_tools)?;
        argv.extend(["--add-dir".into(), rules.path().display().to_string()]);
        // Each added workspace loads its AGENTS.md as a system rule. Split at
        // the CLI's per-file cap without changing the user's workspace.
        let mut text = runtime.append_system_prompt.as_ref();
        let mut index = 0;
        while !text.is_empty() {
            let end = text.floor_char_boundary(text.len().min(RULE_FILE_BYTES));
            let end = if end < text.len() {
                text[..end].rfind('\n').map_or(end, |i| i + 1)
            } else {
                end
            };
            let (chunk, rest) = text.split_at(end);
            let directory = if index == 0 {
                rules.path().to_owned()
            } else {
                let path = rules.path().join(format!("instructions-{index:04}"));
                fs::create_dir(&path)?;
                argv.extend(["--add-dir".into(), path.display().to_string()]);
                path
            };
            fs::write(directory.join("AGENTS.md"), chunk)?;
            index += 1;
            text = rest;
        }
        // With additional roots agy selects the first workspace path in sorted
        // order for relative shell commands. The canonical workspace precedes
        // the isolated rules under /tmp and must remain a writable root.
        argv.extend([
            "--add-dir".into(),
            crate::paths::CANONICAL_WORKING_DIR.into(),
        ]);
        // Install the member's personal Google credential (or clear a stale one
        // from a reused sandbox) before agy reads its local credential store.
        let credential = runtime
            .user_env
            .get(auth::CREDENTIAL_ENV)
            .map(|raw| auth::AntigravityCredential::parse(raw))
            .transpose()?;
        auth::reconcile_credential(runtime.home_dir.as_ref(), credential.as_ref())?;
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
        "modelProvider": "", "useG1Credits": false,
        "enableTerminalSandbox": false, "toolPermission": "always-proceed",
        "allowNonWorkspaceAccess": true, "artifactReviewPolicy": "always-proceed"
    })
}

fn model_slug(model: Option<&str>, effort: Option<&str>) -> Result<String, AgentError> {
    let model = match model {
        Some(model @ ("gemini-4-carbon" | "gemini-4-neon" | "gemini-4-hydrogen")) => model,
        _ => {
            return Err(AgentError::Execution(
                "Missing or unsupported Antigravity model".into(),
            ));
        }
    };
    let effort = effort.unwrap_or("medium");
    if !matches!(effort, "low" | "medium" | "high")
        && !(effort == "xhigh" && model != "gemini-4-carbon")
    {
        return Err(AgentError::Execution(
            "Unsupported reasoning effort for the selected Antigravity model".into(),
        ));
    }
    Ok(format!("{model}-{effort}"))
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
            // --disable-slash-commands prevents the native /loop invocation.
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

pub(super) async fn write_prompt(
    mut stdin: tokio::process::ChildStdin,
    prompt: &str,
) -> Result<(), AgentError> {
    let mut line = serde_json::to_vec(&json!({"event":"user","message":{"content":prompt}}))?;
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.shutdown().await?;
    Ok(())
}

#[cfg(test)]
mod tests;
