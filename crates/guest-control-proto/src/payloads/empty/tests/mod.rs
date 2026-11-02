use super::*;

#[test]
fn empty_payload_accepts_empty_slice() {
    decode_empty_payload("test must be empty", &[]).unwrap();
}

#[test]
fn empty_payload_rejects_non_empty_slice() {
    let err = decode_empty_payload("test must be empty", b"x").unwrap_err();
    assert_eq!(err.to_string(), "invalid payload: test must be empty");
}
