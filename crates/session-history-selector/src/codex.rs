use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};

pub use guest_contracts::session_history::CODEX_COMPACT_GENERATION_MAX_BYTES;
use serde_json::{Map, Value};
use uuid::Uuid;

use super::{
    BoundedRecord, READ_BUFFER_BYTES, SelectionLimits, read_bounded_record, strip_jsonl_line_ending,
};

/// Maximum size of one Codex JSONL record inspected by the selector.
pub const CODEX_JSONL_RECORD_MAX_BYTES: usize = 16 * 1024 * 1024;

const PRODUCTION_LIMITS: SelectionLimits = SelectionLimits {
    candidate_max_bytes: CODEX_COMPACT_GENERATION_MAX_BYTES,
    record_max_bytes: CODEX_JSONL_RECORD_MAX_BYTES,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexHistoryMode {
    Legacy,
    Paginated,
}

#[derive(Clone, Copy, Debug)]
struct OrdinalSequence {
    first: Option<u64>,
    last: Option<u64>,
    valid: bool,
}

impl OrdinalSequence {
    const fn empty() -> Self {
        Self {
            first: None,
            last: None,
            valid: true,
        }
    }

    fn canonical(value: &Value) -> Self {
        let mut sequence = Self::empty();
        sequence.push(value);
        if sequence.first != Some(0) {
            sequence.valid = false;
        }
        sequence
    }

    fn push(&mut self, value: &Value) {
        let Some(ordinal) = value.get("ordinal").and_then(Value::as_u64) else {
            self.valid = false;
            return;
        };
        if self.last.is_some_and(|previous| ordinal <= previous) {
            self.valid = false;
        }
        if self.first.is_none() {
            self.first = Some(ordinal);
        }
        self.last = Some(ordinal);
    }

    fn append(&mut self, suffix: Self) {
        if self
            .last
            .zip(suffix.first)
            .is_some_and(|(previous, next)| next <= previous)
        {
            self.valid = false;
        }
        self.valid &= suffix.valid;
        if self.first.is_none() {
            self.first = suffix.first;
        }
        if suffix.last.is_some() {
            self.last = suffix.last;
        }
    }
}

/// Result of attempting to select a bounded Codex compact generation.
#[derive(Debug, PartialEq, Eq)]
#[must_use]
pub enum CodexHistorySelection {
    /// A structurally valid raw compact generation was selected.
    Candidate(CodexHistoryCandidate),
    /// The source did not have an eligible compact generation.
    Ineligible(CodexHistoryIneligibleReason),
}

/// Raw Codex compact-generation bytes selected for history upload.
#[derive(Debug, PartialEq, Eq)]
pub struct CodexHistoryCandidate {
    bytes: Vec<u8>,
    source_size: u64,
}

impl CodexHistoryCandidate {
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

    /// Borrow the exact raw JSONL bytes selected for history upload.
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

/// Content-free reason that a Codex history was not eligible for pruning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexHistoryIneligibleReason {
    /// The complete source is already within the retained-generation guard.
    SourceWithinGuard,
    /// The canonical first record was missing or malformed.
    InvalidCanonicalMetadata,
    /// The canonical thread identity did not match the saved history identity.
    ThreadIdMismatch,
    /// The canonical history mode was neither legacy nor paginated.
    UnsupportedHistoryMode,
    /// No compacted record was found in the only retained window that can fit.
    NoCompactBoundary,
    /// A retained JSONL record was malformed, incomplete, or unsupported.
    InvalidRecord,
    /// A retained JSONL record exceeded the individual-record limit.
    RecordTooLarge,
    /// The newest compacted record did not contain usable replacement history.
    InvalidCompactBoundary,
    /// The selected compacting or later turn was unbounded or inconsistent.
    InvalidTurn,
    /// The selected compacting or later turn did not retain compatible context.
    MissingTurnContext,
    /// A rollback followed the selected compacted record.
    RollbackAfterCompact,
    /// The selected candidate exceeded its decoded-size limit.
    CandidateTooLarge,
    /// The source EOF changed while the candidate was selected.
    SourceChanged,
}

impl CodexHistoryIneligibleReason {
    /// Return a stable content-free diagnostic label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SourceWithinGuard => "source_within_guard",
            Self::InvalidCanonicalMetadata => "invalid_canonical_metadata",
            Self::ThreadIdMismatch => "thread_id_mismatch",
            Self::UnsupportedHistoryMode => "unsupported_history_mode",
            Self::NoCompactBoundary => "no_compact_boundary",
            Self::InvalidRecord => "invalid_record",
            Self::RecordTooLarge => "record_too_large",
            Self::InvalidCompactBoundary => "invalid_compact_boundary",
            Self::InvalidTurn => "invalid_turn",
            Self::MissingTurnContext => "missing_turn_context",
            Self::RollbackAfterCompact => "rollback_after_compact",
            Self::CandidateTooLarge => "candidate_too_large",
            Self::SourceChanged => "source_changed",
        }
    }
}

