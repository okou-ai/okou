use std::collections::BTreeSet;
use std::path::Path;

use crate::error::{RunnerError, RunnerResult};

const CPU_SYSFS_ROOT: &str = "/sys/devices/system/cpu";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PreSpawnCpuCapacity {
    ExactPhysical(u32),
    ConservativeLogical(u32),
}

impl PreSpawnCpuCapacity {
    pub(crate) fn tokens(&self) -> u32 {
        match self {
            Self::ExactPhysical(tokens) | Self::ConservativeLogical(tokens) => *tokens,
        }
    }
}

/// Return the number of logical CPUs available to this process.
pub fn cpu_count() -> RunnerResult<usize> {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .map_err(|e| RunnerError::Internal(format!("detect CPU count: {e}")))
}

pub(crate) fn pre_spawn_cpu_capacity(
    logical_cpu_count: usize,
) -> RunnerResult<PreSpawnCpuCapacity> {
    pre_spawn_cpu_capacity_at(Path::new(CPU_SYSFS_ROOT), logical_cpu_count)
        .map_err(|error| RunnerError::Internal(format!("detect physical CPU topology: {error}")))
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
pub fn memory_mb() -> RunnerResult<usize> {
    let content = std::fs::read_to_string("/proc/meminfo")
        .map_err(|e| RunnerError::Internal(format!("read /proc/meminfo: {e}")))?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: usize = rest
                .trim()
                .trim_end_matches("kB")
                .trim()
                .parse()
                .map_err(|e| RunnerError::Internal(format!("parse MemTotal: {e}")))?;
            return Ok(kb / 1024);
        }
    }
    Err(RunnerError::Internal(
        "MemTotal not found in /proc/meminfo".into(),
    ))
}

runner_test_group!(platform_support; #[cfg(test)]
mod tests {
    use super::*;

    fn write_topology(root: &Path, cpu: usize, package_id: i64, core_id: i64) {
        let topology = root.join(format!("cpu{cpu}/topology"));
        std::fs::create_dir_all(&topology).unwrap();
        std::fs::write(topology.join("physical_package_id"), package_id.to_string()).unwrap();
        std::fs::write(topology.join("core_id"), core_id.to_string()).unwrap();
    }

    #[test]
    fn cpu_count_is_positive() {
        assert!(cpu_count().unwrap() > 0);
    }

    #[test]
    fn parse_cpu_list_accepts_ranges_and_singletons() {
        assert_eq!(
            parse_cpu_list("0-2,4,6-7\n").unwrap(),
            BTreeSet::from([0, 1, 2, 4, 6, 7])
        );
    }

    #[test]
    fn parse_cpu_list_rejects_malformed_entries() {
        for value in ["", "1-", "3-1", "1-2-3", "0,,1", "cpu0"] {
            assert!(parse_cpu_list(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn physical_core_count_deduplicates_smt_siblings_and_packages() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-5").unwrap();
        write_topology(dir.path(), 0, 0, 0);
        write_topology(dir.path(), 1, 0, 0);
        write_topology(dir.path(), 2, 0, 1);
        write_topology(dir.path(), 3, 0, 1);
        write_topology(dir.path(), 4, 1, 0);
        write_topology(dir.path(), 5, 1, 0);

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 6).unwrap(),
            PreSpawnCpuCapacity::ExactPhysical(3)
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_falls_back_when_topology_is_uniformly_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-15").unwrap();

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 16).unwrap(),
            PreSpawnCpuCapacity::ConservativeLogical(8)
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_keeps_one_token_for_one_logical_cpu() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0").unwrap();

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 1).unwrap(),
            PreSpawnCpuCapacity::ConservativeLogical(1)
        );
    }

    #[test]
    fn physical_core_count_rejects_partial_topology() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-1").unwrap();
        write_topology(dir.path(), 0, 0, 0);

        assert_eq!(
            physical_core_count(dir.path()).unwrap_err(),
            "physical CPU topology is missing for online CPUs {1}"
        );
    }

    #[test]
    fn physical_core_count_accepts_single_threaded_topology() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0,2").unwrap();
        write_topology(dir.path(), 0, 0, 0);
        write_topology(dir.path(), 2, 0, 2);

        assert_eq!(physical_core_count(dir.path()).unwrap(), Some(2));
    }

    #[test]
    fn physical_core_count_rejects_incomplete_and_malformed_topology() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0").unwrap();
        let topology = dir.path().join("cpu0/topology");
        std::fs::create_dir_all(&topology).unwrap();
        std::fs::write(topology.join("physical_package_id"), "0").unwrap();

        let error = physical_core_count(dir.path()).unwrap_err();
        assert!(error.contains("read"), "unexpected error: {error}");
        assert!(error.contains("core_id"), "unexpected error: {error}");

        std::fs::write(topology.join("core_id"), "invalid").unwrap();

        let error = physical_core_count(dir.path()).unwrap_err();
        assert!(error.contains("parse"), "unexpected error: {error}");
        assert!(error.contains("core_id"), "unexpected error: {error}");
    }

    #[test]
    fn physical_core_count_rejects_missing_or_empty_online_list() {
        let missing = tempfile::tempdir().unwrap();
        assert!(physical_core_count(missing.path()).is_err());

        let empty = tempfile::tempdir().unwrap();
        std::fs::write(empty.path().join("online"), "\n").unwrap();
        assert!(physical_core_count(empty.path()).is_err());
    }

    #[test]
    fn memory_mb_is_positive() {
        // Only works on Linux with /proc
        if std::path::Path::new("/proc/meminfo").exists() {
            assert!(memory_mb().unwrap() > 0);
        }
    }
});
