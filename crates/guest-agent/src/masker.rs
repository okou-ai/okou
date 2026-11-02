//! Secret value masking for event payloads and CLI diagnostics.
//!
//! Consumes the guest config's comma-separated base64 secret values,
//! pre-computes plain / base64 / URL-encoded variants for normal payload
//! masking, and derives diagnostic-only multiline variants for bounded CLI
//! stderr tails.

mod stream;
pub(crate) use stream::StreamingSecretMasker;

use crate::env;
use aho_corasick::{Input, MatchKind, automaton::Automaton, nfa::contiguous::NFA};
use base64::Engine;
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    ops::Range,
};

/// Minimum secret length in UTF-8 bytes to avoid false-positive masking.
const MIN_SECRET_LEN: usize = 5;

/// Allocation progress shared by all masked keys in one object.
struct KeyCollisionState {
    next_decimal_suffixes: BTreeMap<String, usize>,
    remaining_decimal_probes: usize,
    next_fallback_suffix: usize,
}

/// Holds compiled secret matchers for efficient masking.
///
/// Uses Aho-Corasick overlapping matches and redacts their full range union so
/// that containing, partially overlapping, and self-overlapping configured
/// values cannot leave sensitive fragments visible. Source pattern vectors are
/// dropped after the matchers are built. See issues #9778 and #24621.
pub struct SecretMasker {
    matcher: Option<NFA>,
    diagnostic_matcher: Option<NFA>,
    url_encoded_matcher: Option<NFA>,
    diagnostic_url_encoded_matcher: Option<NFA>,
    collision_alphabet: [char; 3],
}

impl SecretMasker {
    /// Build a masker from a guest-agent config.
    ///
    /// The config's `secret_values` field is parsed with [`Self::from_raw`], so
    /// the same input format and silent omission rules apply.
    pub fn from_config(config: &env::GuestConfig) -> Self {
        Self::from_raw(&config.secret_values)
    }