#[derive(Debug)]
enum EventRecord<'a> {
    TurnStarted(&'a str),
    UserMessage {
        thread_id: Option<&'a str>,
        turn_id: Option<&'a str>,
    },
    TurnComplete(&'a str),
    TurnAborted,
    ThreadRolledBack,
    Other,
}

#[derive(Debug)]
enum RolloutRecord<'a> {
    Compacted(Result<(), CodexHistoryIneligibleReason>),
    Event(EventRecord<'a>),
    TurnContext(Option<&'a str>),
    Other,
}

struct TurnState {
    id: String,
    start_offset: usize,
    ordinals: Option<OrdinalSequence>,
    saw_user_message: bool,
    saw_compatible_context: bool,
    invalid: Option<CodexHistoryIneligibleReason>,
}

impl TurnState {
    fn new(id: &str, start_offset: usize, track_ordinals: bool) -> Self {
        Self {
            id: id.to_string(),
            start_offset,
            ordinals: track_ordinals.then(OrdinalSequence::empty),
            saw_user_message: false,
            saw_compatible_context: false,
            invalid: None,
        }
    }

    fn invalidate(&mut self, reason: CodexHistoryIneligibleReason) {
        if self.invalid.is_none() {
            self.invalid = Some(reason);
        }
    }

    fn validate_segment(&self) -> Result<(), CodexHistoryIneligibleReason> {
        if let Some(reason) = self.invalid {
            return Err(reason);
        }
        if !self.saw_user_message {
            return Err(CodexHistoryIneligibleReason::InvalidTurn);
        }
        if !self.saw_compatible_context {
            return Err(CodexHistoryIneligibleReason::MissingTurnContext);
        }
        Ok(())
    }
}

struct CandidateState {
    selected_turn_id: String,
    selected_turn_delimited: bool,
    ordinals: Option<OrdinalSequence>,
    invalid: Option<CodexHistoryIneligibleReason>,
}

struct RecordProcessingContext<'a> {
    expected_thread_id: &'a str,
    body_max_bytes: usize,
    canonical_record_len: usize,
    canonical_ordinals: Option<OrdinalSequence>,
}

impl CandidateState {
    fn from_compacting_turn(
        turn: &TurnState,
        compact_validation: Result<(), CodexHistoryIneligibleReason>,
        canonical_ordinals: Option<OrdinalSequence>,
    ) -> Self {
        let invalid = turn.invalid.or_else(|| compact_validation.err());
        let ordinals = canonical_ordinals.and_then(|mut canonical| {
            turn.ordinals.map(|turn| {
                canonical.append(turn);
                canonical
            })
        });
        Self {
            selected_turn_id: turn.id.clone(),
            selected_turn_delimited: false,
            ordinals,
            invalid,
        }
    }

    fn invalidate(&mut self, reason: CodexHistoryIneligibleReason) {
        if self.invalid.is_none() {
            self.invalid = Some(reason);
        }
    }
}

/// Select Codex's latest self-contained raw native compact generation.
///
/// The source handle must refer to a canonical plain legacy or paginated rollout. The
/// source is never modified. Files at or below 64 MiB are left unchanged. For
/// larger files, selection reads only the canonical first record and the final
/// bounded window that can still produce an accepted candidate.
///
/// # Selection contract
///
/// An eligible candidate contains the exact canonical first metadata record,
/// followed by the exact raw records from the native turn containing the newest
/// `compacted` record through the EOF observed during selection. The compacting
/// turn and every retained later turn must preserve a real user-message
/// boundary, compatible turn context, and a native delimiter. Either a matching
/// turn completion or the next turn start can delimit a turn.
///
/// Every newer `compacted` record supersedes the preceding candidate. If the
/// newest boundary is invalid, selection fails closed instead of falling back
/// to an older generation. Retained rollbacks, unsupported rollout or
/// response-item shapes, inconsistent turn relationships, and changes to the
/// observed EOF or source length likewise make the source
/// [`CodexHistorySelection::Ineligible`].
///
/// `Ineligible` is an expected eligibility or compatibility outcome that lets
/// the caller use its ordinary history-upload path. The selector only chooses an
/// in-memory candidate: staging, history upload, and live-file reconciliation
/// remain the caller's responsibility.
///
/// # Errors
///
/// Returns an [`io::Error`] when an underlying file metadata, seek, or read
/// operation fails.
pub fn select_codex_compact_generation(
    source: &mut File,
    expected_thread_id: &str,
) -> io::Result<CodexHistorySelection> {
    select_with_limits_and_hook(source, expected_thread_id, PRODUCTION_LIMITS, || {})
}

/// Select a Codex compact generation with a bounded integration-test window.
#[doc(hidden)]
pub fn select_codex_compact_generation_with_candidate_limit_for_test(
    source: &mut File,
    expected_thread_id: &str,
    candidate_max_bytes: u64,
) -> io::Result<CodexHistorySelection> {
    select_with_limits_and_hook(
        source,
        expected_thread_id,
        SelectionLimits {
            candidate_max_bytes,
            ..PRODUCTION_LIMITS
        },
        || {},
    )
}

fn select_with_limits_and_hook(
    source: &mut File,
    expected_thread_id: &str,
    limits: SelectionLimits,
    before_final_check: impl FnOnce(),
) -> io::Result<CodexHistorySelection> {
    select_with_limits_and_observers(
        source,
        expected_thread_id,
        limits,
        before_final_check,
        |_| {},
        || {},
    )
}

fn select_with_limits_and_observers(
    source: &mut File,
    expected_thread_id: &str,
    limits: SelectionLimits,
    before_final_check: impl FnOnce(),
    mut observe_retained_bytes: impl FnMut(usize),
    mut observe_json_parse: impl FnMut(),
) -> io::Result<CodexHistorySelection> {
    let source_size = source.metadata()?.len();
    if source_size <= limits.candidate_max_bytes {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::SourceWithinGuard,
        ));
    }

    source.seek(SeekFrom::Start(0))?;
    let canonical_record = {
        let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, &mut *source);
        match read_bounded_record(&mut reader, limits.record_max_bytes)? {
            BoundedRecord::Record(record) if record.ends_with(b"\n") => record,
            BoundedRecord::Oversized => {
                return Ok(CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::RecordTooLarge,
                ));
            }
            BoundedRecord::Eof | BoundedRecord::Record(_) => {
                return Ok(CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::InvalidCanonicalMetadata,
                ));
            }
        }
    };

    observe_json_parse();
    let canonical_value =
        match serde_json::from_slice::<Value>(strip_jsonl_line_ending(&canonical_record)) {
            Ok(value) => value,
            Err(_) => {
                return Ok(CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::InvalidCanonicalMetadata,
                ));
            }
        };
    let history_mode = match validate_canonical_metadata(&canonical_value, expected_thread_id) {
        Ok(history_mode) => history_mode,
        Err(reason) => return Ok(CodexHistorySelection::Ineligible(reason)),
    };
    let canonical_ordinals = (history_mode == CodexHistoryMode::Paginated)
        .then(|| OrdinalSequence::canonical(&canonical_value));

    let Some(body_max_bytes) = usize::try_from(limits.candidate_max_bytes)
        .ok()
        .and_then(|max| max.checked_sub(canonical_record.len()))
    else {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::CandidateTooLarge,
        ));
    };
    if body_max_bytes == 0 {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::CandidateTooLarge,
        ));
    }

    let body_window = body_max_bytes as u64;
    let tail_start = source_size.saturating_sub(body_window);
    if tail_start == 0 {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::NoCompactBoundary,
        ));
    }
    source.seek(SeekFrom::Start(tail_start - 1))?;
    let mut preceding_byte = [0_u8; 1];
    source.read_exact(&mut preceding_byte)?;
    source.seek(SeekFrom::Start(tail_start))?;

    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, &mut *source);
    if preceding_byte != *b"\n" {
        match read_bounded_record(&mut reader, limits.record_max_bytes)? {
            BoundedRecord::Eof => {
                return Ok(CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::NoCompactBoundary,
                ));
            }
            BoundedRecord::Record(_) | BoundedRecord::Oversized => {}
        }
    }

    let canonical_record_len = canonical_record.len();
    let processing_context = RecordProcessingContext {
        expected_thread_id,
        body_max_bytes,
        canonical_record_len,
        canonical_ordinals,
    };
    let mut retained_bytes = canonical_record;
    observe_retained_bytes(retained_bytes.len());
    let mut current_turn: Option<TurnState> = None;
    let mut candidate: Option<CandidateState> = None;
    loop {
        match read_bounded_record(&mut reader, limits.record_max_bytes)? {
            BoundedRecord::Eof => break,
            BoundedRecord::Oversized => {
                invalidate_retained_state(
                    &mut current_turn,
                    &mut candidate,
                    CodexHistoryIneligibleReason::RecordTooLarge,
                );
            }
            BoundedRecord::Record(raw_record) if !raw_record.ends_with(b"\n") => {
                invalidate_retained_state(
                    &mut current_turn,
                    &mut candidate,
                    CodexHistoryIneligibleReason::InvalidRecord,
                );
            }
            BoundedRecord::Record(raw_record) => {
                process_record(
                    &raw_record,
                    &processing_context,
                    &mut retained_bytes,
                    &mut current_turn,
                    &mut candidate,
                    &mut observe_retained_bytes,
                    &mut observe_json_parse,
                );
            }
        }
    }

    let observed_eof = reader.stream_position()?;
    before_final_check();
    let final_size = reader.get_ref().metadata()?.len();
    if observed_eof != source_size || final_size != source_size {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::SourceChanged,
        ));
    }

    let Some(mut candidate) = candidate else {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::NoCompactBoundary,
        ));
    };
    if current_turn.is_some() {
        candidate.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
    }
    if !candidate.selected_turn_delimited {
        candidate.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
    }
    if let Some(reason) = candidate.invalid {
        return Ok(CodexHistorySelection::Ineligible(reason));
    }

    if retained_bytes.len() as u64 > limits.candidate_max_bytes {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::CandidateTooLarge,
        ));
    }
    if retained_bytes.len() as u64 >= source_size {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::NoCompactBoundary,
        ));
    }
    if history_mode == CodexHistoryMode::Paginated
        && candidate.ordinals.is_none_or(|ordinals| !ordinals.valid)
    {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::InvalidRecord,
        ));
    }

    Ok(CodexHistorySelection::Candidate(CodexHistoryCandidate {
        bytes: retained_bytes,
        source_size,
    }))
}

