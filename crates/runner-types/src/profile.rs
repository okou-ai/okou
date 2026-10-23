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
    vcpu: 2,
    memory_mb: 4096,
    rootfs_disk_mb: 12288,
    home_disk_mb: 24576,
};
