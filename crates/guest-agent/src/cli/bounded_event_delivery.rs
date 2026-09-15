//! Bounded webhook representation for normalized Pi and Codex events.
//!
//! Source records reach the best-effort local log before this module sees
//! the webhook copy. Official history is owned by the CLI. Normal events retain
//! their existing serialization. Only events that cannot fit in one delivery
//! request receive visibly marked content reduction.

use std::collections::BTreeSet;

use serde_json::Value;

use super::{codex_event_delivery, pi_event_delivery};

use crate::error::AgentError;

#[derive(Clone, Copy)]
pub(super) enum Framework {
    Pi,
    Codex,
}

pub(super) const DELIVERY_NOTICE: &str = "[event content truncated for delivery]";
const MAX_REDUCTION_CANDIDATES: usize = 256;
// Numeric arrays and long keys must not create input-sized traversal state.
const MAX_VISITED_VALUES: usize = 4096;
const MAX_PATH_DEPTH: usize = 64;
const MAX_PATH_KEY_BYTES: usize = 256;
const MAX_REDUCED_FIELDS: usize = 16;
const RETAINED_CONTENT_ADJUSTMENT_ATTEMPTS: usize = 4;

pub(super) struct PreparedEvent {
    pub(super) serialized: Vec<u8>,
    pub(super) reduction: Option<EventReduction>,
}

pub(super) struct EventReduction {
    pub(super) event_type: &'static str,
    pub(super) item_type: &'static str,
    pub(super) original_bytes: usize,
    pub(super) delivered_bytes: usize,
    pub(super) fields: Vec<&'static str>,
    pub(super) fallback: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PathSegment {
    Key(String),
    Index(usize),
}

#[derive(Clone, Debug)]
struct ContentCandidate {
    path: Vec<PathSegment>,
    path_key: String,
    image_text_type: Option<&'static str>,
    category: &'static str,
    reducible_bytes: usize,
}

struct SelectedContent {
    path: Vec<PathSegment>,
    original: String,
}

pub(super) fn prepare_for_delivery(
    mut event: Value,
    max_serialized_event_bytes: usize,
    framework: Framework,
) -> Result<PreparedEvent, AgentError> {
    let serialized = serde_json::to_vec(&event)?;
    if serialized.len() <= max_serialized_event_bytes {
        return Ok(PreparedEvent {
            serialized,
            reduction: None,
        });
    }

    let original_bytes = serialized.len();
    drop(serialized);
    let (event_type, item_type) = match framework {
        Framework::Pi => pi_event_delivery::labels(&event),
        Framework::Codex => codex_event_delivery::labels(&event),
    };
    let mut candidates = collect_content_candidates(&event, framework)?;
    candidates.sort_by(|left, right| {
        right
            .reducible_bytes
            .cmp(&left.reducible_bytes)
            .then_with(|| left.path_key.cmp(&right.path_key))
    });

    let mut reduced_categories = BTreeSet::new();
    let mut selected = Vec::new();
    let mut reducible_bytes = 0usize;
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.reducible_bytes > 0)
        .take(MAX_REDUCED_FIELDS)
    {
        reduced_categories.insert(candidate.category);
        reducible_bytes = reducible_bytes.saturating_add(candidate.reducible_bytes);
        if let Some(text_type) = candidate.image_text_type {
            *value_at_path_mut(&mut event, &candidate.path)? = image_notice(text_type);
        } else {
            let Value::String(original) =
                std::mem::take(value_at_path_mut(&mut event, &candidate.path)?)
            else {
                return Err(AgentError::Execution("delivery content is not text".into()));
            };
            *value_at_path_mut(&mut event, &candidate.path)? =
                Value::String(truncated_text(&original, 0));
            selected.push(SelectedContent {
                path: candidate.path.clone(),
                original,
            });
        }

        let minimum_bytes = original_bytes.saturating_sub(reducible_bytes);
        if minimum_bytes > max_serialized_event_bytes {
            continue;
        }

        apply_retained_budget(&mut event, &selected, 0, 1)?;
        let minimum = serde_json::to_vec(&event)?;
        if minimum.len() > max_serialized_event_bytes {
            continue;
        }
        let total_original_bytes = selected
            .iter()
            .map(|content| content.original.len())
            .sum::<usize>();
        let available_bytes = max_serialized_event_bytes - minimum.len();
        let mut retained_bytes = available_bytes.min(total_original_bytes);

        for _ in 0..RETAINED_CONTENT_ADJUSTMENT_ATTEMPTS {
            apply_retained_budget(
                &mut event,
                &selected,
                retained_bytes,
                total_original_bytes.max(1),
            )?;
            let serialized = serde_json::to_vec(&event)?;
            if serialized.len() <= max_serialized_event_bytes {
                return Ok(reduced_event(
                    serialized,
                    event_type,
                    item_type,
                    original_bytes,
                    reduced_categories,
                    false,
                ));
            }

            let added_bytes = serialized.len().saturating_sub(minimum.len()).max(1);
            // Leave bounded room for UTF-8 edges, JSON escapes and changing
            // marker digit counts instead of spending all four attempts on rounding.
            retained_bytes = (retained_bytes.saturating_mul(available_bytes) / added_bytes)
                .saturating_sub(selected.len().saturating_mul(32));
        }

        return Ok(reduced_event(
            minimum,
            event_type,
            item_type,
            original_bytes,
            reduced_categories,
            false,
        ));
    }

