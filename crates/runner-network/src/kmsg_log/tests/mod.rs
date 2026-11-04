use super::*;
use crate::network_log_drain::NetworkLogDrainContext;
use runner_types::ids::RunId;
use tokio::io::AsyncWriteExt;

#[cfg(target_os = "linux")]
mod lifecycle {
    use std::sync::Arc;
    use std::time::Duration;

    use runner_host::process::read_process_stat;
    use tokio::task::AbortHandle;
    use tokio::time::timeout;

    use super::*;

    const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

    async fn running_kmsg() -> (KmsgHandle, AbortHandle, u32, u64) {
        let child = tokio::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let starttime = read_process_stat(pid).await.unwrap().starttime;
        let handle = KmsgHandle::from_test_child(child, NetworkLogManager::new()).unwrap();
        let stderr = handle.stderr_task.as_ref().unwrap().abort_handle();
        (handle, stderr, pid, starttime)
    }

    async fn assert_child_reaped(pid: u32, starttime: u64) {
        assert_ne!(
            read_process_stat(pid).await.map(|stat| stat.starttime),
            Some(starttime),
            "Kmsg child must be physically reaped"
        );
    }

    async fn wait_for_retirement(stderr: &AbortHandle, pid: u32, starttime: u64) {
        timeout(CLEANUP_TIMEOUT, async {
            while !stderr.is_finished()
                || read_process_stat(pid)
                    .await
                    .is_some_and(|stat| stat.starttime == starttime)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("diagnostic reader and real child must retire");
    }

    #[tokio::test]
    async fn stop_joins_stderr_reader_and_reaps_child() {
        let (handle, stderr, pid, starttime) = running_kmsg().await;

        timeout(CLEANUP_TIMEOUT, handle.stop())
            .await
            .unwrap()
            .unwrap();

        assert!(stderr.is_finished(), "stop must join diagnostic retirement");
        assert_child_reaped(pid, starttime).await;
    }

    #[tokio::test]
    async fn stop_joins_stderr_reader_after_required_monitor_failure() {
        let (mut handle, stderr, pid, starttime) = running_kmsg().await;
        let trigger = handle
            .process
            .replace_monitor_with_panic_trigger_for_test("kmsg")
            .await;
        let monitor_lifetime = Arc::downgrade(&trigger);
        trigger.notify_one();
        drop(trigger);
        // The existing panic fixture retains its trigger until its task
        // exits. Wait for that release before stop can cancel the monitor.
        timeout(CLEANUP_TIMEOUT, async {
            while monitor_lifetime.strong_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let error = timeout(CLEANUP_TIMEOUT, handle.stop())
            .await
            .unwrap()
            .unwrap_err();

        assert!(error.to_string().contains("dmesg monitor cleanup failed"));
        assert!(
            stderr.is_finished(),
            "required errors must not skip diagnostics"
        );
        assert_child_reaped(pid, starttime).await;
    }

    #[tokio::test]
    async fn drop_retires_stderr_reader_and_reaps_child() {
        let (handle, stderr, pid, starttime) = running_kmsg().await;

        drop(handle);

        wait_for_retirement(&stderr, pid, starttime).await;
    }

    #[tokio::test]
    async fn cancelled_stop_retires_stderr_without_aborting_child_reaper() {
        let (mut handle, stderr, pid, starttime) = running_kmsg().await;
        let gate = crate::test_fixtures::ReapGate::new();
        handle.set_reap_gate(gate.clone());
        let stop = tokio::spawn(handle.stop());
        timeout(CLEANUP_TIMEOUT, gate.entered.notified())
            .await
            .unwrap();

        stop.abort();
        assert!(stop.await.unwrap_err().is_cancelled());
        gate.release.add_permits(1);

        wait_for_retirement(&stderr, pid, starttime).await;
    }
}

#[tokio::test]
async fn command_configures_parent_death_signal() {
    let mut command = tokio::process::Command::new("/bin/true");
    configure_command(&mut command);

    // SAFETY: `prctl(PR_GET_PDEATHSIG)` is async-signal-safe. The hook
    // only reads the configured signal and returns fixed OS errors.
    unsafe {
        command.pre_exec(|| {
            let mut signal = 0;
            if nix::libc::prctl(nix::libc::PR_GET_PDEATHSIG, &mut signal) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if signal != nix::libc::SIGKILL {
                return Err(std::io::Error::from_raw_os_error(nix::libc::EPROTO));
            }
            Ok(())
        });
    }

    let status = command.status().await.unwrap();

    assert!(status.success());
}

#[test]
fn parse_udp_log_message() {
    let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 MAC=00:00:00:00:00:00 SRC=10.200.0.2 DST=8.8.8.8 LEN=64 TOS=0x00 PREC=0x00 TTL=64 ID=12345 PROTO=UDP SPT=45678 DPT=53";
    let entry = parse_log_message(msg).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.2");
    assert_eq!(entry.dst_ip, "8.8.8.8");
    assert_eq!(entry.dst_port, 53);
    assert_eq!(entry.protocol, "udp");
    assert_eq!(entry.packet_size, 64);
}

#[test]
fn parse_icmp_log_message() {
    let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=1.1.1.1 LEN=84 PROTO=ICMP TYPE=8 CODE=0";
    let entry = parse_log_message(msg).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.2");
    assert_eq!(entry.dst_ip, "1.1.1.1");
    assert_eq!(entry.dst_port, 0);
    assert_eq!(entry.protocol, "icmp");
    assert_eq!(entry.packet_size, 84);
}

#[test]
fn parse_dmesg_format_with_timestamp_prefix() {
    // dmesg -w prefixes lines with [seconds.microseconds]
    let msg = "[411967.804921] VM0:10.200.12.26:IN=vm0-ve-03-06 OUT=enP2p4s0 MAC=f6:59:f1:28:35:36:de:8b:c8:2e:7b:88:08:00 SRC=10.200.12.26 DST=8.8.8.8 LEN=63 TOS=0x00 PREC=0x00 TTL=125 ID=50938 DF PROTO=UDP SPT=44793 DPT=53 LEN=43";
    let entry = parse_log_message(msg).unwrap();
    assert_eq!(entry.source_ip, "10.200.12.26");
    assert_eq!(entry.dst_ip, "8.8.8.8");
    assert_eq!(entry.dst_port, 53);
    assert_eq!(entry.protocol, "udp");
    assert_eq!(entry.packet_size, 63);
}

#[test]
fn ignores_unrelated_message() {
    let msg = "audit: something happened";
    assert!(parse_log_message(msg).is_none());
}

#[test]
fn ignores_mismatched_src_ip() {
    // SRC field doesn't match the prefix IP — should be rejected
    let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.99 DST=8.8.8.8 LEN=64 PROTO=UDP SPT=1234 DPT=53";
    assert!(parse_log_message(msg).is_none());
}

#[test]
fn extract_field_works() {
    let fields = "SRC=10.0.0.1 DST=8.8.8.8 LEN=64 PROTO=UDP";
    assert_eq!(extract_field(fields, "SRC="), Some("10.0.0.1"));
    assert_eq!(extract_field(fields, "DST="), Some("8.8.8.8"));
    assert_eq!(extract_field(fields, "LEN="), Some("64"));
    assert_eq!(extract_field(fields, "PROTO="), Some("UDP"));
    assert_eq!(extract_field(fields, "DPT="), None);
}

#[test]
fn extract_field_last_field_no_trailing_space() {
    let fields = "SRC=10.0.0.1 PROTO=UDP";
    assert_eq!(extract_field(fields, "PROTO="), Some("UDP"));
}

#[test]
fn extract_field_no_substring_match() {
    // "XSRC=foo" should not match when searching for "SRC="
    let fields = "XSRC=foo SRC=10.0.0.1";
    assert_eq!(extract_field(fields, "SRC="), Some("10.0.0.1"));
}

#[test]
fn extract_field_returns_first_match_for_duplicate_key() {
    // dmesg iptables lines emit LEN= twice for UDP (outer packet then
    // inner UDP payload). We rely on first-wins to pick the outer length.
    let fields = "LEN=63 TOS=0x00 LEN=43";
    assert_eq!(extract_field(fields, "LEN="), Some("63"));
}

#[test]
fn parse_malformed_len_defaults_to_zero() {
    let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=abc PROTO=UDP SPT=1234 DPT=53";
    let entry = parse_log_message(msg).unwrap();
    assert_eq!(entry.packet_size, 0);
}

#[test]
fn parse_malformed_dpt_defaults_to_zero() {
    let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=64 PROTO=UDP SPT=1234 DPT=99999";
    let entry = parse_log_message(msg).unwrap();
    assert_eq!(entry.dst_port, 0); // u16 overflow → parse fails → default 0
}

#[test]
fn parse_missing_proto_returns_none() {
    let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=64";
    assert!(parse_log_message(msg).is_none());
}

#[test]
fn network_log_row_serializes_provided_timestamp() {
    // Locks the contract that row construction must use the provided
    // timestamp rather than calling `Utc::now()` internally.
    let entry = LogEntry {
        source_ip: "10.200.0.2".to_string(),
        dst_ip: "8.8.8.8".to_string(),
        dst_port: 53,
        protocol: "udp".to_string(),
        packet_size: 64,
    };
    let ts = DateTime::parse_from_rfc3339("2024-01-15T10:30:45.123Z")
        .unwrap()
        .with_timezone(&Utc);
    let parsed = network_log_row(&entry, ts);
    assert_eq!(parsed["timestamp"], "2024-01-15T10:30:45.123Z");
}

#[tokio::test]
async fn append_log_entry_registered_source_writes_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.jsonl");
    let manager = NetworkLogManager::new();
    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    let entry = LogEntry {
        source_ip: "10.200.0.2".to_string(),
        dst_ip: "8.8.8.8".to_string(),
        dst_port: 53,
        protocol: "udp".to_string(),
        packet_size: 64,
    };
    assert!(append_log_entry(&manager, &entry, Utc::now()).await);
    manager.flush_path(&path).await;
    let content = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
    assert_eq!(parsed["host"], "8.8.8.8");
    assert_eq!(parsed["port"], 53);
    assert_eq!(parsed["type"], "udp");
    assert_eq!(parsed["request_size"], 64);
    assert!(parsed.get("action").is_none());
    assert!(parsed["timestamp"].is_string());
}

#[test]
fn network_log_row_icmp_entry() {
    let entry = LogEntry {
        source_ip: "10.200.0.2".to_string(),
        dst_ip: "1.1.1.1".to_string(),
        dst_port: 0,
        protocol: "icmp".to_string(),
        packet_size: 84,
    };
    let parsed = network_log_row(&entry, Utc::now());
    assert_eq!(parsed["type"], "icmp");
    assert_eq!(parsed["port"], 0);
    assert_eq!(parsed["request_size"], 84);
}

#[tokio::test]
async fn append_log_entry_appends_multiple_entries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("multi.jsonl");
    let manager = NetworkLogManager::new();
    let _session = manager.register_source_ip("10.0.0.1", path.clone()).await;
    for dst in ["8.8.8.8", "1.1.1.1", "9.9.9.9"] {
        assert!(
            append_log_entry(
                &manager,
                &LogEntry {
                    source_ip: "10.0.0.1".to_string(),
                    dst_ip: dst.to_string(),
                    dst_port: 53,
                    protocol: "udp".to_string(),
                    packet_size: 64,
                },
                Utc::now(),
            )
            .await
        );
    }
    manager.flush_path(&path).await;
    let content = std::fs::read_to_string(&path).unwrap();
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 3);
    let hosts: std::collections::HashSet<String> = lines
        .iter()
        .map(|line| {
            let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
            parsed["host"].as_str().unwrap().to_string()
        })
        .collect();
    assert_eq!(
        hosts,
        ["8.8.8.8", "1.1.1.1", "9.9.9.9"]
            .into_iter()
            .map(str::to_string)
            .collect()
    );
}

#[tokio::test]
async fn append_log_entry_without_mapping_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ignored.jsonl");
    let manager = NetworkLogManager::new();

