//! Bounded, metadata-only evidence for one Guest containment lifecycle.

mod containment;

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

/// Maximum encoded evidence response, including all retained incidents.
pub const MAX_EVIDENCE_BYTES: usize = 48 * 1024;
/// Maximum retained incidents in an operation (additional incidents are counted).
pub const MAX_INCIDENTS: usize = 4;
/// Maximum kernel records retained in one incident.
pub const MAX_KERNEL_EVENTS: usize = 4;
/// Absolute budget for one local evidence exchange.
pub const EVIDENCE_IO_TIMEOUT: Duration = Duration::from_millis(200);
/// Prefix on the existing trusted Guest-control terminal diagnostic transport.
pub const EVIDENCE_PREFIX: &str = "OKOU_OOM_EVIDENCE_V1 ";

/// Why a bounded capture was requested. An error is not evidence of OOM.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureReason {
    /// Existing five-second metrics tick.
    Sample,
    /// Abnormal CLI completion.
    CliError,
    /// Containment is about to signal/remove its descendants.
    Cleanup,
}

/// Availability is separate from measured zero.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    /// All requested source data was available.
    Available,
    /// The reader succeeded but no attributable kernel record was present.
    Missing,
    /// At least one optional source field was absent.
    Partial,
    /// Source does not exist or cannot be read.
    Unavailable,
    /// Source access was denied.
    Denied,
    /// A byte, count, or time budget was exhausted.
    Truncated,
    /// Kernel records were overwritten before the cursor could read them.
    Overwritten,
    /// A source record could not be attributed to this operation.
    Uncorrelated,
    /// The operation-owned cgroup inode changed.
    Recreated,
}

/// Allowlisted memory event counters. Missing keys remain null.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct MemoryEvents {
    /// memory.high events.
    pub high: Option<u64>,
    /// memory.max events, not the configured byte limit.
    pub max: Option<u64>,
    /// OOM allocation failures.
    pub oom: Option<u64>,
    /// OOM-killed tasks.
    pub oom_kill: Option<u64>,
    /// OOM-killed groups, when supported.
    pub oom_group_kill: Option<u64>,
}

impl MemoryEvents {
    /// Subtract only known, non-regressing counters.
    pub fn delta(&self, baseline: &Self) -> Self {
        fn subtract(value: Option<u64>, baseline: Option<u64>) -> Option<u64> {
            value?.checked_sub(baseline?)
        }
        Self {
            high: subtract(self.high, baseline.high),
            max: subtract(self.max, baseline.max),
            oom: subtract(self.oom, baseline.oom),
            oom_kill: subtract(self.oom_kill, baseline.oom_kill),
            oom_group_kill: subtract(self.oom_group_kill, baseline.oom_group_kill),
        }
    }

    /// Whether a known OOM counter increased.
    pub fn has_oom(&self) -> bool {
        [self.oom, self.oom_kill, self.oom_group_kill]
            .into_iter()
            .flatten()
            .any(|value| value > 0)
    }
}

/// A fixed cgroup sample; never an inventory of processes or tool content.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MemorySnapshot {
    /// Fixed role: workload, runtime, or tools.
    pub role: String,
    /// Trusted operation-owned cgroup path.
    pub cgroup: String,
    /// Kernel filesystem identity captured at initialization.
    pub inode: Option<u64>,
    /// Completeness of the source reads.
    pub status: EvidenceStatus,
    /// Current charged bytes, measured after an observed incident.
    pub current: Option<u64>,
    /// Kernel-maintained peak bytes when supported.
    pub peak: Option<u64>,
    /// Actual memory.max readback: decimal bytes or "max".
    pub limit: Option<String>,
    /// Initial limit readback.
    pub initial_limit: Option<String>,
    /// Anonymous charged bytes.
    pub anon: Option<u64>,
    /// File-backed charged bytes.
    pub file: Option<u64>,
    /// Kernel charged bytes when supported.
    pub kernel: Option<u64>,
    /// Initial hierarchical event counters.
    pub baseline: MemoryEvents,
    /// Current hierarchical event counters.
    pub events: MemoryEvents,
    /// Current minus initial hierarchical counters.
    pub delta: MemoryEvents,
    /// Initial local event counters.
    pub local_baseline: MemoryEvents,
    /// Current local event counters.
    pub local_events: MemoryEvents,
    /// Current minus initial local counters.
    pub local_delta: MemoryEvents,
}

