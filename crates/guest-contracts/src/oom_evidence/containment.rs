//! Conservative containment proof shared by the existing diagnostic emitters.

use super::{EvidenceStatus, MemorySnapshot, OomEvidence};
use crate::diagnostics::WorkloadResourceLimitDiagnostic;

impl OomEvidence {
    /// Sequence of the operation-owned cgroup, for correlation with its exec route.
    pub fn operation_sequence(&self) -> Option<u32> {
        let name = self.groups[0]
            .cgroup
            .strip_prefix("/vm0-exec/exec-")?
            .strip_suffix("/workload")?;
        let mut parts = name.split('-');
        parts.next()?.parse::<u32>().ok().filter(|pid| *pid > 0)?;
        let sequence = parts.next()?.parse().ok()?;
        parts.next()?.parse::<u64>().ok()?;
        parts.next().is_none().then_some(sequence)
    }

    /// Positive native progress plus complete operation counters prove that the
    /// OOM kills were confined to managed tool leaves. Kernel truncation alone
    /// is harmless only when these independent, complete counters suffice.
    /// Neither process names nor exit codes participate in this proof.
    pub fn proves_contained_tool_oom(&self) -> bool {
        let Some(progress) = self.runtime_progress_at else {
            return false;
        };
        let Some(sampled) = timestamp_ms(&self.sampled_at) else {
            return false;
        };
        if self.operation_sequence().is_none()
            || uuid::Uuid::parse_str(&self.operation_id).is_err()
            || self
                .guest_boot_id
                .as_ref()
                .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
            || self.started_boottime_us == 0
            || progress > sampled
            || self.dropped_incidents != 0
            || self.incidents.is_empty()
            || self.groups.iter().enumerate().any(|(index, group)| {
                self.groups
                    .iter()
                    .take(index)
                    .any(|other| other.inode == group.inode)
            })
            || !usable_kernel_status(self.kernel_status)
            || !valid_groups(&self.groups, &self.groups)
        {
            return false;
        }
        let total = self.groups[0].delta.oom_kill;
        if !total.is_some_and(|count| count > 0) || total != self.groups[2].delta.oom_kill {
            return false;
        }
        // A counter increase after the last retained incident is not covered by
        // its continuation witness (including deferred kernel/counter races).
        if self.incidents.last().is_none_or(|incident| {
            [
                (&incident.groups[0], &self.groups[0]),
                (&incident.groups[2], &self.groups[2]),
            ]
            .into_iter()
            .any(|(observed, current)| {
                let observed = &observed.delta;
                let current = &current.delta;
                observed.oom != current.oom
                    || observed.oom_kill != current.oom_kill
                    || observed.oom_group_kill != current.oom_group_kill
            })
        }) {
            return false;
        }
        self.incidents.iter().enumerate().all(|(index, incident)| {
            incident.id == format!("{}:{}", self.operation_id, index + 1)
                && incident.after_observation
                && incident.before_cleanup
                && timestamp_ms(&incident.captured_at).is_some_and(|captured| captured < progress)
                && usable_kernel_status(incident.kernel_status)
                && valid_groups(&incident.groups, &self.groups)
                && incident.groups[0].delta.oom_kill == incident.groups[2].delta.oom_kill
                && incident.groups[0].delta.oom_kill <= total
                && incident.kernel_events.iter().all(|event| {
                    event.source == "guest"
                        && event.boottime_us >= self.started_boottime_us
                        && self
                            .kernel_cursor
                            .is_some_and(|cursor| event.sequence <= cursor)
                        && event.victim_pid > 0
                        && !event.victim_comm.is_empty()
                        && event.victim_comm.len() <= 16
                        && !event.victim_comm.chars().any(char::is_control)
                        && matches!(
                            event.constraint.as_str(),
                            "CONSTRAINT_MEMCG"
                                | "CONSTRAINT_NONE"
                                | "CONSTRAINT_CPUSET"
                                | "CONSTRAINT_MEMORY_POLICY"
                        )
                        && event.oom_cgroup.as_ref().is_none_or(|trigger| {
                            trigger == "/"
                                || trigger == "/vm0-exec"
                                || self.groups[0]
                                    .cgroup
                                    .strip_prefix(trigger.as_str())
                                    .is_some_and(|suffix| {
                                        suffix.is_empty() || suffix.starts_with('/')
                                    })
                                || trigger == &self.groups[2].cgroup
                                || trigger == &event.task_cgroup
                        })
                        && event
                            .task_cgroup
                            .strip_prefix(&format!("{}/tool-", self.groups[2].cgroup))
                            .is_some_and(|leaf| {
                                !leaf.is_empty() && leaf.bytes().all(|c| c.is_ascii_digit())
                            })
                })
        })
    }

