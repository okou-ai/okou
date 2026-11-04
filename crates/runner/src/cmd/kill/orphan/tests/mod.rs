use std::collections::VecDeque;
use std::path::PathBuf;

use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::test_support::{discovered_with_firecrackers, make_fc, make_target};
use super::*;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use runner_host::process::{FirecrackerProcessInfo, ProcessDiscovery};

const ORPHAN_KILL_CHILD_ENV: &str = "OKOU_RUNNER_ORPHAN_KILL_TEST_CHILD";
const ORPHAN_KILL_READY_LINE: &str = "vm0 orphan kill test ready";

fn process_stat(generation: &ProcfsProcessGeneration) -> ProcessStat {
    process_stat_with_state(generation, 'S')
}

fn process_stat_with_state(generation: &ProcfsProcessGeneration, state: char) -> ProcessStat {
    ProcessStat {
        state,
        ppid: 7,
        pgid: generation.pgid,
        starttime: generation.starttime,
    }
}

async fn write_procfs_stat(
    proc_root: &std::path::Path,
    pid: u32,
    state: char,
    pgid: i32,
    starttime: u64,
) {
    let state = state.to_string();
    let pgid = pgid.to_string();
    let starttime = starttime.to_string();
    let mut fields = ["0"; 20];
    fields[0] = &state;
    fields[1] = "7";
    fields[2] = &pgid;
    fields[19] = &starttime;
    let pid_dir = proc_root.join(pid.to_string());
    tokio::fs::create_dir_all(&pid_dir).await.unwrap();
    tokio::fs::write(
        pid_dir.join("stat"),
        format!("{pid} (firecracker) {}\n", fields.join(" ")),
    )
    .await
    .unwrap();
}

fn process_discovery(
    firecrackers: Vec<FirecrackerProcessInfo>,
    proc_scan_complete: bool,
) -> ProcessDiscovery {
    ProcessDiscovery {
        processes: discovered_with_firecrackers(firecrackers),
        proc_scan_complete,
    }
}

fn missing_orphan_target() -> KillTarget {
    // Linux /proc PID entries cannot reach u32::MAX, so this target is deterministically absent.
    KillTarget {
        pid: u32::MAX,
        ppid: None,
        run_id: None,
        sandbox_id: "sbox-missing".into(),
        base_dir: Some(PathBuf::from("/data/r1")),
        generation: Some(ProcfsProcessGeneration {
            pgid: 1234,
            starttime: 123456,
        }),
    }
}

#[test]
fn disappeared_initial_orphan_with_identity_allows_cleanup() {
    let initial = make_target(200, "sbox-123");
    let discovered = discovered_with_firecrackers(vec![]);

    assert!(should_cleanup_disappeared_initial_orphan(
        &initial,
        true,
        true,
        &discovered
    ));
}

#[test]
fn incomplete_process_scan_rejects_disappeared_orphan_cleanup() {
    let initial = make_target(200, "sbox-123");
    let discovered = discovered_with_firecrackers(vec![]);

    assert!(!should_cleanup_disappeared_initial_orphan(
        &initial,
        true,
        false,
        &discovered
    ));
}

#[test]
fn disappeared_initial_managed_target_rejects_cleanup() {
    let initial = make_target(200, "sbox-123");
    let discovered = discovered_with_firecrackers(vec![]);

    assert!(!should_cleanup_disappeared_initial_orphan(
        &initial,
        false,
        true,
        &discovered
    ));
}

#[test]
fn disappeared_initial_without_workspace_identity_rejects_cleanup() {
    let mut initial = make_target(200, "sbox-123");
    initial.base_dir = None;
    let discovered = discovered_with_firecrackers(vec![]);

    assert!(!should_cleanup_disappeared_initial_orphan(
        &initial,
        true,
        true,
        &discovered
    ));
}

#[test]
fn disappeared_initial_with_same_sandbox_still_running_rejects_cleanup() {
    let initial = make_target(200, "sbox-123");
    let discovered = discovered_with_firecrackers(vec![make_fc(201, "sbox-123")]);

    assert!(!should_cleanup_disappeared_initial_orphan(
        &initial,
        true,
        true,
        &discovered
    ));
}

#[test]
fn disappeared_initial_with_unidentified_firecracker_rejects_cleanup() {
    let initial = make_target(200, "sbox-123");
    let discovered = discovered_with_firecrackers(vec![FirecrackerProcessInfo {
        pid: 201,
        ppid: None,
        sandbox_id: "pid-201".into(),
        base_dir: None,
        generation: None,
    }]);

    assert!(!should_cleanup_disappeared_initial_orphan(
        &initial,
        true,
        true,
        &discovered
    ));
}