    assert!(
        !append_log_entry(
            &manager,
            &LogEntry {
                source_ip: "10.0.0.1".to_string(),
                dst_ip: "8.8.8.8".to_string(),
                dst_port: 53,
                protocol: "udp".to_string(),
                packet_size: 64,
            },
            Utc::now(),
        )
        .await
    );
    manager.flush_path(&path).await;
    assert!(!path.exists());
}

#[tokio::test]
async fn drain_barrier_processes_queued_kmsg_line_before_ack() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("kmsg.jsonl");
    let manager = NetworkLogManager::new();
    let _session = manager.register_source_ip("10.0.0.1", path.clone()).await;
    let cancel = CancellationToken::new();
    let (producer, drain_rx) = NetworkLogDrainProducer::channel("kmsg-test");
    let (mut writer, reader) = tokio::io::duplex(1024);
    let task = tokio::spawn(run_reader(
        manager.clone(),
        cancel.clone(),
        tokio::io::BufReader::new(reader),
        drain_rx,
    ));

    writer
            .write_all(
                b"[12345.678901] VM0:10.0.0.1:IN=vm0-ve OUT=ens5 SRC=10.0.0.1 DST=8.8.8.8 LEN=64 PROTO=UDP SPT=45678 DPT=53\n",
            )
            .await
            .unwrap();

    producer
        .drain(
            NetworkLogDrainContext {
                run_id: RunId::from(uuid::Uuid::nil()),
                source_ip: "10.0.0.1",
                path: &path,
                generation: 1,
            },
            std::time::Duration::from_secs(1),
        )
        .await;
    manager.flush_path(&path).await;

    let content = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
    assert_eq!(parsed["type"], "udp");
    assert_eq!(parsed["host"], "8.8.8.8");
    assert_eq!(parsed["port"], 53);

    cancel.cancel();
    drop(writer);
    task.await.unwrap();
}

#[test]
fn extract_field_at_start_of_line() {
    let fields = "SRC=10.0.0.1 DST=8.8.8.8";
    assert_eq!(extract_field(fields, "SRC="), Some("10.0.0.1"));
}

#[test]
fn extract_field_missing_key() {
    let fields = "SRC=10.0.0.1 DST=8.8.8.8";
    assert_eq!(extract_field(fields, "PROTO="), None);
}

#[test]
fn extract_field_empty_value() {
    let fields = "KEY= NEXT=val";
    assert_eq!(extract_field(fields, "KEY="), Some(""));
}

#[test]
fn parse_log_empty_string() {
    assert!(parse_log_message("").is_none());
}

#[test]
fn parse_log_prefix_only() {
    assert!(parse_log_message("VM0:").is_none());
}

#[test]
fn parse_log_missing_fields() {
    // Has prefix and IP but missing DST/LEN/PROTO
    let msg = "VM0:10.200.0.2:IN=eth0 SRC=10.200.0.2";
    assert!(parse_log_message(msg).is_none());
}
