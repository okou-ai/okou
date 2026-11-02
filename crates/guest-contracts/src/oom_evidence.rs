//! Bounded, metadata-only evidence for one Guest containment lifecycle.

mod containment;

pub use containment::OomClassification;

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
    evidence.agent_domain_oom_kill() || evidence.incidents.iter().any(incident_proves_oom)
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
mod tests;
