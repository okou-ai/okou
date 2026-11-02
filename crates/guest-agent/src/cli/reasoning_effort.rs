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
mod tests;
