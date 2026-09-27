//! Bounded, active-branch Pi history for a native compacted checkpoint.
//!
//! Pi compaction is append-only: it changes the projected context, not the
//! length of its JSONL file. Select only a complete, bounded active branch
//! from the newest native compact's retained start. Never select an older
//! compact when the newest one is not usable.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};

use serde_json::{Value, json};

use super::{BoundedRecord, READ_BUFFER_BYTES, read_bounded_record, strip_jsonl_line_ending};

/// Limit the retained decoded generation below the shared 128 MiB checkpoint cap.
pub const PI_COMPACT_GENERATION_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// A single native JSONL record is never loaded without a separate bound.
pub const PI_JSONL_RECORD_MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RECORDS: usize = 100_000;
const MAX_ENTRY_ID_BYTES: usize = 256;
const MAX_ENTRY_TYPE_BYTES: usize = 64;
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const PI_SESSION_VERSION: u64 = 3;

#[derive(Debug, PartialEq, Eq)]
#[must_use]
pub enum PiHistorySelection {
    Candidate(PiHistoryCandidate),
    Ineligible(PiHistoryIneligibleReason),
}

#[derive(Debug, PartialEq, Eq)]
pub struct PiHistoryCandidate {
    bytes: Vec<u8>,
    source_size: u64,
}

impl PiHistoryCandidate {
    #[must_use]
    pub const fn source_size(&self) -> u64 {
        self.source_size
    }

    #[must_use]
    pub fn candidate_size(&self) -> u64 {
        self.bytes.len() as u64
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PiHistoryIneligibleReason {
    SourceWithinGuard,
    SourceTooLarge,
    InvalidHeader,
    UnsupportedVersion,
    InvalidRecord,
    RecordTooLarge,
    TooManyRecords,
    DuplicateId,
    BrokenBranch,
    NoCompactBoundary,
    InvalidCompactBoundary,
    UnsafeNativeState,
    CandidateTooLarge,
    SourceChanged,
}

impl PiHistoryIneligibleReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SourceWithinGuard => "source_within_guard",
            Self::SourceTooLarge => "source_too_large",
            Self::InvalidHeader => "invalid_header",
            Self::UnsupportedVersion => "unsupported_version",
            Self::InvalidRecord => "invalid_record",
            Self::RecordTooLarge => "record_too_large",
            Self::TooManyRecords => "too_many_records",
            Self::DuplicateId => "duplicate_id",
            Self::BrokenBranch => "broken_branch",
            Self::NoCompactBoundary => "no_compact_boundary",
            Self::InvalidCompactBoundary => "invalid_compact_boundary",
            Self::UnsafeNativeState => "unsafe_native_state",
            Self::CandidateTooLarge => "candidate_too_large",
            Self::SourceChanged => "source_changed",
        }
    }
}

struct EntryMeta {
    parent: Option<String>,
    kind: String,
    first_kept: Option<String>,
    target_id: Option<String>,
    offset: u64,
    record_len: usize,
    sets_thinking: bool,
    sets_model: bool,
}

struct RetainedRecord {
    id: String,
    bytes: Vec<u8>,
}

/// Select a bounded native Pi generation without changing the source file.
///
/// This validates the exact active parent path, keeps the compact's retained
/// pre-boundary entries and later active entries, and carries the most recent
/// earlier model and thinking state records into the new root. The SDK/API must validate
/// the candidate before it is committed; the Guest only replaces the live file
/// after the checkpoint is acknowledged.
///
/// # Errors
/// Returns an I/O error when the source cannot be inspected.
pub fn select_pi_compact_generation(
    source: &mut File,
    expected_session_id: &str,
) -> io::Result<PiHistorySelection> {
    select_with_limit(
        source,
        expected_session_id,
        PI_COMPACT_GENERATION_MAX_BYTES,
        || {},
    )
}

