use super::*;
use std::io::Write;

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    monitor: EvidenceMonitor,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("exec-281-10-3");
        for role in ["", "runtime", "tools"] {
            let path = root.join("workload").join(role);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("memory.current"), "4096").unwrap();
            fs::write(path.join("memory.peak"), "8192").unwrap();
            fs::write(path.join("memory.max"), "16384").unwrap();
            fs::write(
                path.join("memory.stat"),
                "anon 1024\nfile 2048\nkernel 1024\n",
            )
            .unwrap();
            for file in ["memory.events", "memory.events.local"] {
                fs::write(
                    path.join(file),
                    "high 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
                )
                .unwrap();
            }
        }
        let mut monitor = EvidenceMonitor::without_kernel_for_test(root.clone());
        monitor.evidence.started_boottime_us = 1000;
        Self {
            _directory: directory,
            root,
            monitor,
        }
    }

    fn counters(&self, count: u64) {
        fs::write(
            self.root.join("workload/memory.events"),
            format!("high 0\nmax 2\noom {count}\noom_kill {count}\noom_group_kill 0\n"),
        )
        .unwrap();
    }

    fn kernel(&mut self, sequence: u64, time: u64, constraint: &str) {
        self.record(&format!("6,{sequence},{time},-;oom-kill:constraint={constraint},nodemask=(null),cpuset=/,mems_allowed=0,task_memcg=/vm0-exec/exec-281-10-3/workload/runtime,task=node,pid=999999,uid=1000\n"));
    }

    fn record(&mut self, record: &str) {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(record.as_bytes()).unwrap();
        file.rewind().unwrap();
        self.monitor.kernel = Some(file);
        self.monitor.kernel_status = EvidenceStatus::Available;
    }
}

#[test]
fn collector_rejects_paths_outside_the_exact_operation_mount() {
    let directory = tempfile::tempdir().unwrap();
    for root in [
        "/tmp/vm0-exec/exec-281-10-3",
        "/sys/fs/cgroup2/vm0-exec/exec-281-10-3",
        "/sys/fs/cgroup/other/exec-281-10-3",
        "/sys/fs/cgroup/vm0-exec/exec-",
        "/sys/fs/cgroup/vm0-exec/exec-private",
        "/sys/fs/cgroup/vm0-exec/exec-281-10-3/../exec-1",
        "/sys/fs/cgroup/vm0-exec/exec-281-10-3/workload",
        "/sys/fs//cgroup/vm0-exec/exec-281-10-3",
        "/sys/fs/cgroup/./vm0-exec/exec-281-10-3",
        "sys/fs/cgroup/vm0-exec/exec-281-10-3",
    ] {
        assert!(
            EvidenceMonitor::with_sources(
                Path::new(root),
                directory.path().to_path_buf(),
                Err(io::Error::from(io::ErrorKind::NotFound)),
                1000,
            )
            .is_none(),
            "accepted unowned root: {root}"
        );
    }
    assert!(operation_cgroup(directory.path()).is_none());
    assert!(
        operation_cgroup(Path::new(&format!(
            "/sys/fs/cgroup/vm0-exec/exec-{}",
            "1".repeat(256)
        )))
        .is_none()
    );
}

