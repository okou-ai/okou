//! Bounded storage-apply completion evidence shared by the guest and Runner.

use serde::{Deserialize, Serialize};

/// Optional completed phases outside the existing Guest-server execution timer.
/// These are wall microseconds, not transport time or resource counters.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct StorageControlTiming {
    /// Submit entry through owned-request construction, before enqueue.
    pub request_ownership_us: Option<u64>,
    /// Enqueue-ready ownership through admitted worker handler entry.
    pub worker_wait_us: Option<u64>,
    /// Post-execution output/resource preparation through timing serialization.
    /// Final metadata bytes, frame encoding and response writing are excluded.
    pub response_prepare_us: Option<u64>,
}

/// Additive optional timing reader, independent of legacy resource validation.
#[derive(Debug, Default, Deserialize)]
pub struct StorageControlTimingMetadata {
    /// Missing or invalid optional timing never invalidates core/resource results.
    pub storage_control_timing: Option<StorageControlTiming>,
}

/// Distinguishes resource-less terminal timing from a malformed resource record.
#[derive(Debug, Default, Deserialize)]
pub struct StorageResourceAvailability {
    /// Absent on older metadata; false carries no fabricated resource counters.
    pub storage_resource_available: Option<bool>,
}

/// Configured leaf resource limit, distinct from an unavailable reading.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum StorageResourceLimit {
    /// Finite quota or byte limit.
    Value(u64),
    /// Kernel unlimited marker.
    Unlimited(StorageUnlimited),
}

/// Literal unlimited marker accepted from a cgroup limit file.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StorageUnlimited {
    /// The kernel reports no finite limit.
    #[serde(rename = "max")]
    Max,
}

/// Cleanup decision, not the helper's terminal status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StorageCleanupMode {
    /// The helper exited normally.
    Graceful,
    /// Timeout, cancellation or startup failure requires forced cleanup.
    Forced,
}

/// One pre-cleanup snapshot of a fresh storage workload cgroup.
///
/// Unknown kernel readings remain null. Fields are deliberately allowlisted;
/// deserializing then serializing drops unknown peer fields before logging.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StorageResourceUsage {
    /// UUID-shaped operation identity; arbitrary request text is not logged.
    pub run_id: Option<String>,
    /// Storage request sequence on the guest-control connection.
    pub request_seq: u32,
    /// Generated exec cgroup name, validated before host logging.
    pub group: String,
    /// Cleanup decision at the snapshot boundary.
    pub cleanup_mode: StorageCleanupMode,
    /// Time from fresh containment activation to snapshot start.
    pub containment_wall_us: u64,
    /// Snapshot reads/assembly, excluding serialization and transport.
    pub collection_us: u64,
    /// Cgroup cpu.stat usage_usec counter, when available.
    pub cpu_usage_usec: Option<u64>,
    /// Cgroup cpu.stat user_usec counter, when available.
    pub cpu_user_usec: Option<u64>,
    /// Cgroup cpu.stat system_usec counter, when available.
    pub cpu_system_usec: Option<u64>,
    /// Cgroup cpu.stat nr_periods counter, when available.
    pub cpu_nr_periods: Option<u64>,
    /// Cgroup cpu.stat nr_throttled counter, when available.
    pub cpu_nr_throttled: Option<u64>,
    /// Cgroup cpu.stat throttled_usec counter, when available.
    pub cpu_throttled_usec: Option<u64>,
    /// Cgroup memory.events high counter, when available.
    pub memory_events_high: Option<u64>,
    /// Cgroup memory.events max counter, when available.
    pub memory_events_max: Option<u64>,
    /// Cgroup memory.events oom counter, when available.
    pub memory_events_oom: Option<u64>,
    /// Cgroup memory.events oom_kill counter, when available.
    pub memory_events_oom_kill: Option<u64>,
    /// Cgroup memory.events oom_group_kill counter, when available.
    pub memory_events_oom_group_kill: Option<u64>,
    /// Cgroup pids.events max counter, when available.
    pub pids_events_max: Option<u64>,
    /// Cgroup memory.stat pgfault counter, when available.
    pub memory_pgfault: Option<u64>,
    /// Cgroup memory.stat pgmajfault counter, when available.
    pub memory_pgmajfault: Option<u64>,
    /// Cgroup memory.stat pgscan counter, when available.
    pub memory_pgscan: Option<u64>,
    /// Cgroup memory.stat pgsteal counter, when available.
    pub memory_pgsteal: Option<u64>,
    /// Cgroup memory.stat pgscan_kswapd counter, when available.
    pub memory_pgscan_kswapd: Option<u64>,
    /// Cgroup memory.stat pgscan_direct counter, when available.
    pub memory_pgscan_direct: Option<u64>,
    /// Cgroup memory.stat pgsteal_kswapd counter, when available.
    pub memory_pgsteal_kswapd: Option<u64>,
    /// Cgroup memory.stat pgsteal_direct counter, when available.
    pub memory_pgsteal_direct: Option<u64>,
    /// Cgroup memory.stat workingset_refault_anon counter, when available.
    pub memory_workingset_refault_anon: Option<u64>,
    /// Cgroup memory.stat workingset_refault_file counter, when available.
    pub memory_workingset_refault_file: Option<u64>,
    /// Current bytes charged to the workload cgroup.
    pub memory_current_bytes: Option<u64>,
    /// Peak charged bytes since cgroup creation.
    pub memory_peak_bytes: Option<u64>,
    /// Configured leaf memory.high, not an effective ancestor limit.
    pub memory_high_limit_bytes: Option<StorageResourceLimit>,
    /// Configured leaf memory.max, not an effective ancestor limit.
    pub memory_max_limit_bytes: Option<StorageResourceLimit>,
    /// Configured leaf cpu.max quota, not an effective ancestor limit.
    pub cpu_quota_us: Option<StorageResourceLimit>,
    /// Configured cpu.max period in microseconds.
    pub cpu_period_us: Option<u64>,
}

impl StorageResourceUsage {
    /// Verify safe identity and bind optional evidence to its actual RPC.
    pub fn matches_request(&self, run_id: &str, sequence: u32) -> bool {
        let expected_run_id =
            (run_id.len() == 36 && uuid::Uuid::parse_str(run_id).is_ok()).then_some(run_id);
        let mut group = self.group.split('-');
        self.run_id.as_deref() == expected_run_id
            && self.request_seq == sequence
            && self.group.len() <= 64
            && group.next() == Some("exec")
            && group
                .next()
                .and_then(|value| value.parse::<u32>().ok())
                .is_some()
            && group.next().and_then(|value| value.parse::<u32>().ok()) == Some(sequence)
            && group
                .next()
                .and_then(|value| value.parse::<u64>().ok())
                .is_some()
            && group.next().is_none()
    }
}
