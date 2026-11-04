use super::*;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::ffi::OsStringExt;
use std::process::Stdio;

use guest_contracts::process_containment::MATERIAL_CPU_THROTTLED_USEC;

#[test]
fn pre_exec_places_child_without_inheriting_descriptor() {
    let mut placement = tempfile::NamedTempFile::new().unwrap();
    let containment = WorkloadContainment {
        placement: Arc::new(placement.as_file().try_clone().unwrap().into()),
        workload_path: Arc::new(PathBuf::from("/unused")),
        tool_placement_endpoint: Arc::from("test-tool-endpoint"),
        evidence_stream: Arc::new(Mutex::new(None)),
    };
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(
            r#"for descriptor in /proc/self/fd/*; do
  if [ "$descriptor" -ef "$1" ]; then
    exit 1
  fi
done"#,
        )
        .arg("sh")
        .arg(placement.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    containment.configure_command(&mut command).unwrap();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let status = runtime
        .block_on(async move { command.status().await })
        .unwrap();

    assert!(status.success());
    placement.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
    let mut content = String::new();
    placement
        .as_file_mut()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "0");
}

#[test]
fn exposes_runner_owned_tool_endpoint_for_cli_environment() {
    let containment = WorkloadContainment {
        placement: Arc::new(tempfile::tempfile().unwrap().into()),
        workload_path: Arc::new(PathBuf::from("/unused")),
        tool_placement_endpoint: Arc::from("runner-tool-endpoint"),
        evidence_stream: Arc::new(Mutex::new(None)),
    };

    assert_eq!(
        containment.tool_placement_env(),
        (
            CANONICAL_TOOL_CGROUP_PROCS_ENV,
            "runner-tool-endpoint".to_string()
        )
    );
    assert_eq!(
        containment.env_source_evidence(),
        [
            (CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, "canonical-only"),
            (CANONICAL_TOOL_CGROUP_PROCS_ENV, "canonical-only"),
        ]
    );
}

#[test]
fn canonical_cgroup_placement_endpoint_preserves_values_and_empty() {
    assert_eq!(
        canonical_cgroup_placement_endpoint(CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, None),
        Ok(None)
    );
    assert_eq!(
        canonical_cgroup_placement_endpoint(
            CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            Some(OsString::from("canonical-endpoint")),
        ),
        Ok(Some("canonical-endpoint".to_string()))
    );
    assert_eq!(
        canonical_cgroup_placement_endpoint(
            CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            Some(OsString::new()),
        ),
        Ok(Some(String::new()))
    );
}

#[test]
fn rejects_non_unicode_canonical_cgroup_placement_endpoint_without_values() {
    let error = canonical_cgroup_placement_endpoint(
        CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        Some(OsString::from_vec(vec![0xff])),
    )
    .unwrap_err();

    assert_eq!(
        error,
        format!("{CANONICAL_WORKLOAD_CGROUP_PROCS_ENV} must be valid UTF-8")
    );
}

#[test]
fn reports_hard_limits_and_pressure_from_cgroup_counters() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("cpu.stat"),
        "usage_usec 10\nnr_throttled 2\nthrottled_usec 3\n",
    )
    .unwrap();
    fs::write(
        directory.path().join("memory.events"),
        "low 0\nhigh 4\nmax 5\noom 1\noom_kill 1\noom_group_kill 1\n",
    )
    .unwrap();
    fs::write(directory.path().join("pids.events"), "max 6\n").unwrap();
    fs::create_dir(directory.path().join(TOOLS_CGROUP_NAME)).unwrap();
    fs::write(
        directory.path().join(TOOLS_CGROUP_NAME).join("pids.events"),
        "max 7\n",
    )
    .unwrap();
    let containment = WorkloadContainment {
        placement: Arc::new(tempfile::tempfile().unwrap().into()),
        workload_path: Arc::new(directory.path().to_path_buf()),
        tool_placement_endpoint: Arc::from("test-tool-endpoint"),
        evidence_stream: Arc::new(Mutex::new(None)),
    };

    let diagnostics = containment.resource_diagnostics().unwrap();

    assert_eq!(
        diagnostics.hard_limit,
        Some(WorkloadResourceLimitDiagnostic {
            memory_max_events: 5,
            memory_oom_events: 1,
            memory_oom_kill_events: 1,
            memory_oom_group_kill_events: 1,
            pids_max_events: 7,
        })
    );
    assert_eq!(
        diagnostics.pressure.as_deref(),
        Some(
            "workload resource pressure observed (cpu_nr_throttled=2, cpu_throttled_usec=3, memory_high=4)"
        )
    );
}

#[test]
fn ignores_immaterial_cpu_throttling() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("cpu.stat"),
        format!(
            "usage_usec 10\nnr_throttled 2\nthrottled_usec {}\n",
            MATERIAL_CPU_THROTTLED_USEC - 1
        ),
    )
    .unwrap();
    fs::write(
        directory.path().join("memory.events"),
        "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
    )
    .unwrap();
    fs::write(directory.path().join("pids.events"), "max 0\n").unwrap();
    fs::create_dir(directory.path().join(TOOLS_CGROUP_NAME)).unwrap();
    fs::write(
        directory.path().join(TOOLS_CGROUP_NAME).join("pids.events"),
        "max 0\n",
    )
    .unwrap();
    let containment = WorkloadContainment {
        placement: Arc::new(tempfile::tempfile().unwrap().into()),
        workload_path: Arc::new(directory.path().to_path_buf()),
        tool_placement_endpoint: Arc::from("test-tool-endpoint"),
        evidence_stream: Arc::new(Mutex::new(None)),
    };

    let diagnostics = containment.resource_diagnostics().unwrap();

    assert_eq!(
        diagnostics,
        WorkloadResourceDiagnostics {
            hard_limit: None,
            pressure: None,
        }
    );
}
