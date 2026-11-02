//! POSIX shell argument quoting for executable command construction.
//!
//! This crate intentionally always quotes each argument. It is for command
//! strings that will be parsed by a POSIX shell, not for human-facing display
//! formatting.
//!
//! The functions here only quote shell words. Callers are still responsible for
//! validating transport-specific constraints such as NUL-byte rejection before
//! passing values to process or protocol boundaries.

/// Quote one argument as a POSIX shell word.
///
/// The returned string is always single-quoted. Embedded single quotes are
/// represented by ending the quoted string, emitting an escaped quote, and
/// reopening the quoted string.
///
/// This does not validate whether the input is acceptable for a specific
/// process API, protocol, or filesystem operation.
pub fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests;
