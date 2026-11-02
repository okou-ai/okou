use crate::error::{RunnerError, RunnerResult};

use runner_types::profile::DEFAULT_PROFILE_DEF;
pub use runner_types::profile::ProfileDef;

pub use runner_types::profile_name::DEFAULT_PROFILE;

/// Return the profile definition for a given profile name.
pub fn get(name: &str) -> RunnerResult<&'static ProfileDef> {
    static DEFAULT: ProfileDef = DEFAULT_PROFILE_DEF;

    if name == DEFAULT_PROFILE {
        Ok(&DEFAULT)
    } else {
        Err(RunnerError::Config(format!(
            "unknown profile: {name}. available profiles: {DEFAULT_PROFILE}"
        )))
    }
}

/// Validate `name` and return a `RunnerError::Config` with a uniform
/// message if it fails. Use this at every callsite that takes a profile
/// name from the user (CLI flags, YAML config) so the error wording
/// stays consistent.
pub fn validate_or_err(name: &str) -> RunnerResult<()> {
    if !runner_types::org_name::is_valid(name) {
        return Err(RunnerError::Config(format!(
            "invalid profile name: {name} (must be org/name format, lowercase alphanumeric + hyphens)"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
