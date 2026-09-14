//! Secret value masking for event payloads and CLI diagnostics.
//!
//! Consumes the guest config's comma-separated base64 secret values,
//! pre-computes plain / base64 / URL-encoded variants for normal payload
//! masking, and derives diagnostic-only multiline variants for bounded CLI
//! stderr tails.

use crate::env;
use aho_corasick::{AhoCorasick, MatchKind};
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
    matcher: Option<AhoCorasick>,
    diagnostic_matcher: Option<AhoCorasick>,
    url_encoded_matcher: Option<AhoCorasick>,
    diagnostic_url_encoded_matcher: Option<AhoCorasick>,
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
    /// Panics if the Aho-Corasick automaton fails to build. The only
    /// documented failure mode is pattern sets too large for the state-ID
    /// type (millions of patterns); user-configured secrets never approach
    /// that bound. A hard abort is preferred over silently degrading to a
    /// pass-through masker, which would leak every subsequent event payload.
    #[allow(clippy::expect_used)]
    fn build_matcher(patterns: &[String]) -> Option<AhoCorasick> {
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
        let ac = AhoCorasick::builder()
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
    matcher: Option<&AhoCorasick>,
    url_encoded_matcher: Option<&AhoCorasick>,
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

fn merged_match_ranges(matcher: &AhoCorasick, haystack: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut previous_end = 0;
    for matched in matcher.find_overlapping_iter(haystack) {
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
mod tests {
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
}
