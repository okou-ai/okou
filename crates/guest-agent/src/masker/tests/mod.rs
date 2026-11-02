use super::*;
use serde_json::json;

fn masker_with(patterns: Vec<&str>) -> SecretMasker {
    SecretMasker::build(patterns.into_iter().map(String::from).collect())
}

fn masker_from_secrets(secrets: &[&str]) -> SecretMasker {
    let engine = base64::engine::general_purpose::STANDARD;
    let raw = secrets
        .iter()
        .map(|secret| engine.encode(*secret))
        .collect::<Vec<_>>()
        .join(",");
    SecretMasker::from_raw(&raw)
}

#[test]
fn empty_masker_is_noop() {
    let masker = SecretMasker::empty();
    let mut val = json!({"key": "value"});
    masker.mask_value(&mut val);
    assert_eq!(val, json!({"key": "value"}));
}

#[test]
fn masks_plain_secret() {
    let masker = masker_with(vec!["my-secret-token"]);
    let result = masker.mask_string("Bearer my-secret-token here");
    assert_eq!(result, "Bearer *** here");
}

#[test]
fn overlapping_secrets_are_fully_masked_in_both_orders() {
    let first = "abcdeX";
    let second = "Xvery-sensitive-value";
    let input = "abcdeXvery-sensitive-value";

    for secrets in [[first, second], [second, first]] {
        let masker = masker_from_secrets(&secrets);
        assert_eq!(masker.mask_string(input), "***");
    }
}

#[test]
fn self_overlapping_secret_is_fully_masked() {
    let masker = masker_from_secrets(&["ababa"]);

    assert_eq!(masker.mask_string("abababa"), "***");
}

#[test]
fn equal_end_containing_matches_merge_in_both_orders() {
    for patterns in [vec!["bcdef", "abcdef"], vec!["abcdef", "bcdef"]] {
        let masker = masker_with(patterns);
        assert_eq!(masker.mask_string("abcdef"), "***");
    }
}

#[test]
fn later_match_bridges_prior_disjoint_ranges() {
    let masker = masker_with(vec!["abcde", "fghij", "eXfghijY"]);

    assert_eq!(masker.mask_string("abcdeXfghijY"), "***");
}

#[test]
fn self_overlapping_secret_range_storage_is_bounded() {
    const INPUT_BYTES: usize = 16 * 1024 * 1024;

    let masker = masker_from_secrets(&["aaaaa"]);
    let input = "a".repeat(INPUT_BYTES);
    let ranges = redaction_ranges(
        masker.matcher.as_ref(),
        masker.url_encoded_matcher.as_ref(),
        &input,
    );

    assert_eq!(ranges.first(), Some(&(0..INPUT_BYTES)));
    assert!(
        ranges.capacity() < 1024,
        "one connected redaction range retained capacity for {} ranges",
        ranges.capacity()
    );
    assert_eq!(redact_ranges(input, &ranges), "***");
}

#[test]
fn chained_overlapping_secrets_are_fully_masked() {
    let masker = masker_from_secrets(&["abcdeX", "XmiddleY", "Yvery-sensitive-value"]);

    assert_eq!(
        masker.mask_string("abcdeXmiddleYvery-sensitive-value"),
        "***"
    );
}

#[test]
fn masks_nested_json() {
    let masker = masker_with(vec!["secret123"]);
    let mut val = json!({
        "outer": {
            "inner": "has secret123 inside"
        },
        "list": ["no match", "secret123"]
    });
    masker.mask_value(&mut val);
    assert_eq!(val["outer"]["inner"], "has *** inside");
    assert_eq!(val["list"][1], "***");
}

#[test]
fn masks_nested_json_keys() {
    let masker = masker_with(vec!["secret123"]);
    let mut val = json!({
        "prefix-secret123-suffix": {
            "list": [{"secret123": "value has secret123"}]
        }
    });

    masker.mask_value(&mut val);

    assert_eq!(
        val,
        json!({
            "prefix-***-suffix": {
                "list": [{"***": "value has ***"}]
            }
        })
    );
}

#[test]
fn masked_json_key_collisions_preserve_every_entry() {
    let masker = masker_with(vec!["secret-one", "secret-two"]);
    let original = json!({
        "***": "reserved base",
        "***#2": "reserved suffix",
        "secret-one": {"secret-two": "first"},
        "secret-two": "second"
    });
    let mut first = original.clone();
    let mut second = original;

    masker.mask_value(&mut first);
    masker.mask_value(&mut second);

    let expected = json!({
        "***": "reserved base",
        "***#2": "reserved suffix",
        "***#3": {"***": "first"},
        "***#4": "second"
    });
    assert_eq!(first, expected);
    assert_eq!(second, expected);
}

