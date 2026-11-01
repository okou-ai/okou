use super::*;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;

struct ChildGuard(Child);

fn current_cgroup_path() -> PathBuf {
    let current_cgroup = fs::read_to_string("/proc/self/cgroup").unwrap();
    let relative = current_cgroup
        .lines()
        .find_map(|line| line.strip_prefix("0::/"))
        .unwrap();
    Path::new(CGROUP_V2_MOUNT_PATH).join(relative)
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn oom_evidence_is_captured_before_forced_cleanup_removes_sources() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("exec-281-10-3");
    for suffix in ["", "workload", "workload/runtime", "workload/tools"] {
        let path = root.join(suffix);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("cgroup.events"), "populated 0\n").unwrap();
        fs::write(path.join("memory.current"), "4096").unwrap();
        fs::write(path.join("memory.peak"), "8192").unwrap();
        fs::write(path.join("memory.max"), "16384").unwrap();
        fs::write(
            path.join("memory.stat"),
            "anon 1024\nfile 2048\nkernel 1024\n",
        )
        .unwrap();
        fs::write(path.join("memory.events"), "oom 0\noom_kill 0\n").unwrap();
    }
    let monitor = crate::oom_evidence::EvidenceMonitor::without_kernel_for_test(root.clone());
    fs::write(root.join("workload/memory.events"), "oom 1\noom_kill 1\n").unwrap();
    let guard = CgroupGuard {
        group_name: "exec-281-10-3".into(),
        group_path: root.clone(),
        outer_placement: fs::File::open(&root).unwrap().into(),
        workload_placement: None,
        create_elapsed: Duration::ZERO,
        oom_evidence: Some(Arc::new(Mutex::new(monitor))),
        storage_operation: None,
    };
    let mut resources = None;
    let diagnostic = guard
        .cleanup(ProcessContainmentCleanupMode::Forced, &mut resources, false)
        .unwrap()
        .unwrap();
    assert!(!root.exists());
    assert!(resources.is_none());
    let evidence: guest_contracts::oom_evidence::OomEvidence = serde_json::from_str(
        diagnostic
            .strip_prefix(guest_contracts::oom_evidence::EVIDENCE_PREFIX)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(evidence.incidents[0].groups[0].current, Some(4096));
    assert_eq!(evidence.incidents[0].groups[0].delta.oom_kill, Some(1));
    assert!(evidence.incidents[0].before_cleanup);
}

#[test]
fn oom_evidence_exchange_is_owned_by_authenticated_peer_and_cancel_wake() {
    let directory = tempfile::tempdir().unwrap();
    let monitor = crate::oom_evidence::EvidenceMonitor::without_kernel_for_test(
        directory.path().to_path_buf(),
    );
    let (mut client, server) = UnixStream::pair().unwrap();
    let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let expected = current_cgroup_path();
    // SAFETY: geteuid only returns the current identity.
    let uid = unsafe { libc::geteuid() };
    let (done_tx, done_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        serve_oom_evidence(
            server,
            Arc::new(Mutex::new(monitor)),
            uid,
            &expected,
            &cancel,
            cancel_reader.as_raw_fd(),
        );
        done_tx.send(()).unwrap();
    });
    client.write_all(&[1]).unwrap();
    let first = guest_contracts::oom_evidence::read_evidence(&client).unwrap();
    client.write_all(&[2]).unwrap();
    let error = guest_contracts::oom_evidence::read_evidence(&client).unwrap();
    assert_eq!(first.operation_id, error.operation_id);
    assert!(first.incidents.is_empty());
    assert_eq!(error.incidents.len(), 1);
    assert!(error.incidents[0].kernel_events.is_empty());
    // The request alphabet is exactly `1` and `2`. An unrecognized byte
    // ends the exchange rather than reading a payload the peer never
    // promised, so a desynchronized request cannot consume the next frame.
    client.write_all(&[9]).unwrap();
    assert!(guest_contracts::oom_evidence::read_evidence(&client).is_err());
    drop(cancel_writer);
    done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    worker.join().unwrap();
}

#[test]
fn parses_recursive_populated_state() {
    assert_eq!(parse_populated("populated 0\nfrozen 0\n"), Some(false));
    assert_eq!(parse_populated("populated 1\nfrozen 0\n"), Some(true));
    assert_eq!(parse_populated("frozen 0\n"), None);
    assert_eq!(parse_populated("populated 2\n"), None);
}

