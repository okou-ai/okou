use guest_contracts::active_input::{
    decode_active_input, encode_active_input, encoded_active_input_len,
};
use process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES;

const DELIVERY_ID: &str = "b1e2ad6d-930a-4d51-aa40-7952d54f978b";

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
