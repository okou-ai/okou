use super::*;
use crate::wire::{MSG_PING, MSG_PONG, MSG_READY};

#[test]
fn encode_decode_roundtrip_empty_payload() {
    let data = encode(MSG_PING, 1, &[]).unwrap();
    let mut dec = Decoder::new();
    let msgs = dec.decode(&data).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].msg_type, MSG_PING);
    assert_eq!(msgs[0].seq, 1);
    assert!(msgs[0].payload.is_empty());
}

#[test]
fn encode_decode_roundtrip_with_payload() {
    let data = encode(MSG_PING, 42, b"hello world").unwrap();
    let mut dec = Decoder::new();
    let msgs = dec.decode(&data).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].msg_type, MSG_PING);
    assert_eq!(msgs[0].seq, 42);
    assert_eq!(msgs[0].payload, b"hello world");
}

#[test]
fn decoder_handles_partial_reads() {
    let data = encode(MSG_PONG, 7, &[]).unwrap();
    let mut dec = Decoder::new();

    // Feed first 4 bytes (header only)
    let msgs = dec.decode(&data[..4]).unwrap();
    assert!(msgs.is_empty());

    // Feed the rest
    let msgs = dec.decode(&data[4..]).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].msg_type, MSG_PONG);
    assert_eq!(msgs[0].seq, 7);
}

#[test]
fn decoder_handles_multiple_messages() {
    let mut data = encode(MSG_PING, 1, &[]).unwrap();
    data.extend_from_slice(&encode(MSG_PONG, 1, &[]).unwrap());
    data.extend_from_slice(&encode(MSG_READY, 0, &[]).unwrap());

    let mut dec = Decoder::new();
    let msgs = dec.decode(&data).unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].msg_type, MSG_PING);
    assert_eq!(msgs[1].msg_type, MSG_PONG);
    assert_eq!(msgs[2].msg_type, MSG_READY);
}

#[test]
fn decoder_rejects_too_large() {
    // Craft a header claiming 17MB body
    let bad = (17 * 1024 * 1024_u32).to_be_bytes();
    let mut dec = Decoder::new();
    let err = dec.decode(&bad).unwrap_err();
    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
}

#[test]
fn decoder_rejects_too_small() {
    // Body length 2 (less than MIN_BODY_SIZE=5)
    let bad = 2_u32.to_be_bytes();
    let mut dec = Decoder::new();
    let err = dec.decode(&bad).unwrap_err();
    assert!(matches!(err, ProtocolError::MessageTooSmall(2)));
}

#[test]
fn decoder_byte_by_byte() {
    let data = encode(MSG_PING, 1, &[]).unwrap();
    let mut dec = Decoder::new();

    for (i, &byte) in data.iter().enumerate() {
        let msgs = dec.decode(&[byte]).unwrap();
        if i < data.len() - 1 {
            assert!(msgs.is_empty());
        } else {
            assert_eq!(msgs.len(), 1);
            assert_eq!(msgs[0].msg_type, MSG_PING);
        }
    }
}

#[test]
fn decode_with_visits_borrowed_message() {
    let data = encode(MSG_PING, 42, b"hello world").unwrap();
    let mut dec = Decoder::new();
    let mut visited = Vec::new();

    dec.decode_with(&data, |msg| {
        visited.push((msg.msg_type, msg.seq, msg.payload.to_vec()));
        Ok::<(), Infallible>(())
    })
    .unwrap();

    assert_eq!(visited, vec![(MSG_PING, 42, b"hello world".to_vec())]);
}

