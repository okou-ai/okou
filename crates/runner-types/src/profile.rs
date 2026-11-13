//! Resource shapes shared by Runner profile lookup and native qualification.

/// A platform-defined profile specifying VM resources.
pub struct ProfileDef {
    /// Number of vCPUs for VMs using this profile.
    pub vcpu: u32,
    /// Memory in MiB for VMs using this profile.
    pub memory_mb: u32,
    /// Rootfs disk size in MiB for VMs using this profile.
    pub rootfs_disk_mb: u32,
    /// Home disk size in MiB for VMs using this profile.
    pub home_disk_mb: u32,
}

/// Resource shape for [`crate::profile_name::DEFAULT_PROFILE`].
pub const DEFAULT_PROFILE_DEF: ProfileDef = ProfileDef {
    vcpu: api_contracts::generated::constants::runners::DEFAULT_PROFILE_VCPU,
    memory_mb: api_contracts::generated::constants::runners::DEFAULT_PROFILE_MEMORY_MB,
    rootfs_disk_mb: api_contracts::generated::constants::runners::DEFAULT_PROFILE_ROOTFS_DISK_MB,
    home_disk_mb: api_contracts::generated::constants::runners::DEFAULT_PROFILE_HOME_DISK_MB,
};
