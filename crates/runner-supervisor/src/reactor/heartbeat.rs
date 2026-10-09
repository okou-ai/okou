//! Minimal runtime resource projection for supervisor heartbeats.

use std::collections::BTreeMap;

use super::RuntimeProfile;
use crate::heartbeat::HeartbeatProfile;

pub(super) fn heartbeat_profiles(
    profiles: &BTreeMap<String, RuntimeProfile>,
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
