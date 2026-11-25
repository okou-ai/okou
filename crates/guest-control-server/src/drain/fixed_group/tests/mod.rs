use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use rustix::io::Errno;
use rustix::process::{Pid, WaitOptions, waitpid};

use super::*;
use crate::drain::drain_bounded_cancellable;
use crate::process::spawn_in_own_process_group;

const SPECS: [(usize, &str); 2] = [(128, "capture-out"), (256, "capture-err")];

fn child_with_pipes() -> io::Result<(Child, Pid)> {
    let child = spawn_in_own_process_group(
        Command::new("/bin/sh")
            .args(["-c", "exec sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )?;
    let pid = Pid::from_child(&child);
    Ok((child, pid))
}

#[test]
fn first_drain_failure_reaps_the_child_without_starting_stderr() -> io::Result<()> {
    let cancel = Arc::new(DrainCancellation::new()?);
    let (child, pid) = child_with_pipes()?;
    let mut attempts = Vec::new();

    let result = FixedGroupOutput::start_with(child, &cancel, SPECS, |_, limit, _, _, name| {
        attempts.push((limit, name));
        Err(io::Error::other("injected stdout start failure"))
    });

    assert!(
        matches!(result, Err(FixedGroupOutputError::StartStdout(error))
        if error.to_string() == "injected stdout start failure")
    );
    assert_eq!(attempts, [(128, "capture-out")]);
    assert!(!cancel.is_cancelled());
    assert!(matches!(
        waitpid(Some(pid), WaitOptions::NOHANG),
        Err(Errno::CHILD)
    ));
    Ok(())
}

#[test]
fn second_drain_failure_reaps_the_child_and_joins_stdout() -> io::Result<()> {
    let cancel = Arc::new(DrainCancellation::new()?);
    let (child, pid) = child_with_pipes()?;
    let finished = Arc::new(AtomicBool::new(false));
    let mut attempts = Vec::new();

    let result = FixedGroupOutput::start_with(
        child,
        &cancel,
        SPECS,
        |pipe, limit, cancel, done_tx, name| {
            attempts.push((limit, name));
            if name == "capture-err" {
                return Err(io::Error::other("injected stderr start failure"));
            }
            let finished = Arc::clone(&finished);
            let handle = thread::Builder::new().name(name.into()).spawn(move || {
                let result =
                    drain_bounded_cancellable(pipe, &cancel, Some(limit), None, |_, _| true);
                finished.store(true, Ordering::Release);
                let _ = done_tx.send(());
                result
            })?;
            Ok(BoundedDrainHandle { handle })
        },
    );

    assert!(
        matches!(result, Err(FixedGroupOutputError::StartStderr(error))
        if error.to_string() == "injected stderr start failure")
    );
    assert_eq!(attempts, SPECS);
    assert!(cancel.is_cancelled());
    assert!(finished.load(Ordering::Acquire));
    assert!(matches!(
        waitpid(Some(pid), WaitOptions::NOHANG),
        Err(Errno::CHILD)
    ));
    Ok(())
}
