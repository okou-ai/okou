use super::*;

fn stat_with_comm(comm: &str, state: &str, pgid: &str, starttime: &str) -> String {
    let fields = vec![
        state, "1200", pgid, "1100", "0", "-1", "4194560", "2100", "0", "0", "0", "12", "8", "0",
        "0", "20", "0", "1", "0", starttime,
    ];
    format!("1234 ({comm}) {}", fields.join(" "))
}

fn stat_bytes_with_comm(comm: &[u8], state: &str, pgid: &str, starttime: &str) -> Vec<u8> {
    let fields = [
        state, "1200", pgid, "1100", "0", "-1", "4194560", "2100", "0", "0", "0", "12", "8", "0",
        "0", "20", "0", "1", "0", starttime,
    ];
    let mut stat = b"1234 (".to_vec();
    stat.extend_from_slice(comm);
    stat.extend_from_slice(b") ");
    stat.extend_from_slice(fields.join(" ").as_bytes());
    stat
}

fn service_unit(unit: &str) -> Option<String> {
    Some(unit.to_string())
}

fn create_proc_entry(
    proc_root: &Path,
    pid: u32,
    cmdline: Option<&[u8]>,
    stat: Option<&[u8]>,
) -> PathBuf {
    let pid_dir = proc_root.join(pid.to_string());
    std::fs::create_dir_all(&pid_dir).unwrap();
    if let Some(cmdline) = cmdline {
        std::fs::write(pid_dir.join("cmdline"), cmdline).unwrap();
    }
    if let Some(stat) = stat {
        std::fs::write(pid_dir.join("stat"), stat).unwrap();
    }
    pid_dir
}

async fn scan_test_proc_root(proc_root: &Path) -> ProcCmdlineScan {
    scan_proc_cmdlines_with_reader(
        proc_root,
        ProcDirEntryReader::new(),
        CancellationToken::new(),
        None,
    )
    .await
}

#[test]
fn parse_service_unit_from_cgroup_accepts_v2_service_line() {
    assert_eq!(
        parse_service_unit_from_cgroup("0::/system.slice/vm0-runner-v0.2.0.service\n"),
        service_unit("vm0-runner-v0.2.0")
    );
}

#[test]
fn parse_service_unit_from_cgroup_accepts_v1_systemd_service_line() {
    assert_eq!(
        parse_service_unit_from_cgroup("9:name=systemd:/system.slice/vm0-runner-v0.2.0.service\n",),
        service_unit("vm0-runner-v0.2.0")
    );
}

#[test]
fn parse_service_unit_from_cgroup_skips_malformed_lines_before_valid_service() {
    assert_eq!(
        parse_service_unit_from_cgroup(
            "not-a-cgroup-line\n1:cpu:/system.slice\n0::/system.slice/vm0-runner-v1.service\n",
        ),
        service_unit("vm0-runner-v1")
    );
}

