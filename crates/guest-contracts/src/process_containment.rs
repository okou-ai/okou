//! Shared guest process-containment and resource-policy contract.
//!
//! Each exec operation owns an empty parent cgroup with `control` and
//! `workload` children. Ordinary execs run directly in `workload`. For an agent
//! operation, `workload` is an empty domain containing a `runtime` leaf for the
//! agent CLI and a `tools` domain with one child per managed shell tool.

use std::collections::HashMap;
use std::io;

use crate::diagnostics::WorkloadResourceLimitDiagnostic;

/// Canonical cgroup v2 mount inside the guest.
pub const CGROUP_V2_MOUNT_PATH: &str = "/sys/fs/cgroup";

/// Cgroup containing all active exec-operation child cgroups.
pub const EXEC_CGROUP_BASE_PATH: &str = "/sys/fs/cgroup/vm0-exec";

/// Prefix for each per-operation cgroup directly below the exec cgroup base.
pub const EXEC_CGROUP_NAME_PREFIX: &str = "exec-";

/// Leaf reserved for the trusted Guest Agent control process.
pub const CONTROL_CGROUP_NAME: &str = "control";

/// Workload leaf for ordinary execs and domain for agent operations.
pub const WORKLOAD_CGROUP_NAME: &str = "workload";

/// Leaf containing the agent CLI and its runtime helpers.
pub const RUNTIME_CGROUP_NAME: &str = "runtime";

/// Empty domain containing one cgroup per agent shell tool.
pub const TOOLS_CGROUP_NAME: &str = "tools";

/// Prefix for one shell invocation cgroup below [`TOOLS_CGROUP_NAME`].
pub const TOOL_CGROUP_NAME_PREFIX: &str = "tool-";

/// Cgroup v2 controllers required for workload resource isolation.
pub const REQUIRED_CGROUP_CONTROLLERS: [&str; 3] = ["cpu", "memory", "pids"];

/// Value written to `cgroup.subtree_control` to enable required controllers.
pub const REQUIRED_CGROUP_SUBTREE_CONTROL: &str = "+cpu +memory +pids";

/// Runner-owned endpoint that transfers a workload `cgroup.procs` descriptor.
///
/// The root guest supervisor keeps the write-only descriptor out of the user
/// launch chain and sends it with `SCM_RIGHTS` only after Guest Agent connects
/// from the matching operation `control` cgroup. Guest Agent requires this key
/// at the root bootstrap boundary and uses cloned descriptors only from
/// CLI-child `pre_exec` hooks.
pub const CANONICAL_WORKLOAD_CGROUP_PROCS_ENV: &str = "OKOU_WORKLOAD_CGROUP_PROCS_ENDPOINT";

/// Runner-owned endpoint used by [`crate::guest_binary::TOOL_EXEC_PATH`] to request a unique tool
/// cgroup before it executes user code.
///
/// `guest-control-server` writes this key to Guest Agent, whose root bootstrap reader
/// requires it. Guest Agent intentionally exposes the same key to managed CLI
/// children, and `guest-tool-exec` and the managed mock launcher consult it.
pub const CANONICAL_TOOL_CGROUP_PROCS_ENV: &str = "OKOU_TOOL_CGROUP_PROCS_ENDPOINT";

/// Smallest Runner profile vCPU count validated for workload containment.
pub const MIN_PROFILE_VCPU: u32 = 1;

/// Smallest configured Runner profile memory size validated for workload
/// containment. Guest startup independently derives its policy from the
/// smaller capacity actually visible inside the VM.
pub const MIN_PROFILE_MEMORY_MB: u32 = 1024;

/// CPU bandwidth period used for workload cgroups.
pub const WORKLOAD_CPU_PERIOD_US: u64 = 100_000;

/// CPU time per period reserved outside each operation workload cgroup.
pub const CONTROL_CPU_RESERVE_US: u64 = 10_000;

/// Minimum accumulated CPU throttling reported as material pressure.
pub const MATERIAL_CPU_THROTTLED_USEC: u64 = 1_000_000;

/// Minimum protected memory for Guest control services.
///
/// This protects charged Guest Agent use, not an allocation or usage ceiling.
pub const CONTROL_MEMORY_MIN_BYTES: u64 = 128 * 1024 * 1024;

/// Protected memory for the native agent runtime, including its file-backed pages.
///
/// Managed tools share the workload hard limit but must not reclaim this working
/// set and stall native model/control processing before an OOM victim is chosen.
/// Unused protection remains available to tools; runtime use above this floor
/// remains reclaimable. This does not make the runtime immune to OOM killing.
pub const RUNTIME_MEMORY_MIN_BYTES: u64 = 384 * 1024 * 1024;

