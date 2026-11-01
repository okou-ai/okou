use super::UploadMode;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Maximum bytes held for a single line-aligned telemetry read.
const TELEMETRY_DELTA_READ_LIMIT: usize = 256 * 1024;

/// Marker uploaded when a single system-log line is too large to send safely.
const OVERSIZED_SYSTEM_LOG_LINE_MARKER: &str = "[telemetry omitted oversized system log line]\n";

pub(super) struct TextDelta {
    pub(super) content: String,
    pub(super) new_pos: u64,
    pub(super) made_progress: bool,
}

impl TextDelta {
    fn empty(pos: u64) -> Self {
        Self {
            content: String::new(),
            new_pos: pos,
            made_progress: false,
        }
    }

    fn progressed(content: String, new_pos: u64) -> Self {
        Self {
            content,
            new_pos,
            made_progress: true,
        }
    }
}

pub(super) struct JsonlDelta {
    pub(super) entries: Vec<Value>,
    pub(super) new_pos: u64,
    pub(super) made_progress: bool,
}

#[derive(Clone, Copy)]
enum OversizedLineBehavior {
    EmitSystemLogMarker,
    Drop,
}

fn is_line_boundary(file: &mut std::fs::File, pos: u64) -> Option<bool> {
    if pos == 0 {
        return Some(true);
    }

    if file.seek(SeekFrom::Start(pos - 1)).is_err() {
        return None;
    }

    let mut previous = [0u8; 1];
    if file.read_exact(&mut previous).is_err() {
        return None;
    }

    Some(previous[0] == b'\n')
}

fn read_from_line_boundary(
    buf: &[u8],
    base_pos: u64,
    unread_len: u64,
    mode: UploadMode,
    oversized_line_behavior: OversizedLineBehavior,
) -> TextDelta {
    if mode == UploadMode::Final && unread_len <= buf.len() as u64 {
        return TextDelta::progressed(
            String::from_utf8_lossy(buf).into_owned(),
            base_pos + unread_len,
        );
    }

    match buf.iter().rposition(|&b| b == b'\n') {
        Some(idx) => {
            let consumed = idx + 1;
            let new_pos = base_pos + consumed as u64;
            // `consumed <= buf.len()` by construction (rposition returns
            // a valid index into buf, so idx + 1 <= buf.len()), so this
            // `get` always returns Some. The let-else exists only to
            // satisfy `clippy::indexing_slicing = "deny"` without an
            // explicit suppression or `expect`.
            let Some(slice) = buf.get(..consumed) else {
                return TextDelta::empty(base_pos);
            };
            TextDelta::progressed(String::from_utf8_lossy(slice).into_owned(), new_pos)
        }
        None if unread_len <= TELEMETRY_DELTA_READ_LIMIT as u64 => TextDelta::empty(base_pos),
        None => {
            let new_pos = base_pos + buf.len() as u64;
            let content = match oversized_line_behavior {
                OversizedLineBehavior::EmitSystemLogMarker => {
                    OVERSIZED_SYSTEM_LOG_LINE_MARKER.to_string()
                }
                OversizedLineBehavior::Drop => String::new(),
            };
            TextDelta::progressed(content, new_pos)
        }
    }
}

fn read_bounded_at(file: &mut std::fs::File, file_len: u64, pos: u64) -> Option<(Vec<u8>, u64)> {
    let unread_len = file_len.checked_sub(pos)?;
    let to_read = unread_len.min(TELEMETRY_DELTA_READ_LIMIT as u64) as usize;
    let mut buf = vec![0u8; to_read];

    if file.seek(SeekFrom::Start(pos)).is_err() {
        return None;
    }
    if file.read_exact(&mut buf).is_err() {
        return None;
    }

    Some((buf, unread_len))
}

