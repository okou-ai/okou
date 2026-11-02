//! Validation for runner group names.
//!
//! Group names follow the `org/name` convention (e.g. `vm0/prod`,
//! `acme/staging`). They are joined against `HomePaths::groups_dir()`
//! to form on-disk paths, so any input containing `..`, leading `/`,
//! or extra `/` could escape the intended directory.

use crate::error::{RunnerError, RunnerResult};

/// Validate `name` and return a `RunnerError::Config` with a uniform
/// message if it fails. Use this at every callsite that takes a group
/// name from the user (CLI flags, YAML config) so the error wording
/// stays consistent.
pub fn validate_or_err(name: &str) -> RunnerResult<()> {
    if !runner_types::org_name::is_valid(name) {
        return Err(RunnerError::Config(format!(
            "invalid group name: {name} (must be org/name format, lowercase alphanumeric + hyphens)"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
