//! Maximum retained-record sizes for CLI stdout framing.
//!
//! These limits are shared by guest-agent readers, mock producers, and
//! integration tests so runtime policy and boundary fixtures stay in lockstep.

/// Maximum retained bytes for one ordinary CLI stdout record before parsing.
///
/// This policy is shared by the Claude Code execution path and Pi standby.
/// LF is excluded. A preceding CR counts before CRLF normalization, and an
/// EOF-terminated final record is measured without an implicit terminator.
pub const ORDINARY_CLI_STDOUT_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
