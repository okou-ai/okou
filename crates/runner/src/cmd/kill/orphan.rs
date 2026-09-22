use std::path::PathBuf;
use std::time::Duration;

use tracing::info;

use runner_host::process::{
    self, DiscoveredProcesses, ProcessDiscovery, ProcessStat, ProcessStatRead,
    ProcfsProcessGeneration, ProcfsProcessHandle,
};

use super::target::KillTarget;

const ORPHAN_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const ORPHAN_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[cfg(test)]
mod identity_tests;

#[derive(Debug)]
pub(super) enum Outcome {
    Killed(KillTarget),
    AlreadyExited(KillTarget),
    TerminationUnconfirmed {
        target: KillTarget,
        failure: OrphanExitFailure,
    },
    AlreadyExitedOrChanged(KillTarget),
    SignalFailed(KillTarget),
}

pub(super) async fn terminate(target: &KillTarget) -> Outcome {
    terminate_with_discovery(target, process::discover_all_with_status).await
}

async fn terminate_with_discovery<Discover, DiscoverFuture>(
    target: &KillTarget,
    discover: Discover,
) -> Outcome
where
    Discover: FnOnce() -> DiscoverFuture,
    DiscoverFuture: std::future::Future<Output = ProcessDiscovery>,
{
    let validated = match validate_orphan_target(target).await {
        OrphanTargetValidation::Valid(validated) => validated,
        OrphanTargetValidation::AlreadyGone => {
            return already_gone_orphan_outcome_with_discovery(target, discover).await;
        }
        OrphanTargetValidation::Changed => {
            return Outcome::AlreadyExitedOrChanged(target.clone());
        }
    };

    match signal_process_group(target.pid, &validated) {
        ProcessGroupSignalResult::Signaled => {
            match wait_for_orphan_exit(target.pid, &validated.generation).await {
                Ok(()) => Outcome::Killed(target.clone()),
                Err(failure) => Outcome::TerminationUnconfirmed {
                    target: target.clone(),
                    failure,
                },
            }
        }
        ProcessGroupSignalResult::AlreadyGone => {
            already_gone_orphan_outcome_with_discovery(target, discover).await
        }
        ProcessGroupSignalResult::Failed => Outcome::SignalFailed(target.clone()),
    }
}

pub(super) async fn confirmed_disappeared_outcome(
    target: &KillTarget,
    was_orphan: bool,
) -> Option<Outcome> {
    confirmed_disappeared_outcome_with_discovery(
        target,
        was_orphan,
        process::discover_all_with_status,
    )
    .await
}

pub(super) async fn confirmed_disappeared_outcome_with_discovery<Discover, DiscoverFuture>(
    target: &KillTarget,
    was_orphan: bool,
    discover: Discover,
) -> Option<Outcome>
where
    Discover: FnOnce() -> DiscoverFuture,
    DiscoverFuture: std::future::Future<Output = ProcessDiscovery>,
{
    let discovered = discover().await;
    if should_cleanup_disappeared_initial_orphan(
        target,
        was_orphan,
        discovered.proc_scan_complete,
        &discovered.processes,
    ) && initial_process_confirmed_terminated(target).await
    {
        Some(Outcome::AlreadyExited(target.clone()))
    } else {
        None
    }
}

async fn already_gone_orphan_outcome_with_discovery<Discover, DiscoverFuture>(
    target: &KillTarget,
    discover: Discover,
) -> Outcome
where
    Discover: FnOnce() -> DiscoverFuture,
    DiscoverFuture: std::future::Future<Output = ProcessDiscovery>,
{
    confirmed_disappeared_outcome_with_discovery(target, true, discover)
        .await
        .unwrap_or_else(|| Outcome::AlreadyExitedOrChanged(target.clone()))
}

fn should_cleanup_disappeared_initial_orphan(
    initial: &KillTarget,
    was_orphan: bool,
    proc_scan_complete: bool,
    discovered_after_error: &DiscoveredProcesses,
) -> bool {
    proc_scan_complete
        && was_orphan
        && target_has_workspace_identity(initial)
        && !discovered_has_same_or_unidentified_firecracker(initial, discovered_after_error)
}

fn target_has_workspace_identity(target: &KillTarget) -> bool {
    target.base_dir.is_some() && target.generation.is_some()
}

fn discovered_has_same_or_unidentified_firecracker(
    initial: &KillTarget,
    discovered: &DiscoveredProcesses,
) -> bool {
    discovered.firecrackers.iter().any(|process| {
        process.sandbox_id == initial.sandbox_id || process.workspace_identity_incomplete()
    })
}

