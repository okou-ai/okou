//! Bounded native session-history selection for guest checkpoints.
//!
//! The crate retains structurally valid native compact generations for Claude
//! Code and legacy or paginated Codex rollouts without changing their native
//! session IDs or modifying live JSONL files.

mod codex;
mod pi;
#[cfg(test)]
mod property_tests;

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;
use uuid::Uuid;

pub use codex::{
    CODEX_COMPACT_GENERATION_MAX_BYTES, CODEX_JSONL_RECORD_MAX_BYTES, CodexHistoryCandidate,
    CodexHistoryIneligibleReason, CodexHistorySelection, select_codex_compact_generation,
    select_codex_compact_generation_with_candidate_limit_for_test,
};
pub use pi::{
    PI_COMPACT_GENERATION_MAX_BYTES, PI_JSONL_RECORD_MAX_BYTES, PiHistoryCandidate,
    PiHistoryIneligibleReason, PiHistorySelection, select_pi_compact_generation,
    select_pi_compact_generation_with_candidate_limit_for_test,
};

/// Maximum decoded size of an accepted Claude compact generation.
pub const CLAUDE_COMPACT_GENERATION_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Maximum size of one Claude JSONL record inspected by the selector.
pub const CLAUDE_JSONL_RECORD_MAX_BYTES: usize = 16 * 1024 * 1024;

const READ_BUFFER_BYTES: usize = 64 * 1024;

/// Result of attempting to select a bounded Claude compact generation.
#[derive(Debug, PartialEq, Eq)]
#[must_use]
pub enum ClaudeHistorySelection {
    /// A structurally valid raw compact generation was selected.
    Candidate(ClaudeHistoryCandidate),
    /// The source did not have an eligible compact generation.
    Ineligible(ClaudeHistoryIneligibleReason),
}

/// Raw Claude compact-generation bytes selected for checkpointing.
#[derive(Debug, PartialEq, Eq)]
pub struct ClaudeHistoryCandidate {
    bytes: Vec<u8>,
    source_size: u64,
}

impl ClaudeHistoryCandidate {
    /// Return the complete decoded source size observed during selection.
    #[must_use]
    pub const fn source_size(&self) -> u64 {
        self.source_size
    }

    /// Return the selected raw generation size.
    #[must_use]
    pub fn candidate_size(&self) -> u64 {
        self.bytes.len() as u64
    }

    /// Borrow the exact raw JSONL bytes selected for checkpointing.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Consume the candidate and return its exact raw JSONL bytes.
    #[must_use]
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// Content-free reason that a Claude history was not eligible for pruning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeHistoryIneligibleReason {
    /// The complete source is already within the retained-generation guard.
    SourceWithinGuard,
    /// No compact boundary was found in the only tail window that can fit.
    NoCompactBoundary,
    /// A JSONL record was malformed, empty, or not an object.
    InvalidRecord,
    /// A JSONL record exceeded the individual-record limit.
    RecordTooLarge,
    /// The latest compact boundary did not match the supported native shape.
    InvalidCompactBoundary,
    /// The compact summary was missing, empty, or not linked to its boundary.
    InvalidCompactSummary,
    /// A record carried a different or malformed native session ID.
    SessionIdMismatch,
    /// An ancestry UUID was missing, malformed, or duplicated.
    InvalidUuid,
    /// A non-null parent did not refer to an earlier retained record.
    BrokenParent,
    /// Native tool-use and tool-result records were incomplete or ambiguous.
    BrokenToolPair,
    /// The source EOF changed while the candidate was selected.
    SourceChanged,
}

impl ClaudeHistoryIneligibleReason {
    /// Return a stable content-free diagnostic label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SourceWithinGuard => "source_within_guard",
            Self::NoCompactBoundary => "no_compact_boundary",
            Self::InvalidRecord => "invalid_record",
            Self::RecordTooLarge => "record_too_large",
            Self::InvalidCompactBoundary => "invalid_compact_boundary",
            Self::InvalidCompactSummary => "invalid_compact_summary",
            Self::SessionIdMismatch => "session_id_mismatch",
            Self::InvalidUuid => "invalid_uuid",
            Self::BrokenParent => "broken_parent",
            Self::BrokenToolPair => "broken_tool_pair",
            Self::SourceChanged => "source_changed",
        }
    }
}

#[derive(Clone, Copy)]
struct SelectionLimits {
    candidate_max_bytes: u64,
    record_max_bytes: usize,
}

