use base64::Engine;

use super::*;

fn masker(secrets: &[&str]) -> SecretMasker {
    SecretMasker::from_raw(
        &secrets
            .iter()
            .map(|secret| base64::engine::general_purpose::STANDARD.encode(secret))
            .collect::<Vec<_>>()
            .join(","),
    )
}

#[test]
fn every_split_and_scalar_partition_matches_whole_string_policy() {
    let masker = masker(&[
        "audit-secret-12345",
        "audit/+secret π",
        "abcde",
        "cdefg",
        "aaaaa",
        "🦀é🦀",
        "abcd%",
        "token/a",
        "%2faX",
    ]);
    let encoded = base64::engine::general_purpose::STANDARD.encode("audit-secret-12345");
    for text in [
        String::new(),
        "plain é text with no secrets".into(),
        "short".into(),
        "prefix audit-secret-12345 suffix".into(),
        format!("prefix {encoded} suffix"),
        "audit/+secret π | audit%2F%2Bsecret%20%CF%80".into(),
        "audit%2f%2bsecret%20%cf%80 | audit%2F%2bsecret%20%cF%80".into(),
        "abcdefg aaaaaaaaaa abcdeabcde cdefgabcde".into(),
        "🦀é🦀é🦀🦀é🦀 plain 🦀 incomplete audit-sec".into(),
        "abcd%|abcd%x|token%2fatoken%2fa|token%2ga|token%2|token%".into(),
        "%252faX|%252FaX|token%2Fa|%token%2fa|%%2faX".into(),
    ] {
        let expected = masker.mask_string(&text);
        let boundaries = text
            .char_indices()
            .map(|(index, _)| index)
            .chain([text.len()])
            .collect::<Vec<_>>();
        for &first in &boundaries {
            for &second in boundaries.iter().filter(|&&index| index >= first) {
                let mut stream = masker.stream();
                let mut actual = stream.push(&text[..first]);
                actual.push_str(&stream.push(&text[first..second]));
                actual.push_str(&stream.push(&text[second..]));
                actual.push_str(&stream.finish());
                assert_eq!(actual, expected, "splits {first}, {second} in {text:?}");
            }
        }
        let mut stream = masker.stream();
        let mut actual = String::new();
        for ch in text.chars() {
            actual.push_str(&stream.push(&ch.to_string()));
        }
        actual.push_str(&stream.finish());
        assert_eq!(actual, expected, "scalar partition of {text:?}");
    }
}

#[test]
fn long_overlap_chains_keep_only_a_bounded_original_tail() {
    let masker = masker(&["aaaaa", "🦀é🦀"]);
    for text in ["a".repeat(10_000), "🦀é".repeat(1000)] {
        let mut stream = masker.stream();
        let mut actual = String::new();
        for ch in text.chars() {
            actual.push_str(&stream.push(&ch.to_string()));
            assert!(stream.pending.len() <= stream.holdback + 3);
        }
        actual.push_str(&stream.finish());
        assert_eq!(actual, masker.mask_string(&text));
    }
}

#[test]
fn large_deltas_do_not_retain_their_allocation() {
    let masker = masker(&["audit-secret-12345"]);
    for text in ["z".repeat(100_000), "audit-secret-12345 ".repeat(5000)] {
        let mut stream = masker.stream();
        let mut actual = stream.push(&text);
        assert!(stream.pending.len() <= stream.holdback + 3);
        assert!(stream.pending.capacity() < text.len() / 2);
        // Consumed map entries release their nodes; no vector capacity
        // survives the independent matches in a large provider delta.
        assert!(stream.redactions.len() <= stream.pending.len());
        actual.push_str(&stream.finish());
        assert_eq!(actual, masker.mask_string(&text));
    }
}

#[test]
fn no_configured_patterns_stream_immediately() {
    let masker = masker(&["tiny"]);
    let mut stream = masker.stream();
    assert_eq!(stream.push("é plain"), "é plain");
    assert_eq!(stream.push(" tail"), " tail");
    assert_eq!(stream.finish(), "");
}

#[test]
fn long_secrets_scan_and_relocate_only_linear_input_bytes() {
    for secret_len in [64usize, 4096, 16_384, 65_536] {
        let mut secret = "0123456789abcdef".repeat(secret_len.div_ceil(16));
        secret.truncate(secret_len - 1);
        secret.push('/');
        let masker = masker(&[&secret]);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&secret);
        let percent_encoded = super::super::url_encode(&secret).replace("%2F", "%2f");
        for variant in ["", secret.as_str(), &encoded, &percent_encoded] {
            let text = format!("{}{variant}{}", "x".repeat(65_536), "x".repeat(196_608));
            let expected = masker.mask_string(&text);
            for delta_len in [16, 256, 4096] {
                let mut stream = masker.stream();
                let mut actual = String::new();
                for delta in text.as_bytes().chunks(delta_len) {
                    actual.push_str(&stream.push(std::str::from_utf8(delta).unwrap()));
                    assert!(stream.pending.len() <= stream.holdback + 3);
                    assert!(stream.pending.capacity() <= 4 * (stream.holdback + 3));
                }
                // These positions advance at the actual transition call,
                // counting both the original and normalized matching paths.
                assert_eq!(stream.plain.as_ref().unwrap().consumed, text.len());
                assert_eq!(stream.url_encoded.as_ref().unwrap().consumed, text.len());
                assert!(
                    stream.relocated_bytes <= 2 * text.len(),
                    "retained-byte relocation grew with holdback for {secret_len}-byte secret, {delta_len}-byte deltas"
                );
                actual.push_str(&stream.finish());
                assert_eq!(
                    actual, expected,
                    "{secret_len}-byte secret, {delta_len}-byte deltas"
                );
            }
        }
    }
}

#[test]
fn unfinished_secret_prefix_is_not_published() {
    let masker = masker(&["audit-secret-12345"]);
    let mut stream = masker.stream();
    assert_eq!(stream.push("audit-sec"), "");
    drop(stream);
    let mut completed = masker.stream();
    assert_eq!(completed.push("audit-sec"), "");
    assert_eq!(completed.finish(), "audit-sec");
}
