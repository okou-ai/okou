//! Shared Codex thread ID identity contract.
//!
//! Codex thread IDs are accepted as standard UUID text, either hyphenated or
//! compact. Decorative forms accepted by `uuid::Uuid::parse_str`, such as
//! `urn:uuid:*` and brace-wrapped UUIDs, are intentionally outside this
//! runner/guest contract.

/// Canonical Codex thread identifier shared by runner and guest code.
///
/// Values are stored as lowercase hyphenated UUID text after parsing.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CodexThreadId {
    canonical: String,
}

impl CodexThreadId {
    /// Parse a Codex thread id accepted by the runner/guest contract.
    ///
    /// Hyphenated and compact UUID text are accepted. Other shapes that
    /// `uuid::Uuid::parse_str` could parse, including brace-wrapped UUIDs and
    /// `urn:uuid:*` values, are rejected by this contract.
    pub fn parse(raw: &str) -> Option<Self> {
        if !has_contract_shape(raw) {
            return None;
        }

        uuid::Uuid::parse_str(raw).ok().map(|uuid| Self {
            canonical: uuid.to_string(),
        })
    }

    /// Return the canonical lowercase hyphenated UUID text.
    pub fn as_str(&self) -> &str {
        &self.canonical
    }

    /// Consume the id and return the canonical lowercase hyphenated UUID text.
    pub fn into_string(self) -> String {
        self.canonical
    }

    /// Return the canonical UUID text without hyphens for filename components.
    pub fn filename_key(&self) -> String {
        self.canonical.replace('-', "")
    }
}

/// Canonicalize a Codex thread id to lowercase hyphenated UUID text.
pub fn canonical_codex_thread_id(raw: &str) -> Option<String> {
    CodexThreadId::parse(raw).map(CodexThreadId::into_string)
}

/// Convert a Codex thread id to its no-hyphen filename key.
pub fn codex_thread_id_filename_key(raw: &str) -> Option<String> {
    CodexThreadId::parse(raw).map(|thread_id| thread_id.filename_key())
}

fn has_contract_shape(raw: &str) -> bool {
    match raw.len() {
        32 => raw.bytes().all(|byte| byte.is_ascii_hexdigit()),
        36 => raw.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests;