#[test]
fn canonical_collector_identity_matches_independent_kernel_paths() {
    for (path, memcg) in [
        (
            "/vm0-exec/exec-281-10-3/workload",
            "/vm0-exec/exec-281-10-3/workload",
        ),
        (
            "/vm0-exec/exec-281-10-3/workload/runtime",
            "/vm0-exec/exec-281-10-3/workload",
        ),
        (
            "/vm0-exec/exec-281-10-3/workload/tools",
            "/vm0-exec/exec-281-10-3/workload",
        ),
        (
            "/vm0-exec/exec-281-10-3/workload/tools/tool-45-6",
            "/vm0-exec/exec-281-10-3/workload",
        ),
        (
            "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/runtime",
            "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/runtime",
        ),
        (
            "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/tools/tool-45",
            "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/tools/tool-45",
        ),
        (
            "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/tools/task-00000000-0000-0000-0000-000000000002/runtime",
            "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/tools/task-00000000-0000-0000-0000-000000000002/runtime",
        ),
        (
            "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/tools/task-00000000-0000-0000-0000-000000000002/tools/tool-45",
            "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/tools/task-00000000-0000-0000-0000-000000000002/tools/tool-45",
        ),
        ("/vm0-exec/exec-281-10-3/control", "/vm0-exec/exec-281-10-3"),
    ] {
        for (constraint, trigger) in [("CONSTRAINT_NONE", "/"), ("CONSTRAINT_MEMCG", memcg)] {
            let mut fixture = Fixture::new();
            fixture.record(&format!("6,10,2000,-;oom-kill:constraint={constraint},oom_memcg={trigger},task_memcg={path},task=node,pid=999999,uid=1000\n"));
            let captured = fixture.monitor.capture(CaptureReason::Sample);
            assert_eq!(captured.incidents.len(), 1, "missing victim in {path}");
            let event = &captured.incidents[0].kernel_events[0];
            assert_eq!(event.task_cgroup, path);
            assert_eq!(event.oom_cgroup.as_deref(), Some(trigger));
            assert_eq!(event.constraint, constraint);
            assert_eq!(event.victim_pid, 999999);
        }
    }
    for path in [
        "/vm0-exec/exec-281-10-30/workload/runtime",
        "vm0-exec/exec-281-10-3/workload/runtime",
        "//vm0-exec/exec-281-10-3/workload/runtime",
        "/vm0-exec/exec-281-10-3/workload/tools/tool-1/../runtime",
        "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001/tools/tool-1/../runtime",
        "/vm0-exec/exec-281-10-3/workload/tools/task-1/runtime",
    ] {
        let mut fixture = Fixture::new();
        fixture.record(&format!("6,10,2000,-;oom-kill:constraint=CONSTRAINT_NONE,task_memcg={path},task=node,pid=999999,uid=1000\n"));
        let captured = fixture.monitor.capture(CaptureReason::Sample);
        assert!(captured.incidents.is_empty());
        assert_eq!(captured.kernel_status, EvidenceStatus::Uncorrelated);
    }
}

