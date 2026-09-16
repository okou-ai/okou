use super::support::{
    Harness, blocking_write_path, blocking_write_pid_path, finish_raw_guest_connection, pid_alive,
    read_raw_message, release_blocking_write, start_raw_guest_connection, wait_for_blocking_write,
};
use guest_control_client::{FileCompression, FrameWriteObserver, WriteFileEntry};
use guest_control_proto::*;
use std::fs;
use std::io::{self, Write};
use std::time::Duration;

#[tokio::test]
async fn zstd_streams_large_files_through_existing_publication() {
    let h = Harness::new().await;
    let options = FileCompression::Zstd;
    let target = h.dir.join("history.jsonl");
    fs::write(&target, b"old").unwrap();
    let bytes = vec![b'x'; 17 * 1024 * 1024 + 1];
    h.host()
        .write_file_with_compression(target.to_str().unwrap(), &bytes, false, options)
        .await
        .unwrap();
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert!(fs::read_dir(&h.dir).unwrap().all(|p| {
        !p.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".vm0tmp")
    }));
    h.host()
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap();
    h.host()
        .resume_operations(Duration::from_secs(2))
        .await
        .unwrap();
    h.finish();
}

#[tokio::test]
async fn stream_preserves_small_empty_private_and_batch_writes() {
    let h = Harness::new().await;
    let options = FileCompression::Zstd;
    for bytes in [b"".as_slice(), b"small"] {
        let target = h.dir.join("small");
        h.host()
            .write_file_with_compression(target.to_str().unwrap(), bytes, false, options)
            .await
            .unwrap();
        assert_eq!(fs::read(target).unwrap(), bytes);
    }
    let private = h.dir.join("private/data");
    h.host()
        .write_private_file(private.to_str().unwrap(), b"private")
        .await
        .unwrap();
    let batch = h.dir.join("batch");
    h.host()
        .write_files(&[WriteFileEntry {
            path: batch.to_str().unwrap(),
            content: b"batch",
        }])
        .await
        .unwrap();
    assert_eq!(fs::read(private).unwrap(), b"private");
    assert_eq!(fs::read(batch).unwrap(), b"batch");
    h.finish();
}

#[tokio::test]
async fn blocked_stream_keeps_status_live_and_finishes_after_busy_quiesce() {
    let h = Harness::new().await;
    let options = FileCompression::Zstd;
    let path = blocking_write_path(&h.dir, "stream-blocked");
    let bytes = vec![b'b'; 8 * 1024 * 1024];
    let write =
        h.host()
            .write_file_with_compression(path.to_str().unwrap(), &bytes, false, options);
    let control = async {
        wait_for_blocking_write(&path, Duration::from_secs(5))
            .await
            .unwrap();
        let status = h
            .host()
            .file_write_status(Duration::from_secs(2))
            .await
            .unwrap();
        assert_ne!(status.sequence, 0);
        h.host()
            .quiesce_operations(Duration::from_secs(1))
            .await
            .unwrap_err();
        release_blocking_write(&path);
    };
    let (written, ()) = tokio::join!(write, control);
    written.unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);
    h.host()
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap();
    h.host()
        .resume_operations(Duration::from_secs(2))
        .await
        .unwrap();
    h.finish();
}

#[tokio::test]
async fn cancelling_stream_reaps_blocked_helper_and_forbids_reuse() {
    let h = Harness::new().await;
    let options = FileCompression::Zstd;
    let path = blocking_write_path(&h.dir, "cancel-stream");
    let bytes = vec![b'b'; 8 * 1024 * 1024];
    let mut write = Box::pin(h.host().write_file_with_compression(
        path.to_str().unwrap(),
        &bytes,
        false,
        options,
    ));
    tokio::select! {
        result = &mut write => panic!("write completed before block: {result:?}"),
        result = wait_for_blocking_write(&path, Duration::from_secs(5)) => result.unwrap(),
    }
    let pid: u32 = fs::read_to_string(blocking_write_pid_path(&path))
        .unwrap()
        .parse()
        .unwrap();
    drop(write);
    h.host()
        .write_file(h.dir.join("later").to_str().unwrap(), b"x", false)
        .await
        .unwrap_err();
    h.finish_ignore_guest();
    assert!(!pid_alive(pid));
}

