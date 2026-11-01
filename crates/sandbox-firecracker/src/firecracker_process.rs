//! Applies the shared process contract for Firecracker children.

use std::io;
use std::os::fd::AsFd;
use std::path::Path;

use process_launch::asynchronous::{self, Child};
use process_launch::{Command, SpawnOptions, Stdio};

/// Firecracker's jailer defaults both open-file limits to this value.
const FIRECRACKER_NOFILE_LIMIT: libc::rlim_t = 2048;

pub(crate) async fn spawn_firecracker(
    mut command: Command,
    current_dir: &Path,
    placement_directory: Option<std::fs::File>,
) -> io::Result<Child> {
    command
        .current_dir(current_dir)
        .stdin(Stdio::Null)
        .stdout(Stdio::Piped)
        .stderr(Stdio::Piped)
        .nofile_limit(FIRECRACKER_NOFILE_LIMIT);

    match placement_directory {
        Some(directory) => {
            asynchronous::spawn(command, directory.as_fd(), SpawnOptions::default()).await
        }
        // Explicit unmanaged/snapshot-generation mode, never a failed clone3 retry.
        None => tokio::process::Command::from(command.into_standard_command())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map(Child::from),
    }
}

#[cfg(test)]
mod tests;