struct ValidatedOrphanTarget {
    process: ProcfsProcessHandle,
    generation: ProcfsProcessGeneration,
}

enum OrphanTargetValidation {
    Valid(ValidatedOrphanTarget),
    AlreadyGone,
    Changed,
}

async fn validate_orphan_target(target: &KillTarget) -> OrphanTargetValidation {
    let Some(generation) = &target.generation else {
        tracing::warn!(
            pid = target.pid,
            sandbox_id = %target.sandbox_id,
            "refusing orphan kill without process identity"
        );
        return OrphanTargetValidation::Changed;
    };

    let process = match ProcfsProcessHandle::open(target.pid) {
        Ok(process) => process,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return OrphanTargetValidation::AlreadyGone;
        }
        Err(error) => {
            tracing::warn!(
                pid = target.pid,
                %error,
                "refusing orphan kill because process identity cannot be retained"
            );
            return OrphanTargetValidation::Changed;
        }
    };
    let stat = match process.read_stat().await {
        ProcessStatRead::Found(stat) => stat,
        ProcessStatRead::Missing => {
            tracing::warn!(
                pid = target.pid,
                "orphan target disappeared before validation"
            );
            return OrphanTargetValidation::AlreadyGone;
        }
        ProcessStatRead::Unreadable(error) => {
            tracing::warn!(
                pid = target.pid,
                %error,
                "refusing orphan kill because process stat is unreadable"
            );
            return OrphanTargetValidation::Changed;
        }
        ProcessStatRead::Invalid => {
            tracing::warn!(
                pid = target.pid,
                "refusing orphan kill because process stat is invalid"
            );
            return OrphanTargetValidation::Changed;
        }
    };
    if generation != &stat.procfs_generation() {
        tracing::warn!(
            pid = target.pid,
            expected_pgid = generation.pgid,
            current_pgid = stat.pgid,
            expected_starttime = generation.starttime,
            current_starttime = stat.starttime,
            "refusing orphan kill after process identity changed"
        );
        return OrphanTargetValidation::Changed;
    }
    if !process::process_stat_is_live(&stat) {
        tracing::warn!(
            pid = target.pid,
            state = %stat.state,
            "orphan target already exited and is waiting to be reaped"
        );
        return OrphanTargetValidation::AlreadyGone;
    }

    if !process_group_is_safe(target.pid, generation.pgid) {
        return OrphanTargetValidation::Changed;
    }

    let Some(cmdline) = process.read_cmdline().await else {
        tracing::warn!(
            pid = target.pid,
            "failed to read cmdline before orphan kill"
        );
        return classify_orphan_validation_after_unreadable_pid_fact(&process, generation).await;
    };
    if !process::is_firecracker_cmdline(&cmdline) {
        tracing::warn!(
            pid = target.pid,
            "refusing orphan kill for non-firecracker cmdline"
        );
        return OrphanTargetValidation::Changed;
    }

    let cwd_info = process
        .read_cwd()
        .and_then(|cwd| process::parse_workspace_cwd(&cwd));
    if !orphan_target_matches_facts(target, generation, &stat, true, cwd_info.as_ref()) {
        tracing::warn!(
            pid = target.pid,
            sandbox_id = %target.sandbox_id,
            "refusing orphan kill after workspace identity changed"
        );
        return classify_orphan_validation_after_unreadable_pid_fact(&process, generation).await;
    }

    let final_stat = match process.read_stat().await {
        ProcessStatRead::Found(stat) => stat,
        ProcessStatRead::Missing => {
            tracing::warn!(
                pid = target.pid,
                "orphan target disappeared during validation"
            );
            return OrphanTargetValidation::AlreadyGone;
        }
        ProcessStatRead::Unreadable(error) => {
            tracing::warn!(
                pid = target.pid,
                %error,
                "refusing orphan kill because process stat became unreadable"
            );
            return OrphanTargetValidation::Changed;
        }
        ProcessStatRead::Invalid => {
            tracing::warn!(
                pid = target.pid,
                "refusing orphan kill because process stat became invalid"
            );
            return OrphanTargetValidation::Changed;
        }
    };
    if generation != &final_stat.procfs_generation() {
        tracing::warn!(
            pid = target.pid,
            expected_pgid = generation.pgid,
            current_pgid = final_stat.pgid,
            expected_starttime = generation.starttime,
            current_starttime = final_stat.starttime,
            "refusing orphan kill after process identity changed during validation"
        );
        return OrphanTargetValidation::Changed;
    }
    if !process::process_stat_is_live(&final_stat) {
        tracing::warn!(
            pid = target.pid,
            state = %final_stat.state,
            "orphan target exited during validation and is waiting to be reaped"
        );
        return OrphanTargetValidation::AlreadyGone;
    }

    OrphanTargetValidation::Valid(ValidatedOrphanTarget {
        process,
        generation: *generation,
    })
}

