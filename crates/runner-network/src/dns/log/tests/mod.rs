use super::*;

use crate::network_log_drain::{NetworkLogDrainContext, NetworkLogDrainProducer};
use runner_types::ids::RunId;
use tokio::io::AsyncWriteExt;

fn assert_query_event(entry: &DnsLogEntry<'_>, expected_query_type: &str) {
    assert_eq!(entry.event.name(), "query");
    match &entry.event {
        DnsEvent::Query { query_type } => assert_eq!(*query_type, expected_query_type),
        DnsEvent::Result { .. } => panic!("expected query event"),
    }
}

fn assert_result_event(entry: &DnsLogEntry<'_>, expected_kind: &str, expected_result: &str) {
    assert_eq!(entry.event.name(), expected_kind);
    match &entry.event {
        DnsEvent::Result { result, .. } => assert_eq!(result.as_ref(), expected_result),
        DnsEvent::Query { .. } => panic!("expected result event"),
    }
}

fn readiness_log_row(host: &str, event: &str) -> String {
    serde_json::json!({
        "type": "dns",
        "host": host,
        "dns_event": event,
    })
    .to_string()
}

#[tokio::test]
async fn readiness_log_inspection_observes_current_attempt_query_and_result() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let old_row = readiness_log_row(DNS_READINESS_HOSTNAME, "query");
    tokio::fs::write(&path, format!("{old_row}\n"))
        .await
        .unwrap();
    let start_offset = tokio::fs::metadata(&path).await.unwrap().len();
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .await
        .unwrap();
    let current_rows = [
        readiness_log_row("unrelated.example", "query"),
        readiness_log_row(DNS_READINESS_HOSTNAME, "query"),
        readiness_log_row(DNS_READINESS_HOSTNAME, "config"),
    ]
    .join("\n");
    file.write_all(format!("{current_rows}\n").as_bytes())
        .await
        .unwrap();
    file.flush().await.unwrap();

    let observation = inspect_readiness_log_segment(&path, start_offset).await;

    assert!(observation.query_observed);
    assert!(observation.result_observed);
    assert_eq!(observation.status, DnsReadinessLogScanStatus::Complete);
}

#[tokio::test]
async fn readiness_log_inspection_ignores_previous_attempt_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let old_rows = [
        readiness_log_row(DNS_READINESS_HOSTNAME, "query"),
        readiness_log_row(DNS_READINESS_HOSTNAME, "config"),
    ]
    .join("\n");
    tokio::fs::write(&path, format!("{old_rows}\n"))
        .await
        .unwrap();
    let start_offset = tokio::fs::metadata(&path).await.unwrap().len();
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .await
        .unwrap();
    file.write_all(b"{}\n").await.unwrap();
    file.flush().await.unwrap();

    let observation = inspect_readiness_log_segment(&path, start_offset).await;

    assert!(!observation.query_observed);
    assert!(!observation.result_observed);
    assert_eq!(observation.status, DnsReadinessLogScanStatus::Complete);
}

#[tokio::test]
async fn readiness_log_inspection_ignores_unrelated_hostname_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let rows = [
        readiness_log_row("unrelated.example", "query"),
        readiness_log_row("unrelated.example", "config"),
    ]
    .join("\n");
    tokio::fs::write(&path, format!("{rows}\n")).await.unwrap();

    let observation = inspect_readiness_log_segment(&path, 0).await;

    assert!(!observation.query_observed);
    assert!(!observation.result_observed);
    assert_eq!(observation.status, DnsReadinessLogScanStatus::Complete);
}

#[tokio::test]
async fn readiness_log_inspection_ignores_non_dns_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let rows = ["query", "config"].map(|event| {
        serde_json::json!({
            "type": "http",
            "host": DNS_READINESS_HOSTNAME,
            "dns_event": event,
        })
        .to_string()
    });
    tokio::fs::write(&path, format!("{}\n", rows.join("\n")))
        .await
        .unwrap();

    let observation = inspect_readiness_log_segment(&path, 0).await;

    assert!(!observation.query_observed);
    assert!(!observation.result_observed);
    assert_eq!(observation.status, DnsReadinessLogScanStatus::Complete);
}

#[tokio::test]
async fn readiness_log_inspection_reports_missing_file_as_complete() {
    let dir = tempfile::tempdir().unwrap();
    let observation = inspect_readiness_log_segment(&dir.path().join("missing.jsonl"), 0).await;

    assert!(!observation.query_observed);
    assert!(!observation.result_observed);
    assert_eq!(observation.status, DnsReadinessLogScanStatus::Complete);
}

