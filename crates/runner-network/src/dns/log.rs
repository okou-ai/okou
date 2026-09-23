use std::borrow::Cow;
use std::io::SeekFrom;
use std::path::Path;

use chrono::{DateTime, Utc};
use sandbox_firecracker::DNS_READINESS_HOSTNAME;
use tokio::io::{AsyncBufRead, AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::network_log_drain::{
    DrainableLineReaderExit, NetworkLogDrainRequest, run_drainable_line_reader,
};
use crate::network_log_manager::NetworkLogManager;

const DNS_READINESS_LOG_SCAN_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// The outcome of inspecting the network-log segment for one DNS readiness attempt.
///
/// The status describes the quality and completeness of the bytes that were readable; it does
/// not turn either observation flag into proof that the corresponding event did or did not occur
/// elsewhere.
///
/// `as_str` exposes these variants as `complete`, `truncated`, `invalid_offset`, `malformed`, and
/// `unavailable` for the structured `scan_status` warning field.
pub enum DnsReadinessLogScanStatus {
    /// The file was missing, or the complete attempt segment was readable within the scan bound
    /// and contained no malformed non-whitespace rows.
    Complete,
    /// The attempt segment was larger than 64 KiB, so only its first 64 KiB were inspected.
    ///
    /// This status takes precedence over [`Self::Malformed`] when the inspected prefix also
    /// contains malformed rows. The observation flags can still be true for matching rows found
    /// in that prefix.
    Truncated,
    /// The file was shorter than the attempt-local offset captured before sandbox start.
    InvalidOffset,
    /// At least one non-whitespace row in an otherwise bounded readable segment was not valid
    /// JSON. Valid rows in the same segment still contribute to the observation flags.
    Malformed,
    /// The file could not be opened or inspected because of an I/O failure, or the caller could
    /// not provide an attempt-local offset.
    Unavailable,
}

impl DnsReadinessLogScanStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Truncated => "truncated",
            Self::InvalidOffset => "invalid_offset",
            Self::Malformed => "malformed",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Evidence found while inspecting one attempt-local portion of the DNS network log.
///
/// The flags describe only the readable segment passed to
/// `inspect_readiness_log_segment`. A `false` flag means that the corresponding evidence was not
/// observed in that bounded segment; it is not proof of absence from the full log, from an
/// unreadable portion of the file, or from the DNS request path.
pub struct DnsReadinessLogObservation {
    /// Whether a `type = "dns"` row for `DNS_READINESS_HOSTNAME` with `dns_event = "query"` was
    /// observed in the inspected segment.
    pub query_observed: bool,
    /// Whether a matching row with `dns_event = "reply"`, `"cached"`, or `"config"` was observed
    /// in the inspected segment.
    pub result_observed: bool,
    /// Describes whether the inspected segment was complete, truncated, malformed, invalidly
    /// offset, or unavailable.
    pub status: DnsReadinessLogScanStatus,
}

impl DnsReadinessLogObservation {
    /// Return an observation for a segment that could not be inspected.
    ///
    /// Both event flags are false because no evidence was readable, and callers must interpret
    /// them together with the `Unavailable` status rather than as evidence that no DNS event
    /// occurred.
    pub fn unavailable() -> Self {
        Self {
            query_observed: false,
            result_observed: false,
            status: DnsReadinessLogScanStatus::Unavailable,
        }
    }
}

/// Tail dnsmasq stderr and write DNS log entries to per-sandbox network JSONL.
///
/// dnsmasq `--log-queries=extra --log-facility=-` outputs lines like:
/// ```text
/// dnsmasq[1234]: 42 10.200.0.2/54321 query[A] api.github.com from 10.200.0.2
/// dnsmasq[1234]: 42 10.200.0.2/54321 forwarded api.github.com to 8.8.8.8
/// dnsmasq[1234]: 42 10.200.0.2/54321 reply api.github.com is 140.82.121.4
/// ```
///
/// We parse query and answer/result lines. `forwarded` lines are intentionally
/// not emitted as network-log rows because they describe resolver selection,
/// not a sandbox-visible DNS result.
pub(super) async fn tail_stderr(
    stderr: tokio::process::ChildStderr,
    network_log_manager: NetworkLogManager,
    cancel: CancellationToken,
    drain_rx: mpsc::Receiver<NetworkLogDrainRequest>,
) -> DrainableLineReaderExit {
    tail_reader(
        tokio::io::BufReader::new(stderr),
        network_log_manager,
        cancel,
        drain_rx,
    )
    .await
}

async fn tail_reader<R>(
    reader: R,
    network_log_manager: NetworkLogManager,
    cancel: CancellationToken,
    drain_rx: mpsc::Receiver<NetworkLogDrainRequest>,
) -> DrainableLineReaderExit
where
    R: AsyncBufRead + Unpin,
{
    run_drainable_line_reader(reader, cancel, drain_rx, move |line| {
        let network_log_manager = network_log_manager.clone();
        async move {
            handle_dns_line(&network_log_manager, &line).await;
        }
    })
    .await
}

async fn handle_dns_line(network_log_manager: &NetworkLogManager, line: &str) {
    if let Some(entry) = parse_dns_line(line) {
        // Capture the timestamp before handing the row to the manager so
        // it reflects DNS observation time, not delayed write time.
        let timestamp = Utc::now();
        append_dns_entry(network_log_manager, &entry, timestamp).await;
    }
}

/// Inspect the network-log segment attributable to one sandbox-start attempt.
///
/// The production caller captures `start_offset` from the network-log file before starting the
/// sandbox. After a start failure, it drains and closes the network-log session with
/// `NetworkLogSession::close_for_upload` and then calls this function, so inspection covers the
/// bytes from that attempt-local offset through the file length observed at inspection time.
///
/// At most the first 64 KiB of the attempt segment are read. Only valid JSON rows whose `type`
/// is `"dns"` and whose `host` is `DNS_READINESS_HOSTNAME` contribute evidence. A `dns_event` of
/// `"query"` sets `query_observed`; `"reply"`, `"cached"`, and `"config"` set
/// `result_observed`. Other valid rows and whitespace-only lines are ignored. A malformed
/// non-whitespace row is recorded without stopping the scan, so valid observations from other
/// rows remain available.
///
/// A missing file returns `Complete` with both flags false. A file shorter than `start_offset`
/// returns `InvalidOffset` with both flags false. Other open, metadata, seek, or read failures
/// return `Unavailable` with both flags false. For a readable segment, `Truncated` takes
/// precedence over `Malformed`; an otherwise valid segment returns `Complete`.
///
/// The returned flags describe only the readable bounded segment. In particular, `false` means
/// that evidence was not observed there, not that it is absent from the full attempt or from an
/// unavailable part of the path. The executor uses this result for diagnostics only; it does not
/// change the original sandbox error, cleanup result, or retry decision.
pub async fn inspect_readiness_log_segment(
    path: &Path,
    start_offset: u64,
) -> DnsReadinessLogObservation {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DnsReadinessLogObservation {
                query_observed: false,
                result_observed: false,
                status: DnsReadinessLogScanStatus::Complete,
            };
        }
        Err(_) => return DnsReadinessLogObservation::unavailable(),
    };
    let file_len = match file.metadata().await {
        Ok(metadata) => metadata.len(),
        Err(_) => return DnsReadinessLogObservation::unavailable(),
    };
    if file_len < start_offset {
        return DnsReadinessLogObservation {
            query_observed: false,
            result_observed: false,
            status: DnsReadinessLogScanStatus::InvalidOffset,
        };
    }
    if file.seek(SeekFrom::Start(start_offset)).await.is_err() {
        return DnsReadinessLogObservation::unavailable();
    }

    let segment_len = file_len - start_offset;
    let scan_len = segment_len.min(DNS_READINESS_LOG_SCAN_MAX_BYTES);
    let mut bytes = Vec::new();
    if file.take(scan_len).read_to_end(&mut bytes).await.is_err() {
        return DnsReadinessLogObservation::unavailable();
    }

    let mut query_observed = false;
    let mut result_observed = false;
    let mut malformed = false;
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(row) = serde_json::from_slice::<serde_json::Value>(line) else {
            malformed = true;
            continue;
        };
        if row.get("type").and_then(serde_json::Value::as_str) != Some("dns")
            || row.get("host").and_then(serde_json::Value::as_str) != Some(DNS_READINESS_HOSTNAME)
        {
            continue;
        }
        match row.get("dns_event").and_then(serde_json::Value::as_str) {
            Some("query") => query_observed = true,
            Some("reply" | "cached" | "config") => result_observed = true,
            _ => {}
        }
    }

    let status = if segment_len > DNS_READINESS_LOG_SCAN_MAX_BYTES {
        DnsReadinessLogScanStatus::Truncated
    } else if malformed {
        DnsReadinessLogScanStatus::Malformed
    } else {
        DnsReadinessLogScanStatus::Complete
    };
    DnsReadinessLogObservation {
        query_observed,
        result_observed,
        status,
    }
}

