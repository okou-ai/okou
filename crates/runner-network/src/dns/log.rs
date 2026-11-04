use std::borrow::Cow;
use std::io::SeekFrom;
use std::path::Path;

use chrono::{DateTime, Utc};
use guest_contracts::dns_readiness::DNS_READINESS_HOSTNAME;
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
mod tests;
