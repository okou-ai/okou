//! Cgroup attribution shared by the existing diagnostic emitters.

use super::{EvidenceStatus, OomEvidence};
use crate::diagnostics::WorkloadResourceLimitDiagnostic;

impl OomEvidence {
    /// Whether retained guest kernel records name a victim in the agent's own
    /// containment domain.
    ///
    /// Shell tools run in separately contained `<workload>/tools/tool-*` leaves.
    /// The kernel routinely reclaims those without ending the run, so only the
    /// workload domain itself and its runtime leaf attribute a terminated agent.
    /// Evidence whose identity could not be correlated cannot attribute anything.
    ///
    /// Runner derives the user-visible OOM failure from this, so its result must
    /// stay decided by the kernel record alone. Every other consumer only chooses
    /// how loudly to log.
    pub fn agent_domain_oom_kill(&self) -> bool {
        let workload = self.groups[0].cgroup.as_str();
        let runtime = format!("{workload}/runtime");
        self.incidents
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
            })
    }

    /// Preserve PID exhaustion and any counters the kernel attributed to the
    /// agent's own containment domain.
    pub fn proves_contained_resource_limit(&self, limit: &WorkloadResourceLimitDiagnostic) -> bool {
        let events = &self.groups[0].events;
        !self.agent_domain_oom_kill()
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