    /// Preserve PID exhaustion and any counters newer than the containment proof.
    pub fn proves_contained_resource_limit(&self, limit: &WorkloadResourceLimitDiagnostic) -> bool {
        let events = &self.groups[0].events;
        self.proves_contained_tool_oom()
            && limit.pids_max_events == 0
            && events.max == Some(limit.memory_max_events)
            && events.oom == Some(limit.memory_oom_events)
            && events.oom_kill == Some(limit.memory_oom_kill_events)
            && events.oom_group_kill == Some(limit.memory_oom_group_kill_events)
    }

    /// Preserve the strict v1 API payload while retaining local continuation
    /// context in the trusted terminal transport and on-disk evidence.
    pub fn telemetry_evidence(&self) -> Self {
        let mut evidence = self.clone();
        evidence.runtime_progress_at = None;
        evidence
    }
}

fn timestamp_ms(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()?
        .timestamp_millis()
        .try_into()
        .ok()
}

fn usable_kernel_status(status: EvidenceStatus) -> bool {
    // Missing/truncated kernel records can be supplemented by complete cgroup
    // counters. Malformed or explicitly uncorrelated records cannot.
    matches!(
        status,
        EvidenceStatus::Available
            | EvidenceStatus::Missing
            | EvidenceStatus::Truncated
            | EvidenceStatus::Overwritten
            | EvidenceStatus::Unavailable
            | EvidenceStatus::Denied
    )
}

