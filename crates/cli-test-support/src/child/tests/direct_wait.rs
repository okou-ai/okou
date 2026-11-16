use crate::child::{
    DirectChildWaitOutcome as ChildWaitOutcome, wait_child_with_timeout,
    wait_child_with_timeout_before_kill,
};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Duration;

#[test]
fn child_timeout_exit_stays_bound_to_the_original_child() {
    let (child, stdin) = stdin_controlled_child(23);
    let pid = child.id();

    let outcome = wait_child_with_timeout_before_kill(
        child,
        Duration::ZERO,
        Duration::from_secs(1),
        move |observed_pid| {
            assert_eq!(observed_pid, pid);
            drop(stdin);
            observe_child_exit_without_reaping(observed_pid).unwrap();
        },
    );

    assert!(matches!(outcome, ChildWaitOutcome::TimedOut(status) if status.code() == Some(23)));
    assert_child_reaped(pid);
}

#[test]
fn child_timeout_kills_and_reaps_a_hung_child() {
    let child = Command::new("sh")
        .args(["-c", "exec sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();

    let outcome = wait_child_with_timeout(child, Duration::from_millis(5), Duration::from_secs(1));

    assert!(matches!(outcome, ChildWaitOutcome::TimedOut(status) if !status.success()));
    assert_child_reaped(pid);
}

fn stdin_controlled_child(exit_code: i32) -> (Child, ChildStdin) {
    let mut child = Command::new("sh")
        .args(["-c", &format!("read _ || exit {exit_code}")])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    (child, stdin)
}

fn observe_child_exit_without_reaping(pid: u32) -> std::io::Result<()> {
    use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};

    let pid = libc::pid_t::try_from(pid).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "child PID does not fit in pid_t",
        )
    })?;
    let pid = Pid::from_raw(pid).ok_or_else(|| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    loop {
        // Observe the helper's direct child without releasing its identity.
        match waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
        ) {
            Ok(_) => return Ok(()),
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => return Err(error.into()),
        }
    }
}

fn assert_child_reaped(pid: u32) {
    let mut status = 0;
    // SAFETY: the lifecycle helper has already returned this direct
    // child's status; WNOHANG only verifies that no waitable child remains.
    let result = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
    assert_eq!(result, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}
