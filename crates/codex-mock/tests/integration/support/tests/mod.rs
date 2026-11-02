use super::*;
use std::process::ChildStdin;

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

#[test]
fn output_with_timeout_drains_large_stdout_and_stderr() {
    let mut command = Command::new("sh");
    command.args([
        "-c",
        "head -c 262144 /dev/zero & head -c 262144 /dev/zero >&2 & wait",
    ]);

    let output = output_with_timeout_before_kill(
        command,
        &["large-output"],
        Duration::from_secs(2),
        Duration::from_secs(1),
        |_| {},
    )
    .unwrap();

    assert_eq!(output.stdout, vec![0; 262_144]);
    assert_eq!(output.stderr, vec![0; 262_144]);
}

#[test]
fn output_with_timeout_does_not_join_a_descendant_held_pipe() {
    let mut command = Command::new("sh");
    command.args(["-c", "sleep 1 &"]);
    let started = Instant::now();

    let error = output_with_timeout_before_kill(
        command,
        &["descendant-held-pipe"],
        Duration::from_millis(100),
        Duration::from_millis(30),
        |_| {},
    )
    .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert_eq!(
        error.to_string(),
        "stdout did not close before the child output deadline"
    );
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "output deadline should bound reader completion"
    );
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
    let pid = libc::pid_t::try_from(pid).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "child PID does not fit in pid_t",
        )
    })?;
    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
        // SAFETY: `pid` is the direct child still owned by the helper, and
        // WNOWAIT observes its exit without releasing that identity.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
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
