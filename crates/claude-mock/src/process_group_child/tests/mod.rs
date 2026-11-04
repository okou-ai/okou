use super::ChildProcessGroup;

#[test]
fn child_process_group_rejects_dangerous_values() {
    assert_eq!(ChildProcessGroup::from_raw_pgid(0), None);
    assert_eq!(ChildProcessGroup::from_raw_pgid(1), None);
    assert_eq!(
        ChildProcessGroup::from_raw_pgid(super::current_process_group()),
        None
    );
}

#[test]
fn child_process_group_rejects_child_id_overflow() {
    let overflowing_child_id = (libc::pid_t::MAX as u32).saturating_add(1);

    assert_eq!(
        ChildProcessGroup::from_group_leader_child_id(overflowing_child_id),
        None
    );
}

#[test]
fn child_process_group_preserves_signalable_child_id() {
    let current_pgid = super::current_process_group();
    let child_id = if current_pgid == 42 { 43 } else { 42 };

    let process_group =
        ChildProcessGroup::from_raw_pgid(child_id).expect("signalable process group");

    assert_eq!(process_group.pgid, child_id);
}

#[test]
fn signalable_child_pid_rejects_dangerous_values() {
    assert_eq!(super::signalable_child_pid(0), None);
    assert_eq!(super::signalable_child_pid(1), None);
    assert_eq!(
        super::signalable_child_pid(super::current_process_id() as u32),
        None
    );
}

#[test]
fn signalable_child_pid_rejects_overflow() {
    let overflowing_child_id = (libc::pid_t::MAX as u32).saturating_add(1);

    assert_eq!(super::signalable_child_pid(overflowing_child_id), None);
}
