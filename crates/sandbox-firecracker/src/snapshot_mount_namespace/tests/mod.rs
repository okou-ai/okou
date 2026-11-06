use std::ffi::OsStr;

use super::*;

#[test]
fn snapshot_commands_preserve_network_and_firecracker_arguments() {
    let creation = SnapshotMountMode::Creation {
        rootfs: BindMount::new(
            Path::new("/dev/root device"),
            Path::new("/snapshot/root bind"),
        ),
        home: BindMount::new(
            Path::new("/images/home image"),
            Path::new("/snapshot/home bind"),
        ),
    };
    let restore = SnapshotMountMode::Restore {
        vsock: BindMount::new(
            Path::new("/run/vsock source"),
            Path::new("/snapshot/vsock bind"),
        ),
        rootfs: BindMount::new(
            Path::new("/dev/root device"),
            Path::new("/snapshot/root bind"),
        ),
        home: BindMount::new(
            Path::new("/images/home image"),
            Path::new("/snapshot/home bind"),
        ),
    };
    for mode in [creation, restore] {
        let command = build_command(
            mode,
            "network namespace",
            Path::new("/opt/firecracker binary"),
            Path::new("/run/firecracker api.sock"),
        )
        .unwrap();
        assert_eq!(command.program, OsStr::new("ip"));
        assert_eq!(
            command.args,
            [
                "netns",
                "exec",
                "network namespace",
                "/opt/firecracker binary",
                "--api-sock",
                "/run/firecracker api.sock"
            ]
            .map(std::ffi::OsString::from)
        );
    }
}