impl SelectionLimits {
    const PRODUCTION: Self = Self {
        candidate_max_bytes: CLAUDE_COMPACT_GENERATION_MAX_BYTES,
        record_max_bytes: CLAUDE_JSONL_RECORD_MAX_BYTES,
    };
}

enum BoundedRecord {
    Eof,
    Record(Vec<u8>),
    Oversized,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CandidatePhase {
    ExpectSummary,
    Body,
}

struct CandidateState {
    bytes: Vec<u8>,
    phase: CandidatePhase,
    boundary_uuid: Option<Uuid>,
    seen_uuids: HashSet<Uuid>,
    tool_uses: HashSet<String>,
    tool_results: HashSet<String>,
    invalid: Option<ClaudeHistoryIneligibleReason>,
}

impl CandidateState {
    fn from_boundary(raw_record: &[u8], value: &Value, expected_session_id: &str) -> Self {
        let mut state = Self {
            bytes: raw_record.to_vec(),
            phase: CandidatePhase::ExpectSummary,
            boundary_uuid: None,
            seen_uuids: HashSet::new(),
            tool_uses: HashSet::new(),
            tool_results: HashSet::new(),
            invalid: None,
        };
        match validate_boundary(value, expected_session_id) {
            Ok(boundary_uuid) => {
                state.boundary_uuid = Some(boundary_uuid);
                state.seen_uuids.insert(boundary_uuid);
            }
            Err(reason) => state.invalid = Some(reason),
        }
        state
    }

    fn invalidate(&mut self, reason: ClaudeHistoryIneligibleReason) {
        if self.invalid.is_none() {
            self.invalid = Some(reason);
            self.bytes.clear();
            self.seen_uuids.clear();
            self.tool_uses.clear();
            self.tool_results.clear();
        }
    }

    fn push_record(
        &mut self,
        raw_record: &[u8],
        value: &Value,
        expected_session_id: &str,
        candidate_max_bytes: u64,
    ) {
        if self.invalid.is_some() {
            return;
        }

        let next_size = self.bytes.len().saturating_add(raw_record.len()) as u64;
        if next_size > candidate_max_bytes {
            self.invalidate(ClaudeHistoryIneligibleReason::NoCompactBoundary);
            return;
        }
        self.bytes.extend_from_slice(raw_record);

        let validation = match self.phase {
            CandidatePhase::ExpectSummary => {
                let Some(boundary_uuid) = self.boundary_uuid else {
                    self.invalidate(ClaudeHistoryIneligibleReason::InvalidCompactBoundary);
                    return;
                };
                validate_summary(
                    value,
                    expected_session_id,
                    boundary_uuid,
                    &mut self.seen_uuids,
                    &mut self.tool_uses,
                    &mut self.tool_results,
                )
                .map(|()| {
                    self.phase = CandidatePhase::Body;
                })
            }
            CandidatePhase::Body => validate_body_record(
                value,
                expected_session_id,
                &mut self.seen_uuids,
                &mut self.tool_uses,
                &mut self.tool_results,
            ),
        };
        if let Err(reason) = validation {
            self.invalidate(reason);
        }
    }

