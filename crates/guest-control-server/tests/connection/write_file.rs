use std::path::Path;

use guest_control_proto::{
    self, MSG_WRITE_FILE, MSG_WRITE_FILES, MSG_WRITE_PRIVATE_FILES, WriteFileBatchEntry,
};

use super::support::{
    assert_ping_pong, finish_guest_connection, read_error_response, send_control_payload,
    start_guest_connection, unique_tmp_path,
};

#[test]
fn write_file_seq_zero_returns_error() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_WRITE_FILE, 0, b"bad");
    let error = read_error_response(&mut host_stream, 0);
    assert_eq!(error, "write_file requires non-zero sequence");

    finish_guest_connection(handle, host_stream);
}

#[test]
fn write_file_seq_zero_does_not_write_valid_payload() {
    let (handle, mut host_stream) = start_guest_connection();
    let path = unique_tmp_path("write-file-seq-zero", ".txt");
    let payload =
        guest_control_proto::encode_write_file(path.as_str(), b"should-not-write", false, false)
            .expect("encode write_file");

    send_control_payload(&mut host_stream, MSG_WRITE_FILE, 0, &payload);
    let error = read_error_response(&mut host_stream, 0);
    assert_eq!(error, "write_file requires non-zero sequence");
    assert!(!Path::new(path.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn write_files_seq_zero_does_not_write_valid_payload() {
    let (handle, mut host_stream) = start_guest_connection();
    let path = unique_tmp_path("write-files-seq-zero", ".txt");
    let payload = guest_control_proto::encode_write_files(&[WriteFileBatchEntry {
        path: path.as_str(),
        content: b"should-not-write",
    }])
    .expect("encode write_files");

    send_control_payload(&mut host_stream, MSG_WRITE_FILES, 0, &payload);
    let error = read_error_response(&mut host_stream, 0);
    assert_eq!(error, "write_files requires non-zero sequence");
    assert!(!Path::new(path.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn write_private_files_seq_zero_does_not_write_valid_payload() {
    let (handle, mut host_stream) = start_guest_connection();
    let path = unique_tmp_path("write-private-files-seq-zero", ".txt");
    let payload = guest_control_proto::encode_write_files(&[WriteFileBatchEntry {
        path: path.as_str(),
        content: b"should-not-write",
    }])
    .expect("encode write_private_files");

    send_control_payload(&mut host_stream, MSG_WRITE_PRIVATE_FILES, 0, &payload);
    let error = read_error_response(&mut host_stream, 0);
    assert_eq!(error, "write_private_files requires non-zero sequence");
    assert!(!Path::new(path.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn malformed_write_file_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_WRITE_FILE, 31, b"bad");
    let error = read_error_response(&mut host_stream, 31);
    assert_eq!(error, "invalid payload: write_file path truncated");

    assert_ping_pong(&mut host_stream, 32);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn malformed_write_files_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_WRITE_FILES, 41, &[0, 1]);
    let error = read_error_response(&mut host_stream, 41);
    assert_eq!(error, "invalid payload: write_files path_len truncated");

    assert_ping_pong(&mut host_stream, 42);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn malformed_write_private_files_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_WRITE_PRIVATE_FILES, 51, &[0, 1]);
    let error = read_error_response(&mut host_stream, 51);
    assert_eq!(error, "invalid payload: write_files path_len truncated");

    assert_ping_pong(&mut host_stream, 52);

    finish_guest_connection(handle, host_stream);
}

#[cfg(target_os = "linux")]
#[test]
fn malformed_streamed_batch_is_rejected_without_losing_the_following_frame() {
    use std::io::Write;

    let (handle, mut stream) = start_guest_connection();
    let path = unique_tmp_path("invalid-streamed-write", ".txt");
    let content = vec![b'x'; 5 * 1024 * 1024];
    let mut payload = guest_control_proto::encode_write_files(&[WriteFileBatchEntry {
        path: path.as_str(),
        content: &content,
    }])
    .unwrap();
    payload.push(b'x');
    let mut frames = guest_control_proto::encode(MSG_WRITE_FILES, 61, &payload).unwrap();
    frames.extend_from_slice(
        &guest_control_proto::encode(guest_control_proto::MSG_PING, 62, &[]).unwrap(),
    );
    stream.write_all(&frames).unwrap();

    assert_eq!(
        read_error_response(&mut stream, 61),
        "invalid payload: write_files trailing bytes"
    );
    let pong = super::support::read_message(&mut stream);
    assert_eq!(
        (pong.msg_type, pong.seq),
        (guest_control_proto::MSG_PONG, 62)
    );
    assert!(!Path::new(path.as_str()).exists());
    finish_guest_connection(handle, stream);
}

#[cfg(target_os = "linux")]
#[test]
fn disconnected_streamed_batch_retires_without_applying_its_prefix() {
    use std::io::Write;

    let (handle, mut stream) = start_guest_connection();
    let path = unique_tmp_path("partial-streamed-write", ".txt");
    let content = vec![b'x'; 5 * 1024 * 1024];
    let payload = guest_control_proto::encode_write_files(&[WriteFileBatchEntry {
        path: path.as_str(),
        content: &content,
    }])
    .unwrap();
    let frame = guest_control_proto::encode(MSG_WRITE_FILES, 71, &payload).unwrap();
    stream.write_all(&frame[..128 * 1024]).unwrap();
    drop(stream);

    super::support::join_guest_connection(handle);
    assert!(!Path::new(path.as_str()).exists());
}
