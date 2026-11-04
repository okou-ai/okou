//! Fixed Linux `execve` argv/environment size preflight guards.
//!
//! These helpers reject values beyond the configured budgets before spawning
//! so the runner and guest-agent can return a descriptive error instead of an
//! opaque `E2BIG` or shell-level "Argument list too long" error. Linux's
//! effective aggregate limit also depends on the `RLIMIT_STACK` of the process
//! that performs `execve`, so passing these checks does not guarantee that every
//! later spawn will succeed.

use std::fmt;

/// Conservative maximum byte length for one argv or env string.
///
/// Linux's `MAX_ARG_STRLEN` is commonly 32 pages, or 128 KiB on 4 KiB page
/// systems. The limit includes the trailing NUL, so callers may pass at most
/// one byte less of actual string payload.
pub const EXECVE_STRING_MAX_BYTES: usize = 128 * 1024 - 1;

/// Fixed aggregate byte budget for argv and environment strings.
///
/// Two MiB matches the common Linux `ARG_MAX` value with an 8 MiB soft
/// `RLIMIT_STACK`. Linux derives the effective aggregate limit from the stack
/// limit in force when `execve` runs; see [Linux's `execve` size limits]. This
/// preflight therefore assumes that the actual spawning context permits at
/// least this budget rather than defining a universal Linux limit.
///
/// [Linux's `execve` size limits]: https://man7.org/linux/man-pages/man2/execve.2.html#Limits_on_size_of_arguments_and_environment
pub const EXECVE_ARG_ENV_MAX_BYTES: usize = 2 * 1024 * 1024;

const EXECVE_POINTER_OVERHEAD_BYTES: usize = std::mem::size_of::<usize>();
const EXECVE_POINTER_TABLE_TERMINATOR_BYTES: usize = EXECVE_POINTER_OVERHEAD_BYTES * 2;

/// Process boundary value kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecBoundaryValueKind {
    /// An argv entry.
    Arg,
    /// An environment entry in `KEY=VALUE` form.
    Env,
}

impl ExecBoundaryValueKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Arg => "argv",
            Self::Env => "env",
        }
    }
}

/// One named value crossing an `execve` argv/env boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecBoundaryValue {
    kind: ExecBoundaryValueKind,
    name: String,
    bytes: usize,
}

impl ExecBoundaryValue {
    /// Construct an argv value from its logical name and string payload.
    pub fn arg(name: impl Into<String>, value: &str) -> Self {
        Self {
            kind: ExecBoundaryValueKind::Arg,
            name: name.into(),
            bytes: value.len(),
        }
    }

    /// Construct an env value from its key and value.
    ///
    /// The measured string is `KEY=VALUE`, matching the string passed through
    /// `execve`.
    pub fn env(key: impl Into<String>, value: &str) -> Self {
        let key = key.into();
        Self {
            kind: ExecBoundaryValueKind::Env,
            bytes: key.len() + 1 + value.len(),
            name: key,
        }
    }
}

/// Error returned when a process argv/env boundary is too large.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecBoundarySizeError {
    /// One argv or env string exceeds the per-string limit.
    StringTooLarge {
        /// Whether the value is argv or env.
        kind: ExecBoundaryValueKind,
        /// Logical field name, never the raw value.
        name: String,
        /// Actual byte length of the string.
        bytes: usize,
        /// Maximum allowed byte length.
        max_bytes: usize,
    },
    /// Aggregate argv+env payload exceeds the conservative total budget.
    AggregateTooLarge {
        /// Actual aggregate byte count including per-string NUL bytes and
        /// argv/env pointer-table overhead.
        bytes: usize,
        /// Maximum allowed aggregate byte count.
        max_bytes: usize,
    },
}

impl fmt::Display for ExecBoundarySizeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StringTooLarge {
                kind,
                name,
                bytes,
                max_bytes,
            } => write!(
                formatter,
                "{} value too large: {name} length={bytes} max={max_bytes}",
                kind.label()
            ),
            Self::AggregateTooLarge { bytes, max_bytes } => write!(
                formatter,
                "argv/env aggregate too large: bytes={bytes} max={max_bytes}"
            ),
        }
    }
}

impl std::error::Error for ExecBoundarySizeError {}

/// Validate argv/env sizes against the fixed preflight budgets.
///
/// Aggregate validation uses [`EXECVE_ARG_ENV_MAX_BYTES`]. The effective limit
/// in the process that later calls `execve` can be lower, so successful
/// validation does not rule out a subsequent `E2BIG` spawn failure.
pub fn validate_exec_boundary_sizes(
    values: impl IntoIterator<Item = ExecBoundaryValue>,
) -> Result<(), ExecBoundarySizeError> {
    validate_exec_boundary_sizes_with_budget(values, EXECVE_ARG_ENV_MAX_BYTES)
}

fn validate_exec_boundary_sizes_with_budget(
    values: impl IntoIterator<Item = ExecBoundaryValue>,
    aggregate_max_bytes: usize,
) -> Result<(), ExecBoundarySizeError> {
    let mut aggregate_bytes = EXECVE_POINTER_TABLE_TERMINATOR_BYTES;

    for value in values {
        if value.bytes > EXECVE_STRING_MAX_BYTES {
            return Err(ExecBoundarySizeError::StringTooLarge {
                kind: value.kind,
                name: value.name,
                bytes: value.bytes,
                max_bytes: EXECVE_STRING_MAX_BYTES,
            });
        }
        aggregate_bytes = aggregate_bytes.saturating_add(
            value
                .bytes
                .saturating_add(1)
                .saturating_add(EXECVE_POINTER_OVERHEAD_BYTES),
        );
    }

    if aggregate_bytes > aggregate_max_bytes {
        return Err(ExecBoundarySizeError::AggregateTooLarge {
            bytes: aggregate_bytes,
            max_bytes: aggregate_max_bytes,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests;