    fn finish(
        self,
        source_size: u64,
    ) -> Result<ClaudeHistoryCandidate, ClaudeHistoryIneligibleReason> {
        if let Some(reason) = self.invalid {
            return Err(reason);
        }
        if self.phase != CandidatePhase::Body {
            return Err(ClaudeHistoryIneligibleReason::InvalidCompactSummary);
        }
        if self.tool_uses != self.tool_results {
            return Err(ClaudeHistoryIneligibleReason::BrokenToolPair);
        }
        if self.bytes.is_empty() || self.bytes.len() as u64 >= source_size {
            return Err(ClaudeHistoryIneligibleReason::NoCompactBoundary);
        }
        Ok(ClaudeHistoryCandidate {
            bytes: self.bytes,
            source_size,
        })
    }
}

/// Select Claude Code's latest raw native compact generation.
///
/// The source is never modified. Files at or below 64 MiB are left unchanged.
/// For larger files, only the final 64 MiB can contain an eligible candidate,
/// so the older prefix is neither parsed nor retained.
///
/// # Selection contract
///
/// An eligible candidate contains the exact raw records from the newest
/// recognized native compact boundary through the EOF observed during
/// selection. The record immediately following the boundary must be a linked,
/// nonempty native compact-summary user message. Every retained later record is
/// included without rewriting.
///
/// Every newer recognized compact boundary supersedes the preceding candidate.
/// If the newest boundary or its retained generation is invalid, selection
/// fails closed instead of falling back to an older generation. The retained
/// generation must preserve the expected native session identity, supported
/// boundary, summary, and message shapes and relationships, unique UUID
/// ancestry with retained parent links resolving to earlier candidate records,
/// and complete, unambiguous tool-use/tool-result pairs whose results follow
/// their uses. Malformed or oversized retained records, candidate size
/// violations, and changes to the observed EOF or source length likewise make
/// the source [`ClaudeHistorySelection::Ineligible`].
///
/// `Ineligible` is an expected eligibility or compatibility outcome that lets
/// the caller use its ordinary checkpoint path. The selector only chooses an
/// in-memory candidate: staging, checkpoint commit, and live-file reconciliation
/// remain the caller's responsibility.
///
/// # Errors
///
/// Returns an [`io::Error`] when an underlying source open, metadata, seek, or
/// read operation fails.
pub fn select_claude_compact_generation(
    source_path: impl AsRef<Path>,
    expected_session_id: &str,
) -> io::Result<ClaudeHistorySelection> {
    select_with_limits_and_hook(
        source_path.as_ref(),
        expected_session_id,
        SelectionLimits::PRODUCTION,
        || {},
    )
}

/// Select Claude Code's latest compact generation from an already-open source.
///
/// The caller must open the source before calling this variant and provide the
/// handle containing the Claude Code JSONL history to inspect. The selection
/// and fail-closed eligibility rules are the same as
/// [`select_claude_compact_generation`]: the newest recognized compact boundary
/// supersedes older candidates, and an invalid or otherwise ineligible source
/// returns [`ClaudeHistorySelection::Ineligible`] instead of an older
/// generation.
///
/// The source contents are never modified. For a source large enough to
/// inspect, selection ignores the handle's incoming offset and may leave the
/// cursor repositioned. Cursor preservation is not guaranteed, so callers
/// must not rely on the cursor position after this function returns.
///
/// The selector only chooses an in-memory candidate; staging, checkpoint
/// commit, and live-file reconciliation remain the caller's responsibility.
///
/// # Errors
///
/// Returns an [`io::Error`] when an underlying source metadata, seek, or read
/// operation fails. Source-open errors do not apply because this variant
/// receives an already-open handle.
pub fn select_claude_compact_generation_from_file(
    source: &mut File,
    expected_session_id: &str,
) -> io::Result<ClaudeHistorySelection> {
    select_opened_with_limits_and_hook(
        source,
        expected_session_id,
        SelectionLimits::PRODUCTION,
        || {},
    )
}

/// Select a Claude compact generation with a bounded integration-test window.
#[doc(hidden)]
pub fn select_claude_compact_generation_with_candidate_limit_for_test(
    source_path: impl AsRef<Path>,
    expected_session_id: &str,
    candidate_max_bytes: u64,
) -> io::Result<ClaudeHistorySelection> {
    select_with_limits_and_hook(
        source_path.as_ref(),
        expected_session_id,
        SelectionLimits {
            candidate_max_bytes,
            ..SelectionLimits::PRODUCTION
        },
        || {},
    )
}

/// Select a Claude compact generation from an open file with a bounded test window.
#[doc(hidden)]
pub fn select_claude_compact_generation_from_file_with_candidate_limit_for_test(
    source: &mut File,
    expected_session_id: &str,
    candidate_max_bytes: u64,
) -> io::Result<ClaudeHistorySelection> {
    select_opened_with_limits_and_hook(
        source,
        expected_session_id,
        SelectionLimits {
            candidate_max_bytes,
            ..SelectionLimits::PRODUCTION
        },
        || {},
    )
}

fn select_with_limits_and_hook(
    source_path: &Path,
    expected_session_id: &str,
    limits: SelectionLimits,
    before_final_check: impl FnOnce(),
) -> io::Result<ClaudeHistorySelection> {
    let mut file = File::open(source_path)?;
    select_opened_with_limits_and_hook(&mut file, expected_session_id, limits, before_final_check)
}

fn select_opened_with_limits_and_hook(
    file: &mut File,
    expected_session_id: &str,
    limits: SelectionLimits,
    before_final_check: impl FnOnce(),
) -> io::Result<ClaudeHistorySelection> {
    let source_size = file.metadata()?.len();
    if source_size <= limits.candidate_max_bytes {
        return Ok(ClaudeHistorySelection::Ineligible(
            ClaudeHistoryIneligibleReason::SourceWithinGuard,
        ));
    }

    let tail_start = source_size - limits.candidate_max_bytes;
    file.seek(SeekFrom::Start(tail_start - 1))?;
    let mut preceding_byte = [0_u8; 1];
    file.read_exact(&mut preceding_byte)?;
    file.seek(SeekFrom::Start(tail_start))?;

    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, file);
    if preceding_byte != *b"\n" {
        match read_bounded_record(&mut reader, limits.record_max_bytes)? {
            BoundedRecord::Eof => {
                return Ok(ClaudeHistorySelection::Ineligible(
                    ClaudeHistoryIneligibleReason::NoCompactBoundary,
                ));
            }
            BoundedRecord::Record(_) | BoundedRecord::Oversized => {}
        }
    }

