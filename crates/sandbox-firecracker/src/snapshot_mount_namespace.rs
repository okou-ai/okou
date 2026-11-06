//! Constructs the shared mount-namespace command for snapshot creation and restore.
//!
//! Callers retain ownership of process lifecycle, stdio, readiness, diagnostics,
//! and cleanup after receiving the unspawned command.

use std::io;
use std::path::Path;

use process_launch::Command;

pub(crate) struct BindMount<'a> {
    source: &'a Path,
    target: &'a Path,
}

impl<'a> BindMount<'a> {
    pub(crate) fn new(source: &'a Path, target: &'a Path) -> Self {
        Self { source, target }
    }
}

pub(crate) enum SnapshotMountMode<'a> {
    Creation {
        rootfs: BindMount<'a>,
        home: BindMount<'a>,
    },
    Restore {
        vsock: BindMount<'a>,
        rootfs: BindMount<'a>,
        home: BindMount<'a>,
    },
}

pub(crate) fn build_command(
    mounts: SnapshotMountMode<'_>,
    network_name: &str,
    binary_path: &Path,
    api_sock: &Path,
) -> io::Result<Command> {
    // Retain ip's sysfs and namespace-specific /etc setup, in addition to setns.
    let mut command = Command::new("ip");
    command.args(["netns", "exec"]);

    match mounts {
        SnapshotMountMode::Creation { rootfs, home } => {
            command.private_mount_namespace(
                &[],
                &[(rootfs.source, rootfs.target), (home.source, home.target)],
            )?;
        }
        SnapshotMountMode::Restore {
            vsock,
            rootfs,
            home,
        } => {
            command.private_mount_namespace(
                &[rootfs.target, home.target],
                &[
                    (vsock.source, vsock.target),
                    (rootfs.source, rootfs.target),
                    (home.source, home.target),
                ],
            )?;
        }
    }

    command
        .arg(network_name)
        .arg(binary_path)
        .arg("--api-sock")
        .arg(api_sock);
    Ok(command)
}

#[cfg(test)]
mod tests;
