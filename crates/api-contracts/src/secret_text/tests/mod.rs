use super::*;

#[test]
fn utf8_secret_uses_exact_byte_bounds_without_exposing_values_in_errors() {
    let exact: SecretUtf8Text<6> = serde_json::from_str(r#""界界""#).unwrap();
    assert_eq!(exact.expose(), "界界");
    let allocation = exact.expose().as_ptr();
    let transferred = exact.into_zeroizing();
    assert_eq!(transferred.as_str(), "界界");
    assert_eq!(transferred.as_ptr(), allocation);
    for invalid in [r#"""#, r#""界界a""#, r#""secret-canary""#] {
        let error = serde_json::from_str::<SecretUtf8Text<6>>(invalid)
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret-canary"));
    }
}