#[test]
fn masked_json_keys_do_not_recreate_secret_patterns() {
    let masker = masker_with(vec!["secret123", "prefix-***-suffix", "***#2"]);
    let mut val = json!({
        "***": "reserved base",
        "***#2": "collision candidate",
        "prefix-secret123-suffix": "cascading match"
    });

    masker.mask_value(&mut val);

    assert_eq!(
        val,
        json!({
            "***": "reserved base",
            "***#3": "collision candidate",
            "***#4": "cascading match"
        })
    );
}

#[test]
fn mask_string_in_place_preserves_unmatched_allocation() {
    let masker = masker_with(vec!["secret123"]);
    let mut value = String::from("ordinary event field");
    let original_ptr = value.as_ptr();
    let original_capacity = value.capacity();

    assert!(!masker.mask_string_in_place(&mut value));

    assert_eq!(value, "ordinary event field");
    assert_eq!(value.as_ptr(), original_ptr);
    assert_eq!(value.capacity(), original_capacity);
}

#[test]
fn mask_string_in_place_masks_matched_string() {
    let masker = masker_with(vec!["secret123"]);
    let mut value = String::from("Bearer secret123");

    assert!(masker.mask_string_in_place(&mut value));

    assert_eq!(value, "Bearer ***");
}

#[test]
fn diagnostic_string_preserves_allocation_without_matchers() {
    let masker = SecretMasker::empty();
    let value = String::from("ordinary diagnostic text");
    let original_ptr = value.as_ptr();
    let original_capacity = value.capacity();

    let masked = masker.mask_diagnostic_string(value);

    assert_eq!(masked, "ordinary diagnostic text");
    assert_eq!(masked.as_ptr(), original_ptr);
    assert_eq!(masked.capacity(), original_capacity);
}

#[test]
fn diagnostic_lines_mask_multiline_secret_without_collapsing_lines() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "first-line\nsecond-secret-line\nthird-line\n";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    let lines = vec![
        "before".to_string(),
        "first-line".to_string(),
        "second-secret-line".to_string(),
        "third-line".to_string(),
        "after".to_string(),
    ];

    assert_eq!(
        masker.mask_diagnostic_lines(lines),
        vec![
            "before".to_string(),
            "***".to_string(),
            "***".to_string(),
            "***".to_string(),
            "after".to_string(),
        ]
    );
}

#[test]
fn diagnostic_string_preserves_crlf_blank_lines_and_terminal_newline() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "first-secret-line\r\nsecond-secret-line";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_diagnostic_string(
            "before\r\nfirst-secret-line\r\n\r\nsecond-secret-line\r\nafter\n".to_string(),
        ),
        "before\r\n***\r\n\r\n***\r\nafter\n"
    );
}

#[test]
fn diagnostic_lines_mask_trailing_newline_secret_at_end_with_short_lines() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "aa\nbb\ncc\n";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_diagnostic_lines(vec![
            "before".to_string(),
            "aa".to_string(),
            "bb".to_string(),
            "cc".to_string(),
        ]),
        vec![
            "before".to_string(),
            "***".to_string(),
            "***".to_string(),
            "***".to_string(),
        ]
    );
}

#[test]
fn diagnostic_lines_mask_single_line_secret_with_terminal_newline() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "abcde\n";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_diagnostic_lines(vec!["abcde".to_string()]),
        vec!["***".to_string()]
    );
}

#[test]
fn diagnostic_lines_mask_repeated_matches_on_same_line() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "abcde\n";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_diagnostic_lines(vec!["abcde abcde".to_string()]),
        vec!["*** ***".to_string()]
    );
}

#[test]
fn diagnostic_lines_mask_overlapping_secrets_in_both_orders() {
    let first = "abcdeX";
    let second = "Xvery-sensitive-value";
    let input = "abcdeXvery-sensitive-value";

    for secrets in [[first, second], [second, first]] {
        let masker = masker_from_secrets(&secrets);
        assert_eq!(
            masker.mask_diagnostic_lines(vec![input.to_string()]),
            vec!["***".to_string()]
        );
    }
}

#[test]
fn diagnostic_lines_mask_only_one_missing_terminal_newline() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "aa\nbb\ncc\n\n";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_diagnostic_lines(vec![
            "before".to_string(),
            "aa".to_string(),
            "bb".to_string(),
            "cc".to_string(),
            String::new(),
        ]),
        vec![
            "before".to_string(),
            "***".to_string(),
            "***".to_string(),
            "***".to_string(),
            String::new(),
        ]
    );
}