async fn classify_orphan_validation_after_unreadable_pid_fact(
    process: &ProcfsProcessHandle,
    generation: &ProcfsProcessGeneration,
) -> OrphanTargetValidation {
    match process.read_stat().await {
        ProcessStatRead::Found(stat)
            if generation == &stat.procfs_generation() && !process::process_stat_is_live(&stat) =>
        {
            OrphanTargetValidation::AlreadyGone
        }
        ProcessStatRead::Found(stat) if generation == &stat.procfs_generation() => {
            OrphanTargetValidation::Changed
        }
        ProcessStatRead::Found(_) => OrphanTargetValidation::Changed,
        ProcessStatRead::Missing => OrphanTargetValidation::AlreadyGone,
        ProcessStatRead::Unreadable(_) | ProcessStatRead::Invalid => {
            OrphanTargetValidation::Changed
        }
    }
}

async fn initial_process_confirmed_terminated(target: &KillTarget) -> bool {
    let Some(generation) = &target.generation else {
        return false;
    };
    matches!(
        classify_orphan_exit_observation(
            generation,
            process::read_process_stat_checked(target.pid).await,
        ),
        OrphanExitObservation::Terminated
    )
}

#[derive(Debug, Eq, PartialEq)]
enum OrphanExitObservation {
    Live,
    Terminated,
    IdentityChanged {
        expected_pgid: u32,
        observed_pgid: u32,
        expected_starttime: u64,
        observed_starttime: u64,
    },
    Unverifiable(String),
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum OrphanExitFailure {
    TimedOut,
    IdentityChanged {
        expected_pgid: u32,
        observed_pgid: u32,
        expected_starttime: u64,
        observed_starttime: u64,
    },
    Unverifiable(String),
}

impl std::fmt::Display for OrphanExitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TimedOut => f.write_str("process is still live at the termination deadline"),
            Self::IdentityChanged {
                expected_pgid,
                observed_pgid,
                expected_starttime,
                observed_starttime,
            } => write!(
                f,
                "process identity changed while waiting for termination \
                 (PGID {expected_pgid} -> {observed_pgid}, starttime \
                 {expected_starttime} -> {observed_starttime})"
            ),
            Self::Unverifiable(error) => {
                write!(f, "process termination could not be verified: {error}")
            }
        }
    }
}

fn classify_orphan_exit_observation(
    generation: &ProcfsProcessGeneration,
    read: ProcessStatRead,
) -> OrphanExitObservation {
    match read {
        ProcessStatRead::Found(stat) if generation != &stat.procfs_generation() => {
            OrphanExitObservation::IdentityChanged {
                expected_pgid: generation.pgid,
                observed_pgid: stat.pgid,
                expected_starttime: generation.starttime,
                observed_starttime: stat.starttime,
            }
        }
        ProcessStatRead::Found(stat) if process::process_stat_is_live(&stat) => {
            OrphanExitObservation::Live
        }
        ProcessStatRead::Found(_) | ProcessStatRead::Missing => OrphanExitObservation::Terminated,
        ProcessStatRead::Unreadable(error) => {
            OrphanExitObservation::Unverifiable(error.to_string())
        }
        ProcessStatRead::Invalid => {
            OrphanExitObservation::Unverifiable("process stat is invalid".into())
        }
    }
}

async fn wait_for_orphan_exit(
    pid: u32,
    generation: &ProcfsProcessGeneration,
) -> Result<(), OrphanExitFailure> {
    wait_for_orphan_exit_with(
        pid,
        generation,
        ORPHAN_EXIT_TIMEOUT,
        ORPHAN_EXIT_POLL_INTERVAL,
        process::read_process_stat_checked,
    )
    .await
}

