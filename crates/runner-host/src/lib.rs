//! Runner host filesystem, process, lock, path, and logging primitives.

pub mod bounded_command;
pub mod child_cleanup;
pub mod cleanup_progress;
pub mod error;
pub mod host;
pub mod host_env;
pub mod host_file;
pub mod lock;
pub mod log_file;
pub mod parent_death;
pub mod paths;
pub mod private_fs;
pub mod process;
pub mod runner_dirname;
pub mod runner_process_identity;
pub mod state_file;

#[cfg(test)]
mod test_support;

pub use error::{HostError, HostResult};
