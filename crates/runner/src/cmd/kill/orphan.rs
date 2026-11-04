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
    // Retain the validated kernel identity through the shared disappearance
    // confirmation, including when signal delivery reports ESRCH.
    let validation = validate_orphan_target(target).await;
    match &validation {
        OrphanTargetValidation::Valid(validated) => {
            match signal_process_group(target.pid, validated) {
                ProcessGroupSignalResult::Signaled => {
                    return match wait_for_orphan_exit(target.pid, &validated.generation).await {
                        Ok(()) => Outcome::Killed(target.clone()),
                        Err(failure) => Outcome::TerminationUnconfirmed {
                            target: target.clone(),
                            failure,
                        },
                    };
                }
                ProcessGroupSignalResult::AlreadyGone => {}
                ProcessGroupSignalResult::Failed => {
                    return Outcome::SignalFailed(target.clone());
                }
            }
        }
        OrphanTargetValidation::AlreadyGone => {}
        OrphanTargetValidation::Changed => {
            return Outcome::AlreadyExitedOrChanged(target.clone());
        }
    }

    already_gone_orphan_outcome_with_discovery(target, discover).await
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
    confirmed_disappeared_outcome_from_discovery(target, was_orphan, discovered).await
}

async fn confirmed_disappeared_outcome_from_discovery(
    target: &KillTarget,
    was_orphan: bool,
    discovered: ProcessDiscovery,
) -> Option<Outcome> {
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
        expected_pgid: i32,
        observed_pgid: i32,
        expected_starttime: u64,
        observed_starttime: u64,
    },
    Unverifiable(String),
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum OrphanExitFailure {
    TimedOut,
    IdentityChanged {
        expected_pgid: i32,
        observed_pgid: i32,
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
        ProcessStatRead::Found(stat)
            if stat.starttime == generation.starttime && stat.pgid == -1 =>
        {
            // Linux can lose group metadata during exit. Wait for another
            // observation without treating the sentinel as identity or exit proof.
            OrphanExitObservation::Unverifiable("process group metadata is unavailable".into())
        }
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

fn process_group_is_safe(pid: u32, pgid: i32) -> bool {
    if pgid <= 1 {
        tracing::warn!(
            pid,
            pgid,
            "refusing to signal unavailable or system process group"
        );
        return false;
    }
    if i32::try_from(pid).ok() != Some(pgid) {
        tracing::warn!(
            pid,
            pgid,
            "refusing to signal orphan that is not a process-group leader"
        );
        return false;
    }

    if nix::unistd::getpgrp().as_raw() == pgid {
        tracing::warn!(pid, pgid, "refusing to signal own process group");
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
mod tests;