async fn wait_for_orphan_exit_with<ReadStat, ReadStatFuture>(
    pid: u32,
    generation: &ProcfsProcessGeneration,
    timeout: Duration,
    poll_interval: Duration,
    mut read_stat: ReadStat,
) -> Result<(), OrphanExitFailure>
where
    ReadStat: FnMut(u32) -> ReadStatFuture,
    ReadStatFuture: std::future::Future<Output = ProcessStatRead>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let failure = match classify_orphan_exit_observation(generation, read_stat(pid).await) {
            OrphanExitObservation::Terminated => return Ok(()),
            OrphanExitObservation::IdentityChanged {
                expected_pgid,
                observed_pgid,
                expected_starttime,
                observed_starttime,
            } => {
                return Err(OrphanExitFailure::IdentityChanged {
                    expected_pgid,
                    observed_pgid,
                    expected_starttime,
                    observed_starttime,
                });
            }
            OrphanExitObservation::Live => OrphanExitFailure::TimedOut,
            OrphanExitObservation::Unverifiable(error) => OrphanExitFailure::Unverifiable(error),
        };

        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(failure);
        }
        tokio::time::sleep(poll_interval.min(deadline - now)).await;
    }
}

fn orphan_target_matches_facts(
    target: &KillTarget,
    generation: &ProcfsProcessGeneration,
    stat: &ProcessStat,
    is_firecracker_cmdline: bool,
    cwd_info: Option<&(String, PathBuf)>,
) -> bool {
    generation == &stat.procfs_generation()
        && is_firecracker_cmdline
        && workspace_identity_matches(target, cwd_info)
}

fn workspace_identity_matches(target: &KillTarget, cwd_info: Option<&(String, PathBuf)>) -> bool {
    match (&target.base_dir, cwd_info) {
        (Some(expected_base_dir), Some((sandbox_id, base_dir))) => {
            sandbox_id == &target.sandbox_id && base_dir == expected_base_dir
        }
        _ => false,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessGroupSignalResult {
    Signaled,
    AlreadyGone,
    Failed,
}

fn process_group_is_safe(pid: u32, pgid: u32) -> bool {
    if pgid <= 1 {
        tracing::warn!(pid, pgid, "refusing to signal system process group");
        return false;
    }
    if pid != pgid {
        tracing::warn!(
            pid,
            pgid,
            "refusing to signal orphan that is not a process-group leader"
        );
        return false;
    }

    let Ok(pgid_i32) = i32::try_from(pgid) else {
        return false;
    };
    if nix::unistd::getpgrp().as_raw() == pgid_i32 {
        tracing::warn!(pid, pgid = pgid_i32, "refusing to signal own process group");
        return false;
    }
    true
}

/// The numeric facts are only for safety checks and diagnostics, never delivery.
fn signal_process_group(pid: u32, validated: &ValidatedOrphanTarget) -> ProcessGroupSignalResult {
    signal_process_group_with(pid, validated, ProcfsProcessHandle::kill_process_group)
}

fn signal_process_group_with(
    pid: u32,
    validated: &ValidatedOrphanTarget,
    send_signal: impl FnOnce(&ProcfsProcessHandle) -> nix::Result<()>,
) -> ProcessGroupSignalResult {
    let pgid = validated.generation.pgid;
    if !process_group_is_safe(pid, pgid) {
        return ProcessGroupSignalResult::Failed;
    }

    match send_signal(&validated.process) {
        Ok(()) => {
            info!(
                pid,
                pgid, "killed process group through retained process identity"
            );
            ProcessGroupSignalResult::Signaled
        }
        Err(nix::errno::Errno::ESRCH) => {
            info!(pid, pgid, "process group already exited before signal");
            ProcessGroupSignalResult::AlreadyGone
        }
        Err(e) => {
            tracing::warn!(pid, pgid, error = %e, "failed to kill process group through retained process identity; refusing numeric signal fallback");
            ProcessGroupSignalResult::Failed
        }
    }
}

#[cfg(test)]
mod tests {
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
                ProcessStatRead::Unreadable(std::io::Error::from(
                    std::io::ErrorKind::PermissionDenied,
                )),
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
        let ProcessStatRead::Found(leader_stat) =
            process::read_process_stat_checked(leader_pid).await
        else {
            panic!("spawned group leader stat should be readable");
        };
        let mut member = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("IFS= read -r _")
            .process_group(i32::try_from(leader_stat.pgid).unwrap())
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let member_pid = member.id().unwrap();
        let ProcessStatRead::Found(member_stat) =
            process::read_process_stat_checked(member_pid).await
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
        } else if leader_stat.pgid != leader_pid {
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
    fn signal_process_group_rejects_init_pgid() {
        assert!(!process_group_is_safe(1, 1));
    }

    #[test]
    fn signal_process_group_rejects_own_pgid() {
        let current_pgid = u32::try_from(nix::unistd::getpgrp().as_raw()).unwrap();

        assert!(!process_group_is_safe(current_pgid, current_pgid));
    }

    #[test]
    fn signal_process_group_rejects_out_of_range_pgid() {
        assert!(!process_group_is_safe(u32::MAX, u32::MAX));
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
}
