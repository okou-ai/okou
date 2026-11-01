use super::*;
use guest_control_proto::MSG_WRITE_FILE_STREAM_DATA;
use std::os::unix::net::UnixStream;

#[test]
fn source_length_must_match_before_end_and_cannot_be_exceeded() {
    for (bytes, end) in [(&b"x"[..], true), (&b"xxx"[..], false)] {
        let streams = Streams::default();
        let (writer, _peer) = UnixStream::pair().unwrap();
        let _input = streams
            .begin(
                1,
                GuestWriter::new(writer),
                Arc::new(AtomicBool::new(false)),
                Some(2),
            )
            .unwrap();
        let data = streams.accept(BorrowedRawMessage {
            msg_type: MSG_WRITE_FILE_STREAM_DATA,
            seq: 1,
            payload: bytes,
        });
        if end {
            data.unwrap();
            let error = streams
                .accept(BorrowedRawMessage {
                    msg_type: MSG_WRITE_FILE_STREAM_END,
                    seq: 1,
                    payload: &[],
                })
                .unwrap_err();
            assert_eq!(error.to_string(), "encoded source size mismatch");
        } else {
            assert_eq!(
                data.unwrap_err().to_string(),
                "encoded stream exceeds request bound"
            );
        }
    }
}

#[test]
fn unread_stream_rejects_data_beyond_its_credit_window() {
    let streams = Streams::default();
    let (writer, _peer) = UnixStream::pair().unwrap();
    let _input = streams
        .begin(
            1,
            GuestWriter::new(writer),
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .unwrap();
    for _ in 0..WINDOW {
        streams
            .accept(BorrowedRawMessage {
                msg_type: MSG_WRITE_FILE_STREAM_DATA,
                seq: 1,
                payload: b"x",
            })
            .unwrap();
    }
    let error = streams
        .accept(BorrowedRawMessage {
            msg_type: MSG_WRITE_FILE_STREAM_DATA,
            seq: 1,
            payload: b"x",
        })
        .unwrap_err();
    assert_eq!(error.to_string(), "stream exceeded credit");
}

#[test]
fn full_credit_window_reserves_end_and_drains_exact_bytes() {
    let streams = Streams::default();
    let (writer, _peer) = UnixStream::pair().unwrap();
    let mut input = streams
        .begin(
            2,
            GuestWriter::new(writer),
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .unwrap();
    for _ in 0..WINDOW {
        streams
            .accept(BorrowedRawMessage {
                msg_type: MSG_WRITE_FILE_STREAM_DATA,
                seq: 2,
                payload: b"x",
            })
            .unwrap();
    }
    streams
        .accept(BorrowedRawMessage {
            msg_type: MSG_WRITE_FILE_STREAM_END,
            seq: 2,
            payload: &[],
        })
        .unwrap();
    let mut bytes = Vec::new();
    input.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, vec![b'x'; WINDOW]);
}