#[tokio::test]
async fn readiness_log_inspection_reports_invalid_offset() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    tokio::fs::write(&path, b"{}\n").await.unwrap();

    let observation = inspect_readiness_log_segment(&path, 4).await;

    assert!(!observation.query_observed);
    assert!(!observation.result_observed);
    assert_eq!(observation.status, DnsReadinessLogScanStatus::InvalidOffset);
}

#[tokio::test]
async fn readiness_log_inspection_bounds_large_attempt_segment() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.jsonl");
    let query = readiness_log_row(DNS_READINESS_HOSTNAME, "query");
    let padding_len = usize::try_from(DNS_READINESS_LOG_SCAN_MAX_BYTES).unwrap() + 1;
    let mut content = format!("{query}\n").into_bytes();
    content.extend(std::iter::repeat_n(b' ', padding_len));
    tokio::fs::write(&path, content).await.unwrap();

    let observation = inspect_readiness_log_segment(&path, 0).await;

    assert!(observation.query_observed);
    assert!(!observation.result_observed);
    assert_eq!(observation.status, DnsReadinessLogScanStatus::Truncated);
}

#[test]
fn parse_extra_query_with_serial_and_requestor() {
    let line = "dnsmasq[1234]: 42 10.200.0.2/54321 query[A] api.github.com from 10.200.0.2";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.2");
    assert_eq!(entry.domain, "api.github.com");
    assert_query_event(&entry, "A");
    assert_eq!(entry.serial, "42");
}

#[test]
fn parse_extra_query_with_hash_port_requestor() {
    let line = "dnsmasq[1234]: 42 10.200.0.2#54321 query[A] api.github.com from 10.200.0.2";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.2");
    assert_eq!(entry.domain, "api.github.com");
    assert_eq!(entry.serial, "42");
}

#[test]
fn parse_extra_query_with_syslog_prefix() {
    let line = "Apr 28 12:00:00 runner dnsmasq[1234]: 314 10.200.0.9/41234 query[AAAA] google.com from 10.200.0.9";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.9");
    assert_eq!(entry.domain, "google.com");
    assert_query_event(&entry, "AAAA");
    assert_eq!(entry.serial, "314");
}

#[test]
fn parse_dns_line_skips_unrelated_prefix_tokens() {
    let line = "Apr 28 config runner reply dnsmasq[1234]: 314 10.200.0.9/41234 query[AAAA] google.com from 10.200.0.9";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.9");
    assert_eq!(entry.domain, "google.com");
    assert_query_event(&entry, "AAAA");
    assert_eq!(entry.serial, "314");
}

#[test]
fn parse_dns_line_continues_after_failed_lookahead_candidate() {
    let line = "dnsmasq[1234]: 1 10.200.0.2/54321 reply 314 10.200.0.9/41234 query[AAAA] google.com from 10.200.0.9";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.9");
    assert_eq!(entry.domain, "google.com");
    assert_query_event(&entry, "AAAA");
    assert_eq!(entry.serial, "314");
}

#[test]
fn parse_dns_line_continues_after_failed_query_lookahead_candidate() {
    let line = "dnsmasq[1234]: 1 10.200.0.2/54321 query[A] 314 10.200.0.9/41234 reply api.github.com is 140.82.121.4";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.9");
    assert_eq!(entry.domain, "api.github.com");
    assert_result_event(&entry, "reply", "140.82.121.4");
    assert_eq!(entry.serial, "314");
}

#[test]
fn parse_extra_reply_result() {
    let line = "dnsmasq[1234]: 42 10.200.0.2/54321 reply api.github.com is 140.82.121.4";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.source_ip, "10.200.0.2");
    assert_eq!(entry.domain, "api.github.com");
    assert_result_event(&entry, "reply", "140.82.121.4");
    assert_eq!(entry.serial, "42");
}

#[test]
fn parse_extra_cached_result() {
    let line = "dnsmasq[1234]: 42 10.200.0.2/54321 cached api.github.com is 140.82.121.4";
    let entry = parse_dns_line(line).unwrap();
    assert_result_event(&entry, "cached", "140.82.121.4");
}

#[test]
fn parse_extra_config_result() {
    let line =
        "dnsmasq[1234]: 42 10.200.0.2/54321 config metadata.google.internal is 169.254.169.254";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.domain, "metadata.google.internal");
    assert_result_event(&entry, "config", "169.254.169.254");
}