    let mut fallback_categories = candidates
        .iter()
        .map(|candidate| candidate.category)
        .collect::<BTreeSet<_>>();
    fallback_categories.insert("event_structure");
    let fallback = match framework {
        Framework::Pi => {
            pi_event_delivery::minimum_event(event, reduced_categories.contains("image"))?
        }
        Framework::Codex => {
            codex_event_delivery::minimum_event(event, reduced_categories.contains("image"))?
        }
    };
    let serialized = serde_json::to_vec(&fallback)?;
    if serialized.len() > max_serialized_event_bytes {
        return Err(AgentError::Execution(format!(
            "CLI event delivery minimum is {} bytes, exceeding the {max_serialized_event_bytes}-byte serialized event budget",
            serialized.len()
        )));
    }

    Ok(reduced_event(
        serialized,
        event_type,
        item_type,
        original_bytes,
        fallback_categories,
        true,
    ))
}

fn reduced_event(
    serialized: Vec<u8>,
    event_type: &'static str,
    item_type: &'static str,
    original_bytes: usize,
    fields: BTreeSet<&'static str>,
    fallback: bool,
) -> PreparedEvent {
    let delivered_bytes = serialized.len();
    PreparedEvent {
        serialized,
        reduction: Some(EventReduction {
            event_type,
            item_type,
            original_bytes,
            delivered_bytes,
            fields: fields.into_iter().collect(),
            fallback,
        }),
    }
}

