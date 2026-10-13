use std::fs;
use std::os::unix::net::UnixStream;
use std::thread;

use serde_json::{Value, json};

use super::*;

const RUN_ID: &str = "8d7a07c8-15b2-446f-9f47-36d32028baa6";

fn start_with_resources(
    program: PathBuf,
    resources: &Path,
) -> (thread::JoinHandle<std::io::Result<()>>, UnixStream) {
    let resource_path = resources.to_owned();
    let (guest, mut host) = UnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        guest_control_server::handle_connection_with_test_storage_resources(
            guest,
            program,
            resource_path,
        )
    });
    read_guest_ready(&mut host);
    (handle, host)
}

fn resource_summary(result: &TestResult) -> Value {
    assert!(
        result.resources.len() < guest_control_proto::GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES
    );
    serde_json::from_slice(&result.resources).unwrap()
}

#[test]
fn successful_storage_rpc_records_one_resource_snapshot_per_request() {
    let (directory, program) = create_program("cat >/dev/null; printf applied");
    for (name, contents) in [
        (
            "cpu.stat",
            "usage_usec 5100000\nuser_usec 4800000\nsystem_usec 300000\nnr_periods 31\nnr_throttled 29\nthrottled_usec 5014584\nfuture_counter 123\n",
        ),
        (
            "memory.events",
            "high 0\nmax 2\noom 1\noom_kill 1\noom_group_kill 0\n",
        ),
        ("pids.events", "max 0\n"),
        (
            "memory.stat",
            "pgfault 210\npgmajfault 0\npgscan 16\npgsteal 8\npgscan_kswapd 16\npgscan_direct 0\npgsteal_kswapd 8\npgsteal_direct 0\nworkingset_refault_anon 1\nworkingset_refault_file 2\n",
        ),
        ("memory.current", "65536\n"),
        ("memory.peak", "1048576\n"),
        ("memory.high", "max\n"),
        ("memory.max", "3997175808\n"),
        ("cpu.max", "190000 100000\n"),
    ] {
        fs::write(directory.path().join(name), contents).unwrap();
    }
    let (handle, mut host) = start_with_resources(program, directory.path());
    let mut summaries = Vec::new();
    for seq in [501, 502] {
        send_request(&mut host, seq, 1000, RUN_ID, "/run", b"{}");
        let result = read_result(&mut host, seq);
        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
        assert_eq!(result.stdout, b"applied");
        summaries.push(resource_summary(&result));
        assert!(result.diagnostic.is_empty());
    }
    finish_guest_connection(handle, host);
    assert_eq!(summaries.len(), 2);
    for (summary, seq) in summaries.iter().zip([501, 502]) {
        for (field, expected) in [
            ("run_id", json!(RUN_ID)),
            ("request_seq", json!(seq)),
            ("cleanup_mode", json!("Graceful")),
            ("cpu_usage_usec", json!(5_100_000)),
            ("cpu_user_usec", json!(4_800_000)),
            ("cpu_system_usec", json!(300_000)),
            ("cpu_nr_periods", json!(31)),
            ("cpu_nr_throttled", json!(29)),
            ("cpu_throttled_usec", json!(5_014_584)),
            ("cpu_quota_us", json!(190_000)),
            ("cpu_period_us", json!(100_000)),
            ("memory_current_bytes", json!(65_536)),
            ("memory_peak_bytes", json!(1_048_576)),
            ("memory_high_limit_bytes", json!("max")),
            ("memory_max_limit_bytes", json!(3_997_175_808_u64)),
            ("memory_events_high", json!(0)),
            ("memory_events_max", json!(2)),
            ("memory_pgmajfault", json!(0)),
            ("memory_pgscan_direct", json!(0)),
            ("memory_pgsteal_kswapd", json!(8)),
        ] {
            assert_eq!(summary.get(field), Some(&expected), "{field}");
        }
        assert!(summary.get("cpu_future_counter").is_none());
        assert!(
            summary
                .get("containment_wall_us")
                .and_then(Value::as_u64)
                .is_some()
        );
        assert!(
            summary
                .get("collection_us")
                .and_then(Value::as_u64)
                .is_some()
        );
    }
}

#[test]
fn storage_resource_file_size_boundary_accepts_limit_and_rejects_oversize() {
    for (size, expected) in [(16 * 1024, json!(16)), (16 * 1024 + 1, Value::Null)] {
        let (directory, program) = create_program("cat >/dev/null; printf applied");
        let mut memory_stat = b"pgscan 16\n".to_vec();
        memory_stat.resize(size, b' ');
        assert_eq!(memory_stat.len(), size);
        fs::write(directory.path().join("memory.stat"), memory_stat).unwrap();

        let (handle, mut host) = start_with_resources(program, directory.path());
        send_request(&mut host, 506, 1000, RUN_ID, "/run", b"{}");
        let result = read_result(&mut host, 506);
        finish_guest_connection(handle, host);

        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
        assert_eq!(result.stdout, b"applied");
        assert!(result.diagnostic.is_empty());
        let summary = resource_summary(&result);
        assert_eq!(
            summary.get("memory_pgscan"),
            Some(&expected),
            "{size}-byte memory.stat"
        );
    }
}

