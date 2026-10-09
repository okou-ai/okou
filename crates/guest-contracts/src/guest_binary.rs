//! Canonical executable destinations for binaries delivered in the guest rootfs.
//!
//! The runner's `guest-binaries.json` inventory remains authoritative for
//! delivery metadata. Its integration test requires every inventory entry to
//! match these paths so runner and guest runtime consumers stay in lockstep.

/// Production path of the Guest Agent executable.
pub const AGENT_PATH: &str = "/usr/local/bin/guest-agent";

/// Production path of the guest storage-manifest application executable.
pub const STORAGE_APPLY_PATH: &str = "/usr/local/bin/guest-storage-apply";

/// Production path of the guest init executable.
pub const INIT_PATH: &str = "/sbin/guest-init";

/// Production path of the guest state-restoration executable.
pub const STATE_RESTORE_PATH: &str = "/sbin/guest-state-restore";

/// Production path of the privileged guest file-writer executable.
pub const WRITE_FILE_PATH: &str = "/sbin/guest-write-file";

/// Production path of the managed guest tool executor.
pub const TOOL_EXEC_PATH: &str = "/usr/local/bin/guest-tool-exec";

/// Production path of the one-shot Guest-to-Runner RPC helper.
pub const RUNNER_RPC_CLIENT_PATH: &str = "/usr/local/bin/runner-rpc-client";

/// Production path of the shipped Claude mock executable.
pub const CLAUDE_MOCK_PATH: &str = "/usr/local/bin/claude-mock";

/// Production path of the shipped Codex mock executable.
pub const CODEX_MOCK_PATH: &str = "/usr/local/bin/codex-mock";