fn process_record(
    raw_record: &[u8],
    context: &RecordProcessingContext<'_>,
    retained_bytes: &mut Vec<u8>,
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
    observe_retained_bytes: &mut impl FnMut(usize),
    observe_json_parse: &mut impl FnMut(),
) {
    observe_json_parse();
    let parsed = serde_json::from_slice::<Value>(strip_jsonl_line_ending(raw_record))
        .map_err(|_| CodexHistoryIneligibleReason::InvalidRecord)
        .and_then(|value| {
            validate_rollout_record(&value)?;
            Ok(value)
        });
    let value = match parsed {
        Ok(value) => value,
        Err(reason) => {
            append_to_retained_state(
                raw_record,
                None,
                context,
                retained_bytes,
                current_turn,
                candidate,
                observe_retained_bytes,
            );
            invalidate_retained_state(current_turn, candidate, reason);
            return;
        }
    };
    let record = match classify_rollout_record(&value) {
        Ok(record) => record,
        Err(reason) => {
            append_to_retained_state(
                raw_record,
                None,
                context,
                retained_bytes,
                current_turn,
                candidate,
                observe_retained_bytes,
            );
            invalidate_retained_state(current_turn, candidate, reason);
            return;
        }
    };

    match record {
        RolloutRecord::Event(EventRecord::TurnStarted(turn_id)) => {
            finish_current_turn(
                current_turn,
                candidate,
                retained_bytes,
                context.canonical_record_len,
                observe_retained_bytes,
            );
            *current_turn = Some(TurnState::new(
                turn_id,
                retained_bytes.len(),
                context.canonical_ordinals.is_some(),
            ));
            append_to_retained_state(
                raw_record,
                context.canonical_ordinals.is_some().then_some(&value),
                context,
                retained_bytes,
                current_turn,
                candidate,
                observe_retained_bytes,
            );
        }
        record => {
            append_to_retained_state(
                raw_record,
                context.canonical_ordinals.is_some().then_some(&value),
                context,
                retained_bytes,
                current_turn,
                candidate,
                observe_retained_bytes,
            );
            match record {
                RolloutRecord::Compacted(validation) => {
                    select_compacting_turn(
                        validation,
                        context.canonical_record_len,
                        context.canonical_ordinals,
                        retained_bytes,
                        current_turn,
                        candidate,
                        observe_retained_bytes,
                    );
                }
                RolloutRecord::Event(EventRecord::UserMessage { thread_id, turn_id }) => {
                    if let Some(turn) = current_turn.as_mut() {
                        if thread_id
                            .is_some_and(|thread_id| thread_id != context.expected_thread_id)
                        {
                            turn.invalidate(CodexHistoryIneligibleReason::ThreadIdMismatch);
                        } else if turn_id.is_none_or(|turn_id| turn_id == turn.id) {
                            turn.saw_user_message = true;
                        } else {
                            turn.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                        }
                    } else if let Some(existing) = candidate.as_mut() {
                        existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                    }
                }
                RolloutRecord::TurnContext(turn_id) => {
                    if let Some(turn) = current_turn.as_mut() {
                        if turn_id.is_none_or(|turn_id| turn_id == turn.id) {
                            turn.saw_compatible_context = true;
                        } else {
                            turn.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                        }
                    } else if let Some(existing) = candidate.as_mut() {
                        existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                    }
                }
                RolloutRecord::Event(EventRecord::TurnComplete(turn_id)) => {
                    complete_turn(
                        turn_id,
                        current_turn,
                        candidate,
                        retained_bytes,
                        context.canonical_record_len,
                        observe_retained_bytes,
                    );
                }
                RolloutRecord::Event(EventRecord::TurnAborted) => {
                    if let Some(existing) = candidate.as_mut() {
                        existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                    }
                    *current_turn = None;
                    truncate_unselected_bytes(
                        retained_bytes,
                        context.canonical_record_len,
                        candidate,
                        observe_retained_bytes,
                    );
                }
                RolloutRecord::Event(EventRecord::ThreadRolledBack) => {
                    if let Some(existing) = candidate.as_mut() {
                        existing.invalidate(CodexHistoryIneligibleReason::RollbackAfterCompact);
                    }
                    if let Some(turn) = current_turn.as_mut() {
                        turn.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                    }
                }
                RolloutRecord::Event(EventRecord::TurnStarted(_)) => {}
                RolloutRecord::Event(EventRecord::Other) | RolloutRecord::Other => {}
            }
        }
    }
}

fn append_to_retained_state(
    raw_record: &[u8],
    value: Option<&Value>,
    context: &RecordProcessingContext<'_>,
    retained_bytes: &mut Vec<u8>,
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
    observe_retained_bytes: &mut impl FnMut(usize),
) {
    let current_turn_retains = current_turn
        .as_ref()
        .is_some_and(|turn| turn.invalid.is_none());
    let candidate_retains = candidate
        .as_ref()
        .is_some_and(|candidate| candidate.invalid.is_none());
    if !current_turn_retains && !candidate_retains {
        return;
    }
    let Some(next_body_size) = retained_bytes
        .len()
        .checked_sub(context.canonical_record_len)
        .and_then(|size| size.checked_add(raw_record.len()))
    else {
        invalidate_retained_state(
            current_turn,
            candidate,
            CodexHistoryIneligibleReason::CandidateTooLarge,
        );
        return;
    };
    if next_body_size > context.body_max_bytes {
        invalidate_retained_state(
            current_turn,
            candidate,
            CodexHistoryIneligibleReason::CandidateTooLarge,
        );
        return;
    }
    retained_bytes.extend_from_slice(raw_record);
    if let Some(value) = value {
        if current_turn_retains
            && let Some(ordinals) = current_turn
                .as_mut()
                .and_then(|turn| turn.ordinals.as_mut())
        {
            ordinals.push(value);
        }
        if candidate_retains
            && let Some(ordinals) = candidate
                .as_mut()
                .and_then(|candidate| candidate.ordinals.as_mut())
        {
            ordinals.push(value);
        }
    }
    observe_retained_bytes(retained_bytes.len());
}