/// Combined control/runtime protection carried by the exec base and Agent operation.
///
/// Cgroup v2 caps effective protection at every ancestor. The workload ancestor
/// carries only [`RUNTIME_MEMORY_MIN_BYTES`]; ordinary execs and tools have no
/// leaf protection. Ancestor values do not allocate additional physical memory.
pub const AGENT_MEMORY_MIN_BYTES: u64 = CONTROL_MEMORY_MIN_BYTES + RUNTIME_MEMORY_MIN_BYTES;

/// Memory kept outside the workload hard limit for new Guest control use.
///
/// Existing control use is protected from reclaim by [`CONTROL_MEMORY_MIN_BYTES`].
/// This smaller reserve leaves capacity for control allocations that have not
/// yet been charged while allowing the Guest to enter whole-memory reclaim
/// before the workload reaches its local hard limit.
pub const WORKLOAD_MEMORY_RESERVE_BYTES: u64 = 128 * 1024 * 1024;

/// Value written to workload `memory.high` to avoid unmonitored soft-limit reclaim.
pub const WORKLOAD_MEMORY_HIGH: &str = "max";

/// Value written to the workload domain's `memory.oom.group`.
///
/// Keeping group OOM disabled prevents a parent-limit OOM from unconditionally
/// terminating the entire operation. Managed shell-tool leaves opt into group
/// OOM independently through [`TOOL_MEMORY_OOM_GROUP`].
pub const WORKLOAD_MEMORY_OOM_GROUP: &str = "0";

/// Value written to each individual tool's `memory.oom.group`.
pub const TOOL_MEMORY_OOM_GROUP: &str = "1";

/// Value written to workload `pids.max` while no production ceiling is calibrated.
///
/// The PID controller remains enabled for accounting and operation-local
/// enforcement tests, but normal workloads are not capped by an arbitrary
/// task count.
pub const WORKLOAD_PIDS_MAX: &str = "max";

/// Highest cgroup v2 CPU weight, assigned to a controlled operation and its
/// Guest Agent leaf so concurrent ordinary execs cannot dominate it.
pub const CONTROL_CPU_WEIGHT: u64 = 10_000;

/// Workload cgroup-v2 resource events shared by guest consumers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkloadResourceEvents {
    /// Number of workload CPU periods that contained throttling.
    pub cpu_nr_throttled: u64,
    /// Total workload CPU time throttled, in microseconds.
    pub cpu_throttled_usec: u64,
    /// Number of workload `memory.high` events.
    pub memory_high: u64,
    /// Number of workload `memory.max` events.
    pub memory_max: u64,
    /// Number of workload OOM events.
    pub memory_oom: u64,
    /// Number of workload processes killed by the OOM killer.
    pub memory_oom_kill: u64,
    /// Number of workload cgroups killed as an OOM group.
    pub memory_oom_group_kill: u64,
    /// Number of workload forks or clones rejected by `pids.max`.
    pub pids_max: u64,
}

impl WorkloadResourceEvents {
    /// Parse the flat-keyed contents of `cpu.stat`, `memory.events`, and
    /// `pids.events` for one workload cgroup.
    ///
    /// Missing known counters default to zero and unknown numeric counters are
    /// ignored. Malformed lines return [`io::ErrorKind::InvalidData`].
    pub fn from_file_contents(
        cpu_stat: &str,
        memory_events: &str,
        pids_events: &str,
    ) -> io::Result<Self> {
        let cpu = parse_key_values(cpu_stat)?;
        let memory = parse_key_values(memory_events)?;
        let pids = parse_key_values(pids_events)?;
        Ok(Self {
            cpu_nr_throttled: value_or_zero(&cpu, "nr_throttled"),
            cpu_throttled_usec: value_or_zero(&cpu, "throttled_usec"),
            memory_high: value_or_zero(&memory, "high"),
            memory_max: value_or_zero(&memory, "max"),
            memory_oom: value_or_zero(&memory, "oom"),
            memory_oom_kill: value_or_zero(&memory, "oom_kill"),
            memory_oom_group_kill: value_or_zero(&memory, "oom_group_kill"),
            pids_max: value_or_zero(&pids, "max"),
        })
    }

