use std::process::Stdio;

use super::ChildProcessGroup;

#[test]
fn child_process_group_rejects_dangerous_pgids() {
    assert_eq!(ChildProcessGroup::from_raw_pgid(-1), None);
    assert_eq!(ChildProcessGroup::from_raw_pgid(0), None);
    assert_eq!(ChildProcessGroup::from_raw_pgid(1), None);
}

#[test]
fn child_process_group_rejects_current_process_group() {
    let current_pgid = super::current_process_group();

    assert_eq!(ChildProcessGroup::from_raw_pgid(current_pgid), None);
}

#[test]
fn child_process_group_preserves_signalable_child_id() {
    let current_pgid = super::current_process_group();
    let child_id = if current_pgid == 42 { 43 } else { 42 };

    let process_group =
        ChildProcessGroup::from_raw_pgid(child_id).expect("signalable process group");

    assert_eq!(process_group.raw_pgid(), child_id);
}

#[test]
fn child_process_group_rejects_child_id_overflow() {
    let overflowing_child_id = (i32::MAX as u32).saturating_add(1);

    assert_eq!(
        ChildProcessGroup::from_group_leader_child_id(Some(overflowing_child_id)),
        None
    );
}

#[tokio::test]
async fn child_process_group_rejects_reaped_child() {
    let mut child = tokio::process::Command::new("true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .expect("spawn child");

    child.wait().await.expect("wait for child");

    assert_eq!(ChildProcessGroup::from_group_leader_child(&child), None);
}