#[test]
fn normal_masking_does_not_use_multiline_fragments() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "first-line\nsecond-secret-line\nthird-line";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_string("second-secret-line"),
        "second-secret-line"
    );
    assert_eq!(
        masker.mask_diagnostic_lines(vec!["second-secret-line".to_string()]),
        vec!["***".to_string()]
    );
}

#[test]
fn from_raw_with_encoded_secrets() {
    // Build comma-separated base64-encoded secrets (matching TS format)
    let engine = base64::engine::general_purpose::STANDARD;
    let s1 = engine.encode("hello-world-secret");
    let s2 = engine.encode("tiny");
    let encoded = format!("{s1},{s2}");

    let masker = SecretMasker::from_raw(&encoded);
    // "hello-world-secret" is masked (all three variants)
    assert_eq!(masker.mask_string("hello-world-secret"), "***");
    assert_eq!(masker.mask_string(&s1), "***");
    // "tiny" is < 5 UTF-8 bytes, not masked
    assert_eq!(masker.mask_string("tiny"), "tiny");
}

#[test]
fn url_encode_special_chars() {
    assert_eq!(url_encode("hello world"), "hello%20world");
    assert_eq!(url_encode("a+b=c"), "a%2Bb%3Dc");
}

#[test]
fn from_raw_empty_string() {
    let masker = SecretMasker::from_raw("");
    assert_eq!(masker.mask_string("anything"), "anything");
}

#[test]
fn from_raw_invalid_base64() {
    let masker = SecretMasker::from_raw("not-valid-b64!!!");
    assert_eq!(masker.mask_string("anything"), "anything");
}

#[test]
fn from_raw_skips_short_secrets() {
    let engine = base64::engine::general_purpose::STANDARD;
    let short = engine.encode("abcd"); // 4 UTF-8 bytes < MIN_SECRET_LEN
    let masker = SecretMasker::from_raw(&short);
    assert_eq!(masker.mask_string("abcd"), "abcd");
}

#[test]
fn from_raw_includes_url_encoded_variant() {
    let engine = base64::engine::general_purpose::STANDARD;
    // Secret with special chars that need URL encoding
    let secret = "key=value&token=abc123";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);
    // Plain, base64, and url-encoded variants all mask
    assert_eq!(masker.mask_string(secret), "***");
    assert_eq!(masker.mask_string(&encoded), "***");
    assert_eq!(masker.mask_string(&url_encode(secret)), "***");
}

#[test]
fn masks_lowercase_percent_encoded_variant() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "token/a";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_string("Bearer token%2fa here"),
        "Bearer *** here"
    );
}

#[test]
fn masks_mixed_case_percent_encoded_variant() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "key=value/token+abc123";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_string("url key%3dvalue%2Ftoken%2babc123"),
        "url ***"
    );
}

#[test]
fn lowercase_percent_encoded_overlapping_secrets_are_fully_masked_in_both_orders() {
    let first = "abcde/";
    let second = "/very-sensitive-value";
    let input = "abcde%2fvery-sensitive-value";

    for secrets in [[first, second], [second, first]] {
        let masker = masker_from_secrets(&secrets);
        assert_eq!(masker.mask_string(input), "***");
    }
}

#[test]
fn mask_value_masks_lowercase_percent_encoded_variant() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "token/a";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);
    let mut val = json!({
        "outer": {
            "inner": "contains token%2fa here"
        }
    });

    masker.mask_value(&mut val);

    assert_eq!(val["outer"]["inner"], "contains *** here");
}

#[test]
fn diagnostic_lines_mask_lowercase_percent_encoded_variant() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "key=value/token+abc123";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_diagnostic_lines(vec![
            "before".to_string(),
            "stderr key%3dvalue%2Ftoken%2babc123 tail".to_string(),
            "after".to_string(),
        ]),
        vec![
            "before".to_string(),
            "stderr *** tail".to_string(),
            "after".to_string(),
        ]
    );
}

#[test]
fn invalid_percent_escapes_do_not_match_url_encoded_secret() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "token/a";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);
    let input = "token%2ga token% token%2";

    assert_eq!(masker.mask_string(input), input);
}

#[test]
fn lowercase_percent_path_keeps_plain_and_base64_case_sensitive() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "Case/Secret";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);
    let lowercase_base64 = encoded.to_ascii_lowercase();

    assert_eq!(
        masker.mask_string("case/secret and %2f"),
        "case/secret and %2f"
    );
    assert_ne!(lowercase_base64, encoded);
    assert_eq!(
        masker.mask_string(&format!("{lowercase_base64} and %2f")),
        format!("{lowercase_base64} and %2f")
    );
}

#[test]
fn adjacent_lowercase_percent_encoded_matches_stay_separate() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "token/a";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(masker.mask_string("token%2fatoken%2fa"), "******");
}