    /// Build the canonical hard-limit diagnostic when any such event occurred.
    #[must_use]
    pub fn hard_limit_diagnostic(self) -> Option<WorkloadResourceLimitDiagnostic> {
        let diagnostic = WorkloadResourceLimitDiagnostic {
            memory_max_events: self.memory_max,
            memory_oom_events: self.memory_oom,
            memory_oom_kill_events: self.memory_oom_kill,
            memory_oom_group_kill_events: self.memory_oom_group_kill,
            pids_max_events: self.pids_max,
        };
        diagnostic.has_events().then_some(diagnostic)
    }

    /// Whether the snapshot contains material CPU or memory pressure.
    #[must_use]
    pub const fn has_material_pressure(self) -> bool {
        self.cpu_throttled_usec >= MATERIAL_CPU_THROTTLED_USEC || self.memory_high > 0
    }
}

fn parse_key_values(contents: &str) -> io::Result<HashMap<&str, u64>> {
    contents
        .lines()
        .map(|line| {
            let mut fields = line.split_ascii_whitespace();
            let key = fields.next().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "missing cgroup counter name")
            })?;
            let value = fields
                .next()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "missing cgroup counter value")
                })?
                .parse::<u64>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if fields.next().is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unexpected cgroup counter field",
                ));
            }
            Ok((key, value))
        })
        .collect()
}

fn value_or_zero(values: &HashMap<&str, u64>, key: &str) -> u64 {
    values.get(key).copied().unwrap_or(0)
}

/// Calibrated cgroup v2 resource policy for one operation workload domain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkloadResourcePolicy {
    /// Workload CPU quota in microseconds per [`Self::cpu_period_us`].
    pub cpu_quota_us: u64,
    /// Workload CPU bandwidth period in microseconds.
    pub cpu_period_us: u64,
    /// Value written to the workload `memory.high` cgroup file.
    pub memory_high: &'static str,
    /// Workload hard memory limit in bytes.
    pub memory_max_bytes: u64,
    /// Value written to the workload `memory.oom.group` cgroup file.
    pub memory_oom_group: &'static str,
    /// Protected Guest Agent memory in bytes.
    pub control_memory_min_bytes: u64,
    /// Protected native agent runtime memory in bytes.
    pub runtime_memory_min_bytes: u64,
    /// Value written to the workload `pids.max` cgroup file.
    pub pids_max: &'static str,
}

