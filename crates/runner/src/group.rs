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
mod tests {
    use super::*;

    #[test]
    fn validate_or_err_passes_for_valid_name() {
        assert!(validate_or_err("vm0/prod").is_ok());
    }

    #[test]
    fn validate_or_err_carries_offending_name_in_message() {
        let err = validate_or_err("/etc").unwrap_err();
        assert_eq!(
            err.to_string(),
            "config error: invalid group name: /etc (must be org/name format, lowercase alphanumeric + hyphens)"
        );
    }
}
