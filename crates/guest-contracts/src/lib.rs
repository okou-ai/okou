#![deny(missing_docs)]

//! Shared contracts between the runner and guest binaries.
//!
//! Keep guest-only runtime helpers in `guest-telemetry`. This crate is for names,
//! values, and filesystem layout helpers both sides must keep in lockstep.

pub mod active_input;
pub mod active_input_receipts;
pub mod cli_agent_session_id;
pub mod cli_stderr_diagnostics;
pub mod codex_session_cleanup;
pub mod codex_session_path;
pub mod codex_thread_id;
pub mod connector_account_context;
pub mod diagnostics;
pub mod env;
pub mod epoch_milliseconds;
pub mod exec_limits;
pub mod exec_terminal;
pub mod file_write;
pub mod guest_binary;
pub mod managed_command;
pub mod oom_evidence;
pub mod process_containment;
pub mod reuse_preparation;
pub mod runtime_paths;
pub mod session_history;
pub mod session_history_identity;
pub mod stdout_framing;
pub mod storage_files;
pub mod storage_manifest;
pub mod storage_resources;
pub mod workspace_mount;
