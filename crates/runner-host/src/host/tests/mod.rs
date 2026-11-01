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
