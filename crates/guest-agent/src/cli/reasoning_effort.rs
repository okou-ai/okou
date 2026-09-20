//! Validate the platform's explicit native effort before starting a CLI.

use std::collections::HashMap;

use crate::{env::Framework, error::AgentError};

pub(super) fn resolve(
    framework: Framework,
    user_env: &HashMap<String, String>,
) -> Result<Option<&str>, AgentError> {
    // Pi owns its own launch configuration; native effort is not a Pi setting.
    if !matches!(framework, Framework::Codex | Framework::ClaudeCode) {
        return Ok(None);
    }
    let Some(effort) = user_env.get("OKOU_REASONING_EFFORT") else {
        return Ok(None);
    };
    let (model_key, prefix) = match framework {
        Framework::Codex => ("OPENAI_MODEL", "openai/"),
        _ => ("ANTHROPIC_MODEL", "anthropic/"),
    };
    let model = user_env.get(model_key).map(String::as_str).unwrap_or("");
    let model = model.strip_prefix(prefix).unwrap_or(model);
    let supported = matches!(
        (framework, model, effort.as_str()),
        (
            Framework::Codex,
            "gpt-6-astra" | "gpt-6-sol" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna",
            "low" | "medium" | "high" | "xhigh" | "max",
        ) | (
            Framework::Codex,
            "gpt-6-astra" | "gpt-6-sol" | "gpt-5.6-sol" | "gpt-5.6-terra",
            "ultra",
        ) | (
            Framework::Codex,
            "gpt-5.5",
            "low" | "medium" | "high" | "xhigh"
        ) | (
            Framework::ClaudeCode,
            "claude-fable-5-1"
                | "claude-fable-5.1"
                | "fable"
                | "claude-opus-5"
                | "claude-opus-4-8"
                | "claude-opus-4.8"
                | "claude-sonnet-5",
            "low" | "medium" | "high" | "extra" | "max" | "ultracode",
        ) | (
            Framework::ClaudeCode,
            "claude-sonnet-4-6" | "claude-sonnet-4.6",
            "low" | "medium" | "high" | "max",
        )
    );
    if !supported {
        return Err(AgentError::Execution(
            "OKOU_REASONING_EFFORT is not supported by the selected native model".to_string(),
        ));
    }
    // Okou names Claude's extended level `extra`; Claude Code 2.1.266 calls
    // that flag value `xhigh`. Keep ultracode intact as a separate CLI mode.
    Ok(Some(if effort == "extra" { "xhigh" } else { effort }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_or_unsupported_native_choices_before_launch() {
        for (framework, model_key, model, effort) in [
            (Framework::Codex, "OPENAI_MODEL", "gpt-5.5", "max"),
            (Framework::Codex, "OPENAI_MODEL", "gpt-5.6-luna", "ultra"),
            (Framework::Codex, "OPENAI_MODEL", "gpt-5.5", "ultra"),
            (Framework::Codex, "OPENAI_MODEL", "gpt-6-astra", "extra"),
            (Framework::Codex, "OPENAI_MODEL", "gpt-6-astra", "ultracode"),
            (Framework::Codex, "OPENAI_MODEL", "gpt-6-sol", "extra"),
            (Framework::Codex, "OPENAI_MODEL", "gpt-6-sol", "ultracode"),
            (
                Framework::ClaudeCode,
                "ANTHROPIC_MODEL",
                "claude-sonnet-4-6",
                "extra",
            ),
            (
                Framework::ClaudeCode,
                "ANTHROPIC_MODEL",
                "claude-sonnet-4-6",
                "ultracode",
            ),
            (
                Framework::ClaudeCode,
                "ANTHROPIC_MODEL",
                "claude-opus-5",
                "xhigh",
            ),
            (
                Framework::ClaudeCode,
                "ANTHROPIC_MODEL",
                "custom-model",
                "high",
            ),
            (
                Framework::ClaudeCode,
                "ANTHROPIC_MODEL",
                "claude-opus-5",
                "",
            ),
        ] {
            let env = HashMap::from([
                (model_key.to_string(), model.to_string()),
                ("OKOU_REASONING_EFFORT".to_string(), effort.to_string()),
            ]);
            assert!(resolve(framework, &env).is_err(), "{model}: {effort}");
        }
    }
}