    let mut candidate: Option<CandidateState> = None;
    loop {
        match read_bounded_record(&mut reader, limits.record_max_bytes)? {
            BoundedRecord::Eof => break,
            BoundedRecord::Oversized => {
                if let Some(state) = candidate.as_mut() {
                    state.invalidate(ClaudeHistoryIneligibleReason::RecordTooLarge);
                }
            }
            BoundedRecord::Record(raw_record) => {
                let json_bytes = strip_jsonl_line_ending(&raw_record);
                match serde_json::from_slice::<Value>(json_bytes) {
                    Ok(value) if is_compact_boundary_discriminator(&value) => {
                        candidate = Some(CandidateState::from_boundary(
                            &raw_record,
                            &value,
                            expected_session_id,
                        ));
                    }
                    Ok(value) => {
                        if let Some(state) = candidate.as_mut() {
                            state.push_record(
                                &raw_record,
                                &value,
                                expected_session_id,
                                limits.candidate_max_bytes,
                            );
                        }
                    }
                    Err(_) => {
                        if let Some(state) = candidate.as_mut() {
                            state.invalidate(ClaudeHistoryIneligibleReason::InvalidRecord);
                        }
                    }
                }
            }
        }
    }

    let observed_eof = reader.stream_position()?;
    before_final_check();
    let final_size = reader.get_ref().metadata()?.len();
    if observed_eof != source_size || final_size != source_size {
        return Ok(ClaudeHistorySelection::Ineligible(
            ClaudeHistoryIneligibleReason::SourceChanged,
        ));
    }

    let Some(candidate) = candidate else {
        return Ok(ClaudeHistorySelection::Ineligible(
            ClaudeHistoryIneligibleReason::NoCompactBoundary,
        ));
    };
    Ok(match candidate.finish(source_size) {
        Ok(candidate) => ClaudeHistorySelection::Candidate(candidate),
        Err(reason) => ClaudeHistorySelection::Ineligible(reason),
    })
}

fn read_bounded_record(
    reader: &mut impl BufRead,
    record_max_bytes: usize,
) -> io::Result<BoundedRecord> {
    let mut record = Vec::new();
    let mut oversized = false;
    let mut saw_bytes = false;

    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if !saw_bytes {
                Ok(BoundedRecord::Eof)
            } else if oversized {
                Ok(BoundedRecord::Oversized)
            } else {
                Ok(BoundedRecord::Record(record))
            };
        }

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(buffer.len(), |position| position.saturating_add(1));
        let chunk = buffer
            .get(..consumed)
            .ok_or_else(|| io::Error::other("JSONL record buffer position was invalid"))?;
        saw_bytes = true;

        if !oversized {
            if chunk.len() <= record_max_bytes.saturating_sub(record.len()) {
                record.extend_from_slice(chunk);
            } else {
                oversized = true;
                record.clear();
            }
        }
        reader.consume(consumed);

        if newline.is_some() {
            return if oversized {
                Ok(BoundedRecord::Oversized)
            } else {
                Ok(BoundedRecord::Record(record))
            };
        }
    }
}