/// Source-backed fields from a kernel-facility /dev/kmsg OOM record.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct KernelOomEvent {
    /// Always "guest"; Host records cannot enter this reader.
    pub source: String,
    /// Kernel ring sequence, separate from ingestion order.
    pub sequence: u64,
    /// Kernel record time in microseconds since boot.
    pub boottime_us: u64,
    /// Allowlisted kernel constraint name.
    pub constraint: String,
    /// Trigger cgroup only when it is a canonical ancestor of this workload.
    pub oom_cgroup: Option<String>,
    /// Victim PID reported by the kernel; no /proc lookup is required.
    pub victim_pid: u32,
    /// Bounded task comm from the kernel, never argv.
    pub victim_comm: String,
    /// Canonical operation-owned victim task cgroup from the same record.
    pub task_cgroup: String,
}

/// One deduplicated incident. A candidate can have no proof of OOM.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct OomIncident {
    /// Stable operation UUID plus incident ordinal.
    pub id: String,
    /// Capture time, distinct from source event and ingestion times.
    pub captured_at: String,
    /// Capture trigger; it does not alter execution outcome.
    pub reason: CaptureReason,
    /// Snapshots are taken after observation, never claimed as pre-kill usage.
    pub after_observation: bool,
    /// Snapshot precedes containment signaling/removal.
    pub before_cleanup: bool,
    /// Kernel reader completeness, independent of counter evidence.
    pub kernel_status: EvidenceStatus,
    /// Allowlisted kernel records, bounded by MAX_KERNEL_EVENTS.
    pub kernel_events: Vec<KernelOomEvent>,
    /// Exactly workload, runtime, and aggregate tools.
    pub groups: [MemorySnapshot; 3],
}

/// Operation identity and bounded retained evidence carried by both transports.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct OomEvidence {
    /// Fresh UUID for this containment creation, independent of sandbox/PID reuse.
    pub operation_id: String,
    /// Guest boot UUID; null if inaccessible.
    pub guest_boot_id: Option<String>,
    /// Monotonic initialization boundary for rejecting old kernel records.
    pub started_boottime_us: u64,
    /// Source sample time.
    pub sampled_at: String,
    /// Latest validated native Pi message timestamp in Unix milliseconds.
    /// Ordering after an incident must be checked before using it as proof.
    /// Supplied only by the operation's authenticated Guest Agent. This local
    /// observability context is not part of the version-1 telemetry API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_progress_at: Option<u64>,
    /// Last consumed kernel sequence, absent before the first record.
    pub kernel_cursor: Option<u64>,
    /// Availability of the bounded kernel reader at this sample.
    pub kernel_status: EvidenceStatus,
    /// Current source sample, including identity and baseline.
    pub groups: [MemorySnapshot; 3],
    /// Bounded retained incidents.
    pub incidents: Vec<OomIncident>,
    /// Additional incidents beyond the retention cap.
    pub dropped_incidents: u64,
}

/// Whether a retained incident proves an OOM decision. A capture candidate
/// records that the sources were inspected, not that a kill happened.
fn incident_proves_oom(incident: &OomIncident) -> bool {
    !incident.kernel_events.is_empty()
        || incident
            .groups
            .iter()
            .any(|group| group.delta.has_oom() || group.local_delta.has_oom())
}

/// Whether this evidence carries positive proof rather than an inspected-and-
/// empty capture candidate. Candidates remain useful for triage but are not
/// themselves an operation failure.
pub fn evidence_has_proof(evidence: &OomEvidence) -> bool {
    evidence.incidents.iter().any(incident_proves_oom)
}