impl WorkloadResourcePolicy {
    /// Derive the policy from capacity visible to the current Guest.
    ///
    /// Only Agent operations require room for the protected memory floors.
    pub fn for_current_guest_capacity(protect_agent: bool) -> Result<Self, &'static str> {
        // SAFETY: these sysconf selectors return scalar capacity values.
        let vcpu = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
        // SAFETY: these sysconf selectors return scalar capacity values.
        let physical_pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
        // SAFETY: these sysconf selectors return scalar capacity values.
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if vcpu <= 0 || physical_pages <= 0 || page_size <= 0 {
            return Err("guest capacity query returned a non-positive value");
        }
        let vcpu = u32::try_from(vcpu).map_err(|_| "guest vCPU count is out of range")?;
        let memory_bytes = u64::try_from(physical_pages)
            .ok()
            .and_then(|pages| {
                u64::try_from(page_size)
                    .ok()
                    .and_then(|size| pages.checked_mul(size))
            })
            .ok_or("guest physical memory size is out of range")?;
        Self::for_guest_capacity(vcpu, memory_bytes, protect_agent)
    }

    /// Derive the fixed platform policy from Guest-visible capacity.
    ///
    /// `vcpu` is the number of online processors and `memory_bytes` is physical
    /// memory visible to the Guest. Agent operations also require capacity for
    /// the combined control and runtime floor. Ordinary exec does not receive
    /// these floors and only needs capacity for its workload hard-limit reserve.
    pub fn for_guest_capacity(
        vcpu: u32,
        memory_bytes: u64,
        protect_agent: bool,
    ) -> Result<Self, &'static str> {
        let total_cpu_us = u64::from(vcpu)
            .checked_mul(WORKLOAD_CPU_PERIOD_US)
            .ok_or("guest vCPU capacity overflows workload policy")?;
        let cpu_quota_us = total_cpu_us
            .checked_sub(CONTROL_CPU_RESERVE_US)
            .filter(|quota| *quota > 0)
            .ok_or("guest CPU capacity cannot preserve control headroom")?;

        if protect_agent {
            memory_bytes
                .checked_sub(AGENT_MEMORY_MIN_BYTES)
                .filter(|remaining| *remaining > 0)
                .ok_or(
                    "guest memory capacity cannot preserve control and runtime memory minimum",
                )?;
        }
        let memory_max_bytes = memory_bytes
            .checked_sub(WORKLOAD_MEMORY_RESERVE_BYTES)
            .filter(|limit| *limit > 0)
            .ok_or("guest memory capacity cannot preserve workload memory reserve")?;
        Ok(Self {
            cpu_quota_us,
            cpu_period_us: WORKLOAD_CPU_PERIOD_US,
            memory_high: WORKLOAD_MEMORY_HIGH,
            memory_max_bytes,
            memory_oom_group: WORKLOAD_MEMORY_OOM_GROUP,
            control_memory_min_bytes: CONTROL_MEMORY_MIN_BYTES,
            runtime_memory_min_bytes: RUNTIME_MEMORY_MIN_BYTES,
            pids_max: WORKLOAD_PIDS_MAX,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cgroup_placement_environment_contracts_match_wire_names() {
        assert_eq!(
            CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            "OKOU_WORKLOAD_CGROUP_PROCS_ENDPOINT"
        );
        assert_eq!(
            CANONICAL_TOOL_CGROUP_PROCS_ENV,
            "OKOU_TOOL_CGROUP_PROCS_ENDPOINT"
        );
    }

    #[test]
    fn derives_default_profile_policy() {
        let policy =
            WorkloadResourcePolicy::for_guest_capacity(2, u64::from(4096_u32) * 1024 * 1024, true)
                .unwrap();

        assert_eq!(policy.cpu_quota_us, 190_000);
        assert_eq!(policy.cpu_period_us, 100_000);
        assert_eq!(policy.memory_high, "max");
        assert_eq!(policy.memory_max_bytes, 3968 * 1024 * 1024);
        assert_eq!(policy.memory_oom_group, "0");
        assert_eq!(policy.control_memory_min_bytes, 128 * 1024 * 1024);
        assert_eq!(policy.runtime_memory_min_bytes, 384 * 1024 * 1024);
        assert_eq!(policy.pids_max, "max");
    }

    #[test]
    fn rejects_capacity_without_control_and_runtime_memory_minimum() {
        let error = WorkloadResourcePolicy::for_guest_capacity(1, AGENT_MEMORY_MIN_BYTES, true)
            .unwrap_err();

        assert_eq!(
            error,
            "guest memory capacity cannot preserve control and runtime memory minimum"
        );
    }

    #[test]
    fn derives_small_profile_policy_from_fixed_reserves() {
        let policy =
            WorkloadResourcePolicy::for_guest_capacity(1, u64::from(1024_u32) * 1024 * 1024, true)
                .unwrap();

        assert_eq!(policy.cpu_quota_us, 90_000);
        assert_eq!(policy.memory_high, "max");
        assert_eq!(policy.memory_max_bytes, 896 * 1024 * 1024);
        assert_eq!(policy.control_memory_min_bytes, 128 * 1024 * 1024);
        assert_eq!(policy.runtime_memory_min_bytes, 384 * 1024 * 1024);
    }

    #[test]
    fn derives_policy_from_calibrated_minimum_guest_capacity() {
        // A 1-vCPU/1024-MiB Firecracker Guest exposes this physical capacity
        // after kernel reservations on the production-equivalent test host.
        let policy = WorkloadResourcePolicy::for_guest_capacity(1, 1_033_928_704, true).unwrap();

        assert_eq!(policy.cpu_quota_us, 90_000);
        assert_eq!(policy.memory_high, "max");
        assert_eq!(policy.memory_max_bytes, 899_710_976);
    }

    #[test]
    fn ordinary_exec_preserves_small_guest_capacity_without_agent_floors() {
        // Host CPU fairness uses 512 MiB Guests; kernel reservations further
        // reduce the capacity visible to the Guest's policy derivation.
        let guest_memory_bytes = 480 * 1024 * 1024;
        let policy =
            WorkloadResourcePolicy::for_guest_capacity(1, guest_memory_bytes, false).unwrap();

        assert_eq!(policy.memory_max_bytes, 352 * 1024 * 1024);
        assert_eq!(policy.memory_high, "max");
        assert!(WorkloadResourcePolicy::for_guest_capacity(1, guest_memory_bytes, true).is_err());
    }

    #[test]
    fn ordinary_exec_still_requires_workload_reserve_capacity() {
        let error =
            WorkloadResourcePolicy::for_guest_capacity(1, WORKLOAD_MEMORY_RESERVE_BYTES, false)
                .unwrap_err();

        assert_eq!(
            error,
            "guest memory capacity cannot preserve workload memory reserve"
        );
    }
}