    /// Build a masker from a raw, comma-separated string of Base64-encoded secrets.
    ///
    /// Each component is trimmed before processing. Empty components, invalid
    /// Base64, decoded values that are not valid UTF-8, decoded empty values,
    /// and decoded values shorter than five UTF-8 bytes are ignored. These
    /// omissions are silent: this constructor returns a masker without an
    /// error or diagnostic, and only successfully decoded values of at least
    /// five UTF-8 bytes are masked. For each eligible secret, the normal
    /// matcher stores plain, Base64-encoded, and percent-encoded variants.
    /// Diagnostic-only multiline variants, including individual lines, use the
    /// same byte threshold for bounded stderr masking.
    pub fn from_raw(raw: &str) -> Self {
        if raw.is_empty() {
            return Self::empty();
        }

        // Parse comma-separated base64 values
        let engine = base64::engine::general_purpose::STANDARD;
        let mut patterns = Vec::new();
        let mut diagnostic_patterns = Vec::new();
        let mut url_encoded_patterns = Vec::new();
        let mut diagnostic_url_encoded_patterns = Vec::new();
        let mut seen_secrets = HashSet::new();
        for secret in raw.split(',').filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }
            engine
                .decode(trimmed)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .filter(|value| !value.is_empty())
        }) {
            if seen_secrets.insert(secret.clone()) && secret.len() >= MIN_SECRET_LEN {
                push_secret_patterns(&secret, &mut patterns);
                push_secret_patterns(&secret, &mut diagnostic_patterns);
                push_url_encoded_secret_pattern(&secret, &mut url_encoded_patterns);
                push_url_encoded_secret_pattern(&secret, &mut diagnostic_url_encoded_patterns);
                push_diagnostic_multiline_patterns(&secret, &mut diagnostic_patterns);
            }
        }
        Self::build_with_diagnostic_patterns(
            patterns,
            diagnostic_patterns,
            url_encoded_patterns,
            diagnostic_url_encoded_patterns,
        )
    }

    fn empty() -> Self {
        Self {
            matcher: None,
            diagnostic_matcher: None,
            url_encoded_matcher: None,
            diagnostic_url_encoded_matcher: None,
            collision_alphabet: Self::collision_alphabet(&[]),
        }
    }

    #[cfg(test)]
    fn build(patterns: Vec<String>) -> Self {
        Self::build_with_diagnostic_patterns(patterns.clone(), patterns, Vec::new(), Vec::new())
    }

    fn build_with_diagnostic_patterns(
        patterns: Vec<String>,
        diagnostic_patterns: Vec<String>,
        url_encoded_patterns: Vec<String>,
        diagnostic_url_encoded_patterns: Vec<String>,
    ) -> Self {
        Self {
            matcher: Self::build_matcher(&patterns),
            diagnostic_matcher: Self::build_matcher(&diagnostic_patterns),
            url_encoded_matcher: Self::build_matcher(&url_encoded_patterns),
            diagnostic_url_encoded_matcher: Self::build_matcher(&diagnostic_url_encoded_patterns),
            collision_alphabet: Self::collision_alphabet(&patterns),
        }
    }

    fn collision_alphabet(patterns: &[String]) -> [char; 3] {
        // A production pattern is at least five bytes, so it cannot fit in one
        // four-byte scalar or start inside one. Excluding its first two scalars
        // from our separator/digit transitions prevents it from matching at all.
        let forbidden_pairs: HashSet<_> = patterns
            .iter()
            .filter_map(|pattern| {
                let mut chars = pattern.chars();
                let first = chars.next()?;
                let second = chars.next()?;
                (first.len_utf8() == 4 && second.len_utf8() == 4)
                    .then_some((first.min(second), first.max(second)))
            })
            .collect();
        let mut alphabet = ['\u{10000}'; 3];
        let found = ('\u{10000}'..=char::MAX).any(|separator| {
            let mut digits = ('\u{10000}'..=char::MAX).filter(|&digit| {
                digit != separator
                    && !forbidden_pairs.contains(&(separator.min(digit), separator.max(digit)))
            });
            if let (Some(zero), Some(one)) = (digits.next(), digits.next()) {
                alphabet = [separator, zero, one];
                true
            } else {
                false
            }
        });
        // There are 2^20 four-byte scalars. Denying every separator two distinct
        // neighbors needs over 2^38 pairs, beyond a successfully built matcher's
        // 32-bit pattern-ID limit. Blocked neighbors are bounded by those pairs.
        assert!(found, "secret patterns exhausted the collision alphabet");
        alphabet
    }

    /// # Panics
    /// Panics if the Aho-Corasick automaton fails to build because its pattern
    /// set exceeds the state-ID or contiguous encoding limits. A hard abort is
    /// preferred over silently degrading to a pass-through masker, which would
    /// leak every subsequent event payload.
    #[allow(clippy::expect_used)]
    fn build_matcher(patterns: &[String]) -> Option<NFA> {
        if patterns.is_empty() {
            return None;
        }
        let mut seen = HashSet::with_capacity(patterns.len());
        let mut unique_patterns = Vec::with_capacity(patterns.len());
        for pattern in patterns {
            if seen.insert(pattern.as_str()) {
                unique_patterns.push(pattern.as_str());
            }
        }
        // Share the concrete automaton with streaming masking, which needs to
        // retain transition state instead of searching its original tail again.
        let ac = NFA::builder()
            .match_kind(MatchKind::Standard)
            .build(unique_patterns.iter().copied())
            .expect("AhoCorasick build failed for secret pattern set");
        Some(ac)
    }

    /// Recursively mask secrets in JSON object keys and string values (in-place).
    ///
    /// Keys whose cascading redactions exceed a linear scan budget are replaced
    /// in full with `***`. Colliding masked keys receive unique secret-free names
    /// so that every value and unmatched key is preserved.
    pub fn mask_value(&self, val: &mut Value) {
        if self.matcher.is_none() && self.url_encoded_matcher.is_none() {
            return;
        }
        match val {
            Value::String(s) => {
                self.mask_string_in_place(s);
            }
            Value::Array(arr) => {
                for item in arr {
                    self.mask_value(item);
                }
            }
            Value::Object(map) => {
                self.mask_object(map);
            }
            _ => {}
        }
    }

    /// Recursively mask secrets in JSON string values without changing keys.
    pub(crate) fn mask_string_values(&self, val: &mut Value) {
        if self.matcher.is_none() && self.url_encoded_matcher.is_none() {
            return;
        }
        match val {
            Value::String(s) => {
                self.mask_string_in_place(s);
            }
            Value::Array(arr) => {
                for item in arr {
                    self.mask_string_values(item);
                }
            }
            Value::Object(map) => {
                for value in map.values_mut() {
                    self.mask_string_values(value);
                }
            }
            _ => {}
        }
    }

    /// Replace all secret patterns in a string with `***`.
    ///
    /// Redacts the full union of all pattern matches so overlapping configured
    /// values cannot leave any matched bytes visible.
    pub fn mask_string(&self, s: &str) -> String {
        self.masked_string(s).unwrap_or_else(|| s.to_string())
    }

    /// Mask diagnostic text while preserving embedded line separators.
    pub(crate) fn mask_diagnostic_string(&self, s: String) -> String {
        if self.diagnostic_matcher.is_none() && self.diagnostic_url_encoded_matcher.is_none() {
            return s;
        }

        let mut line_endings = Vec::new();
        let lines = s
            .split_inclusive('\n')
            .map(|segment| {
                let (line, line_ending) = if let Some(line) = segment.strip_suffix("\r\n") {
                    (line, "\r\n")
                } else if let Some(line) = segment.strip_suffix('\n') {
                    (line, "\n")
                } else {
                    (segment, "")
                };
                line_endings.push(line_ending);
                line.to_string()
            })
            .collect();
        let lines = self.mask_diagnostic_lines(lines);
        let mut masked = String::with_capacity(s.len());
        for (line, line_ending) in lines.into_iter().zip(line_endings) {
            masked.push_str(&line);
            masked.push_str(line_ending);
        }
        masked
    }

    /// Mask diagnostic text while preserving the caller's line boundaries.
    pub(crate) fn mask_diagnostic_lines(&self, lines: Vec<String>) -> Vec<String> {
        if self.diagnostic_matcher.is_none() && self.diagnostic_url_encoded_matcher.is_none() {
            return lines;
        }
        if lines.is_empty() {
            return lines;
        }

        let joined_len = lines
            .iter()
            .map(String::len)
            .sum::<usize>()
            .saturating_add(lines.len().saturating_sub(1));
        let mut joined = String::with_capacity(joined_len);
        let mut line_starts = Vec::with_capacity(lines.len());
        let mut line_ends = Vec::with_capacity(lines.len());
        for (index, line) in lines.iter().enumerate() {
            if index > 0 {
                joined.push('\n');
            }
            line_starts.push(joined.len());
            joined.push_str(line);
            line_ends.push(joined.len());
        }

        let joined_ranges = redaction_ranges(
            self.diagnostic_matcher.as_ref(),
            self.diagnostic_url_encoded_matcher.as_ref(),
            &joined,
        );
        if joined_ranges.is_empty() {
            return lines;
        }

        let mut redactions = vec![Vec::new(); lines.len()];
        for range in joined_ranges {
            let match_start = range.start;
            let match_end = range.end;
            let first_line = line_ends.partition_point(|&line_end| line_end <= match_start);
            for ((line_start, line_end), line_redactions) in line_starts
                .iter()
                .copied()
                .zip(line_ends.iter().copied())
                .zip(redactions.iter_mut())
                .skip(first_line)
            {
                if line_start >= match_end {
                    break;
                }
                let redaction_start = match_start.max(line_start);
                let redaction_end = match_end.min(line_end);
                if redaction_start < redaction_end {
                    line_redactions
                        .push((redaction_start - line_start)..(redaction_end - line_start));
                }
            }
        }

        lines
            .into_iter()
            .zip(redactions)
            .map(|(line, ranges)| redact_ranges(line, &ranges))
            .collect()
    }

    fn mask_string_in_place(&self, s: &mut String) -> bool {
        if let Some(masked) = self.masked_string(s) {
            *s = masked;
            true
        } else {
            false
        }
    }

    fn masked_string(&self, s: &str) -> Option<String> {
        let ranges = redaction_ranges(self.matcher.as_ref(), self.url_encoded_matcher.as_ref(), s);
        if ranges.is_empty() {
            None
        } else {
            Some(redact_ranges(s.to_string(), &ranges))
        }
    }

    fn mask_object(&self, map: &mut Map<String, Value>) {
        let has_masked_key = map.keys().any(|key| self.masked_string(key).is_some());
        if !has_masked_key {
            for value in map.values_mut() {
                self.mask_value(value);
            }
            return;
        }

        let mut collisions = KeyCollisionState {
            next_decimal_suffixes: BTreeMap::new(),
            remaining_decimal_probes: map.len(),
            next_fallback_suffix: 0,
        };
        let entries = std::mem::take(map);
        let mut masked_entries = Vec::new();
        for (key, mut value) in entries {
            self.mask_value(&mut value);
            if let Some(masked_key) = self.fully_masked_key(&key) {
                masked_entries.push((masked_key, value));
            } else {
                map.insert(key, value);
            }
        }

        for (masked_key, value) in masked_entries {
            let unique_key = self.unique_masked_key(map, masked_key, &mut collisions);
            map.insert(unique_key, value);
        }
    }

    fn fully_masked_key(&self, key: &str) -> Option<String> {
        // Include the first scan in a budget of four times the original length.
        // Charging each haystack before scanning bounds aggregate searching and
        // copying for a fixed matcher, even when a pass removes only two bytes.
        let mut remaining = key.len().saturating_mul(4) - key.len();
        let mut masked = self.masked_string(key)?;
        loop {
            let Some(budget) = remaining.checked_sub(masked.len()) else {
                // Never return an unchecked intermediate key. This whole-key
                // marker is shorter than every accepted production secret;
                // unique_masked_key still preserves entries when it collides.
                return Some("***".to_string());
            };
            remaining = budget;
            let Some(remasked) = self.masked_string(&masked) else {
                return Some(masked);
            };
            // Production patterns are longer than "***", so each pass shrinks.
            debug_assert!(remasked.len() < masked.len());
            masked = remasked;
        }
    }

    fn unique_masked_key(
        &self,
        map: &Map<String, Value>,
        masked_key: String,
        collisions: &mut KeyCollisionState,
    ) -> String {
        if !map.contains_key(&masked_key) {
            return masked_key;
        }

        // Each base owns a disjoint decimal family. Without secret rejection,
        // every probe consumes an occupied key or assigns one, so N input keys
        // need at most N probes. Share that budget across families as secrets
        // can exclude all of them; a per-family budget could still be quadratic.
        if collisions.remaining_decimal_probes > 0 {
            let suffix = collisions
                .next_decimal_suffixes
                .entry(masked_key.clone())
                .or_insert(2);
            while collisions.remaining_decimal_probes > 0 {
                let candidate = format!("{masked_key}#{suffix}");
                *suffix += 1;
                collisions.remaining_decimal_probes -= 1;
                if !map.contains_key(&candidate) && self.masked_string(&candidate).is_none() {
                    return candidate;
                }
            }
        }

        // These identifiers are distinct and intrinsically secret-free. Never
        // retry one within this object: every probe consumes an occupied key or
        // assigns one, bounding aggregate probes by N and preventing overflow.
        loop {
            let candidate = self.collision_key(collisions.next_fallback_suffix);
            collisions.next_fallback_suffix += 1;
            if !map.contains_key(&candidate) {
                return candidate;
            }
        }
    }

    fn collision_key(&self, mut suffix: usize) -> String {
        let [separator, zero, one] = self.collision_alphabet;
        let mut key = String::new();
        loop {
            key.push(separator);
            key.push(if suffix & 1 == 0 { zero } else { one });
            suffix >>= 1;
            if suffix == 0 {
                return key;
            }
        }
    }
}