#[test]
fn parse_service_unit_from_cgroup_rejects_empty_or_malformed_only_content() {
    assert_eq!(parse_service_unit_from_cgroup(""), None);
    assert_eq!(
        parse_service_unit_from_cgroup("not-a-cgroup-line\n1:cpu:relative.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("0::/system.slice/.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("::/system.slice/vm0-runner-invalid.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("1::/system.slice/vm0-runner-invalid.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("0:cpu:/system.slice/vm0-runner-invalid.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("abc:cpu:/system.slice/vm0-runner-invalid.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("+1:cpu:/system.slice/vm0-runner-invalid.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("00::/system.slice/vm0-runner-invalid.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("01:cpu:/system.slice/vm0-runner-invalid.service\n"),
        None
    );
    assert_eq!(
        parse_service_unit_from_cgroup("1:,:/system.slice/vm0-runner-invalid.service\n"),
        None
    );
}

#[test]
fn parse_service_unit_from_cgroup_finds_service_ancestor() {
    assert_eq!(
        parse_service_unit_from_cgroup("0::/system.slice/vm0-runner-v1.service/runtime/child\n",),
        service_unit("vm0-runner-v1")
    );
}

#[test]
fn parse_service_unit_from_cgroup_preserves_colon_inside_path() {
    assert_eq!(
        parse_service_unit_from_cgroup("0::/system.slice/vm0-runner-v1:blue.service\n"),
        service_unit("vm0-runner-v1:blue")
    );
}

#[test]
fn parse_service_unit_from_cgroup_prefers_v1_systemd_controller() {
    assert_eq!(
        parse_service_unit_from_cgroup(
            "4:cpu:/system.slice/wrong-runner.service\n9:name=systemd:/system.slice/vm0-runner-v1.service\n",
        ),
        service_unit("vm0-runner-v1")
    );
}

#[test]
fn parse_service_unit_from_cgroup_falls_back_without_systemd_path() {
    assert_eq!(
        parse_service_unit_from_cgroup("4:cpu:/system.slice/vm0-runner-fallback.service\n"),
        service_unit("vm0-runner-fallback")
    );
}

#[test]
fn parse_service_unit_from_cgroup_does_not_fallback_when_systemd_path_has_no_service() {
    assert_eq!(
        parse_service_unit_from_cgroup(
            "4:cpu:/system.slice/vm0-runner-fallback.service\n0::/system.slice\n",
        ),
        None
    );
}

#[test]
fn parse_cmdline_bytes_accepts_nul_separated_argv() {
    assert_eq!(
        parse_cmdline_bytes(b"firecracker\0--no-api\0"),
        Some(vec!["firecracker".to_string(), "--no-api".to_string()])
    );
}

#[test]
fn parse_cmdline_bytes_rejects_empty_or_nul_free_content() {
    assert_eq!(parse_cmdline_bytes(b""), None);
    assert_eq!(parse_cmdline_bytes(b"firecracker"), None);
}

#[test]
fn parse_cmdline_bytes_rejects_all_empty_segments() {
    assert_eq!(parse_cmdline_bytes(b"\0\0"), None);
}

#[tokio::test]
async fn proc_scan_submits_one_blocking_task_for_many_pids() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PROCESS_COUNT: u32 = 256;

    let dir = tempfile::tempdir().unwrap();
    let proc_root = dir.path().join("proc");
    std::fs::create_dir(&proc_root).unwrap();
    std::fs::create_dir(proc_root.join("not-a-pid")).unwrap();
    for pid in 1..=PROCESS_COUNT {
        create_proc_entry(&proc_root, pid, Some(b"bash\0-c\0true\0"), None);
    }
    let task_submissions = AtomicUsize::new(0);

    let mut scan = scan_proc_cmdlines_with_reader(
        &proc_root,
        ProcDirEntryReader::new(),
        CancellationToken::new(),
        Some(&task_submissions),
    )
    .await;
    scan.entries.sort_by_key(|(pid, _)| *pid);

    assert_eq!(task_submissions.load(Ordering::Relaxed), 1);
    assert!(scan.complete);
    assert_eq!(scan.entries.len(), PROCESS_COUNT as usize);
    assert_eq!(scan.entries.first().unwrap().0, 1);
    assert_eq!(scan.entries.last().unwrap().0, PROCESS_COUNT);
    assert!(
        scan.entries
            .iter()
            .all(|(_, argv)| argv == &["bash", "-c", "true"])
    );
}

#[tokio::test]
async fn proc_scan_ignores_benign_cmdline_fallbacks() {
    let dir = tempfile::tempdir().unwrap();
    let proc_root = dir.path().join("proc");
    std::fs::create_dir(&proc_root).unwrap();
    create_proc_entry(&proc_root, 10, Some(b"bash\0-c\0true\0"), None);
    let bash_stat = stat_with_comm("bash", "S", "1100", "123456");
    create_proc_entry(&proc_root, 11, Some(b""), Some(bash_stat.as_bytes()));
    let zombie_firecracker_stat = stat_with_comm("firecracker", "Z", "1100", "123456");
    create_proc_entry(
        &proc_root,
        12,
        Some(b""),
        Some(zombie_firecracker_stat.as_bytes()),
    );
    create_proc_entry(&proc_root, 13, None, None);

    let scan = scan_test_proc_root(&proc_root).await;

    assert!(scan.complete);
    assert_eq!(
        scan.entries,
        vec![(
            10,
            vec!["bash".to_string(), "-c".to_string(), "true".to_string()]
        )]
    );
}

#[tokio::test]
async fn proc_scan_marks_possible_live_firecracker_facts_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let proc_root = dir.path().join("live-firecracker");
    std::fs::create_dir(&proc_root).unwrap();
    let live_firecracker_stat = stat_with_comm("firecracker", "S", "1100", "123456");
    create_proc_entry(
        &proc_root,
        20,
        Some(b""),
        Some(live_firecracker_stat.as_bytes()),
    );

    assert!(!scan_test_proc_root(&proc_root).await.complete);

    let malformed_root = dir.path().join("malformed-stat");
    std::fs::create_dir(&malformed_root).unwrap();
    let malformed_pid = create_proc_entry(&malformed_root, 21, None, Some(b"malformed"));
    std::fs::create_dir(malformed_pid.join("cmdline")).unwrap();

    assert!(!scan_test_proc_root(&malformed_root).await.complete);

    let unreadable_root = dir.path().join("unreadable-stat");
    std::fs::create_dir(&unreadable_root).unwrap();
    let unreadable_pid = create_proc_entry(&unreadable_root, 22, None, None);
    std::fs::create_dir(unreadable_pid.join("cmdline")).unwrap();
    std::fs::create_dir(unreadable_pid.join("stat")).unwrap();

    assert!(!scan_test_proc_root(&unreadable_root).await.complete);
}

#[tokio::test]
async fn proc_scan_marks_directory_iteration_failures_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let proc_root = dir.path().join("proc");
    std::fs::create_dir(&proc_root).unwrap();
    create_proc_entry(&proc_root, 30, Some(b"bash\0"), None);
    let entry_reader = ProcDirEntryReader::after_entry(|| {
        Err(std::io::Error::other(
            "injected proc directory iteration failure",
        ))
    });

    let scan =
        scan_proc_cmdlines_with_reader(&proc_root, entry_reader, CancellationToken::new(), None)
            .await;

    assert!(!scan.complete);
    assert!(scan.entries.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_proc_scan_stops_the_blocking_traversal() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    struct Completion {
        entry_count: Arc<AtomicUsize>,
        finished: mpsc::Sender<usize>,
    }

    impl Drop for Completion {
        fn drop(&mut self) {
            let _ = self.finished.send(self.entry_count.load(Ordering::Relaxed));
        }
    }

    const WAIT_TIMEOUT: Duration = Duration::from_secs(5);

    let dir = tempfile::tempdir().unwrap();
    let proc_root = dir.path().join("proc");
    std::fs::create_dir(&proc_root).unwrap();
    create_proc_entry(&proc_root, 40, Some(b"bash\0"), None);
    create_proc_entry(&proc_root, 41, Some(b"bash\0"), None);

    let (reached_tx, reached_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let entry_count = Arc::new(AtomicUsize::new(0));
    let observed_entry_count = Arc::clone(&entry_count);
    let completion = Completion {
        entry_count,
        finished: finished_tx,
    };
    let mut pause = Some((reached_tx, resume_rx));
    let entry_reader = ProcDirEntryReader::after_entry(move || {
        let _completion = &completion;
        if observed_entry_count.fetch_add(1, Ordering::Relaxed) == 0
            && let Some((reached, resume)) = pause.take()
        {
            reached.send(()).unwrap();
            resume.recv().unwrap();
        }
        Ok(())
    });
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        scan_proc_cmdlines_with_reader(&proc_root, entry_reader, task_cancel, None).await
    });

    reached_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert!(cancel.is_cancelled());
    resume_tx.send(()).unwrap();
    assert_eq!(finished_rx.recv_timeout(WAIT_TIMEOUT).unwrap(), 1);
}

#[test]
fn cmdline_problem_for_firecracker_comm_is_unreadable() {
    assert_eq!(
        cmdline_problem_for_comm(
            ProcessCommRead::Name {
                comm: b"firecracker".to_vec(),
                live: Some(true),
            },
            "cmdline is empty or NUL-free",
        ),
        CmdlineRead::Unreadable("cmdline is empty or NUL-free".to_string())
    );
}

#[test]
fn cmdline_problem_for_zombie_firecracker_comm_is_ignored() {
    assert_eq!(
        cmdline_problem_for_comm(
            ProcessCommRead::Name {
                comm: b"firecracker".to_vec(),
                live: Some(false),
            },
            "cmdline is empty or NUL-free",
        ),
        CmdlineRead::Ignored
    );
}

#[test]
fn cmdline_problem_for_firecracker_comm_with_invalid_stat_is_unreadable() {
    assert_eq!(
        cmdline_problem_for_comm(
            ProcessCommRead::Name {
                comm: b"firecracker".to_vec(),
                live: None,
            },
            "cmdline is empty or NUL-free",
        ),
        CmdlineRead::Unreadable("cmdline is empty or NUL-free; stat parse failed".to_string())
    );
}

#[test]
fn cmdline_problem_for_non_firecracker_comm_is_ignored() {
    assert_eq!(
        cmdline_problem_for_comm(
            ProcessCommRead::Name {
                comm: b"postgres".to_vec(),
                live: Some(true),
            },
            "cmdline is empty or NUL-free",
        ),
        CmdlineRead::Ignored
    );
}

#[test]
fn process_comm_extracts_comm_with_spaces_and_parens() {
    let stat = stat_with_comm("firecracker (worker)", "S", "1100", "123456");

    assert_eq!(
        process_comm(stat.as_bytes()),
        Some(&b"firecracker (worker)"[..])
    );
}

#[test]
fn process_comm_accepts_non_utf8_comm() {
    let stat = stat_bytes_with_comm(b"firecracker\xff", "S", "1100", "123456");

    assert_eq!(process_comm(&stat), Some(&b"firecracker\xff"[..]));
}

#[test]
fn process_comm_rejects_missing_delimiters() {
    assert_eq!(process_comm(b"1234 firecracker) S 1 1"), None);
    assert_eq!(process_comm(b"1234 (firecracker S 1 1"), None);
}

#[test]
fn parse_process_stat_simple() {
    // Real /proc/pid/stat: "1234 (firecracker) S 1200 1100 1100 ..."
    let stat = stat_with_comm("firecracker", "S", "1100", "123456");
    assert_eq!(
        parse_process_stat(stat.as_bytes()),
        Some(ProcessStat {
            state: 'S',
            ppid: 1200,
            pgid: 1100,
            starttime: 123456
        })
    );
}

#[test]
fn parse_process_stat_comm_with_spaces() {
    // comm can contain spaces
    let stat = stat_with_comm("Web Content", "S", "200", "999");
    assert_eq!(
        parse_process_stat(stat.as_bytes()),
        Some(ProcessStat {
            state: 'S',
            ppid: 1200,
            pgid: 200,
            starttime: 999
        })
    );
}

#[test]
fn parse_process_stat_comm_with_parens() {
    // comm can contain parentheses — last ')' is the delimiter
    let stat = stat_with_comm("foo (bar)", "S", "600", "888");
    assert_eq!(
        parse_process_stat(stat.as_bytes()),
        Some(ProcessStat {
            state: 'S',
            ppid: 1200,
            pgid: 600,
            starttime: 888
        })
    );
}

#[test]
fn parse_process_stat_zombie_state() {
    let stat = stat_with_comm("firecracker", "Z", "1100", "123456");
    assert_eq!(
        parse_process_stat(stat.as_bytes()),
        Some(ProcessStat {
            state: 'Z',
            ppid: 1200,
            pgid: 1100,
            starttime: 123456
        })
    );
}

#[test]
fn parse_process_stat_empty() {
    assert!(parse_process_stat(b"").is_none());
}

#[test]
fn parse_process_stat_truncated_before_starttime() {
    let stat = "1234 (cmd) S 100 200 200 0 0 0";
    assert!(parse_process_stat(stat.as_bytes()).is_none());
}

#[test]
fn parse_process_stat_rejects_invalid_ppid() {
    let fields = [
        "S",
        "not-a-number",
        "1100",
        "1100",
        "0",
        "-1",
        "4194560",
        "2100",
        "0",
        "0",
        "0",
        "12",
        "8",
        "0",
        "0",
        "20",
        "0",
        "1",
        "0",
        "123456",
    ];
    let stat = format!("1234 (firecracker) {}", fields.join(" "));
    assert!(parse_process_stat(stat.as_bytes()).is_none());
}

#[test]
fn parse_process_stat_rejects_invalid_pgid() {
    let stat = stat_with_comm("firecracker", "S", "not-a-number", "123456");
    assert!(parse_process_stat(stat.as_bytes()).is_none());
}

#[test]
fn parse_process_stat_accepts_unavailable_pgid_without_inferring_exit() {
    for state in ["R", "S", "Z", "X", "x"] {
        let raw = stat_with_comm("exiting", state, "-1", "123456");
        let ProcessStatRead::Found(stat) = classify_process_stat_read(Ok(raw.into_bytes())) else {
            panic!("valid signed process group must remain observable");
        };
        assert_eq!(stat.pgid, -1);
        assert_eq!(stat.starttime, 123456);
        assert_eq!(process_stat_is_live(&stat), matches!(state, "R" | "S"));
    }
}

#[test]
fn parse_process_stat_rejects_pgid_outside_kernel_range() {
    for pgid in ["-2", "-2147483648", "2147483648", "4294967295"] {
        let raw = stat_with_comm("exiting", "X", pgid, "123456");
        assert!(matches!(
            classify_process_stat_read(Ok(raw.into_bytes())),
            ProcessStatRead::Invalid
        ));
    }
    let raw = stat_with_comm("live", "S", "2147483647", "123456");
    assert_eq!(parse_process_stat(raw.as_bytes()).unwrap().pgid, i32::MAX);
}

#[test]
fn parse_process_stat_rejects_malformed_state_with_unavailable_pgid() {
    for state in ["XX", "Xjunk", "☃"] {
        let raw = stat_with_comm("exiting", state, "-1", "123456");
        assert!(matches!(
            classify_process_stat_read(Ok(raw.into_bytes())),
            ProcessStatRead::Invalid
        ));
    }
}

#[test]
fn parse_process_stat_rejects_invalid_starttime() {
    let stat = stat_with_comm("firecracker", "S", "1100", "not-a-number");
    assert!(parse_process_stat(stat.as_bytes()).is_none());
}

#[test]
fn parse_process_ppid_does_not_require_starttime() {
    let stat = stat_with_comm("firecracker", "S", "1100", "not-a-number");
    assert_eq!(parse_process_ppid(stat.as_bytes()), Some(1200));
}

#[test]
fn parse_process_ppid_rejects_invalid_ppid() {
    let stat = "1234 (firecracker) S not-a-number 1100";
    assert!(parse_process_ppid(stat.as_bytes()).is_none());
}

#[test]
fn parse_process_ppid_rejects_missing_ppid() {
    let stat = "1234 (firecracker) S";
    assert!(parse_process_ppid(stat.as_bytes()).is_none());
}

#[test]
fn parse_process_stat_accepts_non_utf8_comm() {
    let stat = stat_bytes_with_comm(b"bad \xff ) name", "S", "1100", "123456");
    assert_eq!(
        parse_process_stat(&stat),
        Some(ProcessStat {
            state: 'S',
            ppid: 1200,
            pgid: 1100,
            starttime: 123456
        })
    );
}

#[test]
fn checked_process_stat_read_distinguishes_parsed_content() {
    let stat = stat_with_comm("firecracker", "S", "1100", "123456");

    assert!(matches!(
        classify_process_stat_read(Ok(stat.into_bytes())),
        ProcessStatRead::Found(ProcessStat {
            state: 'S',
            ppid: 1200,
            pgid: 1100,
            starttime: 123456,
        })
    ));
}

#[test]
fn checked_process_stat_read_distinguishes_missing_content() {
    let error = std::io::Error::from(std::io::ErrorKind::NotFound);

    assert!(matches!(
        classify_process_stat_read(Err(error)),
        ProcessStatRead::Missing
    ));
}

#[test]
fn checked_process_stat_read_distinguishes_unreadable_content() {
    let error = std::io::Error::from(std::io::ErrorKind::PermissionDenied);

    let ProcessStatRead::Unreadable(error) = classify_process_stat_read(Err(error)) else {
        panic!("expected unreadable process stat");
    };
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn checked_process_stat_read_distinguishes_invalid_content() {
    assert!(matches!(
        classify_process_stat_read(Ok(b"invalid stat".to_vec())),
        ProcessStatRead::Invalid
    ));
}

#[test]
fn parse_process_ppid_accepts_non_utf8_comm() {
    let stat = stat_bytes_with_comm(b"bad \xff ) name", "S", "1100", "not-a-number");
    assert_eq!(parse_process_ppid(&stat), Some(1200));
}