#[tokio::test]
async fn observer_failure_preserves_existing_not_parkable_contract() {
    let h = Harness::new().await;
    let options = FileCompression::Zstd;
    let path = h.dir.join("observer");
    let observer = FrameWriteObserver::new(|| Err(io::Error::other("before-frame")));
    h.host()
        .write_file_with_compression_and_observer(
            path.to_str().unwrap(),
            b"first",
            false,
            options,
            observer,
        )
        .await
        .unwrap_err();
    assert!(!path.exists());
    h.host()
        .write_file(path.to_str().unwrap(), b"next", false)
        .await
        .unwrap_err();
    assert!(!path.exists());
    h.finish();
}

fn begin(stream: &mut impl Write, seq: u32, path: &str, mode: u8, size: u32) {
    let mut payload = vec![mode];
    payload.extend_from_slice(&size.to_be_bytes());
    payload.extend_from_slice(&encode_write_file(path, &[], false, false).unwrap());
    stream
        .write_all(&encode(MSG_WRITE_FILE_STREAM_BEGIN, seq, &payload).unwrap())
        .unwrap();
}

#[tokio::test]
async fn caller_transport_choice_is_independent_for_concurrent_files() {
    let h = Harness::new().await;
    let raw = vec![b'x'; 17 * 1024 * 1024 + 1];
    let compressed_path = h.dir.join("compressed");
    let ordinary_path = h.dir.join("ordinary");
    let compressed = FileCompression::Zstd;
    let ordinary = FileCompression::None;
    let (a, b) = tokio::join!(
        h.host().write_file_with_compression(
            compressed_path.to_str().unwrap(),
            &raw,
            false,
            compressed
        ),
        h.host().write_file_with_compression(
            ordinary_path.to_str().unwrap(),
            &raw,
            false,
            ordinary
        ),
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(fs::read(compressed_path).unwrap(), raw);
    assert_eq!(fs::read(ordinary_path).unwrap(), raw);
    h.finish();
}

#[tokio::test]
async fn explicit_compression_is_honored_even_for_small_content() {
    let h = Harness::new().await;
    let options = FileCompression::Zstd;
    let path = h.dir.join("small-explicit");
    h.host()
        .write_file_with_compression(path.to_str().unwrap(), b"x", false, options)
        .await
        .unwrap();
    assert_eq!(fs::read(path).unwrap(), b"x");
    h.finish();
}

#[test]
fn malformed_compressed_input_has_no_success_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("malformed");
    let (guest, mut stream) = start_raw_guest_connection();
    begin(&mut stream, 10, path.to_str().unwrap(), 1, 5);
    assert_eq!(
        read_raw_message(&mut stream).msg_type,
        MSG_WRITE_FILE_STREAM_CREDIT
    );
    // A checksummed frame containing "hello", truncated before its checksum.
    // The helper must observe END/EOF before it can reject the truncation.
    let truncated = b"\x28\xb5\x2f\xfd\x24\x05\x29\x00\x00hello";
    stream
        .write_all(&encode(MSG_WRITE_FILE_STREAM_DATA, 10, truncated).unwrap())
        .unwrap();
    stream
        .write_all(&encode(MSG_WRITE_FILE_STREAM_END, 10, &[]).unwrap())
        .unwrap();
    loop {
        let msg = read_raw_message(&mut stream);
        if msg.msg_type == MSG_WRITE_FILE_STREAM_CREDIT {
            continue;
        }
        assert_eq!(msg.msg_type, MSG_WRITE_FILE_RESULT);
        assert!(!decode_write_file_result(&msg.payload).unwrap().0);
        break;
    }
    finish_raw_guest_connection(guest, stream);
}

#[tokio::test]
async fn oversized_data_frame_closes_and_reaps() {
    let dir = tempfile::tempdir().unwrap();
    let path = blocking_write_path(dir.path(), "credit");
    let (guest, mut stream) = start_raw_guest_connection();
    begin(&mut stream, 11, path.to_str().unwrap(), 1, 1024 * 1024);
    assert_eq!(
        read_raw_message(&mut stream).msg_type,
        MSG_WRITE_FILE_STREAM_CREDIT
    );
    wait_for_blocking_write(&path, Duration::from_secs(5))
        .await
        .unwrap();
    let pid: u32 = fs::read_to_string(blocking_write_pid_path(&path))
        .unwrap()
        .parse()
        .unwrap();
    let frame = encode(MSG_WRITE_FILE_STREAM_DATA, 11, &vec![1; 64 * 1024 + 1]).unwrap();
    stream.write_all(&frame).unwrap();
    drop(stream);
    // Protocol failure is expected; the owned helper must still be reaped.
    let result = guest.join().unwrap();
    assert_eq!(result.unwrap_err().to_string(), "invalid data frame size");
    assert!(!pid_alive(pid));
}
