use super::*;

/// 64 lowercase hex chars — what `Sha256::digest(...).hex_encode()` returns.
const VALID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn validate_name_accepts_canonical() {
    assert!(validate_name(VALID));
}

#[test]
fn validate_name_rejects_wrong_length() {
    assert!(!validate_name(""));
    assert!(!validate_name("a"));
    assert!(!validate_name(&VALID[..63])); // 63
    assert!(!validate_name(&format!("{VALID}a"))); // 65
}

#[test]
fn validate_name_rejects_uppercase() {
    let upper = VALID.to_uppercase();
    assert_eq!(upper.len(), 64);
    assert!(!validate_name(&upper));
}

#[test]
fn validate_name_rejects_non_hex() {
    // Replace one char with a non-hex byte while keeping length 64.
    // Includes realistic mistake modes: shell-paste artifacts (`\n`,
    // `\r`, `\t`) and path metacharacters (`/`, `\`) at the
    // not-too-short length where the cheap length check wouldn't
    // catch them.
    let mut s = String::from(&VALID[..63]);
    for bad in ['g', '-', '_', ' ', 'G', '/', '\\', '\n', '\r', '\t'] {
        s.push(bad);
        assert!(!validate_name(&s), "expected reject for trailing {bad:?}");
        s.pop();
    }
}

#[test]
fn validate_name_rejects_multibyte_utf8_at_byte_len_64() {
    // Defence against the "non-ASCII string sneaks past length check"
    // vector. `'É'` is 0xC3 0x89 in UTF-8 — exactly 2 bytes per char,
    // 32 of them = 64 bytes. The byte-level check catches the 0xC3
    // continuation prefix even though `len()` matches.
    let s = "É".repeat(32);
    assert_eq!(s.len(), 64, "test fixture invariant");
    assert!(!validate_name(&s));
}

#[test]
fn validate_name_rejects_path_traversal() {
    // The security-relevant cases the validator exists to block.
    assert!(!validate_name("..")); // bare relative
    assert!(!validate_name("../etc")); // traversal
    assert!(!validate_name("/etc")); // absolute path
    assert!(!validate_name("/etc/passwd")); // absolute, multi-segment
    assert!(!validate_name(".")); // current dir
    assert!(!validate_name("vm0/abc")); // contains slash
    assert!(!validate_name(r"vm0\abc")); // backslash
}

#[test]
fn validate_or_err_passes_for_valid_hash() {
    assert!(validate_or_err(VALID).is_ok());
}

#[test]
fn validate_or_err_carries_offending_value_in_message() {
    let err = validate_or_err("../etc").unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("invalid image hash"), "got: {msg}");
    assert!(msg.contains("../etc"), "got: {msg}");
}