fn select_compacting_turn(
    compact_validation: Result<(), CodexHistoryIneligibleReason>,
    canonical_record_len: usize,
    canonical_ordinals: Option<OrdinalSequence>,
    retained_bytes: &mut Vec<u8>,
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
    observe_retained_bytes: &mut impl FnMut(usize),
) {
    let Some(turn) = current_turn.as_mut() else {
        *candidate = Some(CandidateState {
            selected_turn_id: String::new(),
            selected_turn_delimited: false,
            ordinals: canonical_ordinals,
            invalid: Some(CodexHistoryIneligibleReason::InvalidTurn),
        });
        return;
    };
    if candidate.is_some() && turn.start_offset > canonical_record_len {
        let turn_len = retained_bytes.len() - turn.start_offset;
        retained_bytes.copy_within(turn.start_offset.., canonical_record_len);
        retained_bytes.truncate(canonical_record_len + turn_len);
        turn.start_offset = canonical_record_len;
        observe_retained_bytes(retained_bytes.len());
    }
    *candidate = Some(CandidateState::from_compacting_turn(
        turn,
        compact_validation,
        canonical_ordinals,
    ));
}

fn invalidate_retained_state(
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
    reason: CodexHistoryIneligibleReason,
) {
    if let Some(turn) = current_turn.as_mut() {
        turn.invalidate(reason);
    }
    if let Some(existing) = candidate.as_mut() {
        existing.invalidate(reason);
    }
}

fn complete_turn(
    turn_id: &str,
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
    retained_bytes: &mut Vec<u8>,
    canonical_record_len: usize,
    observe_retained_bytes: &mut impl FnMut(usize),
) {
    let Some(turn) = current_turn.take() else {
        if let Some(existing) = candidate.as_mut() {
            existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
        }
        return;
    };
    if turn.id != turn_id {
        if let Some(existing) = candidate.as_mut() {
            existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
        }
        truncate_unselected_bytes(
            retained_bytes,
            canonical_record_len,
            candidate,
            observe_retained_bytes,
        );
        return;
    }
    finish_turn(
        turn,
        candidate,
        retained_bytes,
        canonical_record_len,
        observe_retained_bytes,
    );
}

fn finish_current_turn(
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
    retained_bytes: &mut Vec<u8>,
    canonical_record_len: usize,
    observe_retained_bytes: &mut impl FnMut(usize),
) {
    let Some(turn) = current_turn.take() else {
        return;
    };
    finish_turn(
        turn,
        candidate,
        retained_bytes,
        canonical_record_len,
        observe_retained_bytes,
    );
}

fn finish_turn(
    turn: TurnState,
    candidate: &mut Option<CandidateState>,
    retained_bytes: &mut Vec<u8>,
    canonical_record_len: usize,
    observe_retained_bytes: &mut impl FnMut(usize),
) {
    let validation = turn.validate_segment();
    if let Some(existing) = candidate.as_mut() {
        if existing.selected_turn_id == turn.id {
            existing.selected_turn_delimited = true;
        }
        if let Err(reason) = validation {
            existing.invalidate(reason);
        }
    }
    truncate_unselected_bytes(
        retained_bytes,
        canonical_record_len,
        candidate,
        observe_retained_bytes,
    );
}

fn truncate_unselected_bytes(
    retained_bytes: &mut Vec<u8>,
    canonical_record_len: usize,
    candidate: &Option<CandidateState>,
    observe_retained_bytes: &mut impl FnMut(usize),
) {
    if candidate.is_none() {
        retained_bytes.truncate(canonical_record_len);
        observe_retained_bytes(retained_bytes.len());
    }
}

fn validate_canonical_metadata(
    value: &Value,
    expected_thread_id: &str,
) -> Result<CodexHistoryMode, CodexHistoryIneligibleReason> {
    let object = rollout_object(value)?;
    if object.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err(CodexHistoryIneligibleReason::InvalidCanonicalMetadata);
    }
    let payload = object
        .get("payload")
        .and_then(Value::as_object)
        .ok_or(CodexHistoryIneligibleReason::InvalidCanonicalMetadata)?;
    for field in ["timestamp", "cwd", "originator", "cli_version"] {
        require_string(payload, field)
            .map_err(|_| CodexHistoryIneligibleReason::InvalidCanonicalMetadata)?;
    }
    let expected = Uuid::parse_str(expected_thread_id)
        .map_err(|_| CodexHistoryIneligibleReason::ThreadIdMismatch)?;
    let id = uuid_field(payload, "id")
        .map_err(|_| CodexHistoryIneligibleReason::InvalidCanonicalMetadata)?;
    if id != expected {
        return Err(CodexHistoryIneligibleReason::ThreadIdMismatch);
    }
    if let Some(session_id) = payload.get("session_id") {
        let session_id = session_id
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or(CodexHistoryIneligibleReason::InvalidCanonicalMetadata)?;
        if session_id != expected {
            return Err(CodexHistoryIneligibleReason::ThreadIdMismatch);
        }
    }
    match payload.get("history_mode") {
        None => Ok(CodexHistoryMode::Legacy),
        Some(Value::String(mode)) if mode == "legacy" => Ok(CodexHistoryMode::Legacy),
        Some(Value::String(mode)) if mode == "paginated" => Ok(CodexHistoryMode::Paginated),
        Some(Value::String(_)) => Err(CodexHistoryIneligibleReason::UnsupportedHistoryMode),
        Some(_) => Err(CodexHistoryIneligibleReason::InvalidCanonicalMetadata),
    }
}

fn validate_rollout_record(value: &Value) -> Result<(), CodexHistoryIneligibleReason> {
    let object = rollout_object(value)?;
    let record_type = object
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    let payload = object
        .get("payload")
        .and_then(Value::as_object)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;

    match record_type {
        // A rollout has exactly one canonical metadata record. Seeing
        // another one in the retained suffix makes the thread identity
        // ambiguous, so only the separately validated first record is allowed.
        "session_meta" => Err(CodexHistoryIneligibleReason::InvalidRecord),
        "response_item" => validate_response_item_value(
            object
                .get("payload")
                .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?,
        ),
        "inter_agent_communication" => validate_inter_agent_communication(payload),
        "inter_agent_communication_metadata" => require_bool(payload, "trigger_turn"),
        "compacted" => Ok(()),
        "turn_context" => validate_turn_context_payload(payload),
        "world_state" => validate_world_state_payload(payload),
        "event_msg" => require_nonempty_string(payload, "type").map(|_| ()),
        _ => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn classify_rollout_record(
    value: &Value,
) -> Result<RolloutRecord<'_>, CodexHistoryIneligibleReason> {
    let object = rollout_object(value)?;
    let record_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    let payload = object
        .get("payload")
        .and_then(Value::as_object)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    match record_type {
        "compacted" => Ok(RolloutRecord::Compacted(validate_compacted(payload))),
        "turn_context" => Ok(RolloutRecord::TurnContext(optional_nonempty_string(
            payload, "turn_id",
        )?)),
        "event_msg" => classify_event(payload).map(RolloutRecord::Event),
        _ => Ok(RolloutRecord::Other),
    }
}

fn classify_event(
    payload: &Map<String, Value>,
) -> Result<EventRecord<'_>, CodexHistoryIneligibleReason> {
    match require_nonempty_string(payload, "type")? {
        "task_started" | "turn_started" => {
            require_nonempty_string(payload, "turn_id").map(EventRecord::TurnStarted)
        }
        "user_message" => {
            let thread_id = optional_nonempty_string(payload, "thread_id")?;
            let turn_id = optional_nonempty_string(payload, "turn_id")?;
            Ok(EventRecord::UserMessage { thread_id, turn_id })
        }
        "item_completed" => classify_completed_item(payload),
        "task_complete" | "turn_complete" => {
            require_nonempty_string(payload, "turn_id").map(EventRecord::TurnComplete)
        }
        "turn_aborted" => Ok(EventRecord::TurnAborted),
        "thread_rolled_back" => Ok(EventRecord::ThreadRolledBack),
        _ => Ok(EventRecord::Other),
    }
}