#[test]
fn orphan_target_facts_match() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let stat = process_stat(generation);
    let cwd_info = ("sbox-123".to_string(), PathBuf::from("/data/r1"));

    assert!(orphan_target_matches_facts(
        &target,
        generation,
        &stat,
        true,
        Some(&cwd_info)
    ));
}

#[test]
fn orphan_target_rejects_changed_starttime() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let stat = ProcessStat {
        state: 'S',
        ppid: 7,
        pgid: generation.pgid,
        starttime: generation.starttime + 1,
    };
    let cwd_info = ("sbox-123".to_string(), PathBuf::from("/data/r1"));

    assert!(!orphan_target_matches_facts(
        &target,
        generation,
        &stat,
        true,
        Some(&cwd_info)
    ));
}

#[test]
fn orphan_target_rejects_changed_pgid() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let stat = ProcessStat {
        state: 'S',
        ppid: 7,
        pgid: generation.pgid + 1,
        starttime: generation.starttime,
    };
    let cwd_info = ("sbox-123".to_string(), PathBuf::from("/data/r1"));

    assert!(!orphan_target_matches_facts(
        &target,
        generation,
        &stat,
        true,
        Some(&cwd_info)
    ));
}

#[test]
fn target_generation_matches_process_stat_generation() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let matching = process_stat(generation);
    let changed_starttime = ProcessStat {
        state: 'S',
        ppid: 7,
        pgid: generation.pgid,
        starttime: generation.starttime + 1,
    };
    let changed_pgid = ProcessStat {
        state: 'S',
        ppid: 7,
        pgid: generation.pgid + 1,
        starttime: generation.starttime,
    };
    let changed_ppid = ProcessStat {
        state: 'S',
        ppid: 9,
        pgid: generation.pgid,
        starttime: generation.starttime,
    };

    assert_eq!(*generation, matching.procfs_generation());
    assert_eq!(*generation, changed_ppid.procfs_generation());
    assert_ne!(*generation, changed_starttime.procfs_generation());
    assert_ne!(*generation, changed_pgid.procfs_generation());
}

#[test]
fn orphan_target_rejects_non_firecracker_cmdline() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let stat = process_stat(generation);
    let cwd_info = ("sbox-123".to_string(), PathBuf::from("/data/r1"));

    assert!(!orphan_target_matches_facts(
        &target,
        generation,
        &stat,
        false,
        Some(&cwd_info)
    ));
}

#[test]
fn orphan_target_rejects_changed_workspace() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let stat = process_stat(generation);
    let cwd_info = ("sbox-other".to_string(), PathBuf::from("/data/r1"));

    assert!(!orphan_target_matches_facts(
        &target,
        generation,
        &stat,
        true,
        Some(&cwd_info)
    ));
}

#[test]
fn orphan_target_rejects_missing_workspace_identity() {
    let mut target = make_target(200, "sbox-123");
    target.base_dir = None;
    let generation = target.generation.as_ref().unwrap();
    let stat = process_stat(generation);

    assert!(!orphan_target_matches_facts(
        &target, generation, &stat, true, None
    ));
}

#[test]
fn zombie_process_stat_is_already_exited() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let zombie = ProcessStat {
        state: 'Z',
        ppid: 7,
        pgid: generation.pgid,
        starttime: generation.starttime,
    };

    assert_eq!(*generation, zombie.procfs_generation());
    assert!(!process::process_stat_is_live(&zombie));
}

#[test]
fn dead_process_stat_is_already_exited() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let dead = ProcessStat {
        state: 'X',
        ppid: 7,
        pgid: generation.pgid,
        starttime: generation.starttime,
    };

    assert_eq!(*generation, dead.procfs_generation());
    assert!(!process::process_stat_is_live(&dead));
}

#[test]
fn orphan_exit_observation_distinguishes_live_and_terminal_states() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();

    assert_eq!(
        classify_orphan_exit_observation(
            generation,
            ProcessStatRead::Found(process_stat(generation)),
        ),
        OrphanExitObservation::Live
    );
    for state in ['Z', 'X', 'x'] {
        assert_eq!(
            classify_orphan_exit_observation(
                generation,
                ProcessStatRead::Found(process_stat_with_state(generation, state)),
            ),
            OrphanExitObservation::Terminated
        );
    }
    assert_eq!(
        classify_orphan_exit_observation(generation, ProcessStatRead::Missing),
        OrphanExitObservation::Terminated
    );
}