#[test]
fn duplicate_url_encoded_ranges_redact_once_on_lowercase_percent_path() {
    let engine = base64::engine::general_purpose::STANDARD;
    let secret = "token/a";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(masker.mask_string("token%2Fa and %2f"), "*** and %2f");
}

#[test]
fn original_and_canonicalized_url_ranges_merge_in_input_order() {
    let masker = masker_from_secrets(&["token/a"]);

    assert_eq!(
        masker.mask_string("token%2Fa|token%2fa|token%2Fa"),
        "***|***|***"
    );
}

#[test]
fn mask_value_mixed_json_tree() {
    let masker = masker_with(vec!["secret"]);
    let mut val = json!({
        "token": "my secret key",
        "num": 42,
        "bool": true,
        "null": null,
        "list": ["no match", "has secret here"],
        "nested": {"deep": "another secret value"}
    });
    masker.mask_value(&mut val);
    // Strings containing "secret" are masked
    assert_eq!(val["token"], "my *** key");
    assert_eq!(val["list"][1], "has *** here");
    assert_eq!(val["nested"]["deep"], "another *** value");
    // Non-string types and non-matching strings are untouched
    assert_eq!(val["num"], 42);
    assert_eq!(val["bool"], true);
    assert!(val["null"].is_null());
    assert_eq!(val["list"][0], "no match");
}

#[test]
fn mask_value_preserves_unmatched_string_allocation() {
    let masker = masker_with(vec!["secret123"]);
    let mut val = Value::String(String::from("ordinary event field"));
    let Value::String(value) = &val else {
        panic!("test value should be a string");
    };
    let original_ptr = value.as_ptr();
    let original_capacity = value.capacity();

    masker.mask_value(&mut val);

    let Value::String(value) = &val else {
        panic!("masked value should remain a string");
    };
    assert_eq!(value, "ordinary event field");
    assert_eq!(value.as_ptr(), original_ptr);
    assert_eq!(value.capacity(), original_capacity);
}

#[test]
fn mask_string_multiple_occurrences() {
    let masker = masker_with(vec!["token"]);
    let result = masker.mask_string("token and token again");
    assert_eq!(result, "*** and *** again");
}

#[test]
fn url_encode_preserves_unreserved() {
    // All unreserved chars per ECMAScript spec
    let unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    assert_eq!(url_encode(unreserved), unreserved);
}

#[test]
fn url_encode_encodes_slash_and_at() {
    assert_eq!(url_encode("/"), "%2F");
    assert_eq!(url_encode("@"), "%40");
}

#[test]
fn hex_digit_all_values() {
    for n in 0..=15u8 {
        let c = hex_digit(n);
        let expected = format!("{n:X}").chars().next().unwrap();
        assert_eq!(c, expected, "hex_digit({n})");
    }
}

/// Aho-Corasick matches on bytes, but `from_raw` guarantees every pattern
/// is valid UTF-8, so multi-byte codepoints must round-trip through
/// masking without corruption.
#[test]
fn masks_multibyte_utf8_secret() {
    let engine = base64::engine::general_purpose::STANDARD;
    // Mix CJK + emoji — each codepoint is 3–4 bytes.
    let secret = "北京-🔑-token";
    let encoded = engine.encode(secret);
    let masker = SecretMasker::from_raw(&encoded);

    assert_eq!(
        masker.mask_string(&format!("prefix {secret} suffix")),
        "prefix *** suffix"
    );
    // Surrounding multi-byte content that is not part of the secret is
    // preserved byte-for-byte.
    assert_eq!(masker.mask_string("北京-other"), "北京-other");
}

/// Regression for #9778: when one secret is a substring of another, the
/// full containing range must be redacted so no secret fragment leaks.
#[test]
fn substring_secret_is_fully_masked() {
    // Short secret registered BEFORE the long one — this is the ordering
    // that broke the old `str::replace` loop.
    let engine = base64::engine::general_purpose::STANDARD;
    let short = engine.encode("secret");
    let long = engine.encode("mysecret-token-xyz");
    let raw = format!("{short},{long}");
    let masker = SecretMasker::from_raw(&raw);

    // The union covers the containing pattern, so no fragments escape.
    assert_eq!(
        masker.mask_string("mysecret-token-xyz appeared in log"),
        "*** appeared in log"
    );
    // Short secret still masks when the long one is not present.
    assert_eq!(masker.mask_string("plain secret alone"), "plain *** alone");
    // Both secrets present at different positions: both get masked.
    assert_eq!(
        masker.mask_string("secret and mysecret-token-xyz"),
        "*** and ***"
    );
}