#[test]
fn cleanup_evidence_reports_material_cgroup_kill() {
    let evidence = cleanup_evidence_line(
        "exec-7-1",
        ProcessContainmentCleanupMode::Graceful,
        &CleanupReport {
            descendants_observed: true,
            cgroup_kill_used: true,
            initial_members: 61,
            graceful_errors: 0,
        },
        Duration::from_micros(42),
        Duration::from_millis(17),
    )
    .unwrap();

    assert_eq!(
        evidence,
        "exec process containment cleaned group=exec-7-1 mode=Graceful descendants_observed=true cgroup_kill_used=true initial_members=61 graceful_errors=0 create_us=42 cleanup_ms=17"
    );
}

#[test]
fn cleanup_evidence_omits_empty_healthy_cleanup() {
    assert!(
        cleanup_evidence_line(
            "exec-8-1",
            ProcessContainmentCleanupMode::Graceful,
            &CleanupReport {
                descendants_observed: false,
                cgroup_kill_used: false,
                initial_members: 0,
                graceful_errors: 0,
            },
            Duration::ZERO,
            Duration::ZERO,
        )
        .is_none()
    );
}

#[test]
fn quiesce_accepts_empty_exec_cgroup_base() {
    let base = tempfile::tempdir().unwrap();
    fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 0\n").unwrap();

    verify_exec_process_containment_empty_in(base.path()).unwrap();
}

#[test]
fn quiesce_rejects_stale_exec_cgroup_leaf() {
    let base = tempfile::tempdir().unwrap();
    fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 0\n").unwrap();
    fs::create_dir(base.path().join("exec-stale")).unwrap();

    let error = verify_exec_process_containment_empty_in(base.path())
        .expect_err("stale operation leaf must reject quiesce");

    assert_eq!(error.stage, "verify exec cgroup empty");
}

#[test]
fn quiesce_rejects_populated_exec_cgroup_base() {
    let base = tempfile::tempdir().unwrap();
    fs::write(base.path().join(CGROUP_EVENTS_FILE), b"populated 1\n").unwrap();

    let error = verify_exec_process_containment_empty_in(base.path())
        .expect_err("populated containment must reject quiesce");

    assert_eq!(error.stage, "verify exec cgroup empty");
}

#[test]
fn forced_cleanup_attempts_cgroup_kill_when_events_are_unreadable() {
    let group = tempfile::tempdir().unwrap();
    let kill_path = group.path().join(CGROUP_KILL_FILE);
    fs::write(&kill_path, b"").unwrap();

    let error = cleanup_cgroup(group.path(), ProcessContainmentCleanupMode::Forced)
        .expect_err("missing cgroup.events should leave cleanup unproven");

    assert_eq!(error.stage, "read cgroup.events");
    assert_eq!(fs::read(&kill_path).unwrap(), b"1");
}

#[test]
fn graceful_cleanup_attempts_cgroup_kill_when_events_are_unreadable() {
    let group = tempfile::tempdir().unwrap();
    let kill_path = group.path().join(CGROUP_KILL_FILE);
    fs::write(&kill_path, b"").unwrap();

    let error = cleanup_cgroup(group.path(), ProcessContainmentCleanupMode::Graceful)
        .expect_err("missing cgroup.events should leave cleanup unproven");

    assert_eq!(error.stage, "read cgroup.events");
    assert_eq!(fs::read(&kill_path).unwrap(), b"1");
}

#[test]
fn workload_bootstrap_authenticates_peer_uid_and_cgroup() {
    let (peer, _server) = std::os::unix::net::UnixStream::pair().unwrap();
    // SAFETY: geteuid is a simple scalar getter with no preconditions.
    let uid = unsafe { libc::geteuid() };
    let expected = current_cgroup_path();

    assert!(workload_bootstrap_peer_matches(&peer, uid, &expected).unwrap());
    assert!(!workload_bootstrap_peer_matches(&peer, uid.wrapping_add(1), &expected).unwrap());
    assert!(
        !workload_bootstrap_peer_matches(&peer, uid, &expected.join("not-the-peer-cgroup"))
            .unwrap()
    );
}

