//! Incremental normal-policy masking before transient text is published.

use std::ops::Range;

use super::{SecretMasker, merge_sorted_ranges, redaction_ranges};

/// Retains original bytes long enough to recognize every configured variant.
/// Dropping an interrupted stream discards its tail; only completion flushes it.
pub(crate) struct StreamingSecretMasker<'a> {
    masker: &'a SecretMasker,
    holdback: usize,
    pending: String,
    redactions: Vec<Range<usize>>,
    continuing_redaction: bool,
}

impl SecretMasker {
    pub(crate) fn stream(&self) -> StreamingSecretMasker<'_> {
        let longest = self
            .matcher
            .iter()
            .chain(self.url_encoded_matcher.iter())
            .map(|matcher| matcher.max_pattern_len())
            .max()
            .unwrap_or(0);
        StreamingSecretMasker {
            masker: self,
            holdback: longest.saturating_sub(1),
            pending: String::new(),
            redactions: Vec::new(),
            continuing_redaction: false,
        }
    }
}

impl StreamingSecretMasker<'_> {
    pub(crate) fn push(&mut self, text: &str) -> String {
        if self.holdback == 0 {
            return text.to_string();
        }
        self.pending.push_str(text);
        self.redactions = merge_sorted_ranges(
            std::mem::take(&mut self.redactions),
            redaction_ranges(
                self.masker.matcher.as_ref(),
                self.masker.url_encoded_matcher.as_ref(),
                &self.pending,
            ),
        );
        // No later pattern can touch bytes before this boundary. Keep original
        // bytes (not replacement markers) for overlapping matches in the tail.
        let mut end = self.pending.len().saturating_sub(self.holdback);
        while !self.pending.is_char_boundary(end) {
            end -= 1;
        }
        self.emit_prefix(end)
    }

    pub(crate) fn finish(mut self) -> String {
        self.emit_prefix(self.pending.len())
    }

    fn emit_prefix(&mut self, end: usize) -> String {
        if end == 0 {
            return String::new();
        }
        let mut output = String::new();
        let mut cursor = 0;
        for range in &self.redactions {
            if range.start >= end {
                break;
            }
            if range.start > cursor {
                output.push_str(&self.pending[cursor..range.start]);
                self.continuing_redaction = false;
            }
            if !self.continuing_redaction {
                output.push_str("***");
            }
            cursor = range.end.min(end);
            self.continuing_redaction = range.end > end;
            if cursor == end {
                break;
            }
        }
        if cursor < end {
            output.push_str(&self.pending[cursor..end]);
            self.continuing_redaction = false;
        }
        // Retain only the suffix allocation, not the capacity of a potentially
        // large provider delta for every source until message completion.
        self.pending = self.pending.split_off(end);
        // Carry coverage, rather than holding the whole matched union: a
        // self-overlap chain can be arbitrarily long but retention stays bounded.
        self.redactions.retain_mut(|range| {
            if range.end <= end {
                return false;
            }
            range.start = range.start.saturating_sub(end);
            range.end -= end;
            true
        });
        output
    }
}

#[cfg(test)]
mod tests {
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
        let mut stream = masker.stream();
        let text = "z".repeat(100_000);
        let mut actual = stream.push(&text);
        assert!(stream.pending.len() <= stream.holdback + 3);
        assert!(stream.pending.capacity() < text.len() / 2);
        actual.push_str(&stream.finish());
        assert_eq!(actual, text);
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
    fn unfinished_secret_prefix_is_not_published() {
        let masker = masker(&["audit-secret-12345"]);
        let mut stream = masker.stream();
        assert_eq!(stream.push("audit-sec"), "");
        drop(stream);
        let mut completed = masker.stream();
        assert_eq!(completed.push("audit-sec"), "");
        assert_eq!(completed.finish(), "audit-sec");
    }
}
