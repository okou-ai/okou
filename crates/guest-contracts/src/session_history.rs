//! Session-history limits shared by the runner and guest.

/// Maximum decoded size of a retained Codex compact generation.
///
/// Restored zstd histories larger than this guard must be materialized as plain
/// JSONL so the guest can apply the bounded native selector before saving history.
pub const CODEX_COMPACT_GENERATION_MAX_BYTES: u64 = 64 * 1024 * 1024;
