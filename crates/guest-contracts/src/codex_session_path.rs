//! Shared Codex session path layout.

use chrono::{DateTime, Utc};

use crate::codex_thread_id::CodexThreadId;

/// Build the canonical Codex rollout path relative to the Codex home.
///
/// The returned path has the form
/// `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread-id>.jsonl`.
pub fn codex_rollout_relative_path(thread_id: &CodexThreadId, timestamp: DateTime<Utc>) -> String {
    format!(
        "sessions/{}/{}/{}/rollout-{}-{}.jsonl",
        timestamp.format("%Y"),
        timestamp.format("%m"),
        timestamp.format("%d"),
        timestamp.format("%Y-%m-%dT%H-%M-%S"),
        thread_id.as_str(),
    )
}

/// Return whether a path is one canonical logical Codex rollout path for the
/// supplied thread id, relative to the fixed Codex home.
pub fn is_canonical_codex_rollout_relative_path(path: &str, thread_id: &CodexThreadId) -> bool {
    let Some(relative) = path.strip_prefix("sessions/") else {
        return false;
    };
    let mut components = relative.split('/');
    let (Some(year), Some(month), Some(day), Some(filename), None) = (
        components.next(),
        components.next(),
        components.next(),
        components.next(),
        components.next(),
    ) else {
        return false;
    };
    if !fixed_ascii_digits(year, 4) || !fixed_ascii_digits(month, 2) || !fixed_ascii_digits(day, 2)
    {
        return false;
    }
    let (Ok(year_number), Ok(month_number), Ok(day_number)) = (
        year.parse::<i32>(),
        month.parse::<u32>(),
        day.parse::<u32>(),
    ) else {
        return false;
    };
    if year_number < 1
        || chrono::NaiveDate::from_ymd_opt(year_number, month_number, day_number).is_none()
    {
        return false;
    }

    let prefix = format!("rollout-{year}-{month}-{day}T");
    let suffix = format!("-{}.jsonl", thread_id.as_str());
    let Some(time) = filename
        .strip_prefix(&prefix)
        .and_then(|filename| filename.strip_suffix(&suffix))
    else {
        return false;
    };
    let mut time_components = time.split('-');
    let (Some(hour), Some(minute), Some(second), None) = (
        time_components.next(),
        time_components.next(),
        time_components.next(),
        time_components.next(),
    ) else {
        return false;
    };
    if !fixed_ascii_digits(hour, 2)
        || !fixed_ascii_digits(minute, 2)
        || !fixed_ascii_digits(second, 2)
    {
        return false;
    }
    let (Ok(hour), Ok(minute), Ok(second)) = (
        hour.parse::<u32>(),
        minute.parse::<u32>(),
        second.parse::<u32>(),
    ) else {
        return false;
    };
    hour <= 23 && minute <= 59 && second <= 59
}

fn fixed_ascii_digits(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests;
