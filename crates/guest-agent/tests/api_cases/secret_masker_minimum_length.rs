use base64::Engine;
use guest_agent::masker::SecretMasker;

#[test]
fn from_raw_uses_utf8_byte_length_for_minimum_secret_length() {
    let secret = "密ab";
    assert!(secret.chars().count() < 5);
    assert_eq!(secret.len(), 5);

    let encoded = base64::engine::general_purpose::STANDARD.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(masker.mask_string(secret), "***");
}