#[test]
fn workload_bootstrap_completes_after_authenticated_descriptor_confirmation() {
    let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
    let endpoint = format!(
        "vm0-test-workload-confirm-{}-{endpoint_id}",
        std::process::id()
    );
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let placement: OwnedFd = tempfile::tempfile().unwrap().into();
    let (cancel_reader, _cancel_writer) = placement_cancel_pipe().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let server_cancel = Arc::clone(&cancel);
    // SAFETY: geteuid is a simple scalar getter with no preconditions.
    let uid = unsafe { libc::geteuid() };
    let expected = current_cgroup_path();
    let server = thread::spawn(move || {
        serve_workload_placement(
            listener,
            placement,
            uid,
            &expected,
            &server_cancel,
            cancel_reader.as_raw_fd(),
        )
    });

    let client = process_control_ipc::connect_abstract(&endpoint).unwrap();
    let descriptor = process_control_ipc::receive_workload_placement(&client).unwrap();
    process_control_ipc::write_workload_placement_confirmation(&client).unwrap();

    server.join().unwrap().unwrap();
    drop(descriptor);
}

#[test]
fn workload_bootstrap_fails_when_descriptor_recipient_disconnects_before_confirmation() {
    let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
    let endpoint = format!(
        "vm0-test-workload-disconnect-{}-{endpoint_id}",
        std::process::id()
    );
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let placement: OwnedFd = tempfile::tempfile().unwrap().into();
    let (cancel_reader, _cancel_writer) = placement_cancel_pipe().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let server_cancel = Arc::clone(&cancel);
    // SAFETY: geteuid is a simple scalar getter with no preconditions.
    let uid = unsafe { libc::geteuid() };
    let expected = current_cgroup_path();
    let server = thread::spawn(move || {
        serve_workload_placement(
            listener,
            placement,
            uid,
            &expected,
            &server_cancel,
            cancel_reader.as_raw_fd(),
        )
    });

    let client = process_control_ipc::connect_abstract(&endpoint).unwrap();
    let descriptor = process_control_ipc::receive_workload_placement(&client).unwrap();
    drop(client);

    let error = server
        .join()
        .unwrap()
        .expect_err("missing placement confirmation must fail readiness");
    assert!(matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
    ));
    drop(descriptor);
}

#[test]
fn placement_accept_returns_connection_while_active() {
    let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
    let endpoint = format!(
        "vm0-test-placement-accept-{}-{endpoint_id}",
        std::process::id()
    );
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let client = process_control_ipc::connect_abstract(&endpoint).unwrap();
    let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
    let cancel = AtomicBool::new(false);

    let accepted =
        accept_placement_or_cancelled(&listener, &cancel, cancel_reader.as_raw_fd()).unwrap();

    assert!(accepted.is_some());
    drop(cancel_writer);
    drop(client);
}

#[test]
fn placement_cancel_wins_over_ready_connection() {
    let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
    let endpoint = format!(
        "vm0-test-placement-cancel-ready-{}-{endpoint_id}",
        std::process::id()
    );
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let _client = process_control_ipc::connect_abstract(&endpoint).unwrap();
    let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
    let cancel = AtomicBool::new(false);
    drop(cancel_writer);

    let accepted =
        accept_placement_or_cancelled(&listener, &cancel, cancel_reader.as_raw_fd()).unwrap();

    assert!(accepted.is_none());
}

