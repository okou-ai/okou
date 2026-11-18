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

#[test]
fn broker_identity_guards_stop_requests() {
    use process_control_ipc::managed_task::{self as ipc, TaskReply, TaskRequest};

    let tool = format!("peer-credentials-test-{}", TaskHandle::generate().as_str());
    let listener = process_control_ipc::bind_abstract_listener(&ipc::endpoint(&tool)).unwrap();
    let handle = TaskHandle::generate();
    let expected = handle.clone();
    // SAFETY: geteuid is a scalar query with no preconditions.
    let privileged = unsafe { libc::geteuid() } == 0;
    let broker = std::thread::spawn(move || {
        let mut stream =
            process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(5)).unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        if privileged {
            let request = ipc::read_request_with_timeout(&stream, Duration::from_secs(5)).unwrap();
            assert!(
                matches!(request, TaskRequest::Stop { handle } if handle.as_str() == expected.as_str())
            );
            ipc::write_reply(&mut stream, &TaskReply::Stopped {}).unwrap();
        } else {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            assert_eq!(stream.read(&mut [0]).unwrap(), 0);
        }
    });

    let output = Command::new(env!("CARGO_BIN_EXE_guest-task-exec"))
        .args(["stop", handle.as_str()])
        .env(CANONICAL_TOOL_CGROUP_PROCS_ENV, tool)
        .output()
        .unwrap();
    broker.join().unwrap();

    assert!(output.stdout.is_empty());
    if privileged {
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
    } else {
        assert_eq!(output.status.code(), Some(125));
        assert!(String::from_utf8_lossy(&output.stderr).contains("task broker is not privileged"));
    }
}