#[doc(hidden)]
/// Select under a smaller candidate limit for bounded integration tests.
///
/// # Errors
/// Returns an I/O error when the source cannot be inspected.
pub fn select_pi_compact_generation_with_candidate_limit_for_test(
    source: &mut File,
    expected_session_id: &str,
    candidate_max_bytes: u64,
) -> io::Result<PiHistorySelection> {
    select_with_limit(source, expected_session_id, candidate_max_bytes, || {})
}

fn select_with_limit(
    source: &mut File,
    expected_session_id: &str,
    candidate_max_bytes: u64,
    before_final_check: impl FnOnce(),
) -> io::Result<PiHistorySelection> {
    use PiHistoryIneligibleReason as Reason;
    let source_size = source.metadata()?.len();
    if source_size <= candidate_max_bytes {
        return Ok(PiHistorySelection::Ineligible(Reason::SourceWithinGuard));
    }
    if source_size > MAX_SOURCE_BYTES {
        return Ok(PiHistorySelection::Ineligible(Reason::SourceTooLarge));
    }
    source.rewind()?;
    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, &mut *source);
    let header = match read_bounded_record(&mut reader, MAX_HEADER_BYTES)? {
        BoundedRecord::Record(bytes) => bytes,
        BoundedRecord::Eof | BoundedRecord::Oversized => {
            return Ok(PiHistorySelection::Ineligible(Reason::InvalidHeader));
        }
    };
    let Ok(header_value) = serde_json::from_slice::<Value>(strip_jsonl_line_ending(&header)) else {
        return Ok(PiHistorySelection::Ineligible(Reason::InvalidHeader));
    };
    if header_value.get("type").and_then(Value::as_str) != Some("session")
        || header_value.get("id").and_then(Value::as_str) != Some(expected_session_id)
    {
        return Ok(PiHistorySelection::Ineligible(Reason::InvalidHeader));
    }
    if header_value.get("version").and_then(Value::as_u64) != Some(PI_SESSION_VERSION) {
        return Ok(PiHistorySelection::Ineligible(Reason::UnsupportedVersion));
    }
    let mut metas: HashMap<String, EntryMeta> = HashMap::new();
    let mut tail: VecDeque<RetainedRecord> = VecDeque::new();
    let mut tail_bytes = 0_u64;
    let mut last_id: Option<String> = None;
    let mut last_session_info_id: Option<String> = None;
    let mut next_offset = header.len() as u64;
    loop {
        let record_offset = next_offset;
        let record = match read_bounded_record(&mut reader, PI_JSONL_RECORD_MAX_BYTES)? {
            BoundedRecord::Eof => break,
            BoundedRecord::Oversized => {
                return Ok(PiHistorySelection::Ineligible(Reason::RecordTooLarge));
            }
            BoundedRecord::Record(record) => record,
        };
        next_offset = next_offset.saturating_add(record.len() as u64);
        let Ok(value) = serde_json::from_slice::<Value>(strip_jsonl_line_ending(&record)) else {
            return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord));
        };
        let (Some(id), Some(kind)) = (
            value.get("id").and_then(Value::as_str),
            value.get("type").and_then(Value::as_str),
        ) else {
            return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord));
        };
        if id.is_empty()
            || id.len() > MAX_ENTRY_ID_BYTES
            || kind.len() > MAX_ENTRY_TYPE_BYTES
            || kind == "session"
            || value.get("parentId").is_none()
        {
            return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord));
        }
        // Pi parses unknown v3 records without schema validation. We cannot
        // prove their global effects or references survive a branch cut, even
        // if the record itself would be retained in the candidate.
        if !matches!(
            kind,
            "message"
                | "thinking_level_change"
                | "model_change"
                | "usage"
                | "compaction"
                | "branch_summary"
                | "custom"
                | "custom_message"
                | "context_edit"
                | "label"
                | "session_info"
        ) {
            return Ok(PiHistorySelection::Ineligible(Reason::UnsafeNativeState));
        }
        let parent = match value.get("parentId") {
            Some(Value::Null) => None,
            Some(Value::String(parent))
                if !parent.is_empty() && parent.len() <= MAX_ENTRY_ID_BYTES =>
            {
                Some(parent.clone())
            }
            _ => return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord)),
        };
        if metas.len() >= MAX_RECORDS {
            return Ok(PiHistorySelection::Ineligible(Reason::TooManyRecords));
        }
        let first_kept = if kind == "compaction" {
            let Some(summary) = value.get("summary").and_then(Value::as_str) else {
                return Ok(PiHistorySelection::Ineligible(
                    Reason::InvalidCompactBoundary,
                ));
            };
            let Some(first) = value.get("firstKeptEntryId").and_then(Value::as_str) else {
                return Ok(PiHistorySelection::Ineligible(
                    Reason::InvalidCompactBoundary,
                ));
            };
            if summary.trim().is_empty() || first.is_empty() || first.len() > MAX_ENTRY_ID_BYTES {
                return Ok(PiHistorySelection::Ineligible(
                    Reason::InvalidCompactBoundary,
                ));
            }
            Some(first.to_owned())
        } else {
            None
        };
        // Pi's v3 session_info.name is optional: a missing name clears the
        // title just like an empty one. Reject only a present non-string value.
        if kind == "session_info" && value.get("name").is_some_and(|name| !name.is_string()) {
            return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord));
        }
        let target_id = if matches!(kind, "label" | "context_edit") {
            match value.get("targetId").and_then(Value::as_str) {
                Some(target) if !target.is_empty() && target.len() <= MAX_ENTRY_ID_BYTES => {
                    Some(target.to_owned())
                }
                _ => return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord)),
            }
        } else {
            None
        };
        let sets_thinking = kind == "thinking_level_change";
        if sets_thinking && value.get("thinkingLevel").and_then(Value::as_str).is_none() {
            return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord));
        }
        let sets_model = kind == "model_change"
            || (kind == "message"
                && value.pointer("/message/role").and_then(Value::as_str) == Some("assistant"));
        if metas
            .insert(
                id.to_owned(),
                EntryMeta {
                    parent,
                    kind: kind.to_owned(),
                    first_kept,
                    target_id,
                    offset: record_offset,
                    record_len: record.len(),
                    sets_thinking,
                    sets_model,
                },
            )
            .is_some()
        {
            return Ok(PiHistorySelection::Ineligible(Reason::DuplicateId));
        }
        last_id = Some(id.to_owned());
        if kind == "session_info" {
            last_session_info_id = Some(id.to_owned());
        }
        tail_bytes = tail_bytes.saturating_add(record.len() as u64);
        tail.push_back(RetainedRecord {
            id: id.to_owned(),
            bytes: record,
        });
        while tail_bytes > candidate_max_bytes {
            let Some(removed) = tail.pop_front() else {
                break;
            };
            tail_bytes -= removed.bytes.len() as u64;
        }
    }
    let observed_eof = reader.stream_position()?;
    before_final_check();
    if observed_eof != source_size || reader.get_ref().metadata()?.len() != source_size {
        return Ok(PiHistorySelection::Ineligible(Reason::SourceChanged));
    }
    drop(reader);
    let Some(mut cursor) = last_id else {
        return Ok(PiHistorySelection::Ineligible(Reason::NoCompactBoundary));
    };
    let mut visited = HashSet::new();
    let mut branch = Vec::new();
    loop {
        if !visited.insert(cursor.clone()) {
            return Ok(PiHistorySelection::Ineligible(Reason::BrokenBranch));
        }
        let Some(meta) = metas.get(&cursor) else {
            return Ok(PiHistorySelection::Ineligible(Reason::BrokenBranch));
        };
        branch.push(cursor.clone());
        let Some(parent) = meta.parent.as_ref() else {
            break;
        };
        if !metas.contains_key(parent) {
            return Ok(PiHistorySelection::Ineligible(Reason::BrokenBranch));
        }
        cursor = parent.clone();
    }
    branch.reverse();
    let Some(compact_index) = branch
        .iter()
        .rposition(|id| metas.get(id).is_some_and(|meta| meta.kind == "compaction"))
    else {
        return Ok(PiHistorySelection::Ineligible(Reason::NoCompactBoundary));
    };
    let Some(first_kept) = branch
        .get(compact_index)
        .and_then(|id| metas.get(id))
        .and_then(|meta| meta.first_kept.as_ref())
    else {
        return Ok(PiHistorySelection::Ineligible(
            Reason::InvalidCompactBoundary,
        ));
    };
    let Some(first_index) = branch
        .get(..=compact_index)
        .and_then(|path| path.iter().position(|id| id == first_kept))
    else {
        return Ok(PiHistorySelection::Ineligible(
            Reason::InvalidCompactBoundary,
        ));
    };
    // Pi uses the compact's own ID when no pre-compact entry is kept. In that
    // case the compact itself starts the retained path and older context is
    // represented only by its summary (plus portable model/title settings).
    let Some(prefix) = branch.get(..first_index) else {
        return Ok(PiHistorySelection::Ineligible(Reason::BrokenBranch));
    };
    // Pi reads the most recent session_info across the entire native file,
    // not just the active branch. A title on an abandoned branch cannot be
    // silently discarded or rebased into a different branch.
    if last_session_info_id
        .as_ref()
        .is_some_and(|id| !branch.contains(id))
    {
        return Ok(PiHistorySelection::Ineligible(Reason::UnsafeNativeState));
    }
    // Summarized model messages may be discarded, but opaque extension data,
    // labels and future record types cannot be proven equivalent after a cut.
    if prefix.iter().any(|id| {
        metas.get(id).is_none_or(|meta| {
            !matches!(
                meta.kind.as_str(),
                "message"
                    | "model_change"
                    | "thinking_level_change"
                    | "branch_summary"
                    | "compaction"
                    | "context_edit"
                    | "session_info"
            )
        })
    }) {
        return Ok(PiHistorySelection::Ineligible(Reason::UnsafeNativeState));
    }
    let last_thinking_id = prefix
        .iter()
        .rev()
        .find(|id| metas.get(*id).is_some_and(|meta| meta.sets_thinking));
    let last_model_id = prefix
        .iter()
        .rev()
        .find(|id| metas.get(*id).is_some_and(|meta| meta.sets_model));
    let Some(retained_path) = branch.get(first_index..) else {
        return Ok(PiHistorySelection::Ineligible(Reason::BrokenBranch));
    };
    let included_ids: HashSet<&str> = retained_path
        .iter()
        .chain(prefix.iter().filter(|id| {
            last_thinking_id == Some(*id)
                || last_model_id == Some(*id)
                || last_session_info_id.as_ref() == Some(*id)
        }))
        .map(String::as_str)
        .collect();
    // Pi labels are global to the file even when their entries are not on the
    // active path. Extensions can likewise inspect custom entries directly.
    if metas.iter().any(|(id, meta)| {
        matches!(meta.kind.as_str(), "label" | "custom" | "custom_message")
            && !included_ids.contains(id.as_str())
    }) {
        return Ok(PiHistorySelection::Ineligible(Reason::UnsafeNativeState));
    }
    if retained_path.iter().any(|id| {
        metas.get(id).is_none_or(|meta| {
            meta.target_id
                .as_deref()
                .is_some_and(|target| !included_ids.contains(target))
        })
    }) {
        return Ok(PiHistorySelection::Ineligible(Reason::UnsafeNativeState));
    }
    let mut record_by_id: HashMap<String, Vec<u8>> = tail
        .into_iter()
        .map(|record| (record.id, record.bytes))
        .collect();
    let mut candidate = Vec::with_capacity(
        usize::try_from(candidate_max_bytes)
            .unwrap_or(0)
            .min(READ_BUFFER_BYTES),
    );
    candidate.extend_from_slice(&header);
    if !header.ends_with(b"\n") {
        candidate.push(b'\n');
    }
    let mut root_parent = None;
    for id in prefix.iter().filter(|id| {
        last_thinking_id == Some(id)
            || last_model_id == Some(id)
            || last_session_info_id.as_ref() == Some(id)
    }) {
        let Some(meta) = metas.get(id) else {
            return Ok(PiHistorySelection::Ineligible(Reason::BrokenBranch));
        };
        let mut raw = vec![0; meta.record_len];
        source.seek(SeekFrom::Start(meta.offset))?;
        source.read_exact(&mut raw)?;
        if serde_json::from_slice::<Value>(strip_jsonl_line_ending(&raw))
            .ok()
            .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned))
            .as_deref()
            != Some(id.as_str())
        {
            return Ok(PiHistorySelection::Ineligible(Reason::SourceChanged));
        }
        let Some(rebased) = reparent(&raw, root_parent) else {
            return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord));
        };
        candidate.extend_from_slice(&rebased);
        if candidate.len() as u64 > candidate_max_bytes {
            return Ok(PiHistorySelection::Ineligible(Reason::CandidateTooLarge));
        }
        root_parent = Some(id.as_str());
    }
    for (index, id) in retained_path.iter().enumerate() {
        let Some(raw) = record_by_id.remove(id) else {
            return Ok(PiHistorySelection::Ineligible(Reason::CandidateTooLarge));
        };
        if index == 0 {
            let Some(rebased) = reparent(&raw, root_parent) else {
                return Ok(PiHistorySelection::Ineligible(Reason::InvalidRecord));
            };
            candidate.extend_from_slice(&rebased);
        } else {
            candidate.extend_from_slice(&raw);
            if !raw.ends_with(b"\n") {
                candidate.push(b'\n');
            }
        }
        if candidate.len() as u64 > candidate_max_bytes {
            return Ok(PiHistorySelection::Ineligible(Reason::CandidateTooLarge));
        }
    }
    // A candidate must be a strict reduction from the inspected source.
    if source.metadata()?.len() != source_size {
        return Ok(PiHistorySelection::Ineligible(Reason::SourceChanged));
    }
    if candidate.len() as u64 >= source_size {
        return Ok(PiHistorySelection::Ineligible(Reason::CandidateTooLarge));
    }
    Ok(PiHistorySelection::Candidate(PiHistoryCandidate {
        bytes: candidate,
        source_size,
    }))
}