/// One terminal diagnostic separated into its actual diagnostic and the
/// bounded metadata that shares the same transport.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiagnosticSplit {
    /// The diagnostic without any evidence line. Only this part describes an
    /// operation failure and reaches outcome processing.
    pub residual: String,
    /// The last well-formed evidence the diagnostic carried.
    pub evidence: Option<OomEvidence>,
    /// Lines claiming the evidence prefix that exceed a bound or fail to
    /// parse. A broken producer contract must not disappear silently.
    pub malformed_lines: u32,
}

impl DiagnosticSplit {
    /// Whether the residual diagnostic describes an actual failure.
    pub fn is_actionable(&self) -> bool {
        !self.residual.is_empty()
    }

    /// Whether the carried evidence proves an OOM decision.
    pub fn has_proof(&self) -> bool {
        self.evidence.as_ref().is_some_and(evidence_has_proof)
    }
}

/// Separate bounded metadata from the real diagnostic. Every consumer must
/// classify severity and report outcomes on the residual, never on the raw
/// frame. Bounds match [`read_evidence`] so both transports accept exactly the
/// same payloads.
pub fn split_diagnostic(diagnostic: &str) -> DiagnosticSplit {
    let mut split = DiagnosticSplit::default();
    let mut residual = String::new();
    for raw_line in diagnostic.split_inclusive('\n') {
        let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);
        // `str::lines` recognizes CRLF, so retain that parsing behavior for an
        // evidence line while keeping the original bytes of every residual
        // diagnostic line below.
        let line = if raw_line.ends_with('\n') {
            line.strip_suffix('\r').unwrap_or(line)
        } else {
            line
        };
        let Some(json) = line.strip_prefix(EVIDENCE_PREFIX) else {
            residual.push_str(raw_line);
            continue;
        };
        match parse_bounded_evidence(json) {
            Some(evidence) => {
                if split
                    .evidence
                    .as_ref()
                    .is_some_and(|previous| previous != &evidence)
                {
                    split.malformed_lines = split.malformed_lines.saturating_add(1);
                }
                split.evidence = Some(evidence);
            }
            None => split.malformed_lines = split.malformed_lines.saturating_add(1),
        }
    }
    split.residual = residual;
    split
}

fn parse_bounded_evidence(json: &str) -> Option<OomEvidence> {
    if json.len() > MAX_EVIDENCE_BYTES {
        return None;
    }
    let evidence: OomEvidence = serde_json::from_str(json).ok()?;
    (evidence.incidents.len() <= MAX_INCIDENTS
        && evidence
            .incidents
            .iter()
            .all(|incident| incident.kernel_events.len() <= MAX_KERNEL_EVENTS))
    .then_some(evidence)
}

