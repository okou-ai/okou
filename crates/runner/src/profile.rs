use crate::error::{RunnerError, RunnerResult};

/// A platform-defined profile specifying VM resources.
pub struct ProfileDef {
    /// Number of vCPUs for VMs using this profile.
    pub vcpu: u32,
    /// Memory in MiB for VMs using this profile.
    pub memory_mb: u32,
    /// Rootfs disk size in MiB for VMs using this profile.
    pub rootfs_disk_mb: u32,
    /// Workspace disk size in MiB for VMs using this profile.
    pub workspace_disk_mb: u32,
}

pub const DEFAULT_PROFILE: &str = "vm0/default";

/// Return the profile definition for a given profile name.
pub fn get(name: &str) -> RunnerResult<&'static ProfileDef> {
    static DEFAULT: ProfileDef = ProfileDef {
        vcpu: 2,
        memory_mb: 4096,
        rootfs_disk_mb: 12288,
        workspace_disk_mb: 16384,
    };

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
    if !crate::org_name::is_valid(name) {
        return Err(RunnerError::Config(format!(
            "invalid profile name: {name} (must be org/name format, lowercase alphanumeric + hyphens)"
        )));
    }
    Ok(())
}

runner_test_group!(platform_support; #[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_default_profile() {
        let def = get("vm0/default").unwrap();
        assert_eq!(def.vcpu, 2);
        assert_eq!(def.memory_mb, 4096);
        assert_eq!(def.rootfs_disk_mb, 12288);
        assert_eq!(def.workspace_disk_mb, 16384);
    }

    #[test]
    fn get_unknown_profile_fails() {
        assert!(get("unknown").is_err());
    }

    #[test]
    fn validate_or_err_passes_for_valid_name() {
        assert!(validate_or_err("vm0/default").is_ok());
    }

    #[test]
    fn validate_or_err_carries_offending_name_in_message() {
        let err = validate_or_err("/etc").unwrap_err();
        assert_eq!(
            err.to_string(),
            "config error: invalid profile name: /etc (must be org/name format, lowercase alphanumeric + hyphens)"
        );
    }
});