fn strip_jsonl_line_ending(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

fn is_compact_boundary_discriminator(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("system")
        && value.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
}

fn validate_boundary(
    value: &Value,
    expected_session_id: &str,
) -> Result<Uuid, ClaudeHistoryIneligibleReason> {
    let Some(object) = value.as_object() else {
        return Err(ClaudeHistoryIneligibleReason::InvalidCompactBoundary);
    };
    if object.get("type").and_then(Value::as_str) != Some("system")
        || object.get("subtype").and_then(Value::as_str) != Some("compact_boundary")
        || object.get("parentUuid") != Some(&Value::Null)
        || object.get("isSidechain").and_then(Value::as_bool) != Some(false)
        || object
            .get("version")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(ClaudeHistoryIneligibleReason::InvalidCompactBoundary);
    }
    require_session_id(value, expected_session_id)?;

    let logical_parent = object
        .get("logicalParentUuid")
        .and_then(Value::as_str)
        .ok_or(ClaudeHistoryIneligibleReason::InvalidCompactBoundary)?;
    Uuid::parse_str(logical_parent)
        .map_err(|_| ClaudeHistoryIneligibleReason::InvalidCompactBoundary)?;

    parse_uuid_field(value, "uuid")
        .map_err(|_| ClaudeHistoryIneligibleReason::InvalidCompactBoundary)
}

fn validate_summary(
    value: &Value,
    expected_session_id: &str,
    boundary_uuid: Uuid,
    seen_uuids: &mut HashSet<Uuid>,
    tool_uses: &mut HashSet<String>,
    tool_results: &mut HashSet<String>,
) -> Result<(), ClaudeHistoryIneligibleReason> {
    if value.get("type").and_then(Value::as_str) != Some("user")
        || value.get("isCompactSummary").and_then(Value::as_bool) != Some(true)
        || value
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            != Some("user")
        || value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .is_none_or(|content| content.trim().is_empty())
    {
        return Err(ClaudeHistoryIneligibleReason::InvalidCompactSummary);
    }
    require_session_id(value, expected_session_id)?;
    let parent_uuid = parse_uuid_field(value, "parentUuid")
        .map_err(|_| ClaudeHistoryIneligibleReason::InvalidCompactSummary)?;
    if parent_uuid != boundary_uuid {
        return Err(ClaudeHistoryIneligibleReason::InvalidCompactSummary);
    }
    validate_body_record(
        value,
        expected_session_id,
        seen_uuids,
        tool_uses,
        tool_results,
    )
    .map_err(|reason| match reason {
        ClaudeHistoryIneligibleReason::BrokenParent
        | ClaudeHistoryIneligibleReason::InvalidUuid => {
            ClaudeHistoryIneligibleReason::InvalidCompactSummary
        }
        other => other,
    })
}

fn validate_body_record(
    value: &Value,
    expected_session_id: &str,
    seen_uuids: &mut HashSet<Uuid>,
    tool_uses: &mut HashSet<String>,
    tool_results: &mut HashSet<String>,
) -> Result<(), ClaudeHistoryIneligibleReason> {
    let Some(record_type) = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|record_type| !record_type.trim().is_empty())
    else {
        return Err(ClaudeHistoryIneligibleReason::InvalidRecord);
    };
    validate_optional_session_id(value, expected_session_id)?;
    match record_type {
        "assistant" => validate_message_record(value, "assistant")?,
        "user" => validate_message_record(value, "user")?,
        _ => {}
    }

    let requires_ancestry = matches!(record_type, "assistant" | "attachment" | "system" | "user");
    validate_ancestry(value, requires_ancestry, seen_uuids)?;
    validate_tool_pairs(value, record_type, tool_uses, tool_results)
}

fn validate_message_record(
    value: &Value,
    expected_role: &str,
) -> Result<(), ClaudeHistoryIneligibleReason> {
    let Some(message) = value.get("message").and_then(Value::as_object) else {
        return Err(ClaudeHistoryIneligibleReason::InvalidRecord);
    };
    if message.get("role").and_then(Value::as_str) != Some(expected_role) {
        return Err(ClaudeHistoryIneligibleReason::InvalidRecord);
    }
    match message.get("content") {
        Some(Value::String(_)) => {}
        Some(Value::Array(blocks))
            if blocks.iter().all(|block| {
                block
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|block_type| !block_type.trim().is_empty())
            }) => {}
        _ => return Err(ClaudeHistoryIneligibleReason::InvalidRecord),
    }
    Ok(())
}

fn require_session_id(
    value: &Value,
    expected_session_id: &str,
) -> Result<(), ClaudeHistoryIneligibleReason> {
    match value.get("sessionId") {
        Some(Value::String(session_id)) if session_id == expected_session_id => Ok(()),
        None | Some(_) => Err(ClaudeHistoryIneligibleReason::SessionIdMismatch),
    }
}