/// Read new bytes from `file_path` starting at the position stored in `pos_path`.
/// Returns the new content, updated position, and whether the position advanced.
///
/// In `Live` mode, the read is aligned to the last newline: any trailing
/// bytes after the last `\n` are treated as an in-progress write by the
/// producer and left for the next pass. This prevents the producer-consumer
/// race from splitting a log line mid-write, which would corrupt UTF-8
/// multibyte characters via `from_utf8_lossy` (the broken byte is replaced
/// by U+FFFD and permanently lost, since the position has already advanced
/// past it).
///
/// In `Final` mode, the tail is consumed as-is when it fits within the bounded
/// read window after any required line-boundary resync.
pub(super) fn read_file_delta(
    file_path: impl AsRef<Path>,
    pos_path: impl AsRef<Path>,
    mode: UploadMode,
) -> TextDelta {
    read_file_delta_with_behavior(
        file_path.as_ref(),
        pos_path.as_ref(),
        mode,
        OversizedLineBehavior::EmitSystemLogMarker,
    )
}

fn read_file_delta_with_behavior(
    file_path: &Path,
    pos_path: &Path,
    mode: UploadMode,
    oversized_line_behavior: OversizedLineBehavior,
) -> TextDelta {
    let last_pos: u64 = std::fs::read_to_string(pos_path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    let mut file = match std::fs::File::open(file_path) {
        Ok(f) => f,
        Err(_) => return TextDelta::empty(last_pos),
    };

    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file_len <= last_pos {
        return TextDelta::empty(last_pos);
    }

    let Some(at_line_boundary) = is_line_boundary(&mut file, last_pos) else {
        return TextDelta::empty(last_pos);
    };

    let Some((buf, unread_len)) = read_bounded_at(&mut file, file_len, last_pos) else {
        return TextDelta::empty(last_pos);
    };

    if !at_line_boundary {
        let Some(idx) = buf.iter().position(|&b| b == b'\n') else {
            return TextDelta::progressed(String::new(), last_pos + buf.len() as u64);
        };

        let consumed = idx + 1;
        let boundary_pos = last_pos + consumed as u64;
        let remaining_unread_len = file_len - boundary_pos;
        let remaining_len = buf.len().saturating_sub(consumed);

        if remaining_unread_len == 0 {
            return TextDelta::progressed(String::new(), boundary_pos);
        }

        if remaining_unread_len <= remaining_len as u64 {
            let Some(remaining) = buf.get(consumed..) else {
                return TextDelta::progressed(String::new(), boundary_pos);
            };

            let delta = read_from_line_boundary(
                remaining,
                boundary_pos,
                remaining_unread_len,
                mode,
                oversized_line_behavior,
            );
            return if delta.made_progress {
                delta
            } else {
                TextDelta::progressed(String::new(), boundary_pos)
            };
        }

        drop(buf);
        let Some((boundary_buf, boundary_unread_len)) =
            read_bounded_at(&mut file, file_len, boundary_pos)
        else {
            return TextDelta::empty(last_pos);
        };
        let delta = read_from_line_boundary(
            &boundary_buf,
            boundary_pos,
            boundary_unread_len,
            mode,
            oversized_line_behavior,
        );
        return if delta.made_progress {
            delta
        } else {
            TextDelta::progressed(String::new(), boundary_pos)
        };
    }

    read_from_line_boundary(&buf, last_pos, unread_len, mode, oversized_line_behavior)
}

/// Read new JSONL entries from a file, skipping invalid lines.
pub(super) fn read_jsonl_delta(
    file_path: impl AsRef<Path>,
    pos_path: impl AsRef<Path>,
    mode: UploadMode,
) -> JsonlDelta {
    let delta = read_file_delta_with_behavior(
        file_path.as_ref(),
        pos_path.as_ref(),
        mode,
        OversizedLineBehavior::Drop,
    );
    if delta.content.is_empty() {
        return JsonlDelta {
            entries: Vec::new(),
            new_pos: delta.new_pos,
            made_progress: delta.made_progress,
        };
    }
    let entries: Vec<Value> = delta
        .content
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    JsonlDelta {
        entries,
        new_pos: delta.new_pos,
        made_progress: delta.made_progress,
    }
}

#[cfg(test)]
mod tests;
