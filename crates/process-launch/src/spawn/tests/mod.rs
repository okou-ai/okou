use super::*;
use std::os::fd::AsFd;
use std::process::Command as StandardCommand;

fn signal_mask() -> u64 {
    let mut mask = 0u64;
    // SAFETY: null new-set only reads the current thread's kernel mask.
    assert_eq!(
        unsafe {
            libc::syscall(
                libc::SYS_rt_sigprocmask,
                libc::SIG_SETMASK,
                std::ptr::null::<u64>(),
                &mut mask,
                size_of::<u64>(),
            )
        },
        0
    );
    mask
}

#[test]
fn exec_acknowledgement_does_not_restart_an_expired_launch_budget() {
    let (reader, writer) = pipe().unwrap();
    drop(writer);
    let error =
        exec_handshake(&File::from(reader), Instant::now() - Duration::from_secs(1)).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);

    let (reader, writer) = pipe().unwrap();
    drop(writer);
    exec_handshake(&File::from(reader), Instant::now() + EXEC_HANDSHAKE_TIMEOUT).unwrap();
}

#[test]
fn child_retry_errnos_are_terminal_exec_failures() {
    use std::io::Write;

    for errno in [libc::EINTR, libc::EAGAIN] {
        let (reader, writer) = pipe().unwrap();
        File::from(writer).write_all(&errno.to_ne_bytes()).unwrap();
        let error = exec_handshake(&File::from(reader), Instant::now() + EXEC_HANDSHAKE_TIMEOUT)
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(errno));
    }
}

#[test]
fn rejected_cgroup_never_falls_back_or_changes_the_parent_mask() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("must-not-exist");
    let not_a_cgroup = File::open(directory.path()).unwrap();
    let before = signal_mask();
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("touch \"$MARKER\"")
        .env("MARKER", &marker);
    match spawn(command, not_a_cgroup.as_fd(), SpawnOptions::default()) {
        Err(error) => assert!(error.raw_os_error().is_some(), "{error}"),
        Ok(child) => {
            let _ = child.kill_and_reap();
            panic!("an ordinary directory cannot authorize a cgroup launch");
        }
    }
    assert_eq!(signal_mask(), before);
    assert!(!marker.exists());
}

#[test]
fn malformed_launch_inputs_fail_before_child_creation() {
    let directory = tempfile::tempdir().unwrap();
    let descriptor = File::open(directory.path()).unwrap();
    for invalid in ["argument", "environment", "directory"] {
        let mut command = Command::new("/bin/true");
        match invalid {
            "argument" => {
                command.arg("bad\0argument");
            }
            "environment" => {
                command.env("bad=key", "value");
            }
            _ => {
                command.current_dir("bad\0directory");
            }
        }
        let error = match spawn(command, descriptor.as_fd(), SpawnOptions::default()) {
            Err(error) => error,
            Ok(child) => {
                let _ = child.kill_and_reap();
                panic!("invalid input unexpectedly spawned");
            }
        };
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}

#[test]
fn private_pipes_preserve_closed_standard_descriptors() {
    const CHILD_ENV: &str = "OKOU_TEST_PRIVATE_PIPE_CHILD";
    if std::env::var_os(CHILD_ENV).is_some() {
        // Close after Rust startup, which repairs inherited closed stdio.
        // This process runs only this test and exits before harness output.
        for fd in [0, 1, 2] {
            // SAFETY: only this isolated process loses its standard fds.
            unsafe { libc::close(fd) };
        }
        let (reader, writer) = pipe().unwrap();
        assert!(reader.as_raw_fd() > 2 && writer.as_raw_fd() > 2);
        for fd in [0, 1, 2] {
            // SAFETY: fcntl only probes whether this descriptor is open.
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
        }
        // The isolated child intentionally has no harness output fds.
        // SAFETY: all assertions completed; the OS owns final fd cleanup.
        unsafe { libc::_exit(0) };
    }
    let mut command = StandardCommand::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "spawn::tests::private_pipes_preserve_closed_standard_descriptors",
        ])
        .env(CHILD_ENV, "1");
    assert!(command.status().unwrap().success());
}