#[test]
fn orphan_exit_observation_rejects_identity_changes() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let changed = ProcessStat {
        pgid: generation.pgid + 1,
        starttime: generation.starttime + 1,
        ..process_stat(generation)
    };

    assert_eq!(
        classify_orphan_exit_observation(generation, ProcessStatRead::Found(changed)),
        OrphanExitObservation::IdentityChanged {
            expected_pgid: generation.pgid,
            observed_pgid: generation.pgid + 1,
            expected_starttime: generation.starttime,
            observed_starttime: generation.starttime + 1,
        }
    );
}

#[test]
fn orphan_exit_observation_rejects_unverifiable_reads() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();

    assert!(matches!(
        classify_orphan_exit_observation(
            generation,
            ProcessStatRead::Unreadable(
                std::io::Error::from(std::io::ErrorKind::PermissionDenied,)
            ),
        ),
        OrphanExitObservation::Unverifiable(_)
    ));
    assert_eq!(
        classify_orphan_exit_observation(generation, ProcessStatRead::Invalid),
        OrphanExitObservation::Unverifiable("process stat is invalid".into())
    );
}

#[tokio::test]
async fn orphan_exit_wait_observes_delayed_termination() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let mut reads = VecDeque::from([
        ProcessStatRead::Found(process_stat(generation)),
        ProcessStatRead::Found(process_stat_with_state(generation, 'Z')),
    ]);

    let result = wait_for_orphan_exit_with(
        target.pid,
        generation,
        Duration::from_secs(1),
        Duration::ZERO,
        move |_| std::future::ready(reads.pop_front().unwrap()),
    )
    .await;

    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn orphan_exit_wait_times_out_while_identity_is_live() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();

    let result = wait_for_orphan_exit_with(
        target.pid,
        generation,
        Duration::ZERO,
        Duration::ZERO,
        |_| std::future::ready(ProcessStatRead::Found(process_stat(generation))),
    )
    .await;

    assert_eq!(result, Err(OrphanExitFailure::TimedOut));
}

#[tokio::test]
async fn orphan_exit_wait_fails_when_identity_changes() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let changed = ProcessStat {
        pgid: generation.pgid + 1,
        starttime: generation.starttime + 1,
        ..process_stat(generation)
    };

    let result = wait_for_orphan_exit_with(
        target.pid,
        generation,
        Duration::from_secs(1),
        Duration::ZERO,
        |_| std::future::ready(ProcessStatRead::Found(changed.clone())),
    )
    .await;

    let Err(failure) = result else {
        panic!("changed process identity should fail the exit wait");
    };
    assert_eq!(
        failure,
        OrphanExitFailure::IdentityChanged {
            expected_pgid: generation.pgid,
            observed_pgid: generation.pgid + 1,
            expected_starttime: generation.starttime,
            observed_starttime: generation.starttime + 1,
        }
    );
    assert_eq!(
        failure.to_string(),
        "process identity changed while waiting for termination \
         (PGID 1200 -> 1201, starttime 123456 -> 123457)"
    );
}

#[tokio::test]
async fn orphan_exit_wait_recovers_from_transient_unverifiable_read() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    let mut reads = VecDeque::from([ProcessStatRead::Invalid, ProcessStatRead::Missing]);

    let result = wait_for_orphan_exit_with(
        target.pid,
        generation,
        Duration::from_secs(1),
        Duration::ZERO,
        move |_| std::future::ready(reads.pop_front().unwrap()),
    )
    .await;

    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn orphan_exit_wait_recovers_after_unavailable_pgid() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    for state in ['R', 'Z', 'X', 'x'] {
        let dir = tempfile::tempdir().unwrap();
        let proc_root = dir.path();
        let stat_path = proc_root.join(target.pid.to_string()).join("stat");
        let mut observations =
            VecDeque::from([Some(('S', generation.pgid)), Some((state, -1)), None]);

        let result = wait_for_orphan_exit_with(
            target.pid,
            generation,
            Duration::from_secs(1),
            Duration::ZERO,
            |pid| {
                let observation = observations.pop_front().unwrap();
                async move {
                    match observation {
                        Some((state, pgid)) => {
                            write_procfs_stat(proc_root, pid, state, pgid, generation.starttime)
                                .await;
                        }
                        None => {
                            tokio::fs::remove_file(proc_root.join(pid.to_string()).join("stat"))
                                .await
                                .unwrap();
                        }
                    }
                    process::read_process_stat_checked_from(proc_root, pid).await
                }
            },
        )
        .await;

        assert_eq!(result, Ok(()), "unavailable PGID in state {state}");
        assert!(
            !stat_path.exists(),
            "exit proof must wait for disappearance"
        );
    }
}