/// Parsed DNS log entry.
struct DnsLogEntry<'a> {
    source_ip: &'a str,
    domain: &'a str,
    serial: &'a str,
    event: DnsEvent<'a>,
}

enum DnsEvent<'a> {
    Query {
        query_type: &'a str,
    },
    Result {
        kind: DnsResultKind,
        result: Cow<'a, str>,
    },
}

impl DnsEvent<'_> {
    fn name(&self) -> &'static str {
        match self {
            Self::Query { .. } => "query",
            Self::Result { kind, .. } => kind.name(),
        }
    }
}

enum DnsResultKind {
    Reply,
    Cached,
    Config,
}

impl DnsResultKind {
    fn parse(token: &str) -> Option<Self> {
        match token {
            "reply" => Some(Self::Reply),
            "cached" => Some(Self::Cached),
            "config" => Some(Self::Config),
            _ => None,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::Cached => "cached",
            Self::Config => "config",
        }
    }
}

/// Parse a dnsmasq DNS log line.
///
/// Matches dnsmasq `--log-queries=extra` output:
///
/// - `dnsmasq[PID]: SERIAL IP/PORT query[TYPE] DOMAIN from IP`
/// - `dnsmasq[PID]: SERIAL IP/PORT reply DOMAIN is RESULT`
/// - `dnsmasq[PID]: SERIAL IP/PORT cached DOMAIN is RESULT`
/// - `dnsmasq[PID]: SERIAL IP/PORT config DOMAIN is RESULT`
fn parse_dns_line(line: &str) -> Option<DnsLogEntry<'_>> {
    let mut tokens = line.split_whitespace();
    let mut prev_prev = None;
    let mut prev = None;

    while let Some(token) = tokens.next() {
        if token.starts_with("query[")
            && let Some(entry) = parse_extra_query(prev_prev, prev, token, tokens.clone())
        {
            return Some(entry);
        }
        if matches!(token, "reply" | "cached" | "config")
            && let Some(entry) = parse_extra_result(prev_prev, prev, token, tokens.clone())
        {
            return Some(entry);
        }
        prev_prev = prev;
        prev = Some(token);
    }
    None
}

