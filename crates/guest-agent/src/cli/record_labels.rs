//! Bounded, content-free labels naming one CLI stdout record.
//!
//! Two labels name a record without exposing anything it carries: the record's
//! own `type` and the item discriminator that follows it. Bounded delivery
//! reads both from the parsed event. The oversized-record boundary never has a
//! parsed event — it holds a record that was truncated mid-serialisation — so
//! this module also recovers the pair with a bounded byte scan over a small
//! leading window.
//!
//! Every emitted label is one of the fixed tokens below, so no record text,
//! path, diff, command or prompt can reach a log through them. A label the
//! window does not establish is [`UNKNOWN_LABEL`] rather than an absent field.
//!
//! The scan assumes a record serialises its own `type` before any nested one,
//! which holds for every shape this reader accepts: Claude Code stream-json
//! records, the projected events bounded delivery sees, and the raw Pi RPC
//! records the shared stdout loop reads.

/// Stable token for a label the record does not establish.
pub(super) const UNKNOWN_LABEL: &str = "unknown";

/// Leading record bytes examined for labels.
///
/// Both labels sit within the first few hundred bytes of every accepted shape.
/// The window is what keeps the oversized-record path from scanning the
/// megabytes it is already holding.
const LABEL_SCAN_WINDOW_BYTES: usize = 4 * 1024;

/// Longest label token accepted from a record.
const MAX_LABEL_TOKEN_BYTES: usize = 32;

/// Bounded labels naming one record's shape.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct EventLabels {
    pub(super) event_type: &'static str,
    pub(super) item_type: &'static str,
}

impl EventLabels {
    pub(super) const UNKNOWN: Self = Self {
        event_type: UNKNOWN_LABEL,
        item_type: UNKNOWN_LABEL,
    };
}

/// Where a record family carries its item discriminator.
enum ItemSource {
    /// Projected and Claude Code records carry it on the first content block.
    ContentBlock,
    /// Raw Pi RPC message records carry it on the message role.
    MessageRole,
    /// Other records have no item discriminator near their head.
    Absent,
}

/// Recover both labels from a record prefix without parsing it.
///
/// The prefix reaching this function is a record truncated at an arbitrary
/// byte, so it is not valid JSON and is never handed to a parser. Only the
/// leading [`LABEL_SCAN_WINDOW_BYTES`] are examined, whatever the prefix holds.
pub(super) fn prefix_labels(prefix: &[u8]) -> EventLabels {
    let window = prefix.get(..LABEL_SCAN_WINDOW_BYTES).unwrap_or(prefix);
    let Some(record_type) = string_value_for_key(window, b"\"type\"", 0) else {
        return EventLabels::UNKNOWN;
    };
    let event_type = record_type_label(record_type);
    let item_type = match item_source(event_type) {
        ItemSource::ContentBlock => content_block_start(window)
            .and_then(|start| string_value_for_key(window, b"\"type\"", start))
            .map_or(UNKNOWN_LABEL, content_type_label),
        ItemSource::MessageRole => {
            string_value_for_key(window, b"\"role\"", 0).map_or(UNKNOWN_LABEL, message_role_label)
        }
        ItemSource::Absent => UNKNOWN_LABEL,
    };
    EventLabels {
        event_type,
        item_type,
    }
}

/// Name a coarse length range for a record, never its exact size.
pub(super) fn size_bucket(bytes: usize) -> &'static str {
    const MIB: usize = 1024 * 1024;
    match bytes / MIB {
        0 => "<1MiB",
        1 => "1-2MiB",
        2..=3 => "2-4MiB",
        4..=7 => "4-8MiB",
        8..=15 => "8-16MiB",
        _ => ">=16MiB",
    }
}

fn record_type_label(record_type: &str) -> &'static str {
    match record_type {
        // Projected delivery events and Claude Code stream-json records.
        "assistant" => "assistant",
        "user" => "user",
        "result" => "result",
        "system" => "system",
        // Raw Pi RPC records, which reach the stdout reader before projection.
        "message_end" => "message_end",
        "message_update" => "message_update",
        "response" => "response",
        "agent_settled" => "agent_settled",
        "agent_end" => "agent_end",
        "turn_end" => "turn_end",
        "extension_error" => "extension_error",
        _ => "other",
    }
}

fn item_source(event_type: &str) -> ItemSource {
    match event_type {
        "assistant" | "user" | "result" | "system" => ItemSource::ContentBlock,
        "message_end" | "message_update" => ItemSource::MessageRole,
        _ => ItemSource::Absent,
    }
}

/// Content-block types, matching the delivery vocabulary.
///
/// A prefix cannot establish the parsed `none`, since a content block may sit
/// beyond the window; an unrecognized block type stays `other`.
fn content_type_label(content_type: &str) -> &'static str {
    match content_type {
        "text" => "text",
        "tool_use" => "tool_use",
        "tool_result" => "tool_result",
        _ => "other",
    }
}

fn message_role_label(role: &str) -> &'static str {
    match role {
        "assistant" => "assistant",
        "toolResult" => "toolResult",
        "user" => "user",
        _ => "other",
    }
}

/// Index of the first field of the first object in the first content array.
fn content_block_start(window: &[u8]) -> Option<usize> {
    let mut searched = 0;
    while let Some(offset) = window
        .get(searched..)
        .and_then(|rest| find_bytes(rest, b"\"content\""))
    {
        let key_end = searched + offset + b"\"content\"".len();
        searched = key_end;
        let Some(array) = value_start(window, key_end) else {
            continue;
        };
        if window.get(array) != Some(&b'[') {
            continue;
        }
        let block = skip_whitespace(window, array + 1);
        if window.get(block) == Some(&b'{') {
            return Some(block + 1);
        }
    }
    None
}

/// Value of the first `"<key>":` at or after `from`.
///
/// Only that first occurrence is considered: a later one belongs to a nested
/// object, which would name the wrong thing. A value that is absent,
/// unterminated, escaped, longer than [`MAX_LABEL_TOKEN_BYTES`], or not a bare
/// token yields nothing, so no byte derived from record content can escape the
/// fixed label sets above.
fn string_value_for_key<'a>(window: &'a [u8], quoted_key: &[u8], from: usize) -> Option<&'a str> {
    let offset = find_bytes(window.get(from..)?, quoted_key)?;
    let value = value_start(window, from + offset + quoted_key.len())?;
    if window.get(value) != Some(&b'"') {
        return None;
    }
    token(window, value + 1)
}

/// Index of the first value byte after a key, or `None` without a `:`.
fn value_start(window: &[u8], key_end: usize) -> Option<usize> {
    let colon = skip_whitespace(window, key_end);
    if window.get(colon) != Some(&b':') {
        return None;
    }
    Some(skip_whitespace(window, colon + 1))
}

fn skip_whitespace(window: &[u8], from: usize) -> usize {
    let mut index = from;
    while window.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

/// Bare ASCII token of a JSON string that starts at `from`.
fn token(window: &[u8], from: usize) -> Option<&str> {
    let mut length = 0;
    loop {
        match window.get(from + length) {
            Some(b'"') => break,
            Some(byte) if is_token_byte(*byte) && length < MAX_LABEL_TOKEN_BYTES => length += 1,
            // An escape, another byte, or the window end leaves no bare token.
            _ => return None,
        }
    }
    std::str::from_utf8(window.get(from..from + length)?).ok()
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|candidate| candidate == needle)
}

#[cfg(test)]
mod tests;