#[test]
fn parse_extra_negative_result() {
    let line = "dnsmasq[1234]: 42 10.200.0.2/54321 reply missing.example.com is NXDOMAIN";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.domain, "missing.example.com");
    assert_result_event(&entry, "reply", "NXDOMAIN");
}

#[test]
fn parse_extra_result_preserves_multi_token_result() {
    let line = "dnsmasq[1234]: 42 10.200.0.2/54321 reply example.com is <CNAME> target.example.com";
    let entry = parse_dns_line(line).unwrap();
    assert_result_event(&entry, "reply", "<CNAME> target.example.com");
}

#[test]
fn parse_extra_result_with_trailing_carriage_return() {
    let line = "dnsmasq[1234]: 42 10.200.0.2/54321 reply example.com is 1.2.3.4\r";
    let entry = parse_dns_line(line).unwrap();
    assert_result_event(&entry, "reply", "1.2.3.4");
}

#[test]
fn ignore_plain_log_queries_without_extra_metadata() {
    let line = "dnsmasq[1234]: query[A] example.com from 10.200.0.2";
    assert!(parse_dns_line(line).is_none());
}

#[test]
fn ignore_plain_reply_lines_without_extra_metadata() {
    let line = "dnsmasq[1234]: reply example.com is 93.184.216.34";
    assert!(parse_dns_line(line).is_none());
}

#[test]
fn ignore_forwarded_lines() {
    let extra = "dnsmasq[1234]: 42 10.200.0.2/54321 forwarded example.com to 8.8.8.8";
    assert!(parse_dns_line(extra).is_none());
}

#[test]
fn ignore_malformed() {
    assert!(parse_dns_line("").is_none());
    assert!(parse_dns_line("not a dns log").is_none());
    assert!(parse_dns_line("dnsmasq[1]: query[A]").is_none());
    assert!(parse_dns_line("dnsmasq[1]: 42 10.200.0.2/54321 query[A]").is_none());
    assert!(parse_dns_line("dnsmasq[1]: 42 10.200.0.2/54321 reply example.com").is_none());
    assert!(
        parse_dns_line("dnsmasq[1]: abc 10.200.0.2/54321 reply example.com is 1.2.3.4").is_none()
    );
}

#[test]
fn parse_extra_domain_containing_from() {
    let line = "dnsmasq[1234]: 42 10.200.0.2/54321 query[A] from.example.com from 10.200.0.2";
    let entry = parse_dns_line(line).unwrap();
    assert_eq!(entry.domain, "from.example.com");
    assert_eq!(entry.source_ip, "10.200.0.2");
}

#[test]
fn ignore_ipv6_source() {
    // VMs use IPv4 only; IPv6 sources should be ignored.
    let extra = "dnsmasq[1234]: 42 ::1/54321 reply example.com is 93.184.216.34";
    assert!(parse_dns_line(extra).is_none());
}

#[test]
fn network_log_row_serializes_provided_timestamp() {
    // Locks the contract that row construction must use the provided
    // timestamp rather than calling `Utc::now()` internally.
    let entry = DnsLogEntry {
        source_ip: "10.200.0.2",
        domain: "example.com",
        serial: "42",
        event: DnsEvent::Query { query_type: "A" },
    };
    let ts = DateTime::parse_from_rfc3339("2024-01-15T10:30:45.123Z")
        .unwrap()
        .with_timezone(&Utc);
    let parsed = network_log_row(&entry, ts);
    assert_eq!(parsed["timestamp"], "2024-01-15T10:30:45.123Z");
}

#[test]
fn network_log_row_serializes_query_fields() {
    let entry = DnsLogEntry {
        source_ip: "10.200.0.2",
        domain: "example.com",
        serial: "42",
        event: DnsEvent::Query { query_type: "AAAA" },
    };

    let parsed = network_log_row(&entry, Utc::now());

    assert_eq!(parsed["type"], "dns");
    assert_eq!(parsed["host"], "example.com");
    assert_eq!(parsed["port"], 53);
    assert_eq!(parsed["dns_event"], "query");
    assert_eq!(parsed["dns_query_type"], "AAAA");
    assert_eq!(parsed["dns_serial"], "42");
    assert_eq!(parsed.get("dns_result"), None);
}

