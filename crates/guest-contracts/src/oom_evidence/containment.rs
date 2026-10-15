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
mod tests {
    use super::*;

    fn fixture() -> OomEvidence {
        serde_json::from_str(include_str!("../../tests/fixtures/contained-tool-oom.json")).unwrap()
    }

    /// A byte copy of [`fixture`] as it stood before `runtime_progress_at` was
    /// removed, so the retired field is a real recorded payload rather than a
    /// hand-written one.
    fn legacy_fixture() -> OomEvidence {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/oom-evidence-v1-legacy-runtime-progress.json"
        ))
        .unwrap()
    }

    fn agent_domain_fixture() -> OomEvidence {
        serde_json::from_str(include_str!("../../tests/fixtures/oom-evidence-v1.json")).unwrap()
    }

    fn runtime_counter_fixture() -> OomEvidence {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/runtime-counter-oom.json"
        ))
        .unwrap()
    }

    fn with_victim(evidence: &OomEvidence, task_cgroup: &str) -> OomEvidence {
        let mut evidence = evidence.clone();
        evidence.incidents[0].kernel_events[0].task_cgroup = task_cgroup.to_string();
        evidence
    }

    #[test]
    fn only_the_workload_domain_and_its_runtime_leaf_attribute_a_killed_agent() {
        let evidence = agent_domain_fixture();
        let workload = evidence.groups[0].cgroup.clone();
        assert_eq!(workload, "/vm0-exec/exec-281-10-3/workload");

        for victim in [workload.clone(), format!("{workload}/runtime")] {
            assert!(
                with_victim(&evidence, &victim).agent_domain_oom_kill(),
                "agent domain victim must be attributed: {victim}"
            );
        }
        for victim in [
            format!("{workload}/tools"),
            format!("{workload}/tools/tool-1"),
            format!("{workload}/tools/task-00000000-0000-0000-0000-000000000001/runtime"),
            format!("{workload}/tools/task-00000000-0000-0000-0000-000000000001/tools/tool-1"),
            format!(
                "{workload}/tools/task-00000000-0000-0000-0000-000000000001/tools/task-00000000-0000-0000-0000-000000000002/runtime"
            ),
            format!(
                "{workload}/tools/task-00000000-0000-0000-0000-000000000001/tools/task-00000000-0000-0000-0000-000000000002/tools/tool-1"
            ),
            format!("{workload}/runtime/nested"),
            format!("{workload}-sibling"),
            "/vm0-exec/exec-281-11-3/workload".to_string(),
        ] {
            assert!(
                !with_victim(&evidence, &victim).agent_domain_oom_kill(),
                "victim outside the agent domain must not be attributed: {victim}"
            );
        }
    }

    #[test]
    fn a_tool_only_kill_is_not_an_agent_domain_kill() {
        let contained = fixture();
        assert_eq!(
            contained.incidents[0].kernel_events[0].task_cgroup,
            "/vm0-exec/exec-281-7-3/workload/tools/tool-1"
        );
        assert!(!contained.agent_domain_oom_kill());
        assert!(agent_domain_fixture().agent_domain_oom_kill());
    }

    #[test]
    fn local_runtime_counter_attributes_a_victim_omitted_from_kernel_records() {
        let evidence = runtime_counter_fixture();
        assert_eq!(evidence.kernel_status, EvidenceStatus::Truncated);
        assert!(evidence.incidents.iter().all(|incident| {
            incident
                .kernel_events
                .iter()
                .all(|event| event.task_cgroup.contains("/tools/"))
        }));
        assert!(evidence.agent_domain_oom_kill());
        assert_eq!(
            evidence.classification(),
            Some(OomClassification::AgentOomKill)
        );
        let limit = WorkloadResourceLimitDiagnostic {
            memory_max_events: 2,
            memory_oom_events: 1,
            memory_oom_kill_events: 2,
            memory_oom_group_kill_events: 0,
            pids_max_events: 0,
        };
        assert!(!evidence.proves_contained_resource_limit(&limit));
    }

    #[test]
    fn reliable_domain_counters_remain_proof_without_kernel_access_or_incidents() {
        let mut evidence = runtime_counter_fixture();
        evidence.incidents.clear();
        evidence.kernel_status = EvidenceStatus::Denied;
        assert!(evidence_has_proof(&evidence));
        assert!(evidence.agent_domain_oom_kill());
        assert_eq!(
            evidence.classification(),
            Some(OomClassification::AgentOomKill)
        );
    }

    #[test]
    fn known_local_counters_survive_unrelated_partial_snapshot_reads() {
        for status in [EvidenceStatus::Partial, EvidenceStatus::Truncated] {
            let mut evidence = runtime_counter_fixture();
            evidence.incidents.clear();
            evidence.groups[1].status = status;
            evidence.groups[1].peak = None;
            assert!(evidence.agent_domain_oom_kill(), "{status:?}");
        }
    }

    #[test]
    fn prior_correlated_counter_proof_survives_an_unavailable_final_sample() {
        let mut evidence = runtime_counter_fixture();
        evidence.groups[1].status = EvidenceStatus::Unavailable;
        assert!(evidence.agent_domain_oom_kill());
    }

    #[test]
    fn incident_counter_identity_and_baseline_must_match_the_operation() {
        for mismatch_inode in [true, false] {
            let mut evidence = runtime_counter_fixture();
            evidence.groups[1].status = EvidenceStatus::Unavailable;
            let runtime = &mut evidence.incidents[0].groups[1];
            if mismatch_inode {
                runtime.inode = Some(99);
            } else {
                runtime.local_baseline.oom_kill = Some(1);
                runtime.local_events.oom_kill = Some(2);
            }
            assert!(!evidence.agent_domain_oom_kill());
        }
    }

    #[test]
    fn unreliable_runtime_counters_never_attribute_an_agent_victim() {
        type Mutation = (&'static str, fn(&mut MemorySnapshot));
        let mutations: &[Mutation] = &[
            ("missing inode", |group| group.inode = None),
            ("recreated", |group| {
                group.status = EvidenceStatus::Recreated
            }),
            ("uncorrelated", |group| {
                group.status = EvidenceStatus::Uncorrelated
            }),
            ("unavailable", |group| {
                group.status = EvidenceStatus::Unavailable
            }),
            ("denied", |group| group.status = EvidenceStatus::Denied),
            ("wrong role", |group| group.role = "tools".into()),
            ("wrong operation", |group| {
                group.cgroup = "/vm0-exec/exec-9/workload/runtime".into()
            }),
            ("task runtime", |group| {
                group.cgroup.push_str("/tools/task-1/runtime")
            }),
            ("missing baseline", |group| {
                group.local_baseline.oom_kill = None
            }),
            ("missing current", |group| {
                group.local_events.oom_kill = None
            }),
            ("regressing current", |group| {
                group.local_baseline.oom_kill = Some(2)
            }),
            ("inconsistent delta", |group| {
                group.local_delta.oom_kill = Some(99)
            }),
            ("unknown delta", |group| group.local_delta.oom_kill = None),
            ("unchanged historical count", |group| {
                group.local_baseline.oom_kill = Some(1);
                group.local_delta.oom_kill = Some(0);
            }),
        ];
        for (name, mutate) in mutations {
            let mut evidence = runtime_counter_fixture();
            mutate(&mut evidence.groups[1]);
            for incident in &mut evidence.incidents {
                mutate(&mut incident.groups[1]);
            }
            assert!(!evidence.agent_domain_oom_kill(), "{name}");
            assert_eq!(
                evidence.classification(),
                Some(OomClassification::UnprovenContainment),
                "{name}"
            );
        }
    }

    #[test]
    fn root_local_kills_are_agent_proof_but_hierarchical_tool_kills_are_not() {
        let mut evidence = fixture();
        assert_eq!(
            evidence.classification(),
            Some(OomClassification::ContainedToolOom)
        );
        evidence.groups[0].local_events.oom_kill = Some(1);
        evidence.groups[0].local_delta.oom_kill = Some(1);
        assert!(evidence.agent_domain_oom_kill());
        assert_eq!(
            evidence.classification(),
            Some(OomClassification::AgentOomKill)
        );
    }

    #[test]
    fn tool_records_do_not_prove_containment_with_unknown_or_unaccounted_kills() {
        type Mutation = (&'static str, fn(&mut [MemorySnapshot; 3]));
        let mutations: &[Mutation] = &[
            ("missing runtime baseline", |groups| {
                groups[1].local_baseline.oom_kill = None
            }),
            ("missing runtime current", |groups| {
                groups[1].events.oom_kill = None
            }),
            ("recreated tools", |groups| {
                groups[2].status = EvidenceStatus::Recreated
            }),
            ("unaccounted workload victim", |groups| {
                groups[0].events.oom_kill = Some(2);
                groups[0].delta.oom_kill = Some(2);
            }),
            ("inconsistent tools delta", |groups| {
                groups[2].delta.oom_kill = Some(99)
            }),
        ];
        for (name, mutate) in mutations {
            let mut evidence = fixture();
            evidence.kernel_status = EvidenceStatus::Truncated;
            mutate(&mut evidence.groups);
            assert_eq!(
                evidence.classification(),
                Some(OomClassification::UnprovenContainment),
                "{name}"
            );
        }
    }

    #[test]
    fn counters_can_prove_tool_containment_with_truncated_kernel_records() {
        let mut evidence = fixture();
        evidence.kernel_status = EvidenceStatus::Truncated;
        evidence.incidents[0].kernel_status = EvidenceStatus::Truncated;
        evidence.incidents[0].kernel_events.clear();
        assert_eq!(
            evidence.classification(),
            Some(OomClassification::ContainedToolOom)
        );
    }

    #[test]
    fn agent_domain_attribution_requires_a_correlated_record_from_this_operation() {
        let evidence = agent_domain_fixture();

        let mut stale = evidence.clone();
        stale.incidents[0].kernel_events[0].boottime_us = evidence.started_boottime_us - 1;
        assert!(
            !stale.agent_domain_oom_kill(),
            "record precedes this operation"
        );

        for kernel_status in [EvidenceStatus::Recreated, EvidenceStatus::Uncorrelated] {
            let mut uncorrelated = evidence.clone();
            uncorrelated.incidents[0].kernel_status = kernel_status;
            assert!(
                !uncorrelated.agent_domain_oom_kill(),
                "uncorrelated identity cannot attribute a victim: {kernel_status:?}"
            );
        }

        let mut without_records = evidence;
        without_records.incidents[0].kernel_events.clear();
        assert!(!without_records.agent_domain_oom_kill());
    }

    /// One counter mutation and the limit field it changes.
    type LimitMutation = (&'static str, fn(&mut WorkloadResourceLimitDiagnostic));

    #[test]
    fn resource_limit_containment_requires_every_counter_to_match() {
        let evidence = fixture();
        let matching = WorkloadResourceLimitDiagnostic {
            memory_max_events: 2,
            memory_oom_events: 1,
            memory_oom_kill_events: 1,
            memory_oom_group_kill_events: 0,
            pids_max_events: 0,
        };
        assert!(evidence.proves_contained_resource_limit(&matching));

        let mutations: &[LimitMutation] = &[
            ("pids_max_events", |limit| limit.pids_max_events = 1),
            ("memory_max_events", |limit| limit.memory_max_events = 3),
            ("memory_oom_events", |limit| limit.memory_oom_events = 2),
            ("memory_oom_kill_events", |limit| {
                limit.memory_oom_kill_events = 2
            }),
            ("memory_oom_group_kill_events", |limit| {
                limit.memory_oom_group_kill_events = 1
            }),
        ];
        for (field, mutate) in mutations {
            let mut limit = matching;
            mutate(&mut limit);
            assert!(
                !evidence.proves_contained_resource_limit(&limit),
                "field={field}"
            );
        }
    }

    #[test]
    fn a_hard_limit_reached_by_an_agent_domain_kill_is_never_contained() {
        let limit = WorkloadResourceLimitDiagnostic {
            memory_max_events: 2,
            memory_oom_events: 1,
            memory_oom_kill_events: 1,
            memory_oom_group_kill_events: 0,
            pids_max_events: 0,
        };
        let evidence = fixture();
        let workload = evidence.groups[0].cgroup.clone();
        assert!(evidence.proves_contained_resource_limit(&limit));
        assert!(
            !with_victim(&evidence, &workload).proves_contained_resource_limit(&limit),
            "the agent's own domain being killed is not a contained tool limit"
        );
    }

    #[test]
    fn an_old_producers_runtime_progress_field_is_ignored() {
        // An older guest image still transports `runtime_progress_at`. It is an
        // unknown field to this consumer, so it decodes to the same evidence and
        // re-encodes without it.
        let legacy = legacy_fixture();
        assert_eq!(legacy, fixture());
        assert_eq!(
            serde_json::to_value(&legacy).unwrap(),
            serde_json::to_value(fixture()).unwrap()
        );
        assert!(!legacy.agent_domain_oom_kill());
    }
}
