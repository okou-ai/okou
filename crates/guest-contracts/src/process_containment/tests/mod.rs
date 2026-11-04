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
    let error =
        WorkloadResourcePolicy::for_guest_capacity(1, AGENT_MEMORY_MIN_BYTES, true).unwrap_err();

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
    let policy = WorkloadResourcePolicy::for_guest_capacity(1, guest_memory_bytes, false).unwrap();

    assert_eq!(policy.memory_max_bytes, 352 * 1024 * 1024);
    assert_eq!(policy.memory_high, "max");
    assert!(WorkloadResourcePolicy::for_guest_capacity(1, guest_memory_bytes, true).is_err());
}

#[test]
fn ordinary_exec_still_requires_workload_reserve_capacity() {
    let error = WorkloadResourcePolicy::for_guest_capacity(1, WORKLOAD_MEMORY_RESERVE_BYTES, false)
        .unwrap_err();

    assert_eq!(
        error,
        "guest memory capacity cannot preserve workload memory reserve"
    );
}
