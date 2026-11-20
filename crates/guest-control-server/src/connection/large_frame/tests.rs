use std::io::Seek;

use guest_control_proto::{Decoder, MSG_PING, MSG_WRITE_FILES, encode};

use super::*;

#[test]
fn consumes_payload_and_retains_following_frame() {
    let mut decoder = Decoder::new();
    let frame = encode(MSG_WRITE_FILES, 17, b"payload").unwrap();
    let prefix_len = guest_control_proto::HEADER_SIZE + guest_control_proto::MIN_BODY_SIZE + 3;
    assert!(decoder.decode(&frame[..prefix_len]).unwrap().is_empty());
    let incomplete = decoder.take_incomplete_frame(MSG_WRITE_FILES, 7..).unwrap();
    let ping = encode(MSG_PING, 18, &[]).unwrap();
    let stream = [&frame[prefix_len..], &ping].concat();
    let mut reader = stream.as_slice();
    let mut scratch = [0; 16];
    let (mut input, retained) = receive_write(&mut reader, &mut scratch, &incomplete)
        .unwrap()
        .unwrap();

    input.rewind().unwrap();
    let mut payload = Vec::new();
    input.read_to_end(&mut payload).unwrap();
    assert_eq!(payload, b"payload");
    assert_eq!(&scratch[..retained], ping);
    assert_eq!(decoder.decode(&scratch[..retained]).unwrap()[0].seq, 18);
}

#[test]
fn rejects_invalid_trailing_frame_before_returning_the_payload() {
    let mut decoder = Decoder::new();
    let frame = encode(MSG_WRITE_FILES, 17, b"payload").unwrap();
    let prefix_len = guest_control_proto::HEADER_SIZE + guest_control_proto::MIN_BODY_SIZE;
    assert!(decoder.decode(&frame[..prefix_len]).unwrap().is_empty());
    let frame = decoder.take_incomplete_frame(MSG_WRITE_FILES, 7..).unwrap();
    let mut body_and_trailing = b"payload\0\0\0\0".as_slice();
    let mut scratch = [0; 16];
    let mut input = Vec::new();
    assert!(receive_into(&mut body_and_trailing, &mut scratch, &frame, &mut input).is_err());
}

#[test]
fn storage_recovers_the_written_prefix_when_the_file_stops_accepting_writes() {
    let mut file = sealed_input::create(c"storage-receive-write-failure").unwrap();
    file.write_all(b"prefix").unwrap();
    sealed_input::seal(&file).unwrap();
    let mut storage = StorageBuffer::File(file);
    storage.write_all(b"remaining").unwrap();

    let ReceivedStorage::Buffered(payload) = storage.finish().unwrap() else {
        panic!("expected the owned buffer after descriptor write failure");
    };
    assert_eq!(payload.as_ref(), b"prefixremaining");
}

#[test]
fn storage_retains_the_complete_payload_when_sealing_fails() {
    use rustix::fs::{SealFlags, fcntl_add_seals};

    let file = sealed_input::create(c"storage-receive-seal-failure").unwrap();
    fcntl_add_seals(&file, SealFlags::SEAL).unwrap();
    let mut storage = StorageBuffer::File(file);
    storage.write_all(b"complete").unwrap();

    let ReceivedStorage::Buffered(payload) = storage.finish().unwrap() else {
        panic!("expected the owned buffer after descriptor sealing failure");
    };
    assert_eq!(payload.as_ref(), b"complete");
}
