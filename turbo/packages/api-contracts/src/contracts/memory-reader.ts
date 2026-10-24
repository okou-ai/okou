/**
 * Shared personal Memory reader/writer contract.
 *
 * The API selects an org/member storage version per Run; Guest materializes it
 * at this root. Readers use only that mount, never a live HEAD.
 * memory_summary.md is optional UTF-8 startup context; MEMORY.md is the registry.
 * Registry references are relative POSIX file paths within the same root.
 * Detail directories (including rollout_summaries, skills and extensions) are
 * unconstrained; no migration or recursive prompt preload occurs.
 *
 * The source summary is at most 64 KiB. The injected excerpt, including its
 * truncation marker, is at most 2,500 UTF-8 bytes: a conservative upper bound of
 * 2,500 byte-level BPE tokens without loading a tokenizer at session startup.
 * Writers should keep the useful overview first; readers disclose truncation.
 * Memory is potentially stale, lower-priority evidence, never authorization or
 * shared Agent instructions. Current corrections and deliberate forgetting win.
 * This contract defines reading only; each writer owns its authorization rules.
 */
export const PI_MEMORY_ROOT = "/home/user/.pi/agent/memory";
export const PI_MEMORY_SUMMARY_FILE = "memory_summary.md";
export const PI_MEMORY_INDEX_FILE = "MEMORY.md";
export const PI_MEMORY_SUMMARY_SOURCE_BYTES = 64 * 1024;
export const PI_MEMORY_SUMMARY_EXCERPT_BYTES = 2500;
export const PI_MEMORY_LIMITS = {
  fileBytes: 1024 * 1024,
  scanBytes: 8 * 1024 * 1024,
  entries: 500,
  directoryEntries: 4096,
  depth: 8,
  pathBytes: 512,
  queryBytes: 1024,
  matches: 50,
  lines: 500,
  outputBytes: 16 * 1024,
} as const;
