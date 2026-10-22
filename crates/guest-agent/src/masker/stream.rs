//! Incremental normal-policy masking before transient text is published.

use std::{
    collections::{BTreeMap, VecDeque},
    ops::Range,
};

use aho_corasick::{
    Anchored,
    automaton::{Automaton, StateID},
    nfa::contiguous::NFA,
};

use super::SecretMasker;

struct MatcherState<'a> {
    matcher: &'a NFA,
    state: StateID,
    consumed: usize,
}

impl<'a> MatcherState<'a> {
    #[allow(clippy::expect_used)]
    fn new(matcher: &'a NFA) -> Self {
        Self {
            matcher,
            // Concrete NFAs support unanchored searches. Failure must not turn
            // a configured masker into a pass-through stream.
            state: matcher
                .start_state(Anchored::No)
                .expect("secret matcher must support unanchored searches"),
            consumed: 0,
        }
    }

    fn advance(&mut self, byte: u8) -> Option<Range<usize>> {
        self.state = self.matcher.next_state(Anchored::No, self.state, byte);
        self.consumed += 1;
        if !self.matcher.is_match(self.state) {
            return None;
        }
        // Matches ending at this byte are nested. Their union is the longest
        // one, regardless of the configured pattern order.
        let longest = (0..self.matcher.match_len(self.state))
            .map(|index| {
                self.matcher
                    .pattern_len(self.matcher.match_pattern(self.state, index))
            })
            .max()?;
        Some(self.consumed - longest..self.consumed)
    }
}

/// Retains original bytes long enough to recognize every configured variant.
/// Dropping an interrupted stream discards its tail; only completion flushes it.
pub(crate) struct StreamingSecretMasker<'a> {
    plain: Option<MatcherState<'a>>,
    url_encoded: Option<MatcherState<'a>>,
    holdback: usize,
    pending: VecDeque<u8>,
    emitted: usize,
    redactions: BTreeMap<usize, usize>,
    continuing_redaction: bool,
    #[cfg(test)]
    relocated_bytes: usize,
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
            plain: self.matcher.as_ref().map(MatcherState::new),
            url_encoded: self.url_encoded_matcher.as_ref().map(MatcherState::new),
            holdback: longest.saturating_sub(1),
            pending: VecDeque::new(),
            emitted: 0,
            redactions: BTreeMap::new(),
            continuing_redaction: false,
            #[cfg(test)]
            relocated_bytes: 0,
        }
    }
}

impl StreamingSecretMasker<'_> {
    pub(crate) fn push(&mut self, text: &str) -> String {
        if self.holdback == 0 {
            return text.to_string();
        }
        #[cfg(test)]
        let previous_buffer = (self.pending.len(), self.pending.capacity());
        self.pending.extend(text.bytes());
        #[cfg(test)]
        if self.pending.capacity() != previous_buffer.1 {
            self.relocated_bytes += previous_buffer.0;
        }
        for byte in text.bytes() {
            if let Some(range) = self.plain.as_mut().and_then(|state| state.advance(byte)) {
                self.record_redaction(range);
            }
        }
        self.scan_url_encoded(false);
        // No later pattern can touch bytes before this boundary. Keep original
        // bytes (not replacement markers) for overlapping matches in the tail.
        let mut end = self.pending.len().saturating_sub(self.holdback);
        while self
            .pending
            .get(end)
            .is_some_and(|byte| byte & 0b1100_0000 == 0b1000_0000)
        {
            end -= 1;
        }
        self.emit_prefix(self.emitted + end)
    }

    pub(crate) fn finish(mut self) -> String {
        self.scan_url_encoded(true);
        self.emit_prefix(self.emitted + self.pending.len())
    }

    fn scan_url_encoded(&mut self, finishing: bool) {
        while let Some(state) = &self.url_encoded {
            let index = state.consumed - self.emitted;
            let Some(&byte) = self.pending.get(index) else {
                break;
            };
            let mut bytes = [byte, 0, 0];
            let mut count = 1;
            if byte == b'%' {
                // Keep at most two bytes of normalization lookahead. No URL
                // pattern can end inside an incomplete encoded escape, so this
                // does not extend the longest-pattern publication holdback.
                if !finishing && self.pending.len() - index < 3 {
                    break;
                }
                if let Some((&first, &second)) =
                    self.pending.get(index + 1).zip(self.pending.get(index + 2))
                    && first.is_ascii_hexdigit()
                    && second.is_ascii_hexdigit()
                {
                    bytes = [
                        byte,
                        first.to_ascii_uppercase(),
                        second.to_ascii_uppercase(),
                    ];
                    count = 3;
                }
            }
            for byte in bytes.into_iter().take(count) {
                if let Some(range) = self
                    .url_encoded
                    .as_mut()
                    .and_then(|state| state.advance(byte))
                {
                    self.record_redaction(range);
                }
            }
        }
    }

    fn record_redaction(&mut self, mut range: Range<usize>) {
        debug_assert!(range.start >= self.emitted);
        // Normalization can report a match after the plain matcher has moved
        // ahead. Merge by position, without rescanning or rebasing all ranges.
        if let Some((&start, &end)) = self.redactions.range(..=range.start).next_back()
            && end > range.start
        {
            self.redactions.remove(&start);
            range.start = start;
            range.end = range.end.max(end);
        }
        while let Some((&start, &end)) = self.redactions.range(range.start..range.end).next() {
            self.redactions.remove(&start);
            range.end = range.end.max(end);
        }
        self.redactions.insert(range.start, range.end);
    }

    #[allow(clippy::expect_used)]
    fn emit_prefix(&mut self, end: usize) -> String {
        if end == self.emitted {
            return String::new();
        }
        let mut output = Vec::new();
        let mut cursor = self.emitted;
        while let Some((&start, &range_end)) = self.redactions.first_key_value() {
            if start >= end {
                break;
            }
            if start > cursor {
                output.extend(
                    self.pending
                        .range(cursor - self.emitted..start - self.emitted),
                );
                self.continuing_redaction = false;
            }
            if !self.continuing_redaction {
                output.extend_from_slice(b"***");
            }
            cursor = range_end.min(end);
            self.redactions.pop_first();
            self.continuing_redaction = range_end > end;
            if self.continuing_redaction {
                self.redactions.insert(end, range_end);
            }
            if cursor == end {
                break;
            }
        }
        if cursor < end {
            output.extend(
                self.pending
                    .range(cursor - self.emitted..end - self.emitted),
            );
            self.continuing_redaction = false;
        }
        // Removing a deque prefix moves no retained bytes. Shrink only an
        // oversized provider allocation, leaving room for ordinary small deltas.
        self.pending.drain(..end - self.emitted);
        self.emitted = end;
        let tail_bound = self.holdback + 3;
        if self.pending.capacity() > tail_bound.saturating_mul(4) {
            #[cfg(test)]
            {
                self.relocated_bytes += self.pending.len();
            }
            self.pending.shrink_to(tail_bound.saturating_mul(2));
        }
        // Original text and patterns are valid UTF-8; match ranges and the
        // emission boundary end at scalars. Deque wraparound changes no bytes.
        String::from_utf8(output).expect("masked stream must preserve UTF-8")
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
}