/// Percent-encode a string matching JS `encodeURIComponent` behavior.
///
/// Unescaped set per ECMAScript spec (uriUnescaped):
///   A-Z a-z 0-9 - _ . ! ~ * ' ( )
///
/// See: <https://tc39.es/ecma262/#sec-encodeuricomponent-uricomponent>
fn url_encode(s: &str) -> String {
    let mut encoded = String::with_capacity(s.len() * 3);
    // Rust &str is valid UTF-8, so iterating bytes and percent-encoding
    // non-unescaped bytes is equivalent to the spec's UTF-8 encode + escape.
    for byte in s.bytes() {
        match byte {
            // uriUnescaped: uriAlpha | DecimalDigit | uriMark
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push(hex_digit(byte >> 4));
                encoded.push(hex_digit(byte & 0x0f));
            }
        }
    }
    encoded
}

fn hex_digit(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        _ => (b'A' + n - 10) as char,
    }
}

fn push_secret_patterns(secret: &str, patterns: &mut Vec<String>) {
    patterns.push(secret.to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(secret);
    patterns.push(b64);
    push_url_encoded_secret_pattern(secret, patterns);
}

fn push_url_encoded_secret_pattern(secret: &str, patterns: &mut Vec<String>) {
    let url_encoded = url_encode(secret);
    if url_encoded != secret {
        patterns.push(url_encoded);
    }
}

fn canonicalize_lowercase_percent_escapes(s: &str) -> Option<String> {
    if !contains_lowercase_percent_escape(s.as_bytes()) {
        return None;
    }

    let mut canonicalized = s.to_string();
    // SAFETY: the mutation below only changes ASCII hex letters inside valid
    // percent escapes to their ASCII uppercase forms, preserving UTF-8 validity.
    let bytes = unsafe { canonicalized.as_bytes_mut() };
    let mut index = 0;
    while index < bytes.len() {
        if let Some((first, second)) = valid_percent_escape_at(bytes, index) {
            if let Some(first_byte) = bytes.get_mut(index + 1) {
                *first_byte = first.to_ascii_uppercase();
            }
            if let Some(second_byte) = bytes.get_mut(index + 2) {
                *second_byte = second.to_ascii_uppercase();
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    Some(canonicalized)
}

fn contains_lowercase_percent_escape(bytes: &[u8]) -> bool {
    let mut index = 0;
    while index < bytes.len() {
        if let Some((first, second)) = valid_percent_escape_at(bytes, index) {
            if is_ascii_lowercase_hex_digit(first) || is_ascii_lowercase_hex_digit(second) {
                return true;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    false
}

fn valid_percent_escape_at(bytes: &[u8], index: usize) -> Option<(u8, u8)> {
    let percent = *bytes.get(index)?;
    let first = *bytes.get(index + 1)?;
    let second = *bytes.get(index + 2)?;
    if percent == b'%' && is_ascii_hex_digit(first) && is_ascii_hex_digit(second) {
        Some((first, second))
    } else {
        None
    }
}

fn is_ascii_hex_digit(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

fn is_ascii_lowercase_hex_digit(byte: u8) -> bool {
    matches!(byte, b'a'..=b'f')
}

fn redaction_ranges(
    matcher: Option<&NFA>,
    url_encoded_matcher: Option<&NFA>,
    haystack: &str,
) -> Vec<Range<usize>> {
    let canonicalized =
        url_encoded_matcher.and_then(|_| canonicalize_lowercase_percent_escapes(haystack));
    let ranges = matcher
        .map(|matcher| merged_match_ranges(matcher, haystack))
        .unwrap_or_default();
    if let (Some(matcher), Some(canonicalized)) = (url_encoded_matcher, canonicalized.as_deref()) {
        return merge_sorted_ranges(ranges, merged_match_ranges(matcher, canonicalized));
    }
    ranges
}

#[allow(clippy::expect_used)]
fn merged_match_ranges(matcher: &NFA, haystack: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut previous_end = 0;
    // Every matcher is built for Standard, unanchored overlapping searches.
    // An unsupported configuration must fail closed, never publish secrets.
    let matches = matcher
        .try_find_overlapping_iter(Input::new(haystack))
        .expect("secret matcher must support overlapping searches");
    for matched in matches {
        // Overlapping search reports every match at one haystack position
        // before advancing, so match ends are nondecreasing. Match starts and
        // equal-end pattern order are not ordered.
        debug_assert!(matched.end() >= previous_end);
        previous_end = matched.end();
        push_merged_range(&mut ranges, matched.start()..matched.end());
    }
    ranges
}

fn merge_sorted_ranges(first: Vec<Range<usize>>, second: Vec<Range<usize>>) -> Vec<Range<usize>> {
    if first.is_empty() {
        return second;
    }
    if second.is_empty() {
        return first;
    }

    let mut merged = Vec::with_capacity(first.len() + second.len());
    let mut first = first.into_iter().peekable();
    let mut second = second.into_iter().peekable();
    loop {
        let next = match (first.peek(), second.peek()) {
            (Some(left), Some(right)) => {
                if (left.start, left.end) <= (right.start, right.end) {
                    first.next()
                } else {
                    second.next()
                }
            }
            (Some(_), None) => first.next(),
            (None, Some(_)) => second.next(),
            (None, None) => break,
        };
        if let Some(range) = next {
            push_merged_range(&mut merged, range);
        }
    }
    merged
}

fn push_merged_range(ranges: &mut Vec<Range<usize>>, mut range: Range<usize>) {
    while let Some(previous) = ranges.pop_if(|previous| range.start < previous.end) {
        range.start = range.start.min(previous.start);
        range.end = range.end.max(previous.end);
    }
    ranges.push(range);
}

fn push_diagnostic_multiline_patterns(secret: &str, patterns: &mut Vec<String>) {
    let normalized = secret.replace("\r\n", "\n");
    if !normalized.contains('\n') {
        return;
    }
    if normalized != secret && normalized.len() >= MIN_SECRET_LEN {
        patterns.push(normalized.clone());
    }
    if let Some(without_final_newline) = normalized.strip_suffix('\n')
        && without_final_newline.len() >= MIN_SECRET_LEN
    {
        patterns.push(without_final_newline.to_string());
    }
    for line in normalized.split('\n') {
        if line.len() >= MIN_SECRET_LEN {
            patterns.push(line.to_string());
        }
    }
}

fn redact_ranges(line: String, ranges: &[Range<usize>]) -> String {
    if ranges.is_empty() {
        return line;
    }

    let mut redacted = String::with_capacity(line.len());
    let mut cursor = 0;
    for range in ranges {
        if range.start > cursor {
            redacted.push_str(&line[cursor..range.start]);
        }
        if range.end > cursor {
            redacted.push_str("***");
            cursor = range.end;
        }
    }
    if cursor < line.len() {
        redacted.push_str(&line[cursor..]);
    }
    redacted
}

#[cfg(test)]
mod tests;