#[test]
fn collector_output_matches_api_fixture() {
    // This is the producer half of the cross-language contract test. Only
    // nondeterministic UUIDs, wall-clock times and filesystem inodes are
    // replaced for comparison; cgroup paths and counter values are intact.
    fn stable(mut evidence: OomEvidence) -> OomEvidence {
        fn stable_inodes(groups: &mut [MemorySnapshot; 3]) {
            for (index, group) in groups.iter_mut().enumerate() {
                group.inode = group.inode.map(|_| index as u64 + 1);
            }
        }
        evidence.operation_id = "11111111-1111-4111-8111-111111111111".into();
        evidence.guest_boot_id = Some("22222222-2222-4222-8222-222222222222".into());
        evidence.sampled_at = "2026-09-09T09:00:00.000Z".into();
        stable_inodes(&mut evidence.groups);
        for (index, incident) in evidence.incidents.iter_mut().enumerate() {
            incident.id = format!("{}:{}", evidence.operation_id, index + 1);
            incident.captured_at = evidence.sampled_at.clone();
            stable_inodes(&mut incident.groups);
        }
        evidence
    }
    let mut fixture = Fixture::new();
    fs::remove_file(fixture.root.join("workload/runtime/memory.peak")).unwrap();
    fs::remove_file(fixture.root.join("workload/tools/memory.events.local")).unwrap();
    fixture.monitor = EvidenceMonitor::without_kernel_for_test(fixture.root.clone());
    fixture.monitor.evidence.started_boottime_us = 1000;
    let initial = fixture.monitor.capture(CaptureReason::Sample);
    fixture.counters(1);
    fixture.kernel(10, 2000, "CONSTRAINT_MEMCG");
    let sample = fixture.monitor.capture(CaptureReason::Sample);
    let cleanup = fixture.monitor.capture(CaptureReason::Cleanup);
    for evidence in [&initial, &sample, &cleanup] {
        for groups in std::iter::once(&evidence.groups)
            .chain(evidence.incidents.iter().map(|incident| &incident.groups))
        {
            assert_eq!(groups[0].cgroup, "/vm0-exec/exec-281-10-3/workload");
            assert_eq!(groups[1].cgroup, "/vm0-exec/exec-281-10-3/workload/runtime");
            assert_eq!(groups[2].cgroup, "/vm0-exec/exec-281-10-3/workload/tools");
            assert_eq!(groups[0].current, Some(4096));
            assert_eq!(groups[1].peak, None);
            assert_eq!(groups[2].local_events.oom, None);
        }
    }
    assert_eq!(sample.incidents, cleanup.incidents);
    assert_eq!(sample.incidents[0].kernel_events.len(), 1);

    let mut tasks = Fixture::new();
    let task = "/vm0-exec/exec-281-10-3/workload/tools/task-00000000-0000-0000-0000-000000000001";
    let nested = format!("{task}/tools/task-00000000-0000-0000-0000-000000000002");
    let single_tool = format!("{task}/tools/tool-95");
    let nested_tool = format!("{nested}/tools/tool-269");
    for (sequence, time, constraint, trigger, victim) in [
        (10, 2000, "CONSTRAINT_NONE", "/", single_tool.as_str()),
        (
            11,
            3000,
            "CONSTRAINT_MEMCG",
            nested.as_str(),
            nested_tool.as_str(),
        ),
    ] {
        tasks.record(&format!("6,{sequence},{time},-;oom-kill:constraint={constraint},oom_memcg={trigger},task_memcg={victim},task=node,pid=999999,uid=1000\n"));
        tasks.monitor.capture(CaptureReason::Sample);
    }
    let tasks = tasks.monitor.capture(CaptureReason::Cleanup);
    assert_eq!(tasks.incidents.len(), 2);
    let generated = serde_json::json!({
        "initial": stable(initial),
        "sample": stable(sample),
        "cleanup": stable(cleanup),
        "tasks": stable(tasks),
    });
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/oom-evidence-collector.json");
    if std::env::var_os("UPDATE_OOM_COLLECTOR_FIXTURE").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::to_string_pretty(&generated).unwrap() + "\n",
        )
        .unwrap();
    }
    let checked: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(generated, checked, "regenerate the collector API fixture");
}

#[test]
fn kernel_reader_reports_denied_overwritten_and_expired_budgets() {
    struct Source(std::collections::VecDeque<i32>);
    impl Read for Source {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::from_raw_os_error(
                self.0.pop_front().expect("reader exceeded fixture"),
            ))
        }
    }
    impl Seek for Source {
        fn seek(&mut self, _from: SeekFrom) -> io::Result<u64> {
            Ok(0)
        }
    }
    for (errors, expected) in [
        (vec![libc::EACCES], EvidenceStatus::Denied),
        (vec![libc::EPIPE, libc::EAGAIN], EvidenceStatus::Overwritten),
        (vec![libc::EINVAL], EvidenceStatus::Truncated),
        (vec![libc::EAGAIN], EvidenceStatus::Missing),
    ] {
        let mut source = Source(errors.into());
        let (_, status) = read_kernel_records(
            &mut source,
            &mut EvidenceStatus::Available,
            &mut None,
            0,
            "/vm0-exec/exec-1/workload",
            Instant::now() + CAPTURE_BUDGET,
        );
        assert_eq!(status, expected);
        assert!(source.0.is_empty());
    }
    let (_, status) = read_kernel_records(
        &mut Source(Default::default()),
        &mut EvidenceStatus::Available,
        &mut None,
        0,
        "/vm0-exec/exec-1/workload",
        Instant::now(),
    );
    assert_eq!(
        status,
        EvidenceStatus::Truncated,
        "expired capture never starts another read"
    );
}