fn classify_completed_item(
    payload: &Map<String, Value>,
) -> Result<EventRecord<'_>, CodexHistoryIneligibleReason> {
    let item = payload
        .get("item")
        .and_then(Value::as_object)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    let item_type = require_nonempty_string(item, "type")?;
    if item_type == "UserMessage" {
        let thread_id = require_nonempty_string(payload, "thread_id")?;
        let turn_id = require_nonempty_string(payload, "turn_id")?;
        return Ok(EventRecord::UserMessage {
            thread_id: Some(thread_id),
            turn_id: Some(turn_id),
        });
    }
    Ok(EventRecord::Other)
}

fn validate_compacted(payload: &Map<String, Value>) -> Result<(), CodexHistoryIneligibleReason> {
    require_string(payload, "message")
        .map_err(|_| CodexHistoryIneligibleReason::InvalidCompactBoundary)?;
    let replacement_history = payload
        .get("replacement_history")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or(CodexHistoryIneligibleReason::InvalidCompactBoundary)?;
    for item in replacement_history {
        validate_response_item_value(item)
            .map_err(|_| CodexHistoryIneligibleReason::InvalidCompactBoundary)?;
    }
    if payload
        .get("window_number")
        .is_some_and(|value| value.as_u64().is_none())
    {
        return Err(CodexHistoryIneligibleReason::InvalidCompactBoundary);
    }
    for field in ["first_window_id", "previous_window_id", "window_id"] {
        if let Some(value) = payload.get(field)
            && !value.is_null()
            && value
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
                .is_none()
        {
            return Err(CodexHistoryIneligibleReason::InvalidCompactBoundary);
        }
    }
    Ok(())
}