#[tokio::test]
async fn orphan_exit_wait_keeps_unavailable_pgid_unconfirmed_at_deadline() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    for state in ['R', 'Z', 'X', 'x'] {
        let dir = tempfile::tempdir().unwrap();
        let proc_root = dir.path();
        write_procfs_stat(proc_root, target.pid, state, -1, generation.starttime).await;

        let result = wait_for_orphan_exit_with(
            target.pid,
            generation,
            Duration::ZERO,
            Duration::ZERO,
            |pid| process::read_process_stat_checked_from(proc_root, pid),
        )
        .await;

        assert!(matches!(result, Err(OrphanExitFailure::Unverifiable(_))));
        assert!(
            proc_root
                .join(target.pid.to_string())
                .join("stat")
                .is_file()
        );
    }
}

#[tokio::test]
async fn orphan_exit_wait_rejects_changed_identity_before_terminal_state() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();
    for (pgid, starttime) in [
        (generation.pgid + 1, generation.starttime),
        (generation.pgid, generation.starttime + 1),
        (-1, generation.starttime + 1),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let proc_root = dir.path();
        write_procfs_stat(proc_root, target.pid, 'X', pgid, starttime).await;

        let result = wait_for_orphan_exit_with(
            target.pid,
            generation,
            Duration::ZERO,
            Duration::ZERO,
            |pid| process::read_process_stat_checked_from(proc_root, pid),
        )
        .await;

        assert_eq!(
            result,
            Err(OrphanExitFailure::IdentityChanged {
                expected_pgid: generation.pgid,
                observed_pgid: pgid,
                expected_starttime: generation.starttime,
                observed_starttime: starttime,
            }),
        );
    }
}

#[tokio::test]
async fn orphan_exit_wait_fails_when_observation_remains_unverifiable() {
    let target = make_target(200, "sbox-123");
    let generation = target.generation.as_ref().unwrap();

    let result = wait_for_orphan_exit_with(
        target.pid,
        generation,
        Duration::ZERO,
        Duration::ZERO,
        |_| std::future::ready(ProcessStatRead::Invalid),
    )
    .await;

    let Err(failure) = result else {
        panic!("unverifiable process state should fail at the exit deadline");
    };
    assert_eq!(
        failure,
        OrphanExitFailure::Unverifiable("process stat is invalid".into())
    );
    assert_eq!(
        failure.to_string(),
        "process termination could not be verified: process stat is invalid"
    );
}