#[test]
fn placement_bootstrap_drop_wakes_all_idle_accept_workers() {
    let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
    let endpoint_base = format!(
        "vm0-test-placement-cancel-{}-{endpoint_id}",
        std::process::id()
    );
    let endpoint = format!("{endpoint_base}-workload");
    let tool_endpoint = format!("{endpoint_base}-tool");
    let workload_listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let tool_listener = process_control_ipc::bind_abstract_listener(&tool_endpoint).unwrap();
    let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
    let cancel_reader = Arc::new(cancel_reader);
    let workload_cancel_reader = Arc::clone(&cancel_reader);
    let tool_cancel_reader = Arc::clone(&cancel_reader);
    let (ready_tx, ready_rx) = mpsc::channel();
    let worker_done = Arc::new(AtomicU64::new(0));
    let workload_ready_tx = ready_tx.clone();
    let workload_done = Arc::clone(&worker_done);
    let workload_worker = thread::Builder::new()
        .name("test-workload-placement-cancel".to_owned())
        .spawn(move || {
            workload_ready_tx.send(()).unwrap();
            match wait_for_placement_or_cancelled(
                &workload_listener,
                workload_cancel_reader.as_raw_fd(),
            )
            .unwrap()
            {
                PlacementWaitOutcome::Cancelled => {}
                PlacementWaitOutcome::ListenerReady => {
                    panic!("idle workload placement listener unexpectedly became ready");
                }
            }
            workload_done.fetch_add(1, Ordering::Release);
        })
        .unwrap();
    let tool_done = Arc::clone(&worker_done);
    let tool_worker = thread::Builder::new()
        .name("test-tool-placement-cancel".to_owned())
        .spawn(move || {
            ready_tx.send(()).unwrap();
            match wait_for_placement_or_cancelled(&tool_listener, tool_cancel_reader.as_raw_fd())
                .unwrap()
            {
                PlacementWaitOutcome::Cancelled => {}
                PlacementWaitOutcome::ListenerReady => {
                    panic!("idle tool placement listener unexpectedly became ready");
                }
            }
            tool_done.fetch_add(1, Ordering::Release);
        })
        .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_after_drop = Arc::clone(&cancel);
    let (_bootstrap_ready_tx, bootstrap_ready_rx) = mpsc::channel();
    let bootstrap = WorkloadPlacementBootstrap {
        endpoint,
        tool_endpoint,
        setup_elapsed: Duration::ZERO,
        ready_rx: bootstrap_ready_rx,
        cancel,
        cancel_wake_writer: Some(cancel_writer),
        active_tool_placement: Arc::new(ActiveToolPlacement::default()),
        active_task_placement: Arc::new(ActiveToolPlacement::default()),
        workers: vec![workload_worker, tool_worker],
    };

    for _ in 0..2 {
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("placement worker should enter its idle wait");
    }
    let (drop_done_tx, drop_done_rx) = mpsc::channel();
    let drop_worker = thread::spawn(move || {
        drop(bootstrap);
        drop_done_tx.send(()).unwrap();
    });

    drop_done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("bootstrap drop should actively wake and join the idle worker");
    drop_worker.join().unwrap();
    assert!(cancel_after_drop.load(Ordering::Acquire));
    assert_eq!(worker_done.load(Ordering::Acquire), 2);
}