/// Exchange a bounded response on the authenticated placement connection.
pub fn read_evidence(stream: &UnixStream) -> io::Result<OomEvidence> {
    let deadline = Instant::now() + EVIDENCE_IO_TIMEOUT;
    let mut header = [0; 4];
    read_exact_until(stream, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_EVIDENCE_BYTES {
        return Err(io::Error::other("evidence response exceeds byte limit"));
    }
    let mut bytes = vec![0; length];
    read_exact_until(stream, &mut bytes, deadline)?;
    decode_evidence(&bytes)
}

/// Decode a response body with the same byte and count limits for every transport.
pub fn decode_evidence(bytes: &[u8]) -> io::Result<OomEvidence> {
    if bytes.len() > MAX_EVIDENCE_BYTES {
        return Err(io::Error::other("evidence response exceeds byte limit"));
    }
    let evidence: OomEvidence = serde_json::from_slice(bytes)?;
    if evidence.incidents.len() > MAX_INCIDENTS
        || evidence
            .incidents
            .iter()
            .any(|incident| incident.kernel_events.len() > MAX_KERNEL_EVENTS)
    {
        return Err(io::Error::other("evidence response exceeds count limit"));
    }
    Ok(evidence)
}

fn read_exact_until(
    mut stream: &UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> io::Result<()> {
    while !bytes.is_empty() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
        stream.set_read_timeout(Some(remaining))?;
        let count = stream.read(bytes)?;
        if count == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        bytes = bytes
            .get_mut(count..)
            .ok_or_else(|| io::Error::other("invalid evidence read length"))?;
    }
    Ok(())
}

/// Write one bounded response, failing closed on oversize evidence.
pub fn write_evidence(stream: &UnixStream, evidence: &OomEvidence) -> io::Result<()> {
    let bytes = serde_json::to_vec(evidence)?;
    if bytes.len() > MAX_EVIDENCE_BYTES {
        return Err(io::Error::other("evidence exceeds byte limit"));
    }
    let deadline = Instant::now() + EVIDENCE_IO_TIMEOUT;
    write_all_until(stream, &(bytes.len() as u32).to_be_bytes(), deadline)?;
    write_all_until(stream, &bytes, deadline)
}

fn write_all_until(mut stream: &UnixStream, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
        stream.set_write_timeout(Some(remaining))?;
        let count = stream.write(bytes)?;
        if count == 0 {
            return Err(io::ErrorKind::WriteZero.into());
        }
        bytes = bytes
            .get(count..)
            .ok_or_else(|| io::Error::other("invalid evidence write length"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/oom-evidence-v1.json");

    #[test]
    fn serialized_evidence_matches_the_cross_language_fixture() {
        let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(
            serde_json::to_value(evidence).unwrap(),
            serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap()
        );
    }

    #[test]
    fn evidence_exchange_preserves_identity_and_rejects_oversized_frames() {
        let (client, server) = UnixStream::pair().unwrap();
        let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        write_evidence(&server, &evidence).unwrap();
        assert_eq!(read_evidence(&client).unwrap(), evidence);
        (&server)
            .write_all(&((MAX_EVIDENCE_BYTES + 1) as u32).to_be_bytes())
            .unwrap();
        assert!(read_evidence(&client).is_err());
    }

    #[test]
    fn unavailable_evidence_peer_has_a_bounded_deadline() {
        let (client, _server) = UnixStream::pair().unwrap();
        let start = Instant::now();
        assert!(read_evidence(&client).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn evidence_exchange_rejects_count_overflow_and_bounds_a_stalled_writer() {
        let (client, server) = UnixStream::pair().unwrap();
        let mut evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        evidence.incidents = vec![evidence.incidents[0].clone(); MAX_INCIDENTS + 1];
        write_evidence(&server, &evidence).unwrap();
        assert!(read_evidence(&client).is_err());
        evidence.incidents.truncate(1);
        evidence.incidents[0].kernel_events =
            vec![evidence.incidents[0].kernel_events[0].clone(); MAX_KERNEL_EVENTS + 1];
        write_evidence(&server, &evidence).unwrap();
        assert!(read_evidence(&client).is_err());
        evidence.operation_id = "x".repeat(MAX_EVIDENCE_BYTES);
        assert!(write_evidence(&server, &evidence).is_err());
        let start = Instant::now();
        assert!(
            write_all_until(&server, &vec![0; 1024 * 1024], start + EVIDENCE_IO_TIMEOUT).is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    fn candidate_evidence() -> OomEvidence {
        let mut evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        let incident = &mut evidence.incidents[0];
        incident.reason = CaptureReason::CliError;
        incident.kernel_status = EvidenceStatus::Missing;
        incident.kernel_events.clear();
        for group in &mut incident.groups {
            group.delta = MemoryEvents::default();
            group.local_delta = MemoryEvents::default();
        }
        evidence
    }

    fn evidence_line(evidence: &OomEvidence) -> String {
        format!(
            "{EVIDENCE_PREFIX}{}",
            serde_json::to_string(evidence).unwrap()
        )
    }

    #[test]
    fn split_separates_metadata_from_the_actionable_diagnostic() {
        let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        let split = split_diagnostic(&format!(
            "Failed to wait: no child processes\n{}",
            evidence_line(&evidence)
        ));

        assert_eq!(split.residual, "Failed to wait: no child processes\n");
        assert!(split.is_actionable());
        assert_eq!(split.evidence.as_ref(), Some(&evidence));
        assert_eq!(split.malformed_lines, 0);
        assert!(split.has_proof());
    }

    #[test]
    fn metadata_only_diagnostic_is_not_actionable() {
        let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        let split = split_diagnostic(&evidence_line(&evidence));

        assert_eq!(split.residual, "");
        assert!(!split.is_actionable());
        assert!(split.has_proof());
    }

    #[test]
    fn capture_candidate_carries_no_proof_of_an_oom_decision() {
        let candidate = candidate_evidence();
        assert!(!evidence_has_proof(&candidate));

        let split = split_diagnostic(&evidence_line(&candidate));
        assert!(!split.is_actionable());
        assert!(!split.has_proof());
        assert_eq!(split.malformed_lines, 0);
        assert!(split.evidence.is_some(), "candidate is still transported");
    }

    #[test]
    fn local_counter_transition_alone_still_proves_an_oom_decision() {
        let mut candidate = candidate_evidence();
        candidate.incidents[0].groups[2].local_delta.oom_kill = Some(1);

        assert!(evidence_has_proof(&candidate));
    }

    #[test]
    fn malformed_metadata_is_counted_and_never_reported_as_a_diagnostic() {
        let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        let mut over_count = evidence.clone();
        over_count.incidents = vec![evidence.incidents[0].clone(); MAX_INCIDENTS + 1];
        let mut over_events = evidence.clone();
        over_events.incidents[0].kernel_events =
            vec![evidence.incidents[0].kernel_events[0].clone(); MAX_KERNEL_EVENTS + 1];

        for line in [
            format!("{EVIDENCE_PREFIX}not json"),
            format!("{EVIDENCE_PREFIX}{}", "x".repeat(MAX_EVIDENCE_BYTES + 1)),
            evidence_line(&over_count),
            evidence_line(&over_events),
        ] {
            let split = split_diagnostic(&line);
            assert_eq!(
                split.malformed_lines,
                1,
                "line={}",
                &line[..40.min(line.len())]
            );
            assert!(split.evidence.is_none());
            assert_eq!(
                split.residual, "",
                "malformed metadata is never a diagnostic"
            );
            assert!(!split.is_actionable());
            assert!(!split.has_proof());
        }
    }

    #[test]
    fn clean_diagnostic_is_preserved_verbatim() {
        for diagnostic in [
            "",
            "Failed to clean process containment: EBUSY",
            "Failed to clean process containment: EBUSY\n",
            "Failed to clean process containment: EBUSY\r\n",
        ] {
            let split = split_diagnostic(diagnostic);
            assert_eq!(split.residual, diagnostic);
            assert_eq!(split.is_actionable(), !diagnostic.is_empty());
            assert!(split.evidence.is_none());
            assert_eq!(split.malformed_lines, 0);
        }
    }

    #[test]
    fn split_preserves_real_diagnostic_bytes_around_metadata() {
        let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        let split = split_diagnostic(&format!(
            "Failed to wait: no child processes\r\n{}\r\ncleanup still failed\n",
            evidence_line(&evidence)
        ));

        assert_eq!(
            split.residual,
            "Failed to wait: no child processes\r\ncleanup still failed\n"
        );
        assert_eq!(split.evidence.as_ref(), Some(&evidence));
        assert_eq!(split.malformed_lines, 0);
    }

    #[test]
    fn counter_regression_and_missing_baselines_are_unavailable() {
        let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
        let current = &evidence.groups[0].events;
        assert_eq!(MemoryEvents::default().delta(current).oom_kill, None);
        assert_eq!(current.delta(&MemoryEvents::default()).oom_kill, None);
        assert!(!current.delta(current).has_oom());
    }
}