#[test]
fn kernel_record_and_event_caps_bound_a_busy_source() {
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixDatagram;
    let mut fixture = Fixture::new();
    let (reader, writer) = UnixDatagram::pair().unwrap();
    reader.set_nonblocking(true).unwrap();
    let fd: OwnedFd = reader.into();
    fixture.monitor.kernel = Some(File::from(fd));
    fixture.monitor.kernel_status = EvidenceStatus::Available;
    for seq in 1..=MAX_KERNEL_EVENTS + 1 {
        writer.send(format!("6,{seq},2000,-;oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/vm0-exec/exec-281-10-3/workload/runtime,task=node,pid=999999,uid=1000").as_bytes()).unwrap();
    }
    let captured = fixture.monitor.capture(CaptureReason::Sample);
    assert_eq!(captured.incidents[0].kernel_events.len(), MAX_KERNEL_EVENTS);
    assert_eq!(
        captured.incidents[0].kernel_status,
        EvidenceStatus::Truncated
    );
    for seq in 100..100 + KERNEL_RECORDS + 1 {
        writer
            .send(format!("6,{seq},2000,-;ordinary kernel record").as_bytes())
            .unwrap();
    }
    let (_, status) = fixture
        .monitor
        .read_kernel(Instant::now() + Duration::from_secs(1));
    assert_eq!(status, EvidenceStatus::Truncated);
    assert_eq!(
        fixture.monitor.last_sequence,
        Some((100 + KERNEL_RECORDS - 1) as u64)
    );
}

#[test]
fn captures_cgroup_and_global_victims_without_proc_even_with_oom_counters() {
    for constraint in ["CONSTRAINT_MEMCG", "CONSTRAINT_NONE"] {
        let mut fixture = Fixture::new();
        fixture.counters(1);
        fixture.kernel(10, 2000, constraint);
        let captured = fixture.monitor.capture(CaptureReason::Sample);
        let incident = &captured.incidents[0];
        assert_eq!(incident.kernel_events[0].victim_pid, 999999);
        assert_eq!(incident.kernel_events[0].constraint, constraint);
        assert_eq!(incident.kernel_events[0].source, "guest");
        assert_eq!(incident.groups[0].delta.oom_kill, Some(1));
        assert_eq!(incident.groups[0].initial_limit.as_deref(), Some("16384"));
        assert_eq!(incident.groups[0].anon, Some(1024));
        assert!(incident.after_observation && incident.before_cleanup);
        assert!(serde_json::to_vec(&captured).unwrap().len() < MAX_EVIDENCE_BYTES);
    }
}

#[test]
fn recovered_counter_after_missing_read_still_records_tool_oom() {
    let mut fixture = Fixture::new();
    fs::remove_file(fixture.root.join("workload/memory.events")).unwrap();
    let missing = fixture.monitor.capture(CaptureReason::Sample);
    assert_eq!(missing.groups[0].events.oom_kill, None);
    assert!(missing.incidents.is_empty());
    fixture.counters(1);
    let restored = fixture.monitor.capture(CaptureReason::Sample);
    assert_eq!(restored.incidents.len(), 1);
    assert_eq!(restored.incidents[0].groups[0].delta.oom_kill, Some(1));
    assert_eq!(
        restored.incidents[0].kernel_status,
        EvidenceStatus::Unavailable
    );
    assert_eq!(
        fixture
            .monitor
            .capture(CaptureReason::Cleanup)
            .incidents
            .len(),
        1
    );
}

