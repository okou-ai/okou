//! Disposable Guest setup using the unchanged production policy calculator.
use guest_contracts::process_containment::{
    AGENT_MEMORY_MIN_BYTES, CONTROL_CPU_WEIGHT, EXEC_CGROUP_BASE_PATH,
    REQUIRED_CGROUP_SUBTREE_CONTROL, RUNTIME_MEMORY_MIN_BYTES, WorkloadResourcePolicy,
};
use std::{fs, io, path::Path};

fn put(path: &Path, name: &str, value: impl ToString) -> io::Result<()> {
    fs::write(path.join(name), value.to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let policy = WorkloadResourcePolicy::for_current_guest_capacity(true)?;
    let root = Path::new("/sys/fs/cgroup");
    let base = Path::new(EXEC_CGROUP_BASE_PATH);
    let operation = base.join("exec-native");
    let control = operation.join("control");
    let workload = operation.join("workload");
    let runtime = workload.join("runtime");
    let tools = workload.join("tools");
    put(
        root,
        "cgroup.subtree_control",
        REQUIRED_CGROUP_SUBTREE_CONTROL,
    )?;
    fs::create_dir(base)?;
    put(
        base,
        "cgroup.subtree_control",
        REQUIRED_CGROUP_SUBTREE_CONTROL,
    )?;
    put(base, "memory.min", AGENT_MEMORY_MIN_BYTES)?;
    fs::create_dir(&operation)?;
    put(
        &operation,
        "cgroup.subtree_control",
        REQUIRED_CGROUP_SUBTREE_CONTROL,
    )?;
    fs::create_dir(&control)?;
    fs::create_dir(&workload)?;
    put(&operation, "cpu.weight", CONTROL_CPU_WEIGHT)?;
    put(&control, "cpu.weight", CONTROL_CPU_WEIGHT)?;
    put(&operation, "memory.min", AGENT_MEMORY_MIN_BYTES)?;
    put(&control, "memory.min", policy.control_memory_min_bytes)?;
    put(&workload, "memory.min", policy.runtime_memory_min_bytes)?;
    put(
        &workload,
        "cpu.max",
        format!("{} {}", policy.cpu_quota_us, policy.cpu_period_us),
    )?;
    put(&workload, "memory.high", policy.memory_high)?;
    put(&workload, "memory.max", policy.memory_max_bytes)?;
    put(&workload, "memory.oom.group", policy.memory_oom_group)?;
    put(&workload, "pids.max", policy.pids_max)?;
    put(
        &workload,
        "cgroup.subtree_control",
        REQUIRED_CGROUP_SUBTREE_CONTROL,
    )?;
    fs::create_dir(&runtime)?;
    put(&runtime, "memory.min", RUNTIME_MEMORY_MIN_BYTES)?;
    fs::create_dir(&tools)?;
    put(&tools, "memory.oom.group", policy.memory_oom_group)?;
    put(&tools, "cgroup.subtree_control", "+memory")?;
    let direct = tools.join("fixture-direct");
    fs::create_dir(&direct)?;
    put(&direct, "memory.oom.group", "1")?;
    // PID 1 has not loaded Python or admitted user code yet. Its allocations
    // are charged to control from this point forward.
    put(&control, "cgroup.procs", 1)?;
    fs::write(
        "/fixture/resource-policy.json",
        format!(
            "{{\"cpuQuotaUs\":{},\"cpuPeriodUs\":{},\"memoryMaxBytes\":{},\"controlMemoryMinBytes\":{},\"runtimeMemoryMinBytes\":{},\"pidsMax\":\"{}\"}}\n",
            policy.cpu_quota_us,
            policy.cpu_period_us,
            policy.memory_max_bytes,
            policy.control_memory_min_bytes,
            policy.runtime_memory_min_bytes,
            policy.pids_max
        ),
    )?;
    Ok(())
}
