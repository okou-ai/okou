//! Exact, bounded native-file selection after current managed preparation.

use crate::env::Framework;
use crate::error::AgentError;
use crate::session_history::{SessionHistoryUploadSource, resolve_session_history_from_source};
use guest_contracts::session_history_identity::SessionHistorySourceRef;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_NATIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PI_ENTRIES: usize = 16_384;

fn pi_sources(session_id: &str) -> Result<Vec<PathBuf>, AgentError> {
    let root =
        Path::new(api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR);
    #[cfg(target_os = "linux")]
    {
        let dir = match crate::nofollow_fs::Dir::open_absolute(root) {
            Ok(dir) => dir,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(error.into());
            }
        };
        let mut sources = Vec::new();
        for (index, entry) in dir.read_dir()?.enumerate() {
            if index >= MAX_PI_ENTRIES {
                return Err(AgentError::SessionHistoryLookupBudgetExceeded { framework: "Pi" });
            }
            let path = root.join(entry?.file_name());
            if path.to_str().is_some_and(|text| {
                crate::session_metadata::is_pi_session_history_path(text, session_id)
            }) {
                sources.push(path);
            }
        }
        Ok(sources)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (root, session_id);
        Ok(Vec::new())
    }
}

pub(crate) fn retained_session_is_usable(
    framework: Framework,
    session_id: &str,
    claude_dir: &str,
    codex_home: &str,
) -> Result<bool, AgentError> {
    if !guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id(session_id) {
        return Ok(false);
    }
    let source = match framework {
        Framework::ClaudeCode => SessionHistorySourceRef::ClaudeCode {
            config_dir: claude_dir.into(),
            working_dir: crate::paths::CANONICAL_WORKING_DIR.into(),
            session_id: session_id.into(),
        },
        Framework::Codex => {
            let Some(thread_id) =
                guest_contracts::codex_thread_id::canonical_codex_thread_id(session_id)
            else {
                return Ok(false);
            };
            SessionHistorySourceRef::Codex {
                sessions_dir: format!("{codex_home}/sessions"),
                thread_id,
            }
        }
        Framework::Pi => {
            let mut sources = match pi_sources(session_id) {
                Ok(sources) => sources,
                Err(error) => return unavailable_native_source(error),
            };
            if sources.len() != 1 {
                return Ok(false);
            }
            SessionHistorySourceRef::Pi {
                session_path: sources.remove(0).to_string_lossy().into_owned(),
                session_id: session_id.into(),
            }
        }
    };
    let file = match resolve_session_history_from_source(&source) {
        Ok(file) => file,
        Err(error) => return unavailable_native_source(error),
    };
    let bytes = match file.into_upload_source_bounded(MAX_NATIVE_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => return unavailable_native_source(error),
    };
    let bytes = match bytes {
        SessionHistoryUploadSource::Decoded(bytes) => bytes,
        SessionHistoryUploadSource::CodexZstd { encoded } => {
            let Ok(decoder) = zstd::stream::read::Decoder::new(encoded.as_slice()) else {
                return Ok(false);
            };
            let mut bytes = Vec::new();
            if decoder
                .take(MAX_NATIVE_BYTES + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 > MAX_NATIVE_BYTES
            {
                return Ok(false);
            }
            bytes
        }
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(false);
    };
    let mut matched = false;
    let mut has_context = false;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return Ok(false);
        };
        has_context |= native_context_record(framework, &value);
        let id = match framework {
            Framework::ClaudeCode => value.get("sessionId").and_then(serde_json::Value::as_str),
            Framework::Codex
                if value.get("type").and_then(serde_json::Value::as_str)
                    == Some("session_meta") =>
            {
                value
                    .get("payload")
                    .and_then(|payload| payload.get("id"))
                    .and_then(serde_json::Value::as_str)
            }
            Framework::Pi
                if value.get("type").and_then(serde_json::Value::as_str) == Some("session") =>
            {
                if value.get("version").and_then(serde_json::Value::as_u64) != Some(3) {
                    return Ok(false);
                }
                value.get("id").and_then(serde_json::Value::as_str)
            }
            _ => None,
        };
        if let Some(id) = id {
            let matches = if framework == Framework::Codex {
                guest_contracts::codex_thread_id::canonical_codex_thread_id(id)
                    == guest_contracts::codex_thread_id::canonical_codex_thread_id(session_id)
            } else {
                id == session_id
            };
            if !matches {
                return Ok(false);
            }
            matched = true;
        }
    }
    Ok(matched && has_context)
}

