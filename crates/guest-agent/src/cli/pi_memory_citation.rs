//! Pi hidden memory-citation transport normalization.
//!
//! Adapted from OpenAI Codex rust-v0.152.1 commit
//! 5adb68a49933ae446bf11935662c83dba55a0804 under Apache-2.0. Okou also
//! suppresses stray complete delimiters before public projection.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

mod literals;

pub(super) const OPEN: &str = "<oai-mem-citation>";
pub(super) const CLOSE: &str = "</oai-mem-citation>";
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_ROLLOUT_IDS: usize = 64;
const MAX_PATH_BYTES: usize = 1024;
const MAX_NOTE_BYTES: usize = 2048;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PiMemoryCitation {
    pub(super) entries: Vec<PiMemoryCitationEntry>,
    pub(super) rollout_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PiMemoryCitationEntry {
    pub(super) path: String,
    pub(super) line_start: u32,
    pub(super) line_end: u32,
    pub(super) note: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct CitationDiagnostics {
    pub(super) envelopes: usize,
    pub(super) valid_entries: usize,
    pub(super) valid_rollout_ids: usize,
    pub(super) invalid_entries: usize,
    pub(super) invalid_rollout_ids: usize,
    pub(super) oversized_bodies: usize,
    pub(super) incomplete_bodies: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct CitationProjection {
    pub(super) visible_segments: Vec<String>,
    pub(super) citation: Option<PiMemoryCitation>,
    pub(super) diagnostics: CitationDiagnostics,
}

#[derive(Clone, Copy)]
struct SourcedChar {
    value: char,
    source: usize,
}

fn delimiter_starts_with(delimiter: &str, pending: &[SourcedChar]) -> bool {
    let mut characters = delimiter.chars();
    pending
        .iter()
        .all(|item| characters.next() == Some(item.value))
}

pub(super) struct CitationParser {
    literals: literals::LiteralEscaper,
    visible_segments: Vec<String>,
    citation: PiMemoryCitation,
    diagnostics: CitationDiagnostics,
    outside_pending: Vec<SourcedChar>,
    close_pending: Vec<SourcedChar>,
    inside: bool,
    body: String,
    body_oversized: bool,
}

impl CitationParser {
    pub(super) fn new(segment_count: usize) -> Self {
        Self {
            literals: literals::LiteralEscaper::default(),
            visible_segments: vec![String::new(); segment_count],
            citation: PiMemoryCitation::default(),
            diagnostics: CitationDiagnostics::default(),
            outside_pending: Vec::new(),
            close_pending: Vec::new(),
            inside: false,
            body: String::new(),
            body_oversized: false,
        }
    }

    pub(super) fn push(&mut self, chunk: &str, source: usize) {
        if source >= self.visible_segments.len() {
            self.visible_segments.resize(source + 1, String::new());
        }
        // Preserve the allocation-free ordinary-text path from #32348. Code
        // recognition adds work only when the chunk can change Markdown state.
        if self.literals.bypass_plain_chunk(chunk) {
            for value in chunk.chars() {
                self.push_character(SourcedChar { value, source });
            }
            return;
        }
        let mut literals = std::mem::take(&mut self.literals);
        for value in chunk.chars() {
            literals.push(SourcedChar { value, source }, &mut |item, escape| {
                self.push_literal_character(item, escape);
            });
        }
        self.literals = literals;
    }

    /// Drain text that is safe to expose while retaining partial delimiters.
    ///
    /// Source slots stay allocated so later characters released from a
    /// cross-chunk delimiter candidate preserve their native content index.
    pub(super) fn take_visible_segments(&mut self) -> Vec<(usize, String)> {
        self.visible_segments
            .iter_mut()
            .enumerate()
            .filter_map(|(source, text)| (!text.is_empty()).then(|| (source, std::mem::take(text))))
            .collect()
    }

    fn push_literal_character(&mut self, item: SourcedChar, escape: bool) {
        let replacement = match (escape && !self.inside, item.value) {
            (true, '<') => Some("&lt;"),
            (true, '>') => Some("&gt;"),
            _ => None,
        };
        if let Some(replacement) = replacement {
            for value in replacement.chars() {
                self.push_character(SourcedChar {
                    value,
                    source: item.source,
                });
            }
        } else {
            self.push_character(item);
        }
    }

    #[inline(always)]
    fn push_character(&mut self, character: SourcedChar) {
        if self.inside {
            self.close_pending.push(character);
            loop {
                if delimiter_starts_with(CLOSE, &self.close_pending) {
                    // Delimiters are ASCII, so a matching prefix has one byte per character.
                    if self.close_pending.len() == CLOSE.len() {
                        self.finish_body(false);
                        self.close_pending.clear();
                        self.inside = false;
                    }
                    return;
                }
                if self.close_pending.is_empty() {
                    return;
                }
                let first = self.close_pending.remove(0);
                self.append_body(first.value);
            }
        }

        self.outside_pending.push(character);
        loop {
            if delimiter_starts_with(OPEN, &self.outside_pending) {
                if self.outside_pending.len() == OPEN.len() {
                    self.outside_pending.clear();
                    self.inside = true;
                    self.body.clear();
                    self.body_oversized = false;
                }
                return;
            }
            if delimiter_starts_with(CLOSE, &self.outside_pending) {
                if self.outside_pending.len() == CLOSE.len() {
                    self.outside_pending.clear();
                }
                return;
            }
            if self.outside_pending.is_empty() {
                return;
            }
            let first = self.outside_pending.remove(0);
            if let Some(output) = self.visible_segments.get_mut(first.source) {
                output.push(first.value);
            }
        }
    }

    fn append_body(&mut self, value: char) {
        if self.body_oversized {
            return;
        }
        if self.body.len() + value.len_utf8() > MAX_BODY_BYTES {
            self.body.clear();
            self.body_oversized = true;
            return;
        }
        self.body.push(value);
    }

    fn finish_body(&mut self, incomplete: bool) {
        self.diagnostics.envelopes += 1;
        if incomplete {
            self.diagnostics.incomplete_bodies += 1;
        }
        if self.body_oversized {
            self.diagnostics.oversized_bodies += 1;
            return;
        }
        append_body(&self.body, &mut self.citation, &mut self.diagnostics);
    }

    pub(super) fn finish(mut self) -> CitationProjection {
        let mut literals = std::mem::take(&mut self.literals);
        literals.finish(&mut |item, escape| self.push_literal_character(item, escape));
        if self.inside {
            let pending = std::mem::take(&mut self.close_pending);
            for character in pending {
                self.append_body(character.value);
            }
            self.finish_body(true);
        } else {
            for character in std::mem::take(&mut self.outside_pending) {
                if let Some(output) = self.visible_segments.get_mut(character.source) {
                    output.push(character.value);
                }
            }
        }
        let citation = (!self.citation.entries.is_empty() || !self.citation.rollout_ids.is_empty())
            .then_some(self.citation);
        CitationProjection {
            visible_segments: self.visible_segments,
            citation,
            diagnostics: self.diagnostics,
        }
    }
}

pub(super) fn project_segments(segments: &[&str]) -> CitationProjection {
    let mut parser = CitationParser::new(segments.len());
    for (index, segment) in segments.iter().enumerate() {
        parser.push(segment, index);
    }
    parser.finish()
}

fn section<'a>(body: &'a str, names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|name| {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let start = body.find(&open)? + open.len();
        let end = body[start..].find(&close)? + start;
        Some(&body[start..end])
    })
}

fn parse_entry(line: &str) -> Option<PiMemoryCitationEntry> {
    let (location, note_with_close) = line.rsplit_once("|note=[")?;
    let note = note_with_close.strip_suffix(']')?.trim();
    let (path, range) = location.rsplit_once(':')?;
    let (line_start, line_end) = range.split_once('-')?;
    let path = path.trim();
    let line_start = line_start.trim().parse::<u32>().ok()?;
    let line_end = line_end.trim().parse::<u32>().ok()?;
    if path.is_empty()
        || note.is_empty()
        || path.len() > MAX_PATH_BYTES
        || note.len() > MAX_NOTE_BYTES
        || line_start == 0
        || line_end < line_start
    {
        return None;
    }
    Some(PiMemoryCitationEntry {
        path: path.to_string(),
        line_start,
        line_end,
        note: note.to_string(),
    })
}

fn append_body(body: &str, citation: &mut PiMemoryCitation, diagnostics: &mut CitationDiagnostics) {
    if let Some(entries) = section(body, &["citation_entries"]) {
        for line in entries
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Some(entry) = parse_entry(line).filter(|_| citation.entries.len() < MAX_ENTRIES)
            {
                citation.entries.push(entry);
                diagnostics.valid_entries += 1;
            } else {
                diagnostics.invalid_entries += 1;
            }
        }
    }

    let Some(ids) = section(body, &["rollout_ids", "thread_ids"]) else {
        return;
    };
    let mut known: HashSet<String> = citation.rollout_ids.iter().cloned().collect();
    for id in ids.lines().map(str::trim).filter(|id| !id.is_empty()) {
        let Some(canonical) = canonical_uuid(id) else {
            diagnostics.invalid_rollout_ids += 1;
            continue;
        };
        if known.contains(&canonical) {
            continue;
        }
        if citation.rollout_ids.len() >= MAX_ROLLOUT_IDS {
            diagnostics.invalid_rollout_ids += 1;
            continue;
        }
        known.insert(canonical.clone());
        citation.rollout_ids.push(canonical);
        diagnostics.valid_rollout_ids += 1;
    }
}