#[test]
fn unavailable_resources_do_not_fail_storage_or_leak_request_text() {
    let (directory, program) = create_program("cat >/dev/null; exit 7");
    fs::write(directory.path().join("cpu.stat"), "usage_usec -1\nuser_usec 10\nuser_usec 11\nsystem_usec secret-value\nnr_periods 0\nthrottled_usec 18446744073709551616\n").unwrap();
    fs::write(
        directory.path().join("memory.events"),
        "high 0 extra\nmax 0\n",
    )
    .unwrap();
    fs::write(directory.path().join("memory.peak"), "secret-value").unwrap();
    fs::write(
        directory.path().join("memory.stat"),
        vec![b'x'; 16 * 1024 + 1],
    )
    .unwrap();
    fs::write(directory.path().join("cpu.max"), "190000 100000 extra").unwrap();
    let (handle, mut host) = start_with_resources(program, directory.path());
    send_request(
        &mut host,
        503,
        1000,
        "secret-run\nforged log",
        "/run",
        b"{}",
    );
    let result = read_result(&mut host, 503);
    let summary = resource_summary(&result);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host);

    for field in [
        "run_id",
        "cpu_usage_usec",
        "cpu_user_usec",
        "cpu_system_usec",
        "cpu_throttled_usec",
        "cpu_quota_us",
        "cpu_period_us",
        "memory_events_high",
        "memory_peak_bytes",
        "memory_current_bytes",
        "memory_pgscan",
        "pids_events_max",
    ] {
        assert_eq!(summary.get(field), Some(&Value::Null), "{field}");
    }
    assert_eq!(summary.get("cpu_nr_periods"), Some(&json!(0)));
    assert_eq!(summary.get("memory_events_max"), Some(&json!(0)));
    assert!(!summary.to_string().contains("secret"));
    assert!(!summary.to_string().contains("forged"));
}

#[test]
fn forced_storage_cleanup_retains_diagnostics_with_missing_kernel_files() {
    for disconnect in [false, true] {
        let pid_path = unique_pid_path("storage-resources-forced");
        let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
        let (directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
        fs::write(directory.path().join("cpu.max"), "max 100000\n").unwrap();
        let (handle, mut host, timeout_gate) =
            start_with_timeout_gate(program, Some(directory.path().to_owned()));
        send_request(
            &mut host,
            504,
            if disconnect { 60_000 } else { 20 },
            RUN_ID,
            "/run",
            b"{}",
        );
        let pid = process_guard.read_pid();
        assert_eq!(
            timeout_gate.recv_timeout(Duration::from_secs(3)).unwrap(),
            pid
        );
        let resources = if disconnect {
            drop(host);
            join_guest_connection(handle);
            None
        } else {
            let result = read_result(&mut host, 504);
            assert_eq!(result.termination, ExecTermination::TimedOut);
            let resources = resource_summary(&result);
            finish_guest_connection(handle, host);
            Some(resources)
        };
        wait_for_pid_exit(pid, "resource diagnostic cleanup");
        process_guard.disarm();
        if let Some(resources) = resources {
            assert_eq!(resources.get("cleanup_mode"), Some(&json!("Forced")));
            assert_eq!(resources.get("cpu_quota_us"), Some(&json!("max")));
            assert_eq!(resources.get("cpu_period_us"), Some(&json!(100_000)));
            assert_eq!(resources.get("memory_peak_bytes"), Some(&Value::Null));
            assert_eq!(resources.get("cpu_usage_usec"), Some(&Value::Null));
        }
    }
}

#[test]
fn storage_start_failure_retains_resource_evidence_without_changing_diagnostic() {
    let (directory, program) = create_program("exit 0");
    fs::remove_file(&program).unwrap();
    let (handle, mut host) = start_with_resources(program, directory.path());
    send_request(&mut host, 505, 1000, RUN_ID, "/run", b"{}");
    let result = read_result(&mut host, 505);
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(result.diagnostic.contains("Failed to start storage helper"));
    let resources = resource_summary(&result);
    assert_eq!(resources["cleanup_mode"], "Forced");
    assert_eq!(resources["request_seq"], 505);
    finish_guest_connection(handle, host);
}
