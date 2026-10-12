use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

use guest_contracts::managed_task::TaskHandle;
use guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV;

#[test]
fn invalid_arguments_never_execute_target_code() {
    let output = Command::new(env!("CARGO_BIN_EXE_guest-task-exec"))
        .args([
            "--report-fd",
            "1",
            "--",
            "/bin/sh",
            "-c",
            "printf unsafe-target-ran",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(125));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("separate from standard IO"));
}

#[test]
fn missing_or_unsupported_capability_never_falls_back_and_emits_no_startup_record() {
    for endpoint in [
        None,
        Some(format!("absent-tool-{}", TaskHandle::generate().as_str())),
    ] {
        let (mut report, writer) = UnixStream::pair().unwrap();
        report
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let fd = writer.as_raw_fd();
        let mut command = Command::new(env!("CARGO_BIN_EXE_guest-task-exec"));
        command
            .args([
                "--report-fd",
                "3",
                "--",
                "/bin/sh",
                "-c",
                "printf unsafe-target-ran",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(endpoint) = endpoint {
            command.env(CANONICAL_TOOL_CGROUP_PROCS_ENV, endpoint);
        } else {
            command.env_remove(CANONICAL_TOOL_CGROUP_PROCS_ENV);
        }
        // SAFETY: the writer remains open through spawn. The hook uses only
        // async-signal-safe syscalls and consumes an explicitly private FD.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        drop(writer);
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(125));
        assert!(output.stdout.is_empty());
        let mut metadata = Vec::new();
        report.read_to_end(&mut metadata).unwrap();
        assert!(metadata.is_empty());
    }
}
