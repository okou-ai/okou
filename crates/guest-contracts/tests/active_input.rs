use guest_contracts::active_input::{
    ActiveInputDecodeError, decode_active_input, encode_active_input, encoded_active_input_len,
};
use process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES;

const DELIVERY_ID: &str = "b1e2ad6d-930a-4d51-aa40-7952d54f978b";

#[test]
fn producer_bytes_round_trip_through_consumer() {
    for text in [
        "plain ascii",
        "quotes \" backslash \\ newline \n tab \t carriage \r",
        "unicode café 你好 🚀",
    ] {
        let bytes = encode_active_input(DELIVERY_ID, text).unwrap();
        assert_eq!(
            encoded_active_input_len(DELIVERY_ID, text).unwrap(),
            bytes.len()
        );
        assert_eq!(
            decode_active_input(&bytes).unwrap().into_parts(),
            (DELIVERY_ID.to_owned(), text.to_owned())
        );
    }

    assert_eq!(
        encode_active_input(DELIVERY_ID, "follow-up prompt").unwrap(),
        br#"{"type":"active-input","eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":"follow-up prompt"}"#
    );
}

#[test]
fn consumer_rejects_invalid_shapes() {
    for bytes in [
        br#"{"type":"active-input""#.as_slice(),
        br#"{}"#.as_slice(),
        br#"{"eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":"hello"}"#.as_slice(),
        br#"{"type":"active-input","text":"hello"}"#.as_slice(),
        br#"{"type":"active-input","eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b"}"#.as_slice(),
        br#"{"type":null,"eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":"hello"}"#
            .as_slice(),
        br#"{"type":"active-input","eventId":null,"text":"hello"}"#.as_slice(),
        br#"{"type":"active-input","eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":null}"#
            .as_slice(),
        br#"{"type":1,"eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":"hello"}"#.as_slice(),
        br#"{"type":"active-input","eventId":1,"text":"hello"}"#.as_slice(),
        br#"{"type":"active-input","eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":1}"#
            .as_slice(),
    ] {
        assert_eq!(
            decode_active_input(bytes),
            Err(ActiveInputDecodeError::InvalidPayload)
        );
    }
}

#[test]
fn consumer_rejects_invalid_field_values() {
    for (bytes, expected) in [
        (
            br#"{"type":"other","eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":"hello"}"#.as_slice(),
            ActiveInputDecodeError::UnsupportedType,
        ),
        (
            br#"{"type":"active-input","eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":""}"#.as_slice(),
            ActiveInputDecodeError::EmptyText,
        ),
        (
            br#"{"type":"active-input","eventId":"invalid","text":"hello"}"#.as_slice(),
            ActiveInputDecodeError::InvalidEventId,
        ),
        (
            br#"{"type":"active-input","eventId":"B1E2AD6D-930A-4D51-AA40-7952D54F978B","text":"hello"}"#.as_slice(),
            ActiveInputDecodeError::NonCanonicalEventId,
        ),
    ] {
        assert_eq!(decode_active_input(bytes), Err(expected));
    }
}

#[test]
fn consumer_accepts_unknown_fields() {
    let decoded = decode_active_input(
        br#"{"type":"active-input","eventId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":"hello","futureMetadata":{"version":2}}"#,
    )
    .unwrap();

    assert_eq!(
        decoded.into_parts(),
        (DELIVERY_ID.to_owned(), "hello".to_owned())
    );
}

#[test]
fn encoded_payloads_cover_the_transport_size_boundary() {
    let empty_len = encoded_active_input_len(DELIVERY_ID, "").unwrap();
    let exact_text = "x".repeat(MAX_CONTROL_PAYLOAD_BYTES - empty_len);
    let exact = encode_active_input(DELIVERY_ID, &exact_text).unwrap();
    assert_eq!(exact.len(), MAX_CONTROL_PAYLOAD_BYTES);
    assert_eq!(
        decode_active_input(&exact).unwrap().into_parts(),
        (DELIVERY_ID.to_owned(), exact_text.clone())
    );

    let over = encode_active_input(DELIVERY_ID, &format!("{exact_text}x")).unwrap();
    assert_eq!(over.len(), MAX_CONTROL_PAYLOAD_BYTES + 1);
}
