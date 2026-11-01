//! Constructs the shared mount-namespace command for snapshot creation and restore.
//!
//! Callers retain ownership of process lifecycle, stdio, readiness, diagnostics,
//! and cleanup after receiving the unspawned command.

use std::path::Path;

use process_launch::Command;

// The counted sections keep paths in argv while allowing restore to run all
// stale unmount attempts before either mode starts its ordered bind sequence.
const INNER_COMMAND: &str = r#"stale_count=$1
shift
while [ "$stale_count" -gt 0 ]; do
    umount -- "$1" 2>/dev/null
    shift
    stale_count=$((stale_count - 1))
done
bind_count=$1
shift
while [ "$bind_count" -gt 0 ]; do
    mount --bind -- "$1" "$2" || exit
    shift 2
    bind_count=$((bind_count - 1))
done
exec ip netns exec "$@""#;

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
) -> Command {
    let mut command = Command::new("unshare");
    command.args([
        "--mount",
        "--propagation",
        "private",
        "bash",
        "-c",
        INNER_COMMAND,
        "_",
    ]);

    match mounts {
        SnapshotMountMode::Creation { rootfs, home } => {
            append_sections(&mut command, &[], &[rootfs, home]);
        }
        SnapshotMountMode::Restore {
            vsock,
            rootfs,
            home,
        } => {
            append_sections(
                &mut command,
                &[rootfs.target, home.target],
                &[vsock, rootfs, home],
            );
        }
    }

    command
        .arg(network_name)
        .arg(binary_path)
        .arg("--api-sock")
        .arg(api_sock);
    command
}

fn append_sections(command: &mut Command, stale_targets: &[&Path], binds: &[BindMount<'_>]) {
    command.arg(stale_targets.len().to_string());
    for target in stale_targets {
        command.arg(*target);
    }

    command.arg(binds.len().to_string());
    for bind in binds {
        command.arg(bind.source).arg(bind.target);
    }
}

#[cfg(test)]
mod tests;
