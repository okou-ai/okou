use super::*;

#[test]
fn parse_proc_stat_handles_process_names_with_parentheses() {
    let stat = "123 (name ) with parens) S 1 456 456 0 -1 4194304 1 2 3 4 5 6 7 8 20 0 1 0 0";

    let parsed = parse_proc_stat(stat).unwrap();

    assert_eq!(parsed.state, 'S');
    assert_eq!(parsed.pgid, 456);
}

#[test]
fn pid_alive_detects_live_group_after_leader_is_reaped() {
    use std::os::unix::process::CommandExt;

    let pid_path = unique_pid_path("reaped-leader-live-group");
    let mut group_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "printf '%s' \"$$\" > '{}'; sleep 30 & exit 0",
            pid_path.as_str()
        ))
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = group_guard.read_pid();

    child.wait().unwrap();

    assert!(
        pid_alive(pid),
        "live process group should remain visible after leader is reaped"
    );
    kill_pid_group(pid);
    wait_for_pid_exit(pid, "test cleanup for reaped leader live group");
    group_guard.disarm();
}
