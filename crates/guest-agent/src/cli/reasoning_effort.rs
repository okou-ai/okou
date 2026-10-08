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
    // The API admits an effort only when the selected model's catalog route
    // lists it, so the model choice is not checked again here. Only the
    // harness vocabulary is a protocol fact of this launcher.
    let supported = match framework {
        Framework::Codex => matches!(
            effort.as_str(),
            "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        ),
        _ => matches!(
            effort.as_str(),
            "low" | "medium" | "high" | "extra" | "max" | "ultracode"
        ),
    };
    if !supported {
        return Err(AgentError::Execution(
            "OKOU_REASONING_EFFORT is not supported by the selected native harness".to_string(),
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
    fn rejects_efforts_outside_the_harness_vocabulary() {
        for (framework, effort) in [
            (Framework::Codex, "extra"),
            (Framework::Codex, "ultracode"),
            (Framework::Codex, ""),
            (Framework::ClaudeCode, "xhigh"),
            (Framework::ClaudeCode, "ultra"),
            (Framework::ClaudeCode, ""),
        ] {
            let env = HashMap::from([("OKOU_REASONING_EFFORT".to_string(), effort.to_string())]);
            assert!(resolve(framework, &env).is_err(), "{framework:?}: {effort}");
        }
    }

    #[test]
    fn accepts_harness_efforts_for_any_catalog_model() {
        for (framework, model_key, model, effort, expected) in [
            (
                Framework::ClaudeCode,
                "ANTHROPIC_MODEL",
                "claude-haiku-5-5",
                "medium",
                "medium",
            ),
            (
                Framework::ClaudeCode,
                "ANTHROPIC_MODEL",
                "claude-haiku-5-5",
                "extra",
                "xhigh",
            ),
            (
                Framework::Codex,
                "OPENAI_MODEL",
                "openai/gpt-7",
                "ultra",
                "ultra",
            ),
        ] {
            let env = HashMap::from([
                (model_key.to_string(), model.to_string()),
                ("OKOU_REASONING_EFFORT".to_string(), effort.to_string()),
            ]);
            assert_eq!(
                resolve(framework, &env).ok().flatten(),
                Some(expected),
                "{model}: {effort}"
            );
        }
    }
}
