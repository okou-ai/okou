//! Validation for runner instance names.
//!
//! The same name is used as both a directory name (joined against
//! `HomePaths::runners_dir()`) and a systemd service name suffix
//! (e.g. `vm0-runner-<name>`). Service locks and unit staging files also
//! derive filenames from the service name, so this module is the single
//! source of truth for what counts as a valid runner instance name.
//!
//! Without validation, an absolute path (`/etc`) replaces the base via
//! `Path::join`, and a bare `..` segment escapes once the kernel resolves
//! it.
//!
//! `runner config --runner-dirname` validates the directory name before
//! resolving it into `RunnerConfig.base_dir`. Only that resolved path is
//! persisted in `runner.yaml`, so config loading has no original name to
//! revalidate.
//!
//! Independently supplied or discovered systemd service suffixes have a
//! separate lifecycle: `RunnerServiceUnit::from_suffix` validates each suffix
//! when constructing the service identity.
//!
//! Neither input has a matching server-side schema; both are runner-local.

use crate::error::{HostError, HostResult};

/// Maximum byte length for a runner instance name.
///
/// The limit is deliberately below common Linux `NAME_MAX` values after
/// adding runner/service prefixes and staging suffixes.
pub const MAX_NAME_BYTES: usize = 128;
const INVALID_NAME_PREVIEW_CHARS: usize = 64;

/// Validate `name` and return a `HostError::Config` with a uniform
/// message if it fails. Use this at every callsite that takes a runner
/// directory name from the user (currently only the `--runner-dirname`
/// flag of `runner config`) so the error wording stays consistent.
pub fn validate_or_err(name: &str) -> HostResult<()> {
    if !validate_name(name) {
        let diagnostic = invalid_name_diagnostic(name);
        let rules = validation_rules();
        return Err(HostError::Config(format!(
            "invalid runner-dirname: {diagnostic} ({rules})"
        )));
    }
    Ok(())
}

pub fn validation_rules() -> String {
    format!(
        "must be a non-empty single path segment of at most {MAX_NAME_BYTES} bytes, \
         lowercase alphanumeric, hyphens, and dots; cannot start with `.` or `-`"
    )
}

pub fn invalid_name_diagnostic(name: &str) -> String {
    let mut preview = String::new();
    let mut chars = name.chars();
    for _ in 0..INVALID_NAME_PREVIEW_CHARS {
        let Some(c) = chars.next() else {
            return format!("{name:?} ({} bytes)", name.len());
        };
        preview.push(c);
    }
    if chars.next().is_some() {
        format!("{preview:?}... ({} bytes)", name.len())
    } else {
        format!("{name:?} ({} bytes)", name.len())
    }
}

/// Validate that `name` is a safe runner instance identifier.
///
/// Used for both runner directory names and systemd service name suffixes
/// to ensure a single validation rule across the codebase.
///
/// Accepts `[a-z0-9.-]+` with these guards:
/// - non-empty
/// - at most [`MAX_NAME_BYTES`] bytes
/// - does not start with `.` (rejects `.`, `..`, and hidden-file forms)
/// - does not start with `-` (avoids being parsed as a flag downstream)
///
/// Implicitly rejects `/` and `\` (neither is in the charset), keeping the
/// name to a single path segment regardless of the host's separator
/// conventions. The dot allowance exists for production semver dirnames
/// produced by `ansible/playbooks/build-runner.yml` (e.g. `v0.3.0`).
pub fn validate_name(name: &str) -> bool {
    if name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || name.starts_with('.')
        || name.starts_with('-')
    {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

#[cfg(test)]
mod tests;
