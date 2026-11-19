use std::io::Seek;

use guest_control_proto::{Decoder, MSG_PING, MSG_WRITE_FILES, encode};

use super::*;

#[test]
fn consumes_payload_and_retains_following_frame() {
    let mut decoder = Decoder::new();
    let frame = encode(MSG_WRITE_FILES, 17, b"payload").unwrap();
    let prefix_len = guest_control_proto::HEADER_SIZE + guest_control_proto::MIN_BODY_SIZE + 3;
    assert!(decoder.decode(&frame[..prefix_len]).unwrap().is_empty());
    let incomplete = decoder.take_incomplete_frame(MSG_WRITE_FILES, 7).unwrap();
    let ping = encode(MSG_PING, 18, &[]).unwrap();
    let stream = [&frame[prefix_len..], &ping].concat();
    let mut reader = stream.as_slice();
    let mut scratch = [0; 16];
    let (mut input, retained) = receive(&mut reader, &mut scratch, &incomplete)
        .unwrap()
        .unwrap();

    input.rewind().unwrap();
    let mut payload = Vec::new();
    input.read_to_end(&mut payload).unwrap();
    assert_eq!(payload, b"payload");
    assert_eq!(&scratch[..retained], ping);
    assert_eq!(decoder.decode(&scratch[..retained]).unwrap()[0].seq, 18);
}