#[test]
fn kernel_first_kill_counter_tail_reuses_incident_but_new_oom_is_distinct() {
    for constraint in ["CONSTRAINT_NONE", "CONSTRAINT_MEMCG"] {
        let mut fixture = Fixture::new();
        let oom = u64::from(constraint == "CONSTRAINT_MEMCG");
        let events_path = fixture.root.join("workload/memory.events");
        let write_events = |kills, attempts| {
            fs::write(
                &events_path,
                format!("oom {attempts}\noom_kill {kills}\noom_group_kill 0\n"),
            )
            .unwrap();
        };
        write_events(0, oom);
        fixture.kernel(10, 2000, constraint);
        let first = fixture.monitor.capture(CaptureReason::Sample);
        write_events(1, oom);
        let tail = fixture.monitor.capture(CaptureReason::Sample);
        assert_eq!(
            tail.incidents, first.incidents,
            "original snapshot and time remain true"
        );
        assert_eq!(tail.groups[0].events.oom_kill, Some(1));
        write_events(2, oom + 1);
        fixture.kernel(11, 3000, constraint);
        let second = fixture.monitor.capture(CaptureReason::Sample);
        assert_eq!(second.incidents.len(), 2);
        assert_ne!(second.incidents[0].id, second.incidents[1].id);
    }
}

#[test]
fn uncertain_kernel_gap_and_control_victim_cannot_consume_workload_counter() {
    for status in [EvidenceStatus::Unavailable, EvidenceStatus::Overwritten] {
        let mut fixture = Fixture::new();
        fixture.kernel(10, 2000, "CONSTRAINT_NONE");
        fixture.monitor.capture(CaptureReason::Sample);
        fixture.monitor.kernel = None;
        fixture.monitor.kernel_status = status;
        fs::write(
            fixture.root.join("workload/memory.events"),
            "oom 0\noom_kill 1\noom_group_kill 0\n",
        )
        .unwrap();
        assert_eq!(
            fixture
                .monitor
                .capture(CaptureReason::Sample)
                .incidents
                .len(),
            2
        );
    }
    let mut fixture = Fixture::new();
    fixture.record("6,10,2000,-;oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/vm0-exec/exec-281-10-3/control,task=guest-agent,pid=999999,uid=1000\n");
    fixture.monitor.capture(CaptureReason::Sample);
    fs::write(
        fixture.root.join("workload/memory.events"),
        "oom 0\noom_kill 1\noom_group_kill 0\n",
    )
    .unwrap();
    assert_eq!(
        fixture
            .monitor
            .capture(CaptureReason::Sample)
            .incidents
            .len(),
        2
    );
}

#[test]
fn recovered_tool_oom_error_and_cleanup_share_one_incident() {
    let mut fixture = Fixture::new();
    fixture.counters(1);
    let first = fixture.monitor.capture(CaptureReason::Sample);
    assert_eq!(first.incidents.len(), 1);
    assert!(first.incidents[0].kernel_events.is_empty());
    fixture.kernel(10, 2000, "CONSTRAINT_MEMCG");
    let exit = fixture.monitor.capture(CaptureReason::CliError);
    let cleanup = fixture.monitor.capture(CaptureReason::Cleanup);
    assert_eq!(exit.incidents.len(), 1);
    assert_eq!(cleanup.incidents.len(), 1);
    assert_eq!(first.incidents[0].id, cleanup.incidents[0].id);
    assert_eq!(cleanup.incidents[0].kernel_events.len(), 1);
    fs::remove_dir_all(&fixture.root).unwrap();
    assert_eq!(cleanup.incidents[0].groups[0].current, Some(4096));
    assert_eq!(cleanup.incidents[0].groups[0].local_delta.oom, Some(0));
}