#[test]
fn placement_bootstrap_drop_interrupts_accepted_tool_handshake() {
    let endpoint_id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
    let endpoint_base = format!(
        "vm0-test-placement-active-cancel-{}-{endpoint_id}",
        std::process::id()
    );
    let endpoint = format!("{endpoint_base}-workload");
    let tool_endpoint = format!("{endpoint_base}-tool");
    let workload_listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let tool_listener = process_control_ipc::bind_abstract_listener(&tool_endpoint).unwrap();
    let (cancel_reader, cancel_writer) = placement_cancel_pipe().unwrap();
    let cancel_reader = Arc::new(cancel_reader);
    let workload_cancel_reader = Arc::clone(&cancel_reader);
    let tool_cancel_reader = Arc::clone(&cancel_reader);
    let cancel = Arc::new(AtomicBool::new(false));
    let tool_cancel = Arc::clone(&cancel);
    let cancel_after_drop = Arc::clone(&cancel);
    let active_tool_placement = Arc::new(ActiveToolPlacement::default());
    let worker_active_tool_placement = Arc::clone(&active_tool_placement);
    let active_after_success = Arc::clone(&active_tool_placement);
    let (ready_tx, ready_rx) = mpsc::channel();
    let workload_ready_tx = ready_tx.clone();
    let (successful_done_tx, successful_done_rx) = mpsc::channel();
    let (stalled_error_tx, stalled_error_rx) = mpsc::channel();
    let worker_done = Arc::new(AtomicU64::new(0));
    let workload_done = Arc::clone(&worker_done);
    let tool_done = Arc::clone(&worker_done);
    // SAFETY: geteuid is a simple scalar getter with no preconditions.
    let expected_uid = unsafe { libc::geteuid() };
    let current_cgroup = fs::read_to_string("/proc/self/cgroup").unwrap();
    let relative_cgroup = current_cgroup
        .lines()
        .find_map(|line| line.strip_prefix("0::/"))
        .unwrap();
    let expected_cgroup = Path::new(CGROUP_V2_MOUNT_PATH).join(relative_cgroup);

    let workload_worker = thread::Builder::new()
        .name("test-workload-placement-active-cancel".to_owned())
        .spawn(move || {
            workload_ready_tx.send(()).unwrap();
            match wait_for_placement_or_cancelled(
                &workload_listener,
                workload_cancel_reader.as_raw_fd(),
            )
            .unwrap()
            {
                PlacementWaitOutcome::Cancelled => {}
                PlacementWaitOutcome::ListenerReady => {
                    panic!("idle workload placement listener unexpectedly became ready");
                }
            }
            workload_done.fetch_add(1, Ordering::Release);
        })
        .unwrap();
    let tool_worker = thread::Builder::new()
        .name("test-tool-placement-active-cancel".to_owned())
        .spawn(move || {
            ready_tx.send(()).unwrap();
            let placement = std::fs::File::open("/dev/null").unwrap();

            let successful_stream = accept_placement_or_cancelled(
                &tool_listener,
                &tool_cancel,
                tool_cancel_reader.as_raw_fd(),
            )
            .unwrap()
            .unwrap();
            let successful_stream = worker_active_tool_placement
                .register(successful_stream, &tool_cancel)
                .unwrap()
                .unwrap();
            successful_stream
                .as_ref()
                .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
                .unwrap();
            successful_stream
                .as_ref()
                .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
                .unwrap();
            assert!(
                peer_matches(successful_stream.as_ref(), expected_uid, &expected_cgroup).unwrap()
            );
            process_control_ipc::send_tool_placement(successful_stream.as_ref(), placement.as_fd())
                .unwrap();
            process_control_ipc::read_tool_placement_confirmation(successful_stream.as_ref())
                .unwrap();
            process_control_ipc::write_tool_placement_ack(successful_stream.as_ref()).unwrap();
            drop(successful_stream);
            successful_done_tx.send(()).unwrap();

            let stalled_stream = accept_placement_or_cancelled(
                &tool_listener,
                &tool_cancel,
                tool_cancel_reader.as_raw_fd(),
            )
            .unwrap()
            .unwrap();
            let stalled_stream = worker_active_tool_placement
                .register(stalled_stream, &tool_cancel)
                .unwrap()
                .unwrap();
            stalled_stream
                .as_ref()
                .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
                .unwrap();
            stalled_stream
                .as_ref()
                .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
                .unwrap();
            assert!(peer_matches(stalled_stream.as_ref(), expected_uid, &expected_cgroup).unwrap());
            process_control_ipc::send_tool_placement(stalled_stream.as_ref(), placement.as_fd())
                .unwrap();
            let error =
                process_control_ipc::read_tool_placement_confirmation(stalled_stream.as_ref())
                    .expect_err("bootstrap drop should interrupt the confirmation read");
            stalled_error_tx.send(error.kind()).unwrap();
            tool_done.fetch_add(1, Ordering::Release);
        })
        .unwrap();
    let (_bootstrap_ready_tx, bootstrap_ready_rx) = mpsc::channel();
    let bootstrap = WorkloadPlacementBootstrap {
        endpoint,
        tool_endpoint: tool_endpoint.clone(),
        setup_elapsed: Duration::ZERO,
        ready_rx: bootstrap_ready_rx,
        cancel,
        cancel_wake_writer: Some(cancel_writer),
        active_tool_placement,
        active_task_placement: Arc::new(ActiveToolPlacement::default()),
        workers: vec![workload_worker, tool_worker],
    };

    for _ in 0..2 {
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("placement worker should enter its wait");
    }
    let successful_client = process_control_ipc::connect_abstract(&tool_endpoint).unwrap();
    successful_client
        .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
        .unwrap();
    successful_client
        .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
        .unwrap();
    let successful_placement =
        process_control_ipc::receive_tool_placement(&successful_client).unwrap();
    drop(successful_placement);
    process_control_ipc::write_tool_placement_confirmation(&successful_client).unwrap();
    process_control_ipc::read_tool_placement_ack(&successful_client).unwrap();
    successful_done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("successful placement should clear its active stream");
    assert!(active_after_success.stream.lock().unwrap().is_none());

    let stalled_client = process_control_ipc::connect_abstract(&tool_endpoint).unwrap();
    stalled_client
        .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
        .unwrap();
    stalled_client
        .set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
        .unwrap();
    let stalled_placement = process_control_ipc::receive_tool_placement(&stalled_client).unwrap();
    drop(stalled_placement);

    let (drop_done_tx, drop_done_rx) = mpsc::channel();
    let drop_worker = thread::spawn(move || {
        drop(bootstrap);
        drop_done_tx.send(()).unwrap();
    });

    drop_done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("bootstrap drop should interrupt and join the accepted handshake");
    drop_worker.join().unwrap();
    let stalled_error = stalled_error_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("accepted handshake should report interrupted I/O");
    assert_ne!(stalled_error, io::ErrorKind::TimedOut);
    process_control_ipc::read_tool_placement_ack(&stalled_client)
        .expect_err("cancelled placement must not receive an acknowledgement");
    assert!(cancel_after_drop.load(Ordering::Acquire));
    assert_eq!(worker_done.load(Ordering::Acquire), 2);
}

