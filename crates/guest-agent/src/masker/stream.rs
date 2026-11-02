//! Incremental normal-policy masking before transient text is published.

use std::{
    collections::{BTreeMap, VecDeque},
    ops::{Bound::Excluded, Range},
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
            range.start = start;
            range.end = range.end.max(end);
        }
        // Preserve an overlapping predecessor's node so a self-overlap chain
        // updates its coverage without allocating a new node for every byte.
        while let Some((&start, &end)) = self
            .redactions
            .range((Excluded(range.start), Excluded(range.end)))
            .next()
        {
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
mod tests;
