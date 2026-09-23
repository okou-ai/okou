use crate::{ProviderError, ProviderResult};

pub(crate) use runner_types::profile_name::DEFAULT_PROFILE;

pub(crate) fn validate_or_err(name: &str) -> ProviderResult<()> {
    if !runner_types::org_name::is_valid(name) {
        return Err(invalid_profile(name));
    }
    Ok(())
}

fn invalid_profile(name: &str) -> ProviderError {
    ProviderError::Config(format!(
        "invalid profile name: {name} (must be org/name format, lowercase alphanumeric + hyphens)"
    ))
}
