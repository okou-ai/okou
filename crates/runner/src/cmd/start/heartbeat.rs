//! Concrete Runner configuration projection for supervisor heartbeats.

use std::collections::BTreeMap;

use crate::config::ProfileConfig;
use runner_supervisor::heartbeat::HeartbeatProfile;

pub(super) fn heartbeat_profiles(
    profiles: &BTreeMap<String, ProfileConfig>,
) -> BTreeMap<String, HeartbeatProfile> {
    profiles
        .iter()
        .map(|(name, profile)| {
            (
                name.clone(),
                HeartbeatProfile {
                    vcpu: profile.vcpu,
                    memory_mb: profile.memory_mb,
                    workspace_disk_mb: profile.workspace_disk_mb,
                },
            )
        })
        .collect()
}