#[test]
fn discovers_nested_control_runtime_and_tool_leaves() {
    let base = tempfile::tempdir().unwrap();
    let operation = base.path().join("exec-nested");
    let control = operation.join(CONTROL_CGROUP_NAME);
    let runtime = operation
        .join(WORKLOAD_CGROUP_NAME)
        .join(RUNTIME_CGROUP_NAME);
    let tool = operation
        .join(WORKLOAD_CGROUP_NAME)
        .join(TOOLS_CGROUP_NAME)
        .join("tool-7");
    fs::create_dir_all(&control).unwrap();
    fs::create_dir_all(&runtime).unwrap();
    fs::create_dir_all(&tool).unwrap();

    let leaves = cgroup_leaf_paths(&operation).unwrap();

    assert_eq!(leaves, vec![control, runtime, tool]);
}

#[test]
fn removes_nested_cgroup_hierarchy_bottom_up() {
    let base = tempfile::tempdir().unwrap();
    let operation = base.path().join("exec-nested");
    fs::create_dir_all(
        operation
            .join(WORKLOAD_CGROUP_NAME)
            .join(TOOLS_CGROUP_NAME)
            .join("tool-9"),
    )
    .unwrap();
    fs::create_dir_all(
        operation
            .join(WORKLOAD_CGROUP_NAME)
            .join(RUNTIME_CGROUP_NAME),
    )
    .unwrap();
    fs::create_dir_all(operation.join(CONTROL_CGROUP_NAME)).unwrap();

    remove_cgroup_hierarchy(&operation).unwrap();

    assert!(!operation.exists());
}

#[test]
fn controlled_operation_preserves_both_memory_floors_without_partitioning_workload() {
    let operation = tempfile::tempdir().unwrap();
    let control = operation.path().join(CONTROL_CGROUP_NAME);
    let workload = operation.path().join(WORKLOAD_CGROUP_NAME);
    fs::create_dir(&control).unwrap();
    fs::create_dir(&workload).unwrap();
    let policy = WorkloadResourcePolicy::for_guest_capacity(2, 4096 * 1024 * 1024, true).unwrap();

    configure_resource_policy(operation.path(), &control, &workload, true, policy).unwrap();

    for (path, expected) in [
        (operation.path(), 512 * 1024 * 1024),
        (control.as_path(), 128 * 1024 * 1024),
        (workload.as_path(), 384 * 1024 * 1024),
    ] {
        assert_eq!(
            fs::read_to_string(path.join(MEMORY_MIN_FILE)).unwrap(),
            expected.to_string()
        );
    }
    assert_eq!(
        fs::read_to_string(workload.join(MEMORY_MAX_FILE)).unwrap(),
        (3968_u64 * 1024 * 1024).to_string()
    );
    assert_eq!(
        fs::read_to_string(workload.join(MEMORY_HIGH_FILE)).unwrap(),
        "max"
    );
}

#[test]
fn ordinary_exec_does_not_receive_agent_memory_protection() {
    let operation = tempfile::tempdir().unwrap();
    let control = operation.path().join(CONTROL_CGROUP_NAME);
    let workload = operation.path().join(WORKLOAD_CGROUP_NAME);
    fs::create_dir(&control).unwrap();
    fs::create_dir(&workload).unwrap();
    for path in [operation.path(), control.as_path(), workload.as_path()] {
        fs::write(path.join(MEMORY_MIN_FILE), "0").unwrap();
    }
    let policy = WorkloadResourcePolicy::for_guest_capacity(2, 480 * 1024 * 1024, false).unwrap();

    configure_resource_policy(operation.path(), &control, &workload, false, policy).unwrap();

    for path in [operation.path(), control.as_path(), workload.as_path()] {
        assert_eq!(fs::read_to_string(path.join(MEMORY_MIN_FILE)).unwrap(), "0");
    }
    assert_eq!(
        fs::read_to_string(workload.join(MEMORY_MAX_FILE)).unwrap(),
        (352 * 1024 * 1024).to_string()
    );
}