fn validate_optional_session_id(
    value: &Value,
    expected_session_id: &str,
) -> Result<(), ClaudeHistoryIneligibleReason> {
    match value.get("sessionId") {
        Some(Value::String(session_id)) if session_id == expected_session_id => Ok(()),
        None => Ok(()),
        Some(_) => Err(ClaudeHistoryIneligibleReason::SessionIdMismatch),
    }
}

fn validate_ancestry(
    value: &Value,
    required: bool,
    seen_uuids: &mut HashSet<Uuid>,
) -> Result<(), ClaudeHistoryIneligibleReason> {
    match (value.get("uuid"), value.get("parentUuid")) {
        (None, None) if !required => Ok(()),
        (Some(_), Some(_)) => {
            let uuid = parse_uuid_field(value, "uuid")?;
            let parent_uuid = parse_uuid_field(value, "parentUuid")?;
            if !seen_uuids.contains(&parent_uuid) {
                return Err(ClaudeHistoryIneligibleReason::BrokenParent);
            }
            if !seen_uuids.insert(uuid) {
                return Err(ClaudeHistoryIneligibleReason::InvalidUuid);
            }
            Ok(())
        }
        (None, None) | (None, Some(_)) | (Some(_), None) => {
            Err(ClaudeHistoryIneligibleReason::InvalidUuid)
        }
    }
}

fn parse_uuid_field(value: &Value, field: &str) -> Result<Uuid, ClaudeHistoryIneligibleReason> {
    let raw = value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(ClaudeHistoryIneligibleReason::InvalidUuid)?;
    Uuid::parse_str(raw).map_err(|_| ClaudeHistoryIneligibleReason::InvalidUuid)
}

fn validate_tool_pairs(
    value: &Value,
    record_type: &str,
    tool_uses: &mut HashSet<String>,
    tool_results: &mut HashSet<String>,
) -> Result<(), ClaudeHistoryIneligibleReason> {
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Ok(());
    };

    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                if record_type != "assistant" {
                    return Err(ClaudeHistoryIneligibleReason::BrokenToolPair);
                }
                let id = nonempty_string_field(block, "id")?;
                if !tool_uses.insert(id.to_owned()) {
                    return Err(ClaudeHistoryIneligibleReason::BrokenToolPair);
                }
            }
            Some("tool_result") => {
                if record_type != "user" {
                    return Err(ClaudeHistoryIneligibleReason::BrokenToolPair);
                }
                let id = nonempty_string_field(block, "tool_use_id")?;
                if !tool_uses.contains(id) || !tool_results.insert(id.to_owned()) {
                    return Err(ClaudeHistoryIneligibleReason::BrokenToolPair);
                }
            }
            Some(_) | None => {}
        }
    }
    Ok(())
}