fn reparent(raw: &[u8], parent: Option<&str>) -> Option<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(strip_jsonl_line_ending(raw)).ok()?;
    value.as_object_mut()?.insert(
        "parentId".into(),
        parent.map_or(Value::Null, |id| json!(id)),
    );
    let mut bytes = serde_json::to_vec(&value).ok()?;
    bytes.push(b'\n');
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::{PiHistoryIneligibleReason, PiHistorySelection, select_with_limit};
    use std::fs::{File, OpenOptions};
    use std::io::Write;

    #[test]
    fn detects_source_growth_during_selection() {
        let mut file = tempfile::NamedTempFile::new().expect("temporary history");
        for record in [
            serde_json::json!({"type":"session","version":3,"id":"pi-growth","cwd":"/tmp","timestamp":"2026-09-27T00:00:00Z"}),
            serde_json::json!({"type":"message","id":"old","parentId":null,"timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"X".repeat(2048)}}),
            serde_json::json!({"type":"message","id":"kept","parentId":"old","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"kept"}}),
            serde_json::json!({"type":"compaction","id":"compact","parentId":"kept","timestamp":"2026-09-27T00:00:00Z","summary":"summary","firstKeptEntryId":"kept","tokensBefore":1000}),
        ] {
            writeln!(file, "{record}").expect("write fixture");
        }
        let path = file.path().to_owned();
        let result = select_with_limit(
            &mut File::open(&path).expect("open fixture"),
            "pi-growth",
            1024,
            || {
                OpenOptions::new()
                    .append(true)
                    .open(&path)
                    .expect("append fixture")
                    .write_all(b"\n")
                    .expect("append history");
            },
        )
        .expect("inspect fixture");
        assert_eq!(
            result,
            PiHistorySelection::Ineligible(PiHistoryIneligibleReason::SourceChanged)
        );
    }
}
