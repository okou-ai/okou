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
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct DeltaFixture {
        _dir: tempfile::TempDir,
        file: PathBuf,
        pos: PathBuf,
    }

    impl DeltaFixture {
        fn text() -> Self {
            Self::new("log.txt", "log.pos")
        }

        fn jsonl() -> Self {
            Self::new("data.jsonl", "data.pos")
        }

        fn new(file_name: &str, pos_name: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join(file_name);
            let pos = dir.path().join(pos_name);
            Self {
                _dir: dir,
                file,
                pos,
            }
        }

        fn write_file(&self, content: impl AsRef<[u8]>) {
            fs::write(&self.file, content).unwrap();
        }

        fn write_pos(&self, pos: u64) {
            self.write_pos_raw(pos.to_string());
        }

        fn write_pos_raw(&self, content: impl AsRef<[u8]>) {
            fs::write(&self.pos, content).unwrap();
        }

        fn read_text(&self, mode: UploadMode) -> TextDelta {
            read_file_delta(&self.file, &self.pos, mode)
        }

        fn read_text_parts(&self, mode: UploadMode) -> (String, u64) {
            let delta = self.read_text(mode);
            (delta.content, delta.new_pos)
        }

        fn read_jsonl(&self, mode: UploadMode) -> JsonlDelta {
            read_jsonl_delta(&self.file, &self.pos, mode)
        }

        fn read_jsonl_parts(&self, mode: UploadMode) -> (Vec<Value>, u64) {
            let delta = self.read_jsonl(mode);
            (delta.entries, delta.new_pos)
        }
    }

    #[test]
    fn read_file_delta_from_start() {
        let fixture = DeltaFixture::text();
        fixture.write_file("hello world\n");

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content, "hello world\n");
        assert_eq!(new_pos, 12);
    }

    #[test]
    fn read_file_delta_incremental() {
        let fixture = DeltaFixture::text();
        fixture.write_file("hello\nworld\n");
        // Simulate having already consumed the first complete line.
        fixture.write_pos(6);

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content, "world\n");
        assert_eq!(new_pos, 12);
    }

    #[test]
    fn read_file_delta_from_middle_of_line_skips_suffix_then_resumes() {
        let fixture = DeltaFixture::text();
        fixture.write_file("hello world\nnext\n");
        fixture.write_pos(6);

        let delta = fixture.read_text(UploadMode::Live);
        assert_eq!(delta.content, "next\n");
        assert_eq!(delta.new_pos, 17);
        assert!(delta.made_progress);
    }

    #[test]
    fn read_file_delta_no_new_data() {
        let fixture = DeltaFixture::text();
        fixture.write_file("done");
        fixture.write_pos(4);

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert!(content.is_empty());
        assert_eq!(new_pos, 4);
    }

    #[test]
    fn read_file_delta_missing_file() {
        let fixture = DeltaFixture::new("missing.txt", "missing.pos");

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert!(content.is_empty());
        assert_eq!(new_pos, 0);
    }

    #[test]
    fn read_jsonl_delta_parses_valid_lines() {
        let fixture = DeltaFixture::jsonl();
        fixture.write_file("{\"a\":1}\n{\"b\":2}\ninvalid\n");

        let (entries, new_pos) = fixture.read_jsonl_parts(UploadMode::Live);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["a"], 1);
        assert_eq!(entries[1]["b"], 2);
        assert!(new_pos > 0);
    }

    #[test]
    fn read_file_delta_truncated_file() {
        // Position file says we read 100 bytes, but file is shorter → no new data.
        let fixture = DeltaFixture::text();
        fixture.write_file("short");
        fixture.write_pos(100);

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert!(content.is_empty());
        assert_eq!(new_pos, 100);
    }

    #[test]
    fn read_file_delta_corrupt_pos_file() {
        // Corrupt position file → starts from 0.
        let fixture = DeltaFixture::text();
        fixture.write_file("data\n");
        fixture.write_pos_raw("notanumber");

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content, "data\n");
        assert_eq!(new_pos, 5);
    }

    #[test]
    fn read_jsonl_delta_empty_file() {
        let fixture = DeltaFixture::new("empty.jsonl", "empty.pos");
        fixture.write_file("");

        let (entries, new_pos) = fixture.read_jsonl_parts(UploadMode::Live);
        assert!(entries.is_empty());
        assert_eq!(new_pos, 0);
    }

    #[test]
    fn read_jsonl_delta_all_invalid_lines() {
        let fixture = DeltaFixture::new("bad.jsonl", "bad.pos");
        fixture.write_file("bad1\nbad2\nbad3\n");

        let (entries, new_pos) = fixture.read_jsonl_parts(UploadMode::Live);
        assert!(entries.is_empty());
        assert!(new_pos > 0);
    }

    /// Live mode: an in-progress line (no trailing \n) must be deferred
    /// to the next pass instead of being uploaded half-written.
    #[test]
    fn read_file_delta_defers_trailing_fragment() {
        let fixture = DeltaFixture::text();
        // Two complete lines followed by a partial write.
        fixture.write_file("line1\nline2\npartial");

        // First pass: read up to the last newline, leave "partial" behind.
        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content, "line1\nline2\n");
        assert_eq!(new_pos, 12);

        // Simulate the producer completing the line.
        fixture.write_file("line1\nline2\npartial done\n");
        fixture.write_pos(12);

        // Second pass: now "partial done\n" is complete.
        let (content2, new_pos2) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content2, "partial done\n");
        assert_eq!(new_pos2, 25);
    }

    /// Final pass: trailing fragment without a newline must be consumed,
    /// since there will be no subsequent pass to pick it up.
    #[test]
    fn read_file_delta_final_pass_consumes_fragment() {
        let fixture = DeltaFixture::text();
        fixture.write_file("line1\npartial");

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Final);
        assert_eq!(content, "line1\npartial");
        assert_eq!(new_pos, 13);
    }

    /// Regression: a multibyte UTF-8 character split across two passes
    /// must survive intact. Before the fix, `from_utf8_lossy` replaced
    /// each split byte with U+FFFD and the broken char was permanently
    /// lost because `save_position` had advanced past it.
    #[test]
    fn read_file_delta_utf8_multibyte_survives_split() {
        let fixture = DeltaFixture::text();
        // "中" is 3 bytes (0xE4 0xB8 0xAD). Simulate the producer having
        // written only the first byte mid-line: "prefix\n\xE4".
        let mut partial = Vec::from("prefix\n");
        partial.push(0xE4);
        fixture.write_file(&partial);

        // First pass: stops at the newline, leaves the orphan 0xE4 behind.
        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content, "prefix\n");
        assert_eq!(new_pos, 7);
        fixture.write_pos(new_pos);

        // Producer finishes writing the character and terminates the line.
        let mut complete = partial.clone();
        complete.extend_from_slice(&[0xB8, 0xAD]); // rest of "中"
        complete.extend_from_slice(b"\n");
        fixture.write_file(&complete);

        // Second pass: reads the complete multibyte character.
        let (content2, new_pos2) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content2, "中\n");
        assert_eq!(new_pos2, complete.len() as u64);
        // No U+FFFD anywhere — the character is intact.
        assert!(!content2.contains('\u{FFFD}'));
    }

    /// A JSONL file with a partially-written trailing record must not have
    /// that record silently dropped. The half line is deferred to the next
    /// pass, and once the producer completes it, the entry is uploaded.
    #[test]
    fn read_jsonl_delta_defers_partial_line() {
        let fixture = DeltaFixture::jsonl();
        fixture.write_file("{\"a\":1}\n{\"b\":2");

        // First pass: only {"a":1} is complete.
        let (entries, new_pos) = fixture.read_jsonl_parts(UploadMode::Live);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["a"], 1);
        assert_eq!(new_pos, 8);
        fixture.write_pos(new_pos);

        // Producer completes the record.
        fixture.write_file("{\"a\":1}\n{\"b\":2}\n");
        let (entries2, new_pos2) = fixture.read_jsonl_parts(UploadMode::Live);
        assert_eq!(entries2.len(), 1);
        assert_eq!(entries2[0]["b"], 2);
        assert_eq!(new_pos2, 16);
    }

    /// Live mode, first pass, delta contains no newline at all. Must
    /// return empty without advancing the position so the data is
    /// picked up intact once the producer writes the terminating \n.
    #[test]
    fn read_file_delta_live_no_newline_at_all() {
        let fixture = DeltaFixture::text();
        fixture.write_file("partial");

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert!(content.is_empty());
        assert_eq!(new_pos, 0);

        // Producer completes the line — the next pass picks up everything.
        fixture.write_file("partial done\n");
        let (content2, new_pos2) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content2, "partial done\n");
        assert_eq!(new_pos2, 13);
    }

    #[test]
    fn read_file_delta_large_unread_delta_reads_bounded_complete_prefix() {
        let fixture = DeltaFixture::text();
        let line = format!("{}\n", "x".repeat(1023));
        let content = line.repeat((TELEMETRY_DELTA_READ_LIMIT / line.len()) + 2);
        fixture.write_file(content);

        let delta = fixture.read_text(UploadMode::Live);
        assert_eq!(delta.content.len(), TELEMETRY_DELTA_READ_LIMIT);
        assert_eq!(delta.new_pos, TELEMETRY_DELTA_READ_LIMIT as u64);
        assert!(delta.made_progress);
    }

    #[test]
    fn read_file_delta_oversized_no_newline_system_log_emits_marker() {
        let fixture = DeltaFixture::text();
        fixture.write_file("x".repeat(TELEMETRY_DELTA_READ_LIMIT + 1));

        let delta = fixture.read_text(UploadMode::Live);
        assert_eq!(delta.content, OVERSIZED_SYSTEM_LOG_LINE_MARKER);
        assert_eq!(delta.new_pos, TELEMETRY_DELTA_READ_LIMIT as u64);
        assert!(delta.made_progress);
    }

    #[test]
    fn read_file_delta_mid_oversized_line_skips_suffix_then_resumes() {
        let fixture = DeltaFixture::text();
        let content = format!("{}tail\nnext\n", "x".repeat(TELEMETRY_DELTA_READ_LIMIT));
        fixture.write_file(content);
        fixture.write_pos(TELEMETRY_DELTA_READ_LIMIT as u64);

        let delta = fixture.read_text(UploadMode::Live);
        assert_eq!(delta.content, "next\n");
        assert_eq!(
            delta.new_pos,
            (TELEMETRY_DELTA_READ_LIMIT + "tail\nnext\n".len()) as u64,
        );
        assert!(delta.made_progress);
    }

    #[test]
    fn read_jsonl_delta_oversized_invalid_line_advances_without_entries() {
        let fixture = DeltaFixture::jsonl();
        fixture.write_file("x".repeat(TELEMETRY_DELTA_READ_LIMIT + 1));

        let delta = fixture.read_jsonl(UploadMode::Live);
        assert!(delta.entries.is_empty());
        assert_eq!(delta.new_pos, TELEMETRY_DELTA_READ_LIMIT as u64);
        assert!(delta.made_progress);
    }

    #[test]
    fn read_file_delta_final_from_middle_of_line_resumes_and_consumes_tail() {
        let fixture = DeltaFixture::text();
        let content = "old suffix\nnext\ntail";
        fixture.write_file(content);
        fixture.write_pos(4);

        let delta = fixture.read_text(UploadMode::Final);
        assert_eq!(delta.content, "next\ntail");
        assert_eq!(delta.new_pos, content.len() as u64);
        assert!(delta.made_progress);
    }

    #[test]
    fn read_file_delta_final_resync_reads_full_bounded_tail_window() {
        let fixture = DeltaFixture::text();
        let skipped_suffix = "x".repeat(TELEMETRY_DELTA_READ_LIMIT / 2);
        let tail = "t".repeat(TELEMETRY_DELTA_READ_LIMIT - 8);
        let content = format!("{skipped_suffix}\n{tail}");
        fixture.write_file(&content);
        fixture.write_pos(1);

        let delta = fixture.read_text(UploadMode::Final);
        assert_eq!(delta.content, tail);
        assert_eq!(delta.new_pos, content.len() as u64);
        assert!(delta.made_progress);
    }

    /// Final pass must consume the whole buffer even when the file contains
    /// no newlines at all — otherwise the tail is silently dropped.
    #[test]
    fn read_file_delta_final_pass_all_no_newline() {
        let fixture = DeltaFixture::text();
        fixture.write_file("no_newline");

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Final);
        assert_eq!(content, "no_newline");
        assert_eq!(new_pos, 10);
    }

    /// Same guarantee as the 3-byte multibyte test, but with a 4-byte
    /// emoji — the most common case in real Claude Code output. A split
    /// in the middle of the 4-byte sequence must not corrupt the char.
    #[test]
    fn read_file_delta_utf8_4byte_emoji_survives_split() {
        let fixture = DeltaFixture::text();
        // "😀" is 4 bytes (0xF0 0x9F 0x98 0x80). Producer wrote the first
        // two bytes mid-line: "prefix\n\xF0\x9F".
        let mut partial = Vec::from("prefix\n");
        partial.extend_from_slice(&[0xF0, 0x9F]);
        fixture.write_file(&partial);

        // First pass stops at \n, defers the orphan bytes.
        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content, "prefix\n");
        assert_eq!(new_pos, 7);
        fixture.write_pos(new_pos);

        // Producer finishes the emoji and terminates the line.
        let mut complete = partial.clone();
        complete.extend_from_slice(&[0x98, 0x80]);
        complete.extend_from_slice(b"\n");
        fixture.write_file(&complete);

        let (content2, new_pos2) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content2, "😀\n");
        assert_eq!(new_pos2, complete.len() as u64);
        assert!(!content2.contains('\u{FFFD}'));
    }

    /// Documents the `Final` mode behavior under the residual mid-chunk
    /// race tracked in #11010: if guest-control-server's chunk boundary split a
    /// UTF-8 character, the final flush sees invalid bytes. The code
    /// must replace them with U+FFFD and advance the position — not
    /// panic, not truncate the tail. Guards against accidental
    /// replacement of `from_utf8_lossy` with the stricter `from_utf8`.
    #[test]
    fn read_file_delta_final_pass_invalid_utf8_replaces_with_fffd() {
        let fixture = DeltaFixture::text();
        // Complete "log\n" followed by a lone 0xE4 (first byte of a
        // 3-byte UTF-8 char, the rest never arrived).
        let mut torn = Vec::from("log\n");
        torn.push(0xE4);
        fixture.write_file(&torn);

        let (content, new_pos) = fixture.read_text_parts(UploadMode::Final);
        assert_eq!(content, "log\n\u{FFFD}");
        assert_eq!(new_pos, 5);
    }

    /// Regression for the pre-finalization flush UTF-8 bug: the
    /// pre-finalization flush (`UploadMode::Live`) must not consume an
    /// in-flight UTF-8 byte sequence. Simulates the real sequence — Live
    /// flush (newline-aligned), producer continues writing, Final
    /// catch-up flush (consumes EOF).
    #[test]
    fn live_pass_then_final_catch_up_preserves_utf8() {
        let fixture = DeltaFixture::text();
        // Producer state at the moment the Live flush fires: "log\n"
        // plus the first byte of "中" (0xE4).
        let mut partial = Vec::from("log\n");
        partial.push(0xE4);
        fixture.write_file(&partial);

        // Pre-finalization Live flush: newline-aligned, defers the orphan byte.
        let (content, new_pos) = fixture.read_text_parts(UploadMode::Live);
        assert_eq!(content, "log\n");
        assert_eq!(new_pos, 4);
        fixture.write_pos(new_pos);

        // Producer finishes "中" and appends a final line.
        let mut complete = partial.clone();
        complete.extend_from_slice(&[0xB8, 0xAD]);
        complete.extend_from_slice(b"\ntail");
        fixture.write_file(&complete);

        // Catch-up final pass: consumes the rest including the no-newline tail.
        let (content2, new_pos2) = fixture.read_text_parts(UploadMode::Final);
        assert_eq!(content2, "中\ntail");
        assert_eq!(new_pos2, complete.len() as u64);
        assert!(!content2.contains('\u{FFFD}'));
    }
}