pub(super) enum ContentPolicy {
    Preserve,
    Descend,
    Text(&'static str),
    Image(&'static str),
}

fn collect_content_candidates(
    event: &Value,
    framework: Framework,
) -> Result<Vec<ContentCandidate>, AgentError> {
    let mut candidates = Vec::new();
    collect_value(
        event,
        framework,
        event.pointer("/item/type").and_then(Value::as_str),
        &mut Vec::new(),
        &mut candidates,
        &mut 0,
    )?;
    Ok(candidates)
}

fn collect_value(
    value: &Value,
    framework: Framework,
    item_type: Option<&str>,
    path: &mut Vec<PathSegment>,
    candidates: &mut Vec<ContentCandidate>,
    visited: &mut usize,
) -> Result<(), AgentError> {
    if candidates.len() >= MAX_REDUCTION_CANDIDATES
        || *visited >= MAX_VISITED_VALUES
        || path.len() >= MAX_PATH_DEPTH
    {
        return Ok(());
    }
    *visited += 1;
    let policy = match framework {
        Framework::Pi => pi_event_delivery::content_policy(value, path),
        Framework::Codex => codex_event_delivery::content_policy(value, path, item_type),
    };
    match policy {
        ContentPolicy::Preserve => return Ok(()),
        ContentPolicy::Text(category) => {
            if let Some(text) = value.as_str() {
                candidates.push(ContentCandidate {
                    path: path.clone(),
                    path_key: path_key(path),
                    category,
                    image_text_type: None,
                    reducible_bytes: json_string_bytes(text)
                        .saturating_sub(json_string_bytes(&truncated_text(text, 0))),
                });
            }
            return Ok(());
        }
        ContentPolicy::Image(text_type) => {
            candidates.push(ContentCandidate {
                path: path.clone(),
                path_key: path_key(path),
                category: "image",
                image_text_type: Some(text_type),
                reducible_bytes: serialized_bytes(value)?
                    .saturating_sub(serialized_bytes(&image_notice(text_type))?),
            });
            return Ok(());
        }
        ContentPolicy::Descend => {}
    }
    match value {
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                path.push(PathSegment::Index(index));
                collect_value(value, framework, item_type, path, candidates, visited)?;
                path.pop();
                if candidates.len() >= MAX_REDUCTION_CANDIDATES || *visited >= MAX_VISITED_VALUES {
                    break;
                }
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                if key.len() > MAX_PATH_KEY_BYTES {
                    continue;
                }
                path.push(PathSegment::Key(key.clone()));
                collect_value(value, framework, item_type, path, candidates, visited)?;
                path.pop();
                if candidates.len() >= MAX_REDUCTION_CANDIDATES || *visited >= MAX_VISITED_VALUES {
                    break;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

// Count without allocating another image-sized serialization.
fn serialized_bytes(value: &Value) -> Result<usize, AgentError> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

pub(super) fn image_notice(text_type: &str) -> Value {
    serde_json::json!({"type": text_type, "text": "[image omitted for delivery]"})
}

pub(super) fn json_string_bytes(value: &str) -> usize {
    value.chars().fold(2usize, |bytes, character| {
        bytes
            + match character {
                '"' | '\\' | '\u{0008}' | '\t' | '\n' | '\u{000c}' | '\r' => 2,
                '\u{0000}'..='\u{001f}' => 6,
                _ => character.len_utf8(),
            }
    })
}

fn apply_retained_budget(
    event: &mut Value,
    selected: &[SelectedContent],
    retained_bytes: usize,
    total_original_bytes: usize,
) -> Result<(), AgentError> {
    let retained_bytes = retained_bytes.min(total_original_bytes);
    let mut allocations = selected
        .iter()
        .map(|content| {
            ((retained_bytes as u128 * content.original.len() as u128)
                / total_original_bytes as u128) as usize
        })
        .collect::<Vec<_>>();
    let allocated = allocations.iter().sum::<usize>();
    let mut remainder = retained_bytes.saturating_sub(allocated);
    while remainder > 0 {
        for (allocation, content) in allocations.iter_mut().zip(selected) {
            if *allocation < content.original.len() {
                *allocation += 1;
                remainder -= 1;
                if remainder == 0 {
                    break;
                }
            }
        }
    }

    for (content, allocation) in selected.iter().zip(allocations) {
        *value_at_path_mut(event, &content.path)? =
            Value::String(truncated_text(&content.original, allocation));
    }
    Ok(())
}

fn path_key(path: &[PathSegment]) -> String {
    let mut output = String::new();
    for segment in path {
        match segment {
            PathSegment::Key(key) => {
                output.push('/');
                output.push_str(key);
            }
            PathSegment::Index(index) => {
                output.push('/');
                output.push_str(&index.to_string());
            }
        }
    }
    output
}

fn value_at_path_mut<'a>(
    value: &'a mut Value,
    path: &[PathSegment],
) -> Result<&'a mut Value, AgentError> {
    let mut current = value;
    for segment in path {
        current = match segment {
            PathSegment::Key(key) => current.get_mut(key),
            PathSegment::Index(index) => current.get_mut(*index),
        }
        .ok_or_else(|| AgentError::Execution("event reduction path disappeared".into()))?;
    }
    Ok(current)
}

fn truncated_text(original: &str, retained_bytes: usize) -> String {
    if retained_bytes >= original.len() {
        return original.to_string();
    }

    let head_target = retained_bytes.div_ceil(2);
    let tail_target = retained_bytes / 2;
    let head_end = floor_char_boundary(original, head_target);
    let tail_start = ceil_char_boundary(original, original.len().saturating_sub(tail_target));
    let preserved = head_end + original.len().saturating_sub(tail_start);
    let omitted = original.len().saturating_sub(preserved);
    format!(
        "{}\n[{omitted} bytes truncated for delivery]\n{}",
        &original[..head_end],
        &original[tail_start..]
    )
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while !value.is_char_boundary(index) {
        index += 1;
    }
    index
}
