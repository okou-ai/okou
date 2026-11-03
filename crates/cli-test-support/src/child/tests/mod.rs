use super::KillAndWaitChild;
use nix::errno::Errno;
use nix::sys::wait::{WaitPidFlag, waitpid};
use nix::unistd::Pid;
use std::process::Command;

#[test]
fn drop_terminates_and_reaps_live_child() {
    let mut child = KillAndWaitChild(Command::new("sleep").arg("60").spawn().unwrap());
    let pid = Pid::from_raw(i32::try_from(child.0.id()).unwrap());
    assert!(child.0.try_wait().unwrap().is_none());

    drop(child);

    assert_eq!(waitpid(pid, Some(WaitPidFlag::WNOHANG)), Err(Errno::ECHILD));
}