fn validate_response_item_value(value: &Value) -> Result<(), CodexHistoryIneligibleReason> {
    let object = value
        .as_object()
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    let item_type = require_nonempty_string(object, "type")?;
    match item_type {
        "additional_tools" => {
            require_nonempty_string(object, "role")?;
            require_array(object, "tools")
        }
        "message" => {
            require_nonempty_string(object, "role")?;
            require_array(object, "content")
        }
        "agent_message" => {
            require_nonempty_string(object, "author")?;
            require_nonempty_string(object, "recipient")?;
            require_array(object, "content")
        }
        "reasoning" => {
            require_array(object, "summary")?;
            require_optional_string(object, "encrypted_content")
        }
        "local_shell_call" => {
            require_optional_string(object, "call_id")?;
            require_nonempty_string(object, "status")?;
            require_object(object, "action")
        }
        "function_call" => {
            require_nonempty_string(object, "name")?;
            require_string(object, "arguments")?;
            require_nonempty_string(object, "call_id").map(|_| ())
        }
        "tool_search_call" => {
            require_optional_string(object, "call_id")?;
            require_nonempty_string(object, "execution")?;
            object
                .contains_key("arguments")
                .then_some(())
                .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
        }
        "function_call_output" | "custom_tool_call_output" => {
            require_nonempty_string(object, "call_id")?;
            validate_output(object.get("output"))
        }
        "custom_tool_call" => {
            require_nonempty_string(object, "call_id")?;
            require_nonempty_string(object, "name")?;
            require_string(object, "input").map(|_| ())
        }
        "tool_search_output" => {
            require_optional_string(object, "call_id")?;
            require_nonempty_string(object, "status")?;
            require_nonempty_string(object, "execution")?;
            require_array(object, "tools")
        }
        "web_search_call" => Ok(()),
        "image_generation_call" => {
            require_nonempty_string(object, "status")?;
            require_string(object, "result").map(|_| ())
        }
        "compaction" | "compaction_summary" => {
            require_nonempty_string(object, "encrypted_content").map(|_| ())
        }
        "compaction_trigger" => Ok(()),
        "context_compaction" => require_optional_string(object, "encrypted_content"),
        _ => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn validate_output(value: Option<&Value>) -> Result<(), CodexHistoryIneligibleReason> {
    match value {
        Some(Value::String(_)) | Some(Value::Array(_)) => Ok(()),
        Some(_) | None => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn validate_inter_agent_communication(
    payload: &Map<String, Value>,
) -> Result<(), CodexHistoryIneligibleReason> {
    require_nonempty_string(payload, "author")?;
    require_nonempty_string(payload, "recipient")?;
    require_string(payload, "content")?;
    require_bool(payload, "trigger_turn")
}

fn validate_turn_context_payload(
    payload: &Map<String, Value>,
) -> Result<(), CodexHistoryIneligibleReason> {
    optional_nonempty_string(payload, "turn_id")?;
    require_nonempty_string(payload, "cwd")?;
    require_nonempty_string(payload, "model")?;
    require_nonempty_string_or_object(payload, "approval_policy")?;
    require_object(payload, "sandbox_policy")?;
    require_nonempty_string(payload, "summary").map(|_| ())
}

fn validate_world_state_payload(
    payload: &Map<String, Value>,
) -> Result<(), CodexHistoryIneligibleReason> {
    require_bool(payload, "full")?;
    payload
        .contains_key("state")
        .then_some(())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

fn rollout_object(value: &Value) -> Result<&Map<String, Value>, CodexHistoryIneligibleReason> {
    let object = value
        .as_object()
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    require_nonempty_string(object, "timestamp")?;
    if object
        .get("ordinal")
        .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
    {
        return Err(CodexHistoryIneligibleReason::InvalidRecord);
    }
    Ok(object)
}

fn uuid_field(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Uuid, CodexHistoryIneligibleReason> {
    require_nonempty_string(object, field)?
        .parse()
        .map_err(|_| CodexHistoryIneligibleReason::InvalidRecord)
}

fn require_nonempty_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CodexHistoryIneligibleReason> {
    let value = require_string(object, field)?;
    if value.is_empty() {
        return Err(CodexHistoryIneligibleReason::InvalidRecord);
    }
    Ok(value)
}

fn require_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CodexHistoryIneligibleReason> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

fn optional_nonempty_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a str>, CodexHistoryIneligibleReason> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value)),
        Some(_) => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn require_optional_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    match object.get(field) {
        None | Some(Value::Null | Value::String(_)) => Ok(()),
        Some(_) => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn require_array(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    object
        .get(field)
        .and_then(Value::as_array)
        .map(|_| ())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

fn require_object(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    object
        .get(field)
        .and_then(Value::as_object)
        .map(|_| ())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

fn require_nonempty_string_or_object(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    match object.get(field) {
        Some(Value::String(value)) if !value.is_empty() => Ok(()),
        Some(Value::Object(value)) if !value.is_empty() => Ok(()),
        Some(_) | None => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn require_bool(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    object
        .get(field)
        .and_then(Value::as_bool)
        .map(|_| ())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, Write};

    use serde_json::json;
    use tempfile::NamedTempFile;

    use super::*;

    const THREAD_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TURN_ID: &str = "turn-1";
    const TEST_LIMITS: SelectionLimits = SelectionLimits {
        candidate_max_bytes: 8 * 1024,
        record_max_bytes: 2 * 1024,
    };

    fn line(record_type: &str, payload: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&json!({
            "timestamp": "2026-07-26T00:00:00Z",
            "type": record_type,
            "payload": payload,
        }))
        .unwrap();
        bytes.push(b'\n');
        bytes
    }

    fn with_ordinal(record: &[u8], ordinal: u64) -> Vec<u8> {
        with_ordinal_value(record, Some(json!(ordinal)))
    }

    fn with_ordinal_value(record: &[u8], ordinal: Option<Value>) -> Vec<u8> {
        let mut value = serde_json::from_slice::<Value>(strip_jsonl_line_ending(record)).unwrap();
        match ordinal {
            Some(ordinal) => value["ordinal"] = ordinal,
            None => {
                value.as_object_mut().unwrap().remove("ordinal");
            }
        }
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }

    fn canonical(history_mode: Option<&str>) -> Vec<u8> {
        let mut payload = json!({
            "id": THREAD_ID,
            "session_id": THREAD_ID,
            "timestamp": "2026-07-26T00:00:00Z",
            "cwd": "/workspace",
            "originator": "codex",
            "cli_version": "0.144.6",
            "source": "cli",
        });
        if let Some(history_mode) = history_mode {
            payload["history_mode"] = json!(history_mode);
        }
        line("session_meta", payload)
    }

    fn event(event_type: &str, extra: Value) -> Vec<u8> {
        let mut payload = json!({"type": event_type});
        payload.as_object_mut().unwrap().extend(
            extra
                .as_object()
                .expect("event extra must be an object")
                .clone(),
        );
        line("event_msg", payload)
    }

    fn turn_started(turn_id: &str) -> Vec<u8> {
        event("task_started", json!({"turn_id": turn_id}))
    }

    fn user_message() -> Vec<u8> {
        event("user_message", json!({"message": "hello"}))
    }

    fn paginated_user_message_for_thread(thread_id: &str, turn_id: &str) -> Vec<u8> {
        event(
            "item_completed",
            json!({
                "thread_id": thread_id,
                "turn_id": turn_id,
                "item": {
                    "type": "UserMessage",
                    "id": "user-message-1",
                    "content": [{
                        "type": "text",
                        "text": "hello",
                        "text_elements": [],
                    }],
                },
                "completed_at_ms": 1_785_024_000_000_i64,
            }),
        )
    }

    fn paginated_user_message(turn_id: &str) -> Vec<u8> {
        paginated_user_message_for_thread(THREAD_ID, turn_id)
    }

    fn turn_context(turn_id: &str) -> Vec<u8> {
        line(
            "turn_context",
            json!({
                "turn_id": turn_id,
                "cwd": "/workspace",
                "approval_policy": "never",
                "sandbox_policy": {"type": "read_only", "network_access": false},
                "model": "gpt-test",
                "summary": "auto",
            }),
        )
    }

    fn compacted(message: &str) -> Vec<u8> {
        line(
            "compacted",
            json!({
                "message": message,
                "replacement_history": [{
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": message}],
                }],
                "window_number": 2,
                "first_window_id": "019c0000-0000-7000-8000-000000000001",
                "previous_window_id": "019c0000-0000-7000-8000-000000000002",
                "window_id": "019c0000-0000-7000-8000-000000000003",
            }),
        )
    }

    fn turn_complete(turn_id: &str) -> Vec<u8> {
        event("task_complete", json!({"turn_id": turn_id}))
    }

    fn source(records: &[Vec<u8>]) -> NamedTempFile {
        source_with_history_mode(records, "legacy")
    }

    fn source_with_history_mode(records: &[Vec<u8>], history_mode: &str) -> NamedTempFile {
        let canonical = canonical(Some(history_mode));
        let canonical = if history_mode == "paginated" {
            with_ordinal(&canonical, 0)
        } else {
            canonical
        };
        let encoded_records = records
            .iter()
            .enumerate()
            .map(|(index, record)| {
                if history_mode == "paginated" {
                    with_ordinal(record, index as u64 + 2)
                } else {
                    record.clone()
                }
            })
            .collect::<Vec<_>>();
        source_with_encoded_records(canonical, &encoded_records, history_mode)
    }

    fn source_with_encoded_records(
        canonical: Vec<u8>,
        records: &[Vec<u8>],
        history_mode: &str,
    ) -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(&canonical).unwrap();
        let retained_len: usize = records.iter().map(Vec::len).sum();
        let filler_len = TEST_LIMITS
            .candidate_max_bytes
            .saturating_sub(retained_len as u64)
            .saturating_add(512) as usize;
        let filler = line(
            "response_item",
            json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "x".repeat(filler_len)}],
            }),
        );
        let filler = if history_mode == "paginated" {
            with_ordinal(&filler, 1)
        } else {
            filler
        };
        file.write_all(&filler).unwrap();
        for record in records {
            file.write_all(record).unwrap();
        }
        file.flush().unwrap();
        file
    }

    fn paginated_source_with_ordinals(
        canonical_ordinal: Option<Value>,
        records: &[Vec<u8>],
        ordinals: &[Option<Value>],
    ) -> NamedTempFile {
        assert_eq!(records.len(), ordinals.len());
        let canonical = with_ordinal_value(&canonical(Some("paginated")), canonical_ordinal);
        let encoded_records = records
            .iter()
            .zip(ordinals)
            .map(|(record, ordinal)| with_ordinal_value(record, ordinal.clone()))
            .collect::<Vec<_>>();
        source_with_encoded_records(canonical, &encoded_records, "paginated")
    }

    fn complete_generation(summary: &str) -> Vec<Vec<u8>> {
        vec![
            turn_started(TURN_ID),
            user_message(),
            turn_context(TURN_ID),
            compacted(summary),
            turn_complete(TURN_ID),
        ]
    }

    fn complete_paginated_generation(turn_id: &str, summary: &str) -> Vec<Vec<u8>> {
        vec![
            turn_started(turn_id),
            paginated_user_message(turn_id),
            turn_context(turn_id),
            compacted(summary),
            turn_complete(turn_id),
        ]
    }

    fn select(file: &NamedTempFile) -> io::Result<CodexHistorySelection> {
        let mut source = file.reopen()?;
        select_with_limits_and_hook(&mut source, THREAD_ID, TEST_LIMITS, || {})
    }

    fn candidate_bytes(selection: CodexHistorySelection) -> Vec<u8> {
        match selection {
            CodexHistorySelection::Candidate(candidate) => {
                let borrowed = candidate.as_bytes().to_vec();
                assert_eq!(candidate.candidate_size(), borrowed.len() as u64);
                assert_eq!(candidate.into_bytes(), borrowed);
                borrowed
            }
            CodexHistorySelection::Ineligible(reason) => {
                panic!("expected candidate, got {reason:?}")
            }
        }
    }

    #[test]
    fn preserves_canonical_metadata_and_complete_compacting_turn_exactly() {
        let generation = complete_generation("latest summary");
        let file = source(&generation);

        let selected = candidate_bytes(select(&file).unwrap());
        let expected = std::iter::once(canonical(Some("legacy")))
            .chain(generation)
            .flatten()
            .collect::<Vec<_>>();

        assert_eq!(selected, expected);
    }

    #[test]
    fn preserves_paginated_generation_with_completed_user_item() {
        let generation = vec![
            turn_started(TURN_ID),
            paginated_user_message(TURN_ID),
            turn_context(TURN_ID),
            compacted("latest summary"),
            turn_complete(TURN_ID),
        ];
        let file = source_with_history_mode(&generation, "paginated");

        let selected = candidate_bytes(select(&file).unwrap());
        let expected_generation = generation
            .iter()
            .enumerate()
            .map(|(index, record)| with_ordinal(record, index as u64 + 2));
        let expected = std::iter::once(with_ordinal(&canonical(Some("paginated")), 0))
            .chain(expected_generation)
            .flatten()
            .collect::<Vec<_>>();

        assert_eq!(selected, expected);
    }

    #[test]
    fn paginated_candidate_requires_present_increasing_ordinals() {
        let records = complete_paginated_generation(TURN_ID, "summary");
        let valid_ordinals = [10_u64, 20, 30, 40, 50].map(|ordinal| Some(json!(ordinal)));
        let file = paginated_source_with_ordinals(Some(json!(0)), &records, &valid_ordinals);
        assert!(matches!(
            select(&file).unwrap(),
            CodexHistorySelection::Candidate(_)
        ));

        for canonical_ordinal in [None, Some(json!(1))] {
            let file = paginated_source_with_ordinals(canonical_ordinal, &records, &valid_ordinals);
            assert_eq!(
                select(&file).unwrap(),
                CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
            );
        }

        let mut boundary_reset = valid_ordinals.clone();
        boundary_reset[0] = Some(json!(0));
        let file = paginated_source_with_ordinals(Some(json!(0)), &records, &boundary_reset);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
        );

        for invalid_ordinal in [
            None,
            Some(json!("40")),
            Some(json!(-1)),
            Some(json!(40.5)),
            Some(json!(40)),
            Some(json!(39)),
            Some(json!(0)),
        ] {
            let mut ordinals = valid_ordinals.clone();
            ordinals[4] = invalid_ordinal;
            let file = paginated_source_with_ordinals(Some(json!(0)), &records, &ordinals);
            assert_eq!(
                select(&file).unwrap(),
                CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
            );
        }
    }

    #[test]
    fn paginated_candidate_replaces_discarded_ordinal_state() {
        let mut records = complete_paginated_generation(TURN_ID, "older");
        let newer = complete_paginated_generation("turn-2", "newer");
        records.extend(newer.clone());
        let ordinals = [
            Some(json!(100)),
            None,
            Some(json!(102)),
            Some(json!(103)),
            Some(json!(104)),
            Some(json!(1)),
            Some(json!(2)),
            Some(json!(3)),
            Some(json!(4)),
            Some(json!(5)),
        ];
        let file = paginated_source_with_ordinals(Some(json!(0)), &records, &ordinals);

        let selected = candidate_bytes(select(&file).unwrap());
        let expected = std::iter::once(with_ordinal(&canonical(Some("paginated")), 0))
            .chain(
                newer
                    .iter()
                    .enumerate()
                    .map(|(index, record)| with_ordinal(record, index as u64 + 1)),
            )
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(selected, expected);

        let mut invalid_newer = ordinals;
        invalid_newer[8] = Some(json!(2));
        let file = paginated_source_with_ordinals(Some(json!(0)), &records, &invalid_newer);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
        );
    }

    #[test]
    fn paginated_candidate_ignores_pre_candidate_ordinals_and_checks_later_turns() {
        let pre_candidate = line("event_msg", json!({"type": "warning", "message": "old"}));
        let generation = complete_paginated_generation(TURN_ID, "summary");
        let mut records = vec![pre_candidate];
        records.extend(generation);
        let ordinals = [
            None,
            Some(json!(10)),
            Some(json!(11)),
            Some(json!(12)),
            Some(json!(13)),
            Some(json!(14)),
        ];
        let file = paginated_source_with_ordinals(Some(json!(0)), &records, &ordinals);
        assert!(matches!(
            select(&file).unwrap(),
            CodexHistorySelection::Candidate(_)
        ));

        records.extend([
            turn_started("turn-2"),
            paginated_user_message("turn-2"),
            turn_context("turn-2"),
            turn_complete("turn-2"),
        ]);
        let later_reset = [
            None,
            Some(json!(10)),
            Some(json!(11)),
            Some(json!(12)),
            Some(json!(13)),
            Some(json!(14)),
            Some(json!(15)),
            Some(json!(16)),
            Some(json!(2)),
            Some(json!(18)),
        ];
        let file = paginated_source_with_ordinals(Some(json!(0)), &records, &later_reset);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
        );
    }

    #[test]
    fn paginated_candidate_parses_each_retained_record_once() {
        let generation = complete_paginated_generation(TURN_ID, "summary");
        let file = source_with_history_mode(&generation, "paginated");
        let mut source = file.reopen().unwrap();
        let mut parsed_records = 0;

        let selection = select_with_limits_and_observers(
            &mut source,
            THREAD_ID,
            TEST_LIMITS,
            || {},
            |_| {},
            || parsed_records += 1,
        )
        .unwrap();
        let selected = candidate_bytes(selection);
        let retained_records = selected.iter().filter(|byte| **byte == b'\n').count();

        assert_eq!(parsed_records, retained_records);
    }

    #[test]
    fn paginated_candidate_rejects_user_message_for_another_thread() {
        let generation = vec![
            turn_started(TURN_ID),
            paginated_user_message_for_thread("cccccccc-cccc-4ccc-8ccc-cccccccccccc", TURN_ID),
            turn_context(TURN_ID),
            compacted("latest summary"),
            turn_complete(TURN_ID),
        ];
        let file = source_with_history_mode(&generation, "paginated");

        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::ThreadIdMismatch)
        );
    }

    #[test]
    fn latest_invalid_compaction_supersedes_an_older_generation() {
        let mut records = complete_generation("older");
        records.extend([
            turn_started("turn-2"),
            user_message(),
            turn_context("turn-2"),
            line(
                "compacted",
                json!({"message": "latest", "replacement_history": []}),
            ),
            turn_complete("turn-2"),
        ]);
        let file = source(&records);

        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidCompactBoundary)
        );
    }

    #[test]
    fn retains_complete_later_turns_after_the_selected_compaction() {
        let mut records = complete_generation("summary");
        let later = [
            turn_started("turn-2"),
            user_message(),
            turn_context("turn-2"),
            line(
                "response_item",
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}],
                }),
            ),
            turn_complete("turn-2"),
        ];
        records.extend(later.clone());
        let file = source(&records);

        let selected = candidate_bytes(select(&file).unwrap());

        assert!(selected.ends_with(&later.concat()));
    }

    #[test]
    fn bounds_near_limit_retained_bytes_to_one_candidate_window() {
        let mut records = complete_generation("older summary");
        records.push(event("thread_rolled_back", json!({"num_turns": 1})));
        let mut latest = vec![
            turn_started("turn-2"),
            user_message(),
            turn_context("turn-2"),
        ];
        latest.extend((0..5).map(|index| {
            line(
                "response_item",
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": format!("chunk-{index}-{}", "x".repeat(900)),
                    }],
                }),
            )
        }));
        latest.extend([compacted("newer summary"), turn_complete("turn-2")]);
        records.extend(latest.clone());
        let file = source(&records);
        let mut source = file.reopen().unwrap();
        let mut peak_retained_bytes = 0;

        let selection = select_with_limits_and_observers(
            &mut source,
            THREAD_ID,
            TEST_LIMITS,
            || {},
            |retained_bytes| {
                peak_retained_bytes = peak_retained_bytes.max(retained_bytes);
            },
            || {},
        )
        .unwrap();
        let selected = candidate_bytes(selection);
        let expected = std::iter::once(canonical(Some("legacy")))
            .chain(latest)
            .flatten()
            .collect::<Vec<_>>();
        let candidate_limit = TEST_LIMITS.candidate_max_bytes as usize;

        assert_eq!(selected, expected);
        assert!(selected.len() > candidate_limit * 3 / 4);
        assert!(peak_retained_bytes <= candidate_limit);
    }

    #[test]
    fn accepts_compacting_turn_delimited_by_the_next_turn_start() {
        let records = [
            turn_started(TURN_ID),
            user_message(),
            turn_context(TURN_ID),
            compacted("summary"),
            turn_started("turn-2"),
            turn_context("turn-2"),
            user_message(),
            line(
                "response_item",
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}],
                }),
            ),
            turn_complete("turn-2"),
        ];
        let file = source(&records);

        let selected = candidate_bytes(select(&file).unwrap());
        let expected = std::iter::once(canonical(Some("legacy")))
            .chain(records)
            .flatten()
            .collect::<Vec<_>>();

        assert_eq!(selected, expected);
    }

    #[test]
    fn rejects_missing_context_incomplete_turn_and_rollback() {
        let missing_context = [
            turn_started(TURN_ID),
            user_message(),
            compacted("summary"),
            turn_complete(TURN_ID),
        ];
        let file = source(&missing_context);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::MissingTurnContext)
        );

        let incomplete = [
            turn_started(TURN_ID),
            user_message(),
            turn_context(TURN_ID),
            compacted("summary"),
        ];
        let file = source(&incomplete);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidTurn)
        );

        let mut rolled_back = complete_generation("summary");
        rolled_back.push(event("thread_rolled_back", json!({"num_turns": 1})));
        let file = source(&rolled_back);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::RollbackAfterCompact)
        );

        let mut incomplete_later = complete_generation("summary");
        incomplete_later.extend([
            turn_started("turn-2"),
            user_message(),
            turn_context("turn-2"),
        ]);
        let file = source(&incomplete_later);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidTurn)
        );
    }

    #[test]
    fn accepts_omitted_mode_and_rejects_unsupported_modes_and_wrong_thread_id() {
        let generation = complete_generation("summary");
        let mut file = source(&generation);
        file.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        file.as_file_mut().write_all(&canonical(None)).unwrap();
        file.as_file_mut().flush().unwrap();
        let selected = candidate_bytes(select(&file).unwrap());
        let expected = std::iter::once(canonical(None))
            .chain(generation)
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(selected, expected);

        let mut file = source(&complete_generation("summary"));
        file.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        file.as_file_mut()
            .write_all(&canonical(Some("future")))
            .unwrap();
        file.as_file_mut().flush().unwrap();
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::UnsupportedHistoryMode)
        );

        let file = source(&complete_generation("summary"));
        let mut source_file = file.reopen().unwrap();
        assert_eq!(
            select_with_limits_and_hook(
                &mut source_file,
                "99999999-9999-4999-8999-999999999999",
                TEST_LIMITS,
                || {},
            )
            .unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::ThreadIdMismatch)
        );

        let mut file = source(&complete_generation("summary"));
        file.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        file.as_file_mut()
            .write_all(&line(
                "session_meta",
                json!({"id": THREAD_ID, "session_id": THREAD_ID}),
            ))
            .unwrap();
        file.as_file_mut().flush().unwrap();
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(
                CodexHistoryIneligibleReason::InvalidCanonicalMetadata
            )
        );
    }

    #[test]
    fn rejects_malformed_oversized_and_unknown_retained_records() {
        for bad_record in [
            b"{not-json}\n".to_vec(),
            vec![0xff, b'\n'],
            line("future_record", json!({})),
            canonical(Some("legacy")),
            line(
                "response_item",
                json!({"type": "future_response_item", "value": "unknown"}),
            ),
            line("world_state", json!({"full": "yes", "state": {}})),
        ] {
            let mut records = complete_generation("summary");
            records.insert(records.len() - 1, bad_record);
            let file = source(&records);
            assert_eq!(
                select(&file).unwrap(),
                CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
            );
        }

        let mut records = complete_generation("summary");
        records.insert(
            records.len() - 1,
            line(
                "event_msg",
                json!({"type": "warning", "message": "x".repeat(4096)}),
            ),
        );
        let file = source(&records);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::RecordTooLarge)
        );

        let mut records = complete_generation("summary");
        records.push(b"{\"timestamp\":\"partial\"}".to_vec());
        let file = source(&records);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
        );
    }

    #[test]
    fn detects_source_growth_before_acceptance() {
        let mut file = source(&complete_generation("summary"));
        let path = file.path().to_owned();
        let mut source = file.reopen().unwrap();

        let selection = select_with_limits_and_hook(&mut source, THREAD_ID, TEST_LIMITS, || {
            file.as_file_mut().seek(SeekFrom::End(0)).unwrap();
            file.as_file_mut().write_all(b"changed\n").unwrap();
            file.as_file_mut().flush().unwrap();
        })
        .unwrap();

        assert_eq!(
            selection,
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::SourceChanged)
        );
        assert!(path.exists());
    }

    #[test]
    fn source_within_guard_is_not_scanned() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"not json").unwrap();
        let mut source = file.reopen().unwrap();

        assert_eq!(
            select_with_limits_and_hook(&mut source, THREAD_ID, TEST_LIMITS, || {}).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::SourceWithinGuard)
        );
    }
}

#[cfg(test)]
mod property_tests;