#[tokio::test]
async fn orphan_kill_validates_signals_and_waits_for_real_exit() {
    run_ignored_child_test(
        "cmd::kill::orphan::tests::orphan_kill_validates_signals_and_waits_for_real_exit_child",
        (ORPHAN_KILL_CHILD_ENV, "1"),
        &[],
        Duration::from_secs(30),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by orphan_kill_validates_signals_and_waits_for_real_exit"]
async fn orphan_kill_validates_signals_and_waits_for_real_exit_child() {
    if !ignored_child_test_env_guard_enabled((ORPHAN_KILL_CHILD_ENV, "1")) {
        return;
    }

    let base_dir = tempfile::tempdir().unwrap();
    let sandbox_id = "test-sandbox";
    let workspace = base_dir.path().join("workspaces").join(sandbox_id);
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    let firecracker = base_dir.path().join("firecracker");
    std::os::unix::fs::symlink("/bin/sh", &firecracker).unwrap();

    let mut leader = tokio::process::Command::new(&firecracker)
        .arg("-c")
        .arg("printf '%s\\n' \"$1\"; IFS= read -r _")
        .arg("vm0-orphan-kill-test")
        .arg(ORPHAN_KILL_READY_LINE)
        .current_dir(&workspace)
        .process_group(0)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let stdout = leader.stdout.take().unwrap();
    let mut stdout_lines = BufReader::new(stdout).lines();
    let ready_line = tokio::time::timeout(Duration::from_secs(5), stdout_lines.next_line())
        .await
        .expect("fake firecracker readiness timed out")
        .expect("read fake firecracker readiness")
        .expect("fake firecracker exited before readiness");
    assert_eq!(ready_line, ORPHAN_KILL_READY_LINE);

    let leader_pid = leader.id().unwrap();
    let ProcessStatRead::Found(leader_stat) = process::read_process_stat_checked(leader_pid).await
    else {
        panic!("spawned group leader stat should be readable");
    };
    let mut member = tokio::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("IFS= read -r _")
        .process_group(leader_stat.pgid)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let member_pid = member.id().unwrap();
    let ProcessStatRead::Found(member_stat) = process::read_process_stat_checked(member_pid).await
    else {
        panic!("spawned group member stat should be readable");
    };
    let leader_generation = ProcfsProcessGeneration {
        pgid: leader_stat.pgid,
        starttime: leader_stat.starttime,
    };
    let member_generation = ProcfsProcessGeneration {
        pgid: member_stat.pgid,
        starttime: member_stat.starttime,
    };
    let target = KillTarget {
        pid: leader_pid,
        ppid: None,
        run_id: None,
        sandbox_id: sandbox_id.into(),
        base_dir: Some(base_dir.path().to_path_buf()),
        generation: Some(leader_generation),
    };

    let fixture_error = if leader_pid == member_pid {
        Some(format!(
            "group leader and member unexpectedly share PID {leader_pid}"
        ))
    } else if Some(leader_stat.pgid) != i32::try_from(leader_pid).ok() {
        Some(format!(
            "group leader PID {leader_pid} does not match its PGID {}",
            leader_stat.pgid
        ))
    } else if leader_stat.pgid != member_stat.pgid {
        Some(format!(
            "group member PGID {} does not match leader PGID {}",
            member_stat.pgid, leader_stat.pgid
        ))
    } else if !process::process_stat_is_live(&leader_stat) {
        Some(format!(
            "group leader {leader_pid} was not live before termination"
        ))
    } else if !process::process_stat_is_live(&member_stat) {
        Some(format!(
            "group member {member_pid} was not live before termination"
        ))
    } else {
        None
    };
    let observations = if fixture_error.is_none() {
        let outcome = terminate(&target).await;
        let (leader_exit, member_exit) = tokio::join!(
            wait_for_orphan_exit(leader_pid, &leader_generation),
            wait_for_orphan_exit(member_pid, &member_generation),
        );
        Some((outcome, leader_exit, member_exit))
    } else {
        None
    };

    let _ = leader.start_kill();
    let _ = member.start_kill();
    let (leader_status, member_status) = tokio::join!(leader.wait(), member.wait());

    if let Some(error) = fixture_error {
        panic!("invalid process-group fixture: {error}");
    }
    let (outcome, leader_exit, member_exit) = observations.unwrap();
    assert!(
        matches!(&outcome, Outcome::Killed(killed) if killed == &target),
        "unexpected orphan kill outcome: {outcome:?}"
    );
    assert_eq!(leader_exit, Ok(()), "group leader remained live");
    assert_eq!(member_exit, Ok(()), "group member remained live");
    assert!(!leader_status.unwrap().success());
    assert!(!member_status.unwrap().success());
}

#[test]
fn signal_process_group_rejects_zero_pgid() {
    assert!(!process_group_is_safe(0, 0));
}

#[test]
fn signal_process_group_rejects_unavailable_pgid() {
    assert!(!process_group_is_safe(std::process::id(), -1));
    assert!(!process_group_is_safe(u32::MAX, -1));
}

#[test]
fn signal_process_group_rejects_init_pgid() {
    assert!(!process_group_is_safe(1, 1));
}

#[test]
fn signal_process_group_rejects_own_pgid() {
    let current_pgid = nix::unistd::getpgrp().as_raw();

    assert!(!process_group_is_safe(
        u32::try_from(current_pgid).unwrap(),
        current_pgid,
    ));
}

#[test]
fn signal_process_group_rejects_out_of_range_pid() {
    assert!(!process_group_is_safe(u32::MAX, i32::MAX));
}

#[tokio::test]
async fn orphan_kill_nonexistent_pid_reports_gone_with_complete_discovery() {
    let target = missing_orphan_target();

    let outcome = terminate_with_discovery(&target, || {
        std::future::ready(process_discovery(vec![], true))
    })
    .await;

    assert!(
        matches!(
            &outcome,
            Outcome::AlreadyExited(exited) if exited == &target
        ),
        "unexpected orphan kill outcome: {outcome:?}"
    );
}

#[tokio::test]
async fn orphan_kill_nonexistent_pid_refuses_incomplete_discovery() {
    let target = missing_orphan_target();

    let outcome = terminate_with_discovery(&target, || {
        std::future::ready(process_discovery(vec![], false))
    })
    .await;

    assert!(
        matches!(
            &outcome,
            Outcome::AlreadyExitedOrChanged(refused) if refused == &target
        ),
        "unexpected orphan kill outcome: {outcome:?}"
    );
}