#[test]
fn decode_with_handles_partial_reads() {
    let data = encode(MSG_PONG, 7, b"later").unwrap();
    let mut dec = Decoder::new();
    let mut visited = Vec::new();

    dec.decode_with(&data[..4], |msg| {
        visited.push(msg.to_owned_message());
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert!(visited.is_empty());

    dec.decode_with(&data[4..], |msg| {
        visited.push(msg.to_owned_message());
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert_eq!(visited.len(), 1);
    assert_eq!(visited[0].msg_type, MSG_PONG);
    assert_eq!(visited[0].seq, 7);
    assert_eq!(visited[0].payload, b"later");
}

#[test]
fn decode_with_preserves_partial_frame_after_complete_frame() {
    let first = encode(MSG_PING, 1, b"first").unwrap();
    let second = encode(MSG_PONG, 2, b"second").unwrap();
    let mut data = first;
    data.extend_from_slice(&second[..7]);
    let mut dec = Decoder::new();
    let mut visited = Vec::new();

    dec.decode_with(&data, |msg| {
        visited.push(msg.to_owned_message());
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert_eq!(visited.len(), 1);
    assert_eq!(visited[0].msg_type, MSG_PING);
    assert_eq!(visited[0].payload, b"first");

    dec.decode_with(&second[7..], |msg| {
        visited.push(msg.to_owned_message());
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert_eq!(visited.len(), 2);
    assert_eq!(visited[1].msg_type, MSG_PONG);
    assert_eq!(visited[1].seq, 2);
    assert_eq!(visited[1].payload, b"second");
}

#[test]
fn decode_with_handles_multiple_messages() {
    let mut data = encode(MSG_PING, 1, b"a").unwrap();
    data.extend_from_slice(&encode(MSG_PONG, 2, b"b").unwrap());
    data.extend_from_slice(&encode(MSG_READY, 3, b"c").unwrap());
    let mut dec = Decoder::new();
    let mut visited = Vec::new();

    dec.decode_with(&data, |msg| {
        visited.push((msg.msg_type, msg.seq, msg.payload.to_vec()));
        Ok::<(), Infallible>(())
    })
    .unwrap();

    assert_eq!(
        visited,
        vec![
            (MSG_PING, 1, b"a".to_vec()),
            (MSG_PONG, 2, b"b".to_vec()),
            (MSG_READY, 3, b"c".to_vec()),
        ]
    );
}

#[test]
fn decode_with_preserves_protocol_errors() {
    let mut dec = Decoder::new();
    let err = dec
        .decode_with::<()>(&(17 * 1024 * 1024_u32).to_be_bytes(), |_| {
            panic!("visitor should not run for oversized frame")
        })
        .unwrap_err();
    assert!(matches!(
        err,
        DecodeWithError::Protocol(ProtocolError::MessageTooLarge(_))
    ));

    let err = dec
        .decode_with::<()>(&2_u32.to_be_bytes(), |_| {
            panic!("visitor should not run for too-small frame")
        })
        .unwrap_err();
    assert!(matches!(
        err,
        DecodeWithError::Protocol(ProtocolError::MessageTooSmall(2))
    ));
}

#[test]
fn decode_with_reports_invalid_length_after_partial_header() {
    let bad_header = 2_u32.to_be_bytes();
    let mut dec = Decoder::new();
    let mut visited = false;

    dec.decode_with(&bad_header[..3], |_msg| {
        visited = true;
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert!(!visited);

    let err = dec
        .decode_with(&bad_header[3..], |_msg| {
            visited = true;
            Ok::<(), Infallible>(())
        })
        .unwrap_err();
    assert!(matches!(
        err,
        DecodeWithError::Protocol(ProtocolError::MessageTooSmall(2))
    ));
    assert!(!visited);

    let valid = encode(MSG_PING, 9, b"recovered").unwrap();
    let mut recovered = Vec::new();
    dec.decode_with(&valid, |msg| {
        recovered.push((msg.msg_type, msg.seq, msg.payload.to_vec()));
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert_eq!(recovered, vec![(MSG_PING, 9, b"recovered".to_vec())]);
}

#[test]
fn decode_with_rejects_protocol_error_before_visiting_prior_frames() {
    let mut data = encode(MSG_PING, 1, b"valid").unwrap();
    data.extend_from_slice(&(17 * 1024 * 1024_u32).to_be_bytes());
    let mut dec = Decoder::new();
    let mut visited = false;

    let err = dec
        .decode_with(&data, |_msg| {
            visited = true;
            Ok::<(), Infallible>(())
        })
        .unwrap_err();

    assert!(matches!(
        err,
        DecodeWithError::Protocol(ProtocolError::MessageTooLarge(_))
    ));
    assert!(!visited);

    dec.decode_with(&[], |_msg| {
        visited = true;
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert!(!visited);
}

#[test]
fn decode_with_propagates_visitor_error() {
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum VisitorError {
        Stop,
    }

    let mut data = encode(MSG_PING, 1, b"first").unwrap();
    data.extend_from_slice(&encode(MSG_PONG, 2, b"second").unwrap());
    let mut dec = Decoder::new();
    let err = dec
        .decode_with(&data, |_msg| Err(VisitorError::Stop))
        .unwrap_err();
    assert!(matches!(err, DecodeWithError::Visitor(VisitorError::Stop)));

    let mut visited = Vec::new();
    dec.decode_with(&[], |msg| {
        visited.push(msg.to_owned_message());
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert_eq!(visited.len(), 1);
    assert_eq!(visited[0].msg_type, MSG_PONG);
    assert_eq!(visited[0].payload, b"second");
}

#[test]
fn decode_with_preserves_later_frames_after_mid_batch_visitor_error() {
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum VisitorError {
        Stop,
    }

    let mut data = encode(MSG_PING, 1, b"first").unwrap();
    data.extend_from_slice(&encode(MSG_PONG, 2, b"second").unwrap());
    data.extend_from_slice(&encode(MSG_READY, 3, b"third").unwrap());
    let mut dec = Decoder::new();
    let mut visited = Vec::new();

    let err = dec
        .decode_with(&data, |msg| {
            visited.push((msg.msg_type, msg.seq, msg.payload.to_vec()));
            if msg.seq == 2 {
                Err(VisitorError::Stop)
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(matches!(err, DecodeWithError::Visitor(VisitorError::Stop)));
    assert_eq!(
        visited,
        vec![
            (MSG_PING, 1, b"first".to_vec()),
            (MSG_PONG, 2, b"second".to_vec()),
        ]
    );

    visited.clear();
    dec.decode_with(&[], |msg| {
        visited.push((msg.msg_type, msg.seq, msg.payload.to_vec()));
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert_eq!(visited, vec![(MSG_READY, 3, b"third".to_vec())]);
}

#[test]
fn decode_with_releases_empty_oversized_buffer_after_large_frame() {
    let payload = vec![0xAB; OVERSIZED_BUFFER_CAPACITY];
    let data = encode(MSG_PING, 42, &payload).unwrap();
    let mut dec = Decoder::new();
    let mut visited = Vec::new();

    dec.decode_with(&data, |msg| {
        visited.push((msg.msg_type, msg.seq, msg.payload.len()));
        Ok::<(), Infallible>(())
    })
    .unwrap();

    assert_eq!(visited, vec![(MSG_PING, 42, payload.len())]);
    assert!(dec.buf.is_empty());
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);

    let small = encode(MSG_PONG, 43, b"small").unwrap();
    visited.clear();
    dec.decode_with(&small, |msg| {
        visited.push((msg.msg_type, msg.seq, msg.payload.len()));
        Ok::<(), Infallible>(())
    })
    .unwrap();
    assert_eq!(visited, vec![(MSG_PONG, 43, 5)]);
}

#[test]
fn decode_releases_empty_oversized_buffer_after_large_frame() {
    let payload = vec![0xCD; OVERSIZED_BUFFER_CAPACITY];
    let data = encode(MSG_READY, 0, &payload).unwrap();
    let mut dec = Decoder::new();

    let messages = dec.decode(&data).unwrap();

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].msg_type, MSG_READY);
    assert_eq!(messages[0].seq, 0);
    assert_eq!(messages[0].payload.len(), payload.len());
    assert!(dec.buf.is_empty());
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);
}

#[test]
fn decode_with_preserves_partial_large_frame_before_release() {
    let payload = vec![0xEF; OVERSIZED_BUFFER_CAPACITY + INITIAL_BUFFER_CAPACITY];
    let data = encode(MSG_PING, 7, &payload).unwrap();
    let split = OVERSIZED_BUFFER_CAPACITY + HEADER_SIZE;
    let mut dec = Decoder::new();
    let mut visited = false;

    dec.decode_with(&data[..split], |_msg| {
        visited = true;
        Ok::<(), Infallible>(())
    })
    .unwrap();

    assert!(!visited);
    assert_eq!(dec.buf.len(), split);
    assert_eq!(dec.buf.as_slice(), &data[..split]);
    assert!(dec.buf.capacity() > OVERSIZED_BUFFER_CAPACITY);

    let mut decoded = Vec::new();
    dec.decode_with(&data[split..], |msg| {
        decoded.push((msg.msg_type, msg.seq, msg.payload.len()));
        Ok::<(), Infallible>(())
    })
    .unwrap();

    assert_eq!(decoded, vec![(MSG_PING, 7, payload.len())]);
    assert!(dec.buf.is_empty());
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);
}

#[test]
fn decode_with_visitor_error_preserves_later_frame_after_large_frame() {
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum VisitorError {
        Stop,
    }

    let payload = vec![0x11; OVERSIZED_BUFFER_CAPACITY];
    let large = encode(MSG_PING, 1, &payload).unwrap();
    let later = encode(MSG_PONG, 2, b"later").unwrap();
    let mut data = large;
    data.extend_from_slice(&later);
    let mut dec = Decoder::new();

    let err = dec
        .decode_with(&data, |msg| {
            if msg.seq == 1 {
                Err(VisitorError::Stop)
            } else {
                Ok(())
            }
        })
        .unwrap_err();

    assert!(matches!(err, DecodeWithError::Visitor(VisitorError::Stop)));
    assert_eq!(dec.buf, later);
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);

    let mut visited = Vec::new();
    dec.decode_with(&[], |msg| {
        visited.push((msg.msg_type, msg.seq, msg.payload.to_vec()));
        Ok::<(), Infallible>(())
    })
    .unwrap();

    assert_eq!(visited, vec![(MSG_PONG, 2, b"later".to_vec())]);
    assert!(dec.buf.is_empty());
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);
}

#[test]
fn decode_with_releases_oversized_buffer_with_small_partial_remainder() {
    let payload = vec![0x33; OVERSIZED_BUFFER_CAPACITY];
    let large = encode(MSG_PING, 1, &payload).unwrap();
    let later = encode(MSG_PONG, 2, b"later").unwrap();
    let split = 3;
    let mut data = large;
    data.extend_from_slice(&later[..split]);
    let mut dec = Decoder::new();
    let mut visited = Vec::new();

    dec.decode_with(&data, |msg| {
        visited.push((msg.msg_type, msg.seq, msg.payload.len()));
        Ok::<(), Infallible>(())
    })
    .unwrap();

    assert_eq!(visited, vec![(MSG_PING, 1, payload.len())]);
    assert_eq!(dec.buf.as_slice(), &later[..split]);
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);

    dec.decode_with(&later[split..], |msg| {
        visited.push((msg.msg_type, msg.seq, msg.payload.len()));
        Ok::<(), Infallible>(())
    })
    .unwrap();

    assert_eq!(
        visited,
        vec![(MSG_PING, 1, payload.len()), (MSG_PONG, 2, b"later".len())]
    );
    assert!(dec.buf.is_empty());
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);
}

#[test]
fn decode_with_visitor_error_releases_empty_oversized_buffer() {
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum VisitorError {
        Stop,
    }

    let payload = vec![0x22; OVERSIZED_BUFFER_CAPACITY];
    let data = encode(MSG_PING, 1, &payload).unwrap();
    let mut dec = Decoder::new();

    let err = dec
        .decode_with(&data, |_msg| Err(VisitorError::Stop))
        .unwrap_err();

    assert!(matches!(err, DecodeWithError::Visitor(VisitorError::Stop)));
    assert!(dec.buf.is_empty());
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);
}

#[test]
fn decode_with_protocol_error_resets_oversized_capacity() {
    let mut dec = Decoder {
        buf: Vec::with_capacity(OVERSIZED_BUFFER_CAPACITY + 1),
    };
    let too_large = ((MAX_MESSAGE_SIZE + 1) as u32).to_be_bytes();

    let err = dec
        .decode_with::<()>(&too_large, |_| {
            panic!("visitor should not run for oversized frame")
        })
        .unwrap_err();

    assert!(matches!(
        err,
        DecodeWithError::Protocol(ProtocolError::MessageTooLarge(_))
    ));
    assert!(dec.buf.is_empty());
    assert!(dec.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY);
}