#[tokio::test]
async fn append_dns_entry_registered_source_writes_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dns.jsonl");
    let manager = NetworkLogManager::new();
    let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
    let entry = DnsLogEntry {
        source_ip: "10.200.0.2",
        domain: "api.github.com",
        serial: "42",
        event: DnsEvent::Result {
            kind: DnsResultKind::Reply,
            result: Cow::Borrowed("140.82.121.4"),
        },
    };
    assert!(append_dns_entry(&manager, &entry, Utc::now()).await);
    manager.flush_path(&path).await;
    let content = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
    assert_eq!(parsed["type"], "dns");
    assert_eq!(parsed["host"], "api.github.com");
    assert_eq!(parsed["port"], 53);
    assert_eq!(parsed["dns_event"], "reply");
    assert_eq!(parsed["dns_result"], "140.82.121.4");
    assert_eq!(parsed["dns_serial"], "42");
    assert_eq!(parsed.get("dns_query_type"), None);
    assert!(parsed["timestamp"].is_string());
}

#[tokio::test]
async fn append_dns_entry_appends_multiple_entries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dns.jsonl");
    let manager = NetworkLogManager::new();
    let _session = manager.register_source_ip("10.0.0.1", path.clone()).await;
    for domain in ["a.com", "b.com", "c.com"] {
        assert!(
            append_dns_entry(
                &manager,
                &DnsLogEntry {
                    source_ip: "10.0.0.1",
                    domain,
                    serial: "42",
                    event: DnsEvent::Result {
                        kind: DnsResultKind::Reply,
                        result: Cow::Borrowed("1.2.3.4"),
                    },
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
        ["a.com", "b.com", "c.com"]
            .into_iter()
            .map(str::to_string)
            .collect()
    );
}

#[tokio::test]
async fn append_dns_entry_preserves_multiple_answers_for_same_query() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dns.jsonl");
    let manager = NetworkLogManager::new();
    let _session = manager.register_source_ip("10.0.0.1", path.clone()).await;

    for result in ["140.82.121.3", "140.82.121.4"] {
        assert!(
            append_dns_entry(
                &manager,
                &DnsLogEntry {
                    source_ip: "10.0.0.1",
                    domain: "api.github.com",
                    serial: "42",
                    event: DnsEvent::Result {
                        kind: DnsResultKind::Reply,
                        result: Cow::Borrowed(result),
                    },
                },
                Utc::now(),
            )
            .await
        );
    }

    manager.flush_path(&path).await;
    let content = std::fs::read_to_string(&path).unwrap();
    let mut results: Vec<String> = content
        .lines()
        .map(|line| {
            let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(parsed["host"], "api.github.com");
            assert_eq!(parsed["dns_event"], "reply");
            assert_eq!(parsed["dns_serial"], "42");
            parsed["dns_result"].as_str().unwrap().to_string()
        })
        .collect();
    results.sort();
    assert_eq!(results, ["140.82.121.3", "140.82.121.4"]);
}

#[tokio::test]
async fn append_dns_entry_without_mapping_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ignored.jsonl");
    let manager = NetworkLogManager::new();

    assert!(
        !append_dns_entry(
            &manager,
            &DnsLogEntry {
                source_ip: "10.0.0.1",
                domain: "ignored.test",
                serial: "42",
                event: DnsEvent::Query { query_type: "A" },
            },
            Utc::now(),
        )
        .await
    );
    manager.flush_path(&path).await;
    assert!(!path.exists());
}

#[tokio::test]
async fn drain_barrier_processes_queued_dns_line_before_ack() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dns.jsonl");
    let manager = NetworkLogManager::new();
    let _session = manager.register_source_ip("10.0.0.1", path.clone()).await;
    let cancel = CancellationToken::new();
    let (producer, drain_rx) = NetworkLogDrainProducer::channel("dns-test");
    let (mut writer, reader) = tokio::io::duplex(1024);
    let mut task = tokio::spawn(tail_reader(
        tokio::io::BufReader::new(reader),
        manager.clone(),
        cancel.clone(),
        drain_rx,
    ));

    writer
        .write_all(b"dnsmasq[1234]: 42 10.0.0.1/54321 query[A] example.com from 10.0.0.1\n")
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
    assert_eq!(parsed["type"], "dns");
    assert_eq!(parsed["host"], "example.com");
    assert_eq!(parsed["dns_event"], "query");

    cancel.cancel();
    let exit = match tokio::time::timeout(std::time::Duration::from_secs(1), &mut task).await {
        Ok(result) => result.unwrap(),
        Err(_) => {
            task.abort();
            let _ = task.await;
            panic!("timed out waiting for DNS tail reader cancellation");
        }
    };
    assert!(matches!(exit, DrainableLineReaderExit::Cancelled));
    drop(writer);
}
