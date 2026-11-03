use super::*;
use std::io::{SeekFrom, Write};

fn append_skippable_frame(file: &mut File, payload_bytes: u32) {
    file.write_all(&0x184D2A50u32.to_le_bytes()).unwrap();
    file.write_all(&payload_bytes.to_le_bytes()).unwrap();
    let end = file
        .seek(SeekFrom::Current(i64::from(payload_bytes)))
        .unwrap();
    file.set_len(end).unwrap();
}

fn assert_encoded_limit(error: AgentError, expected: u64) {
    match error {
        AgentError::SessionHistoryEncodedTooLarge { max_bytes } => {
            assert_eq!(max_bytes, expected);
        }
        other => panic!("expected encoded input limit, got {other}"),
    }
}

#[test]
fn oversized_skippable_history_is_rejected_before_reading() {
    std::fs::create_dir_all("/home/user").unwrap();
    let dir = tempfile::tempdir_in("/home/user").unwrap();
    let path = dir.path().join("history.jsonl.zst");
    let mut file = File::create(&path).unwrap();
    append_skippable_frame(&mut file, 256 * 1024 * 1024);
    file.write_all(&zstd::encode_all(b"a".as_slice(), 0).unwrap())
        .unwrap();

    for retained_home in [false, true] {
        let resolved = resolve_test_payload(path.to_str().unwrap()).unwrap();
        let mut observed = resolved.file.try_clone().unwrap();
        let error = if retained_home {
            match resolved.digest_retained_home(1).err().unwrap() {
                SessionHistoryDigestError::Read(error) => error,
                other => panic!("expected encoded input limit, got {other:?}"),
            }
        } else {
            resolved.into_content_bounded(1).err().unwrap()
        };

        assert_encoded_limit(error, 1 + SESSION_HISTORY_ENCODED_OVERHEAD_BYTES);
        assert_eq!(observed.stream_position().unwrap(), 0);
    }
}

#[test]
fn encoded_reads_remain_bounded_when_history_grows_after_admission() {
    let max_decoded_bytes = 1;
    let max_encoded_bytes = max_decoded_bytes + SESSION_HISTORY_ENCODED_OVERHEAD_BYTES;
    let history_frame = zstd::encode_all(b"a".as_slice(), 0).unwrap();
    let empty_frame = zstd::encode_all(b"".as_slice(), 0).unwrap();

    for layout in ["leading-skippable", "trailing-skippable", "empty-frames"] {
        for digest in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = write_history_file(&dir, "history.jsonl.zst", b"");
            let resolved = resolve_test_payload(path.to_str().unwrap()).unwrap();
            let mut observed = resolved.file.try_clone().unwrap();
            let reader = resolved.into_decoded_reader(max_decoded_bytes).unwrap();
            // The descriptor was admitted while empty. A separate writer now
            // grows it, so metadata admission cannot be the only enforcement.
            let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            match layout {
                "leading-skippable" => {
                    append_skippable_frame(&mut writer, 2 * max_encoded_bytes as u32);
                    writer.write_all(&history_frame).unwrap();
                }
                "trailing-skippable" => {
                    writer.write_all(&history_frame).unwrap();
                    append_skippable_frame(&mut writer, 2 * max_encoded_bytes as u32);
                }
                "empty-frames" => {
                    let frames =
                        empty_frame.repeat(max_encoded_bytes as usize / empty_frame.len() + 1);
                    writer.write_all(&frames).unwrap();
                    writer.write_all(&history_frame).unwrap();
                }
                other => panic!("unknown fixture layout: {other}"),
            }

            let error = if digest {
                match reader.digest(max_decoded_bytes).err().unwrap() {
                    SessionHistoryDigestError::Read(error) => error,
                    other => panic!("expected encoded input limit, got {other:?}"),
                }
            } else {
                reader.read(Some(max_decoded_bytes)).unwrap_err()
            };
            assert_encoded_limit(error, max_encoded_bytes);
            assert_eq!(observed.stream_position().unwrap(), max_encoded_bytes + 1);
        }
    }
}

#[test]
fn encoded_limit_accepts_real_eof_before_or_after_a_complete_frame() {
    let history = b"a";
    let history_frame = zstd::encode_all(history.as_slice(), 0).unwrap();
    let max_encoded_bytes = history.len() as u64 + SESSION_HISTORY_ENCODED_OVERHEAD_BYTES;
    let padding = (max_encoded_bytes - 8 - history_frame.len() as u64) as u32;

    for trailing_padding in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl.zst");
        let mut writer = File::create(&path).unwrap();
        if trailing_padding {
            writer.write_all(&history_frame).unwrap();
            append_skippable_frame(&mut writer, padding);
        } else {
            append_skippable_frame(&mut writer, padding);
            writer.write_all(&history_frame).unwrap();
        }
        assert_eq!(writer.metadata().unwrap().len(), max_encoded_bytes);
        let resolved = resolve_test_payload(path.to_str().unwrap()).unwrap();
        let mut observed = resolved.file.try_clone().unwrap();

        let digest = resolved.into_decoded_reader(1).unwrap().digest(1).unwrap();

        assert_eq!(digest.size_bytes, 1);
        assert_eq!(digest.sha256_hex, hex::encode(Sha256::digest(history)));
        assert_eq!(observed.stream_position().unwrap(), max_encoded_bytes);
    }
}

#[test]
fn source_digest_accepts_concatenated_and_empty_frames_with_normal_overhead() {
    std::fs::create_dir_all("/home/user").unwrap();
    let dir = tempfile::tempdir_in("/home/user").unwrap();
    let sessions_dir = dir.path().join("sessions");
    let day = sessions_dir.join("2026/11/03");
    std::fs::create_dir_all(&day).unwrap();
    let thread = "019e9154-c304-70f0-adde-36efb1be1701";
    let path = day.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst");
    let mut writer = File::create(&path).unwrap();
    for bytes in [b"".as_slice(), b"a", b"", b"b"] {
        append_skippable_frame(&mut writer, 0);
        writer
            .write_all(&zstd::encode_all(bytes, 0).unwrap())
            .unwrap();
    }
    append_skippable_frame(&mut writer, 16);
    let source = codex_source(&sessions_dir, thread);

    let digest = digest_session_history_from_source_bounded(&source, 2).unwrap();
    let retained = resolve_session_history_from_source(&source)
        .unwrap()
        .digest_retained_home(2)
        .unwrap();

    assert_eq!(digest.size_bytes, 2);
    assert_eq!(digest.sha256_hex, hex::encode(Sha256::digest(b"ab")));
    assert_eq!(retained.sha256_hex, digest.sha256_hex);
    assert_eq!(retained.size_bytes, digest.size_bytes);
}

#[test]
fn encoded_budget_handles_empty_history_and_saturating_decoded_limit() {
    let dir = tempfile::tempdir().unwrap();
    for (history, limit) in [(b"".as_slice(), 0), (b"abcde".as_slice(), u64::MAX)] {
        let frame = zstd::encode_all(history, 0).unwrap();
        let path = write_history_file(&dir, "history.jsonl.zst", &frame);
        let digest = resolve_test_payload(path.to_str().unwrap())
            .unwrap()
            .into_decoded_reader(limit)
            .unwrap()
            .digest(limit)
            .unwrap();

        assert_eq!(digest.size_bytes, history.len() as u64);
        assert_eq!(digest.sha256_hex, hex::encode(Sha256::digest(history)));
    }
}
