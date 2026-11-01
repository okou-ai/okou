//! Cgroup attribution shared by the existing diagnostic emitters.

use super::{EvidenceStatus, MemorySnapshot, OomEvidence, evidence_has_proof};
use crate::diagnostics::WorkloadResourceLimitDiagnostic;

/// Domain attribution, separate from whether the operation itself failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OomClassification {
    /// An in-operation kernel victim or local counter identifies the agent domain.
    AgentOomKill,
    /// Reliable counters account for the workload's kills entirely within tools.
    ContainedToolOom,
    /// OOM occurred, but incomplete or inconsistent evidence cannot prove containment.
    UnprovenContainment,
}

impl OomClassification {
    /// Stable names shared by Guest and Runner diagnostics.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AgentOomKill => "agent_oom_kill",
            Self::ContainedToolOom => "contained_tool_oom",
            Self::UnprovenContainment => "unproven_containment",
        }
    }
}

fn kill_delta(
    group: &MemorySnapshot,
    expected: &MemorySnapshot,
    role: &str,
    cgroup: &str,
    local: bool,
) -> Option<u64> {
    if group.role != role
        || group.cgroup != cgroup
        || expected.role != role
        || expected.cgroup != cgroup
        || group.inode.is_none()
        || group.inode != expected.inode
        || !matches!(
            group.status,
            EvidenceStatus::Available | EvidenceStatus::Partial | EvidenceStatus::Truncated
        )
    {
        return None;
    }
    let (baseline, events, delta, expected_baseline) = if local {
        (
            &group.local_baseline,
            &group.local_events,
            &group.local_delta,
            &expected.local_baseline,
        )
    } else {
        (
            &group.baseline,
            &group.events,
            &group.delta,
            &expected.baseline,
        )
    };
    if baseline.oom_kill != expected_baseline.oom_kill {
        return None;
    }
    let measured = events.oom_kill?.checked_sub(baseline.oom_kill?)?;
    (delta.oom_kill == Some(measured)).then_some(measured)
}

impl OomEvidence {
    /// Whether kernel victims or reliable local counters identify an OOM kill
    /// in the agent's own containment domain during this operation.
    ///
    /// Shell tools run in separately contained `<workload>/tools/tool-*` leaves.
    /// The kernel routinely reclaims those without ending the run, so only the
    /// workload domain itself and its runtime leaf attribute a terminated agent.
    /// Local counters have an independent cgroup identity and baseline, so they
    /// remain proof when bounded kernel records omit the victim. They identify
    /// the domain, not a specific victim PID. Hierarchical tool kills never
    /// attribute a terminated agent.
    pub fn agent_domain_oom_kill(&self) -> bool {
        let workload = self.groups[0].cgroup.as_str();
        let runtime = format!("{workload}/runtime");
        let kernel_victim = self
            .incidents
            .iter()
            .filter(|incident| {
                !matches!(
                    incident.kernel_status,
                    EvidenceStatus::Recreated | EvidenceStatus::Uncorrelated
                )
            })
            .flat_map(|incident| incident.kernel_events.iter())
            .any(|event| {
                event.boottime_us >= self.started_boottime_us
                    && (event.task_cgroup == workload || event.task_cgroup == runtime)
            });
        kernel_victim
            || std::iter::once(&self.groups)
                .chain(self.incidents.iter().map(|incident| &incident.groups))
                .any(|groups| {
                    kill_delta(&groups[0], &self.groups[0], "workload", workload, true)
                        .is_some_and(|delta| delta > 0)
                        || kill_delta(&groups[1], &self.groups[1], "runtime", &runtime, true)
                            .is_some_and(|delta| delta > 0)
                })
    }

    /// Classify only what retained evidence can prove. Missing agent records
    /// alone are not evidence that every workload kill stayed inside tools.
    pub fn classification(&self) -> Option<OomClassification> {
        if !evidence_has_proof(self) {
            return None;
        }
        if self.agent_domain_oom_kill() {
            return Some(OomClassification::AgentOomKill);
        }
        let workload = self.groups[0].cgroup.as_str();
        let runtime = format!("{workload}/runtime");
        let tools = format!("{workload}/tools");
        let workload_kills = kill_delta(
            &self.groups[0],
            &self.groups[0],
            "workload",
            workload,
            false,
        );
        let tools_kills = kill_delta(&self.groups[2], &self.groups[2], "tools", &tools, false);
        let contained = workload_kills.is_some_and(|kills| kills > 0)
            && workload_kills == tools_kills
            && kill_delta(&self.groups[0], &self.groups[0], "workload", workload, true) == Some(0)
            && kill_delta(&self.groups[1], &self.groups[1], "runtime", &runtime, true) == Some(0)
            && kill_delta(&self.groups[1], &self.groups[1], "runtime", &runtime, false) == Some(0);
        Some(if contained {
            OomClassification::ContainedToolOom
        } else {
            OomClassification::UnprovenContainment
        })
    }

    /// Preserve PID exhaustion and any counters the kernel attributed to the
    /// agent's own containment domain.
    pub fn proves_contained_resource_limit(&self, limit: &WorkloadResourceLimitDiagnostic) -> bool {
        let events = &self.groups[0].events;
        self.classification() == Some(OomClassification::ContainedToolOom)
            && limit.pids_max_events == 0
            && events.max == Some(limit.memory_max_events)
            && events.oom == Some(limit.memory_oom_events)
            && events.oom_kill == Some(limit.memory_oom_kill_events)
            && events.oom_group_kill == Some(limit.memory_oom_group_kill_events)
    }
}

#[cfg(test)]
mod tests;