fn nonempty_content(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::String(text)) => !text.trim().is_empty(),
        Some(serde_json::Value::Array(items)) => !items.is_empty(),
        _ => false,
    }
}

/// A matching identity header alone is not resumed conversation context.
fn native_context_record(framework: Framework, value: &serde_json::Value) -> bool {
    let kind = value.get("type").and_then(serde_json::Value::as_str);
    match framework {
        Framework::ClaudeCode => {
            (matches!(kind, Some("user" | "assistant"))
                && nonempty_content(value.pointer("/message/content")))
                || (kind == Some("summary") && nonempty_content(value.get("summary")))
        }
        Framework::Pi => {
            (kind == Some("message")
                && matches!(
                    value
                        .pointer("/message/role")
                        .and_then(serde_json::Value::as_str),
                    Some("user" | "assistant" | "toolResult")
                )
                && nonempty_content(value.pointer("/message/content")))
                || (matches!(kind, Some("compaction" | "branch_summary"))
                    && nonempty_content(value.get("summary")))
        }
        Framework::Codex => match kind {
            Some("response_item") => {
                (matches!(
                    value
                        .pointer("/payload/role")
                        .and_then(serde_json::Value::as_str),
                    Some("user" | "assistant")
                ) && nonempty_content(value.pointer("/payload/content")))
                    || nonempty_content(value.pointer("/payload/arguments"))
                    || nonempty_content(value.pointer("/payload/output"))
            }
            Some("compacted") => {
                nonempty_content(value.pointer("/payload/message"))
                    || nonempty_content(value.pointer("/payload/replacement_history"))
            }
            Some("event_msg") => {
                matches!(
                    value
                        .pointer("/payload/type")
                        .and_then(serde_json::Value::as_str),
                    Some("user_message" | "agent_message")
                ) && nonempty_content(value.pointer("/payload/message"))
            }
            _ => false,
        },
    }
}

fn unavailable_native_source(error: AgentError) -> Result<bool, AgentError> {
    match error {
        AgentError::SessionHistoryMissing { .. }
        | AgentError::SessionHistoryAmbiguous { .. }
        | AgentError::SessionHistoryNotRegular { .. }
        | AgentError::SessionHistoryLookupBudgetExceeded { .. }
        | AgentError::SessionHistoryTooLarge { .. } => Ok(false),
        AgentError::Io(ref source) | AgentError::SessionHistoryRead(ref source)
            if matches!(
                source.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) || source.raw_os_error() == Some(libc::ELOOP) =>
        {
            Ok(false)
        }
        _ => Err(error),
    }
}

/// Pi's captured identity is Thread-bound. Move only that identity's old files
/// out of SDK selection before a deliberate fresh launch, preserving their bytes.
pub(crate) fn prepare_fresh_pi_session(session_id: &str, run_id: &str) -> Result<(), AgentError> {
    for path in pi_sources(session_id)? {
        #[cfg(target_os = "linux")]
        {
            let dir = crate::nofollow_fs::Dir::open_absolute(
                path.parent()
                    .ok_or_else(|| AgentError::Execution("invalid native Pi parent".into()))?,
            )?;
            let leaf = path
                .file_name()
                .ok_or_else(|| AgentError::Execution("invalid native Pi path".into()))?;
            let retired = format!("{}.unresumed-{run_id}", leaf.to_string_lossy());
            dir.rename_child(leaf, std::ffi::OsStr::new(&retired))?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (path, run_id);
        }
    }
    Ok(())
}