fn nonempty_string_field<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a str, ClaudeHistoryIneligibleReason> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .ok_or(ClaudeHistoryIneligibleReason::BrokenToolPair)
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, Write};

    use serde_json::json;
    use tempfile::NamedTempFile;

    use super::*;

    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const BOUNDARY_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SUMMARY_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const USER_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const ASSISTANT_ID: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const RESULT_ID: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    const TEST_LIMITS: SelectionLimits = SelectionLimits {
        candidate_max_bytes: 4 * 1024,
        record_max_bytes: 1024,
    };

    fn line(value: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }

    fn boundary(session_id: &str, uuid: &str) -> Vec<u8> {
        line(json!({
            "type": "system",
            "subtype": "compact_boundary",
            "sessionId": session_id,
            "uuid": uuid,
            "parentUuid": null,
            "logicalParentUuid": "11111111-1111-4111-8111-111111111111",
            "isSidechain": false,
            "version": "2.1.220"
        }))
    }

    fn summary(session_id: &str, boundary_uuid: &str, uuid: &str) -> Vec<u8> {
        line(json!({
            "type": "user",
            "sessionId": session_id,
            "uuid": uuid,
            "parentUuid": boundary_uuid,
            "isCompactSummary": true,
            "message": {"role": "user", "content": "retained summary"}
        }))
    }

    fn user(parent_uuid: &str, uuid: &str) -> Vec<u8> {
        line(json!({
            "type": "user",
            "sessionId": SESSION_ID,
            "uuid": uuid,
            "parentUuid": parent_uuid,
            "message": {"role": "user", "content": "later prompt"}
        }))
    }

    fn tool_use(parent_uuid: &str) -> Vec<u8> {
        line(json!({
            "type": "assistant",
            "sessionId": SESSION_ID,
            "uuid": ASSISTANT_ID,
            "parentUuid": parent_uuid,
            "message": {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}}]
            }
        }))
    }

    fn tool_result(parent_uuid: &str) -> Vec<u8> {
        line(json!({
            "type": "user",
            "sessionId": SESSION_ID,
            "uuid": RESULT_ID,
            "parentUuid": parent_uuid,
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "tool-1", "content": "ok"}]
            }
        }))
    }

    fn source(records: &[Vec<u8>]) -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(&vec![b'x'; TEST_LIMITS.candidate_max_bytes as usize + 64])
            .unwrap();
        file.write_all(b"\n").unwrap();
        for record in records {
            file.write_all(record).unwrap();
        }
        file.flush().unwrap();
        file
    }

    fn select(file: &NamedTempFile, session_id: &str) -> io::Result<ClaudeHistorySelection> {
        select_with_limits_and_hook(file.path(), session_id, TEST_LIMITS, || {})
    }

    fn candidate_bytes(selection: ClaudeHistorySelection) -> Vec<u8> {
        match selection {
            ClaudeHistorySelection::Candidate(candidate) => {
                let borrowed = candidate.as_bytes().to_vec();
                assert_eq!(candidate.candidate_size(), borrowed.len() as u64);
                assert_eq!(candidate.into_bytes(), borrowed);
                borrowed
            }
            ClaudeHistorySelection::Ineligible(reason) => {
                panic!("expected candidate, got {reason:?}")
            }
        }
    }

    #[test]
    fn preserves_exact_latest_generation_and_complete_tool_pair() {
        let records = [
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            user(SUMMARY_ID, USER_ID),
            tool_use(USER_ID),
            tool_result(ASSISTANT_ID),
        ];
        let file = source(&records);

        let selected = candidate_bytes(select(&file, SESSION_ID).unwrap());

        assert_eq!(selected, records.concat());
    }

    #[test]
    fn latest_invalid_boundary_supersedes_an_earlier_valid_generation() {
        let records = [
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            boundary(
                "99999999-9999-4999-8999-999999999999",
                "12121212-1212-4212-8212-121212121212",
            ),
        ];
        let file = source(&records);

        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::SessionIdMismatch)
        );
    }

    #[test]
    fn requires_the_expected_session_id_on_boundary_and_summary() {
        let boundary_without_session_id = line(json!({
            "type": "system",
            "subtype": "compact_boundary",
            "uuid": BOUNDARY_ID,
            "parentUuid": null,
            "logicalParentUuid": "11111111-1111-4111-8111-111111111111",
            "isSidechain": false,
            "version": "2.1.220"
        }));
        let file = source(&[
            boundary_without_session_id,
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::SessionIdMismatch)
        );

        let summary_without_session_id = line(json!({
            "type": "user",
            "uuid": SUMMARY_ID,
            "parentUuid": BOUNDARY_ID,
            "isCompactSummary": true,
            "message": {"role": "user", "content": "retained summary"}
        }));
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary_without_session_id,
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::SessionIdMismatch)
        );
    }

    #[test]
    fn rejects_unlinked_or_empty_summary() {
        let empty_summary = line(json!({
            "type": "user",
            "sessionId": SESSION_ID,
            "uuid": SUMMARY_ID,
            "parentUuid": BOUNDARY_ID,
            "isCompactSummary": true,
            "message": {"role": "user", "content": " "}
        }));
        let file = source(&[boundary(SESSION_ID, BOUNDARY_ID), empty_summary]);

        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(
                ClaudeHistoryIneligibleReason::InvalidCompactSummary
            )
        );

        let unlinked_summary = summary(
            SESSION_ID,
            "99999999-9999-4999-8999-999999999999",
            SUMMARY_ID,
        );
        let file = source(&[boundary(SESSION_ID, BOUNDARY_ID), unlinked_summary]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(
                ClaudeHistoryIneligibleReason::InvalidCompactSummary
            )
        );

        let wrong_role_summary = line(json!({
            "type": "user",
            "sessionId": SESSION_ID,
            "uuid": SUMMARY_ID,
            "parentUuid": BOUNDARY_ID,
            "isCompactSummary": true,
            "message": {"role": "assistant", "content": "retained summary"}
        }));
        let file = source(&[boundary(SESSION_ID, BOUNDARY_ID), wrong_role_summary]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(
                ClaudeHistoryIneligibleReason::InvalidCompactSummary
            )
        );
    }

    #[test]
    fn rejects_broken_parent_and_duplicate_uuid() {
        let broken = user("99999999-9999-4999-8999-999999999999", USER_ID);
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            broken,
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::BrokenParent)
        );

        let duplicate = user(SUMMARY_ID, SUMMARY_ID);
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            duplicate,
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::InvalidUuid)
        );
    }

    #[test]
    fn rejects_incomplete_or_reversed_tool_pairs() {
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            user(SUMMARY_ID, USER_ID),
            tool_use(USER_ID),
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::BrokenToolPair)
        );

        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            tool_result(SUMMARY_ID),
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::BrokenToolPair)
        );
    }

    #[test]
    fn rejects_incomplete_or_mislabeled_message_records() {
        let missing_content = line(json!({
            "type": "user",
            "sessionId": SESSION_ID,
            "uuid": USER_ID,
            "parentUuid": SUMMARY_ID,
            "message": {"role": "user"}
        }));
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            missing_content,
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::InvalidRecord)
        );

        let wrong_role = line(json!({
            "type": "assistant",
            "sessionId": SESSION_ID,
            "uuid": ASSISTANT_ID,
            "parentUuid": SUMMARY_ID,
            "message": {"role": "user", "content": []}
        }));
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            wrong_role,
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::InvalidRecord)
        );

        for malformed_content in [json!([42]), json!([{}]), json!([{"type": " "}])] {
            let malformed_block = line(json!({
                "type": "user",
                "sessionId": SESSION_ID,
                "uuid": USER_ID,
                "parentUuid": SUMMARY_ID,
                "message": {"role": "user", "content": malformed_content}
            }));
            let file = source(&[
                boundary(SESSION_ID, BOUNDARY_ID),
                summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
                malformed_block,
            ]);
            assert_eq!(
                select(&file, SESSION_ID).unwrap(),
                ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::InvalidRecord)
            );
        }

        let empty_record_type = line(json!({"type": " ", "value": "metadata"}));
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            empty_record_type,
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::InvalidRecord)
        );
    }

    #[test]
    fn rejects_tool_blocks_on_the_wrong_message_roles() {
        let user_tool_use = line(json!({
            "type": "user",
            "sessionId": SESSION_ID,
            "uuid": USER_ID,
            "parentUuid": SUMMARY_ID,
            "message": {
                "role": "user",
                "content": [{"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}}]
            }
        }));
        let assistant_tool_result = line(json!({
            "type": "assistant",
            "sessionId": SESSION_ID,
            "uuid": ASSISTANT_ID,
            "parentUuid": USER_ID,
            "message": {
                "role": "assistant",
                "content": [{"type": "tool_result", "tool_use_id": "tool-1", "content": "ok"}]
            }
        }));
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            user_tool_use,
            assistant_tool_result,
        ]);

        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::BrokenToolPair)
        );
    }

    #[test]
    fn rejects_malformed_and_oversized_records_after_boundary() {
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            b"{not-json}\n".to_vec(),
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::InvalidRecord)
        );

        let oversized = line(json!({"type": "metadata", "value": "x".repeat(2048)}));
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            oversized,
        ]);
        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::RecordTooLarge)
        );
    }

    #[test]
    fn rejects_a_generation_above_the_candidate_limit() {
        let metadata = || {
            line(json!({
                "type": "metadata",
                "value": "x".repeat(900)
            }))
        };
        let file = source(&[
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
            metadata(),
            metadata(),
            metadata(),
            metadata(),
            metadata(),
        ]);

        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::NoCompactBoundary)
        );
    }

    #[test]
    fn detects_source_length_change_before_acceptance() {
        let records = [
            boundary(SESSION_ID, BOUNDARY_ID),
            summary(SESSION_ID, BOUNDARY_ID, SUMMARY_ID),
        ];
        let mut file = source(&records);
        let path = file.path().to_owned();

        let selection = select_with_limits_and_hook(&path, SESSION_ID, TEST_LIMITS, || {
            file.as_file_mut().seek(SeekFrom::End(0)).unwrap();
            file.as_file_mut().write_all(b"changed\n").unwrap();
            file.as_file_mut().flush().unwrap();
        })
        .unwrap();

        assert_eq!(
            selection,
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::SourceChanged)
        );
    }

    #[test]
    fn source_within_guard_is_not_scanned() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"not json").unwrap();

        assert_eq!(
            select(&file, SESSION_ID).unwrap(),
            ClaudeHistorySelection::Ineligible(ClaudeHistoryIneligibleReason::SourceWithinGuard)
        );
    }
}
