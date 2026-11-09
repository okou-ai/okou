use crate::{Result, SandboxError, SandboxOperation, SandboxOperationReason};

/// Validate environment variable names for sandbox exec and process requests.
///
/// Returns an operation error for the first invalid name in request order, with
/// the name escaped for diagnostics. Values are not inspected or modified.
/// Callers choose when to validate relative to backend lifecycle checks.
pub fn validate_exec_env_keys(operation: SandboxOperation, env: &[(&str, &str)]) -> Result<()> {
    for (key, _) in env {
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            return Err(SandboxError::Operation {
                operation,
                reason: SandboxOperationReason::Other,
                message: format!("invalid environment variable name: {}", key.escape_debug()),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