fn canonical_uuid(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || [8, 13, 18, 23]
            .into_iter()
            .any(|index| bytes.get(index) != Some(&b'-'))
        || !matches!(
            bytes.get(14).copied().map(|byte| byte.to_ascii_lowercase()),
            Some(b'1'..=b'8')
        )
        || !matches!(
            bytes.get(19).copied().map(|byte| byte.to_ascii_lowercase()),
            Some(b'8' | b'9' | b'a' | b'b')
        )
    {
        return None;
    }
    Uuid::parse_str(value)
        .ok()
        .map(|parsed| parsed.hyphenated().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureCase {
        name: String,
        chunks: Vec<String>,
        visible_text: String,
        entries: Vec<PiMemoryCitationEntry>,
        rollout_ids: Vec<String>,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<FixtureCase>,
        #[serde(rename = "literalCases")]
        literal_cases: Vec<LiteralCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LiteralCase {
        name: String,
        text: String,
        visible_text: String,
    }

    fn expand(template: &str) -> String {
        template
            .replace(
                "$ESCAPED_OPEN",
                &OPEN.replace('<', "&lt;").replace('>', "&gt;"),
            )
            .replace(
                "$ESCAPED_CLOSE",
                &CLOSE.replace('<', "&lt;").replace('>', "&gt;"),
            )
            .replace("$OPEN", OPEN)
            .replace("$CLOSE", CLOSE)
    }

    #[test]
    fn shared_literals_preserve_every_split_and_repeat_projection() {
        for case in fixture().literal_cases {
            let text = expand(&case.text);
            let visible = expand(&case.visible_text);
            for split in (0..=text.len()).filter(|&split| text.is_char_boundary(split)) {
                let projected = project_segments(&[&text[..split], &text[split..]]);
                assert_eq!(
                    projected.visible_segments.concat(),
                    visible,
                    "{} split {split}",
                    case.name
                );
            }
            assert_eq!(
                project_segments(&[&visible]).visible_segments.concat(),
                visible,
                "{} repeated",
                case.name
            );
            assert!(!visible.contains(OPEN) && !visible.contains(CLOSE));
        }
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(
            "../../../../fixtures/pi-memory-citations.json"
        ))
        .expect("shared citation fixture must parse")
    }

    #[test]
    fn matches_shared_cross_language_fixtures() {
        for case in fixture().cases {
            let chunks: Vec<&str> = case.chunks.iter().map(String::as_str).collect();
            let projection = project_segments(&chunks);
            assert_eq!(
                projection.visible_segments.concat(),
                case.visible_text,
                "{}",
                case.name
            );
            let citation = projection.citation.unwrap_or_default();
            assert_eq!(citation.entries, case.entries, "{}", case.name);
            assert_eq!(citation.rollout_ids, case.rollout_ids, "{}", case.name);
        }
    }

    #[test]
    fn handles_every_delimiter_split() {
        let envelope = format!("{OPEN}<citation_entries>x:1-1|note=[n]</citation_entries>{CLOSE}");
        for delimiter in [OPEN, CLOSE] {
            let start = envelope.find(delimiter).expect("delimiter exists");
            for index in 1..delimiter.len() {
                let boundary = start + index;
                let first = format!("before{}", &envelope[..boundary]);
                let second = format!("{}after", &envelope[boundary..]);
                let projection = project_segments(&[first.as_str(), second.as_str()]);
                assert_eq!(projection.visible_segments.concat(), "beforeafter");
                assert_eq!(projection.citation.expect("citation").entries.len(), 1);
            }
        }
    }

    #[test]
    fn hides_oversized_body() {
        let body = "界".repeat(MAX_BODY_BYTES);
        let projection = project_segments(&[&format!("{OPEN}{body}{CLOSE}ok")]);
        assert_eq!(projection.visible_segments.concat(), "ok");
        assert!(projection.citation.is_none());
        assert_eq!(projection.diagnostics.oversized_bodies, 1);
    }

    #[test]
    fn bounds_entry_counts_and_field_bytes() {
        let mut entries = (0..65)
            .map(|index| format!("p{index}:1-1|note=[n]"))
            .collect::<Vec<_>>();
        entries.push(format!("{}:1-1|note=[n]", "界".repeat(342)));
        entries.push(format!("x:1-1|note=[{}]", "界".repeat(683)));
        let envelope = format!(
            "{OPEN}<citation_entries>{}</citation_entries>{CLOSE}",
            entries.join("\n")
        );
        let projection = project_segments(&[&envelope]);
        assert_eq!(
            projection.citation.expect("citation").entries.len(),
            MAX_ENTRIES
        );
        assert_eq!(projection.diagnostics.invalid_entries, 3);
    }
}
