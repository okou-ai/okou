use std::collections::BTreeSet;
use std::path::Path;

use crate::error::{HostError, HostResult};

const CPU_SYSFS_ROOT: &str = "/sys/devices/system/cpu";

#[derive(Debug, PartialEq, Eq)]
pub enum PreSpawnCpuCapacity {
    ExactPhysical(u32),
    ConservativeLogical(u32),
}

impl PreSpawnCpuCapacity {
    pub fn tokens(&self) -> u32 {
        match self {
            Self::ExactPhysical(tokens) | Self::ConservativeLogical(tokens) => *tokens,
        }
    }
}

/// Return the number of logical CPUs available to this process.
pub fn cpu_count() -> HostResult<usize> {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .map_err(|e| HostError::Internal(format!("detect CPU count: {e}")))
}

pub fn pre_spawn_cpu_capacity(logical_cpu_count: usize) -> HostResult<PreSpawnCpuCapacity> {
    pre_spawn_cpu_capacity_at(Path::new(CPU_SYSFS_ROOT), logical_cpu_count)
        .map_err(|error| HostError::Internal(format!("detect physical CPU topology: {error}")))
}

fn pre_spawn_cpu_capacity_at(
    cpu_root: &Path,
    logical_cpu_count: usize,
) -> Result<PreSpawnCpuCapacity, String> {
    match physical_core_count(cpu_root)? {
        Some(physical_cores) => u32::try_from(physical_cores)
            .map(PreSpawnCpuCapacity::ExactPhysical)
            .map_err(|_| {
                format!("physical CPU count {physical_cores} exceeds supported pre-spawn capacity")
            }),
        None => {
            let conservative_logical = (logical_cpu_count / 2).max(1);
            u32::try_from(conservative_logical)
                .map(PreSpawnCpuCapacity::ConservativeLogical)
                .map_err(|_| {
                    format!(
                        "logical CPU fallback count {conservative_logical} exceeds supported pre-spawn capacity"
                    )
                })
        }
    }
}

fn physical_core_count(cpu_root: &Path) -> Result<Option<usize>, String> {
    let online_path = cpu_root.join("online");
    let online = std::fs::read_to_string(&online_path)
        .map_err(|error| format!("read {}: {error}", online_path.display()))?;
    let cpus = parse_cpu_list(&online)?;
    let mut missing_topology = BTreeSet::new();

    for cpu in &cpus {
        let topology = cpu_root.join(format!("cpu{cpu}/topology"));
        match std::fs::symlink_metadata(&topology) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_topology.insert(*cpu);
            }
            Err(error) => return Err(format!("inspect {}: {error}", topology.display())),
        }
    }

    if missing_topology == cpus {
        return Ok(None);
    }
    if !missing_topology.is_empty() {
        return Err(format!(
            "physical CPU topology is missing for online CPUs {missing_topology:?}"
        ));
    }

    let mut cores = BTreeSet::new();

    for cpu in cpus {
        let topology = cpu_root.join(format!("cpu{cpu}/topology"));
        let package_id = read_topology_id(&topology.join("physical_package_id"))?;
        let core_id = read_topology_id(&topology.join("core_id"))?;
        cores.insert((package_id, core_id));
    }

    if cores.is_empty() {
        return Err("online CPU topology contains no physical cores".into());
    }
    Ok(Some(cores.len()))
}

fn read_topology_id(path: &Path) -> Result<i64, String> {
    let value = std::fs::read_to_string(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    value
        .trim()
        .parse()
        .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn parse_cpu_list(value: &str) -> Result<BTreeSet<usize>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("online CPU list is empty".into());
    }

    let mut cpus = BTreeSet::new();
    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(format!("invalid empty entry in online CPU list {value:?}"));
        }
        if let Some((start, end)) = part.split_once('-') {
            if end.contains('-') {
                return Err(format!("invalid CPU range {part:?}"));
            }
            let start = parse_cpu_number(start, part)?;
            let end = parse_cpu_number(end, part)?;
            if start > end {
                return Err(format!("descending CPU range {part:?}"));
            }
            cpus.extend(start..=end);
        } else {
            cpus.insert(parse_cpu_number(part, part)?);
        }
    }
    Ok(cpus)
}

fn parse_cpu_number(value: &str, entry: &str) -> Result<usize, String> {
    value
        .parse()
        .map_err(|error| format!("parse CPU entry {entry:?}: {error}"))
}

/// Read total physical memory in MiB from `/proc/meminfo`.
pub fn memory_mb() -> HostResult<usize> {
    let content = std::fs::read_to_string("/proc/meminfo")
        .map_err(|e| HostError::Internal(format!("read /proc/meminfo: {e}")))?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: usize = rest
                .trim()
                .trim_end_matches("kB")
                .trim()
                .parse()
                .map_err(|e| HostError::Internal(format!("parse MemTotal: {e}")))?;
            return Ok(kb / 1024);
        }
    }
    Err(HostError::Internal(
        "MemTotal not found in /proc/meminfo".into(),
    ))
}

#[cfg(test)]
mod tests;