#[test]
fn controlled_operation_rejects_failed_runtime_ancestor_protection() {
    let operation = tempfile::tempdir().unwrap();
    let control = operation.path().join(CONTROL_CGROUP_NAME);
    let workload = operation.path().join(WORKLOAD_CGROUP_NAME);
    fs::create_dir(&control).unwrap();
    fs::create_dir_all(workload.join(MEMORY_MIN_FILE)).unwrap();
    let policy = WorkloadResourcePolicy::for_guest_capacity(2, 4096 * 1024 * 1024, true).unwrap();

    let error =
        configure_resource_policy(operation.path(), &control, &workload, true, policy).unwrap_err();

    assert_eq!(error.stage, "preserve runtime ancestor memory protection");
}

#[test]
fn partial_creation_failure_removes_operation_cgroup() {
    let base = tempfile::tempdir().unwrap();

    let policy =
        WorkloadResourcePolicy::for_guest_capacity(2, u64::from(4096_u32) * 1024 * 1024, true)
            .unwrap();
    // A plain directory can supply the outer directory capability, but
    // cannot supply the Agent's kernel-created runtime cgroup.procs file.
    let result = CgroupGuard::create_in(base.path(), 17, ExecProcessRole::Agent, policy);
    let Err(error) = result else {
        panic!("placement-file open unexpectedly succeeded");
    };

    assert_eq!(error.stage, "open workload cgroup.procs");
    assert_eq!(error.source.kind(), io::ErrorKind::NotFound);
    assert!(fs::read_dir(base.path()).unwrap().next().is_none());
}

#[test]
fn spawn_failure_removes_owned_operation_cgroup() {
    let base = tempfile::tempdir().unwrap();
    let group_path = base.path().join("exec-spawn-failure");
    fs::create_dir(&group_path).unwrap();
    let containment = ExecProcessContainment {
        backend: ContainmentBackend::TestDirectory(group_path.clone()),
    };

    let result = crate::shell_command::spawn_shell_command_with_pipes(
        "bad\0command",
        &[],
        false,
        false,
        containment,
    );
    let Err(error) = result else {
        panic!("invalid command unexpectedly spawned");
    };

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(!group_path.exists());
}

#[test]
fn spawn_failure_preserves_primary_error_when_cleanup_fails() {
    let base = tempfile::tempdir().unwrap();
    let group_path = base.path().join("exec-cleanup-failure");
    fs::create_dir(&group_path).unwrap();
    fs::write(group_path.join("blocker"), b"keep directory non-empty").unwrap();
    let containment = ExecProcessContainment {
        backend: ContainmentBackend::TestDirectory(group_path.clone()),
    };

    let result = crate::shell_command::spawn_shell_command_with_pipes(
        "bad\0command",
        &[],
        false,
        false,
        containment,
    );
    let Err(error) = result else {
        panic!("invalid command unexpectedly spawned");
    };

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(group_path.is_dir());
}

#[test]
fn graceful_signal_rechecks_membership_after_opening_pidfd() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join(CGROUP_PROCS_FILE), "").unwrap();
    let mut child = ChildGuard(
        Command::new("/bin/sh")
            .arg("-c")
            .arg(
                "trap 'printf \"term\\n\"; exit 42' TERM; \
                     printf 'ready\\n'; \
                     while IFS= read -r line; do printf '%s\\n' \"$line\"; done",
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let enumerated_pid = libc::pid_t::try_from(child.0.id()).unwrap();
    let mut stdout = BufReader::new(child.0.stdout.take().unwrap());
    let mut response = String::new();
    stdout.read_line(&mut response).unwrap();
    assert_eq!(response, "ready\n");

    let errors = signal_term(directory.path(), &[enumerated_pid]);
    writeln!(child.0.stdin.as_mut().unwrap(), "probe").unwrap();
    response.clear();
    stdout.read_line(&mut response).unwrap();

    assert_eq!(errors, 0);
    assert_eq!(response, "probe\n");
}