fn parse_extra_query<'a>(
    serial: Option<&'a str>,
    requestor: Option<&'a str>,
    token: &'a str,
    mut tokens: std::str::SplitWhitespace<'a>,
) -> Option<DnsLogEntry<'a>> {
    let (serial, source_ip) = parse_extra_prefix(serial, requestor)?;
    let query_type = parse_query_type(token)?;
    let domain = tokens.next()?;
    if tokens.next()? != "from" {
        return None;
    }
    extract_ipv4_requestor(tokens.next()?)?;
    Some(DnsLogEntry {
        source_ip,
        domain,
        serial,
        event: DnsEvent::Query { query_type },
    })
}

fn parse_extra_result<'a>(
    serial: Option<&'a str>,
    requestor: Option<&'a str>,
    token: &'a str,
    mut tokens: std::str::SplitWhitespace<'a>,
) -> Option<DnsLogEntry<'a>> {
    let (serial, source_ip) = parse_extra_prefix(serial, requestor)?;
    let kind = DnsResultKind::parse(token)?;
    let domain = tokens.next()?;
    if tokens.next()? != "is" {
        return None;
    }
    let first_result = tokens.next()?;
    let result = if tokens.clone().next().is_none() {
        Cow::Borrowed(first_result)
    } else {
        let mut result = first_result.to_string();
        for token in tokens {
            result.push(' ');
            result.push_str(token);
        }
        Cow::Owned(result)
    };
    Some(DnsLogEntry {
        source_ip,
        domain,
        serial,
        event: DnsEvent::Result { kind, result },
    })
}

fn parse_extra_prefix<'a>(
    serial: Option<&'a str>,
    requestor: Option<&'a str>,
) -> Option<(&'a str, &'a str)> {
    let serial = serial?;
    if serial.is_empty() || !serial.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let source_ip = extract_ipv4_requestor(requestor?)?;
    Some((serial, source_ip))
}

fn parse_query_type(token: &str) -> Option<&str> {
    let start = token.find('[')? + 1;
    let end = token[start..].find(']')? + start;
    let query_type = &token[start..end];
    if query_type.is_empty() {
        return None;
    }
    Some(query_type)
}

fn extract_ipv4_requestor(token: &str) -> Option<&str> {
    let ip = token.split(['/', '#']).next()?;
    if ip.parse::<std::net::Ipv4Addr>().is_ok() {
        Some(ip)
    } else {
        None
    }
}

async fn append_dns_entry(
    network_log_manager: &NetworkLogManager,
    entry: &DnsLogEntry<'_>,
    timestamp: DateTime<Utc>,
) -> bool {
    network_log_manager
        .append_for_ip(entry.source_ip, network_log_row(entry, timestamp))
        .await
}

fn network_log_row(entry: &DnsLogEntry<'_>, timestamp: DateTime<Utc>) -> serde_json::Value {
    // [NETWORK_LOG_FIELDS] — shared schema consumed by api-contracts.
    let mut json = serde_json::json!({
        "timestamp": timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "type": "dns",
        "host": entry.domain,
        "port": 53,
    });
    if let Some(object) = json.as_object_mut() {
        object.insert(
            "dns_event".to_string(),
            serde_json::Value::String(entry.event.name().to_string()),
        );
        match &entry.event {
            DnsEvent::Query { query_type } => {
                object.insert(
                    "dns_query_type".to_string(),
                    serde_json::Value::String((*query_type).to_string()),
                );
            }
            DnsEvent::Result { result, .. } => {
                object.insert(
                    "dns_result".to_string(),
                    serde_json::Value::String(result.to_string()),
                );
            }
        }
        object.insert(
            "dns_serial".to_string(),
            serde_json::Value::String(entry.serial.to_string()),
        );
    }

    json
}

#[cfg(test)]
mod tests {
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
        let line =
            "dnsmasq[1234]: 42 10.200.0.2/54321 reply example.com is <CNAME> target.example.com";
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
            parse_dns_line("dnsmasq[1]: abc 10.200.0.2/54321 reply example.com is 1.2.3.4")
                .is_none()
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
}
