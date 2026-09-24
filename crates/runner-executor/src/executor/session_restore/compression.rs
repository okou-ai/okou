//! Session-history business policy; the file transport does not choose codecs.
use sandbox::FileCompression;

use super::MaterializedResumeSession;
use crate::telemetry::HistoryCodecDecision;

const MIN_BYTES: usize = 16 * 1024 * 1024;

pub(super) fn select(
    session: &MaterializedResumeSession,
) -> (FileCompression, HistoryCodecDecision) {
    if session.codex_zstd_history().is_some() {
        (FileCompression::None, HistoryCodecDecision::NativeZstd)
    } else if session.history_bytes().len() < MIN_BYTES {
        (FileCompression::None, HistoryCodecDecision::BelowThreshold)
    } else {
        (FileCompression::Zstd, HistoryCodecDecision::AboveThreshold)
    }
}
