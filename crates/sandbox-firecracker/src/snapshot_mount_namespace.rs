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
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command as StdCommand, Output};

    use super::*;

    #[test]
    fn creation_command_owns_private_namespace_bind_order_and_tail() {
        let command = build_command(
            SnapshotMountMode::Creation {
                rootfs: BindMount::new(
                    Path::new("/dev/root device"),
                    Path::new("/snapshot/root bind"),
                ),
                home: BindMount::new(
                    Path::new("/images/home image"),
                    Path::new("/snapshot/workspace bind"),
                ),
            },
            "snapshot-network",
            Path::new("/opt/firecracker binary"),
            Path::new("/run/firecracker api.sock"),
        );

        assert_eq!(command.program.as_os_str(), OsStr::new("unshare"));
        assert_eq!(
            command_args(&command),
            vec![
                OsString::from("--mount"),
                OsString::from("--propagation"),
                OsString::from("private"),
                OsString::from("bash"),
                OsString::from("-c"),
                OsString::from(INNER_COMMAND),
                OsString::from("_"),
                OsString::from("0"),
                OsString::from("2"),
                OsString::from("/dev/root device"),
                OsString::from("/snapshot/root bind"),
                OsString::from("/images/home image"),
                OsString::from("/snapshot/workspace bind"),
                OsString::from("snapshot-network"),
                OsString::from("/opt/firecracker binary"),
                OsString::from("--api-sock"),
                OsString::from("/run/firecracker api.sock"),
            ]
        );
        assert!(!INNER_COMMAND.contains("/dev/root device"));
        assert!(!INNER_COMMAND.contains("/snapshot/root bind"));
    }

    #[test]
    fn restore_command_cleans_drives_before_ordered_binds_and_tail() {
        let command = build_command(
            SnapshotMountMode::Restore {
                vsock: BindMount::new(
                    Path::new("/run/sandbox vsock"),
                    Path::new("/snapshot/vsock bind"),
                ),
                rootfs: BindMount::new(
                    Path::new("/dev/root device"),
                    Path::new("/snapshot/root bind"),
                ),
                home: BindMount::new(
                    Path::new("/images/home image"),
                    Path::new("/snapshot/workspace bind"),
                ),
            },
            "restore-network",
            Path::new("/opt/firecracker binary"),
            Path::new("/run/firecracker api.sock"),
        );

        assert_eq!(command.program.as_os_str(), OsStr::new("unshare"));
        assert_eq!(
            command_args(&command),
            vec![
                OsString::from("--mount"),
                OsString::from("--propagation"),
                OsString::from("private"),
                OsString::from("bash"),
                OsString::from("-c"),
                OsString::from(INNER_COMMAND),
                OsString::from("_"),
                OsString::from("2"),
                OsString::from("/snapshot/root bind"),
                OsString::from("/snapshot/workspace bind"),
                OsString::from("3"),
                OsString::from("/run/sandbox vsock"),
                OsString::from("/snapshot/vsock bind"),
                OsString::from("/dev/root device"),
                OsString::from("/snapshot/root bind"),
                OsString::from("/images/home image"),
                OsString::from("/snapshot/workspace bind"),
                OsString::from("restore-network"),
                OsString::from("/opt/firecracker binary"),
                OsString::from("--api-sock"),
                OsString::from("/run/firecracker api.sock"),
            ]
        );
    }

    #[test]
    fn inner_command_ignores_stale_unmount_failures_and_preserves_order() {
        let (dir, trace) = fake_host_commands();
        let output = run_inner_command(
            dir.path(),
            &trace,
            &[
                "2",
                "/root target",
                "/workspace target",
                "3",
                "/vsock source",
                "/vsock target",
                "/root source",
                "/root target",
                "/workspace source",
                "/workspace target",
                "network namespace",
                "/firecracker binary",
                "--api-sock",
                "/api socket",
            ],
            None,
        );

        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(trace).unwrap(),
            "umount </root target>\n\
umount </workspace target>\n\
mount </vsock source> </vsock target>\n\
mount </root source> </root target>\n\
mount </workspace source> </workspace target>\n\
ip <netns> <exec> <network namespace> </firecracker binary> <--api-sock> </api socket>\n"
        );
        assert!(INNER_COMMAND.ends_with("exec ip netns exec \"$@\""));
    }

    #[test]
    fn inner_command_stops_after_first_bind_failure() {
        let (dir, trace) = fake_host_commands();
        let output = run_inner_command(
            dir.path(),
            &trace,
            &[
                "0",
                "2",
                "/bad source",
                "/root target",
                "/workspace source",
                "/workspace target",
                "network",
                "/firecracker",
                "--api-sock",
                "/api",
            ],
            Some("/bad source"),
        );

        assert_eq!(output.status.code(), Some(23));
        assert_eq!(
            fs::read_to_string(trace).unwrap(),
            "mount </bad source> </root target>\n"
        );
    }

    fn command_args(command: &Command) -> Vec<OsString> {
        command.args.clone()
    }

    fn fake_host_commands() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let trace = dir.path().join("trace");
        write_executable(
            &dir.path().join("umount"),
            r#"#!/bin/sh
printf 'umount <%s>\n' "$2" >> "$TRACE"
exit 1
"#,
        );
        write_executable(
            &dir.path().join("mount"),
            r#"#!/bin/sh
printf 'mount <%s> <%s>\n' "$3" "$4" >> "$TRACE"
if [ "$3" = "$FAIL_MOUNT_SOURCE" ]; then
    exit 23
fi
"#,
        );
        write_executable(
            &dir.path().join("ip"),
            r#"#!/bin/sh
printf 'ip' >> "$TRACE"
for arg in "$@"; do
    printf ' <%s>' "$arg" >> "$TRACE"
done
printf '\n' >> "$TRACE"
"#,
        );
        (dir, trace)
    }

    fn write_executable(path: &Path, contents: &str) {
        fs::write(path, contents).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn run_inner_command(
        command_dir: &Path,
        trace: &Path,
        args: &[&str],
        fail_mount_source: Option<&str>,
    ) -> Output {
        let mut command = StdCommand::new("/bin/bash");
        command
            .args(["-c", INNER_COMMAND, "_"])
            .args(args)
            .env("PATH", command_dir)
            .env("TRACE", trace)
            .env_remove("FAIL_MOUNT_SOURCE");
        if let Some(source) = fail_mount_source {
            command.env("FAIL_MOUNT_SOURCE", source);
        }
        command.output().unwrap()
    }
}
