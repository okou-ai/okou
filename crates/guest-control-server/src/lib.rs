//! Guest-side server for Runner-initiated control operations.
//!
//! This library dispatches guest control requests over vsock or Unix sockets.
//! guest-init embeds it in its child process; it is not a separate daemon.
//!
//! Protocol encoding/decoding is handled by the `guest-control-proto` crate.

mod agent_command;
mod connection;
mod contained_command;
mod drain;
mod error;
mod exec_control;
mod exec_operation;
mod file_stream;
mod file_write_progress;
mod file_write_worker;
mod guest_dns_readiness;
mod guest_state_restore;
mod guest_storage_manifest;
mod handlers;
mod log;
mod memory_snapshot;
mod oom_evidence;
mod process;
mod process_containment;
mod quiesce;
mod shell_command;
mod shutdown;
#[cfg(test)]
mod test_support;
mod threading;
mod user;
mod wait;
mod worker_ownership;
mod workspace_drive_mount;
mod writer;

pub use connection::handle_connection_with_test_dns_readiness_program;
pub use connection::handle_connection_with_test_guest_agent_program;
pub use connection::handle_connection_with_test_guest_state_restore_program;
pub use connection::handle_connection_with_test_memory_snapshot_path;
pub use connection::handle_connection_with_test_storage_manifest_program;
pub use connection::handle_connection_with_test_storage_manifest_timeout_gate;
pub use connection::handle_connection_with_test_storage_resources;
pub use connection::handle_connection_with_test_workspace_drive_mount_program;
pub use connection::{
    connect_unix, connect_vsock, handle_connection,
    handle_connection_with_test_process_containment,
    handle_connection_with_test_process_containment_and_exec_drain_deadline, run,
};
pub use log::log;

#[cfg(any(debug_assertions, feature = "test-support"))]
#[doc(hidden)]
pub fn set_debug_guest_write_file_path_for_tests(path: std::path::PathBuf) {
    handlers::set_debug_guest_write_file_path(path);
}