fn valid_groups(groups: &[MemorySnapshot; 3], current: &[MemorySnapshot; 3]) -> bool {
    groups
        .iter()
        .zip(current)
        .zip(["workload", "runtime", "tools"])
        .all(|((group, latest), role)| {
            let path = if role == "workload" {
                current[0].cgroup.clone()
            } else {
                format!("{}/{role}", current[0].cgroup)
            };
            group.role == role
                && group.cgroup == path
                && group.inode.is_some_and(|inode| inode > 0)
                && group.inode == latest.inode
                && group.baseline == latest.baseline
                && group.local_baseline == latest.local_baseline
                && matches!(
                    group.status,
                    EvidenceStatus::Available | EvidenceStatus::Partial
                )
                && group.delta == group.events.delta(&group.baseline)
                && group.local_delta == group.local_events.delta(&group.local_baseline)
                && [
                    group.delta.oom,
                    group.delta.oom_kill,
                    group.delta.oom_group_kill,
                    group.local_delta.oom,
                    group.local_delta.oom_kill,
                    group.local_delta.oom_group_kill,
                ]
                .iter()
                .all(Option::is_some)
                && group.local_delta.oom <= group.delta.oom
                && group.delta.oom <= latest.delta.oom
                && group.delta.oom_kill <= latest.delta.oom_kill
                && group.delta.oom_group_kill <= latest.delta.oom_group_kill
                && group.local_delta.oom_kill == Some(0)
                && group.local_delta.oom_group_kill == Some(0)
                && (role != "runtime"
                    || (group.delta.oom == Some(0)
                        && group.delta.oom_kill == Some(0)
                        && group.delta.oom_group_kill == Some(0)))
        })
        && groups[0].delta.oom >= groups[2].delta.oom
        && groups[0].delta.oom_group_kill == groups[2].delta.oom_group_kill
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> OomEvidence {
        serde_json::from_str(include_str!("../../tests/fixtures/contained-tool-oom.json")).unwrap()
    }

    #[test]
    fn native_continuation_and_complete_counters_prove_tool_containment() {
        let evidence = fixture();
        assert_eq!(evidence.operation_sequence(), Some(7));
        assert!(evidence.proves_contained_tool_oom());
        // MainThread is a tool comm here, not a runtime ownership signal.
        assert_eq!(
            evidence.incidents[0].kernel_events[0].victim_comm,
            "MainThread"
        );
    }

    #[test]
    fn partial_kernel_evidence_requires_complete_counter_and_continuation_proof() {
        for status in [
            EvidenceStatus::Truncated,
            EvidenceStatus::Overwritten,
            EvidenceStatus::Missing,
            EvidenceStatus::Denied,
            EvidenceStatus::Unavailable,
        ] {
            let mut evidence = fixture();
            evidence.kernel_status = status;
            evidence.incidents[0].kernel_status = status;
            evidence.incidents[0].kernel_events.clear();
            assert!(evidence.proves_contained_tool_oom(), "status={status:?}");
            evidence.groups[1].delta.oom_kill = None;
            assert!(!evidence.proves_contained_tool_oom());
        }
        let mut evidence = fixture();
        evidence.groups[1].status = EvidenceStatus::Partial;
        evidence.groups[1].peak = None;
        assert!(
            evidence.proves_contained_tool_oom(),
            "optional byte fields are not kill counters"
        );
    }

    #[test]
    fn missing_null_regressing_or_conflicting_counters_never_mean_zero() {
        for group in 0..3 {
            for field in ["oom", "oom_kill", "oom_group_kill"] {
                for section in [
                    "baseline",
                    "events",
                    "delta",
                    "local_baseline",
                    "local_events",
                    "local_delta",
                ] {
                    let mut value = serde_json::to_value(fixture()).unwrap();
                    value["groups"][group][section][field] = serde_json::Value::Null;
                    let evidence: OomEvidence = serde_json::from_value(value.clone()).unwrap();
                    assert!(
                        !evidence.proves_contained_tool_oom(),
                        "{group}/{section}/{field}"
                    );
                    value["groups"][group][section]
                        .as_object_mut()
                        .unwrap()
                        .remove(field);
                    let evidence: OomEvidence = serde_json::from_value(value).unwrap();
                    assert!(!evidence.proves_contained_tool_oom());
                }
            }
        }
        let mut evidence = fixture();
        evidence.groups[1].baseline.oom_kill = Some(1);
        assert!(!evidence.proves_contained_tool_oom());
    }

    #[test]
    fn runtime_control_unknown_and_mixed_victims_remain_unproven() {
        for victim in [
            "/vm0-exec/exec-281-7-3/control",
            "/vm0-exec/exec-281-7-3/workload",
            "/vm0-exec/exec-281-7-3/workload/runtime",
            "/vm0-exec/exec-281-7-3/workload/tools",
            "/vm0-exec/exec-281-8-3/workload/tools/tool-1",
            "/vm0-exec/exec-281-7-3/workload/tools/tool-1/../runtime",
        ] {
            let mut evidence = fixture();
            let mut mixed = evidence.incidents[0].kernel_events[0].clone();
            mixed.task_cgroup = victim.into();
            evidence.incidents[0].kernel_events.push(mixed);
            assert!(!evidence.proves_contained_tool_oom(), "victim={victim}");
        }
        let mut evidence = fixture();
        evidence.groups[1].events.oom_kill = Some(1);
        evidence.groups[1].delta.oom_kill = Some(1);
        assert!(!evidence.proves_contained_tool_oom());
    }

    #[test]
    fn contradictory_hierarchical_counters_remain_unproven() {
        for retained in [false, true] {
            for field in ["oom", "oom_group_kill"] {
                let mut value = serde_json::to_value(fixture()).unwrap();
                let groups = if retained {
                    &mut value["incidents"][0]["groups"]
                } else {
                    &mut value["groups"]
                };
                // Each counter delta is arithmetically valid in isolation, but
                // the tool subtree cannot exceed its enclosing workload.
                groups[2]["events"][field] = 2.into();
                groups[2]["delta"][field] = 2.into();
                let evidence: OomEvidence = serde_json::from_value(value).unwrap();
                assert!(!evidence.proves_contained_tool_oom());
            }
            let mut evidence = fixture();
            let groups = if retained {
                &mut evidence.incidents[0].groups
            } else {
                &mut evidence.groups
            };
            groups[2].local_events.oom = Some(2);
            groups[2].local_delta.oom = Some(2);
            assert!(!evidence.proves_contained_tool_oom());
        }
    }

    #[test]
    fn stale_identity_corruption_and_absent_or_early_progress_remain_unproven() {
        let mutations: &[fn(&mut OomEvidence)] = &[
            |e| e.runtime_progress_at = None,
            |e| e.runtime_progress_at = Some(1),
            |e| e.runtime_progress_at = Some(u64::MAX),
            |e| e.sampled_at = "bad".into(),
            |e| e.guest_boot_id = None,
            |e| e.operation_id = "stale".into(),
            |e| e.groups[1].inode = Some(99),
            |e| e.groups[1].inode = Some(0),
            |e| e.groups[2].cgroup.push_str("/stale"),
            |e| e.groups[0].status = EvidenceStatus::Recreated,
            |e| e.incidents[0].id = "another-operation:1".into(),
            |e| e.incidents[0].kernel_status = EvidenceStatus::Uncorrelated,
            |e| e.incidents[0].kernel_status = EvidenceStatus::Partial,
            |e| e.incidents[0].before_cleanup = false,
            |e| e.incidents[0].kernel_events[0].boottime_us = 1,
            |e| e.incidents[0].kernel_events[0].source = "host".into(),
            |e| e.kernel_cursor = Some(1),
            |e| e.dropped_incidents = 1,
            |e| e.incidents[0].captured_at = e.sampled_at.clone(),
            |e| {
                e.groups[0].events.oom = Some(2);
                e.groups[0].delta.oom = Some(2);
            },
            |e| {
                for i in [0, 2] {
                    e.groups[i].delta.oom_kill = Some(2);
                    e.groups[i].events.oom_kill = Some(2);
                }
            },
        ];
        for (index, mutate) in mutations.iter().enumerate() {
            let mut evidence = fixture();
            mutate(&mut evidence);
            assert!(!evidence.proves_contained_tool_oom(), "mutation={index}");
        }
    }

    #[test]
    fn independent_resource_limits_and_newer_counters_remain_actionable() {
        let evidence = fixture();
        let mut limit = WorkloadResourceLimitDiagnostic {
            memory_max_events: 2,
            memory_oom_events: 1,
            memory_oom_kill_events: 1,
            memory_oom_group_kill_events: 0,
            pids_max_events: 0,
        };
        assert!(evidence.proves_contained_resource_limit(&limit));
        limit.pids_max_events = 1;
        assert!(!evidence.proves_contained_resource_limit(&limit));
        limit.pids_max_events = 0;
        limit.memory_oom_kill_events = 2;
        assert!(!evidence.proves_contained_resource_limit(&limit));
    }

    #[test]
    fn continuation_is_retained_locally_without_changing_the_strict_telemetry_contract() {
        let evidence = fixture();
        let encoded = serde_json::to_vec(&evidence).unwrap();
        assert_eq!(super::super::decode_evidence(&encoded).unwrap(), evidence);
        let mut expected = serde_json::to_value(&evidence).unwrap();
        expected
            .as_object_mut()
            .unwrap()
            .remove("runtime_progress_at");
        assert_eq!(
            serde_json::to_value(evidence.telemetry_evidence()).unwrap(),
            expected
        );
        let without_progress: OomEvidence = serde_json::from_value(expected).unwrap();
        assert!(!without_progress.proves_contained_tool_oom());
        let diagnostic = format!(
            "{}{}\n{}{}",
            super::super::EVIDENCE_PREFIX,
            serde_json::to_string(&without_progress).unwrap(),
            super::super::EVIDENCE_PREFIX,
            serde_json::to_string(&evidence).unwrap()
        );
        assert_eq!(
            super::super::split_diagnostic(&diagnostic).malformed_lines,
            1
        );
    }
}