#[test]
fn rejects_stale_unrelated_host_and_userspace_records() {
    let mut fixture = Fixture::new();
    fixture.kernel(10, 999, "CONSTRAINT_MEMCG");
    assert!(
        fixture
            .monitor
            .capture(CaptureReason::Sample)
            .incidents
            .is_empty()
    );
    for record in [
        "6,11,2000,-;Killed\n",
        "6,12,2000,-;oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/host/firecracker,task=firecracker,pid=55,uid=0\n",
        "6,13,2000,-;oom-kill:constraint=CONSTRAINT_MEMCG,task_memcg=/vm0-exec/exec-1-2-3/workload/runtime,task=node,pid=55,uid=0\n",
    ] {
        fixture.record(record);
        assert!(
            fixture
                .monitor
                .capture(CaptureReason::Sample)
                .incidents
                .is_empty()
        );
    }
    fixture.kernel(14, 3000, "CONSTRAINT_NONE");
    let mut text = String::new();
    fixture
        .monitor
        .kernel
        .as_mut()
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    fixture.record(&text.replacen("6,", "14,", 1));
    assert!(
        fixture
            .monitor
            .capture(CaptureReason::Sample)
            .incidents
            .is_empty()
    );
    let candidate = fixture.monitor.capture(CaptureReason::CliError);
    assert!(candidate.incidents[0].kernel_events.is_empty());
    assert!(!candidate.incidents[0].groups[0].delta.has_oom());
}

#[test]
fn duplicate_kernel_fields_cannot_forge_victim_identity() {
    assert!(parse_oom("oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/g/runtime,task=evil,pid=1,pid=99,uid=1000", 1, 2, "/g").is_none());
    assert!(parse_oom("oom-kill:constraint=CONSTRAINT_NONE,task_memcg=/g/runtime,task=evil\nname,pid=99,uid=1000", 1, 2, "/g").is_none());
}

#[test]
fn repeated_operations_and_recreated_cgroups_do_not_inherit_counters() {
    let mut fixture = Fixture::new();
    fixture.counters(5);
    let mut next = EvidenceMonitor::without_kernel_for_test(fixture.root.clone());
    assert_ne!(
        fixture.monitor.evidence.operation_id,
        next.evidence.operation_id
    );
    assert!(next.capture(CaptureReason::Sample).incidents.is_empty());
    fs::rename(
        fixture.root.join("workload"),
        fixture.root.join("old-workload"),
    )
    .unwrap();
    fs::create_dir(fixture.root.join("workload")).unwrap();
    fixture.counters(9);
    let capture = fixture.monitor.capture(CaptureReason::Sample);
    assert!(capture.incidents.is_empty());
    assert_eq!(capture.groups[0].status, EvidenceStatus::Recreated);
    assert_eq!(capture.groups[0].delta.oom_kill, None);
}

#[test]
fn unsupported_and_oversized_sources_are_explicit_and_retention_is_bounded() {
    let mut fixture = Fixture::new();
    fs::remove_file(fixture.root.join("workload/memory.peak")).unwrap();
    fs::write(
        fixture.root.join("workload/memory.stat"),
        "x".repeat(FILE_BYTES + 1),
    )
    .unwrap();
    let first = fixture.monitor.capture(CaptureReason::Sample);
    assert_eq!(first.groups[0].peak, None);
    assert_eq!(first.groups[0].anon, None);
    assert_eq!(first.groups[0].status, EvidenceStatus::Truncated);
    for count in 1..=10 {
        fixture.counters(count);
        fixture.monitor.capture(CaptureReason::Sample);
    }
    let capture = fixture.monitor.capture(CaptureReason::Cleanup);
    assert_eq!(capture.incidents.len(), MAX_INCIDENTS);
    assert_eq!(capture.dropped_incidents, 6);
    assert!(serde_json::to_vec(&capture).unwrap().len() < MAX_EVIDENCE_BYTES);
    let deadline = snapshots(
        &fixture.root,
        &fixture.monitor.cgroup_root,
        Some(&fixture.monitor.initial),
        Instant::now(),
    );
    assert!(
        deadline
            .iter()
            .all(|group| group.status == EvidenceStatus::Truncated)
    );
}
