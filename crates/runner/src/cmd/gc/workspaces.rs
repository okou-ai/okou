use std::collections::HashSet;
use std::ffi::OsString;
use std::future::Future;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::SystemTime;

use nix::fcntl::Flock;
use tracing::{info, warn};

use crate::byte_size::human_bytes;
use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, base_dir_lock_name};

use super::GC_MIN_AGE;
use super::filesystem::{GcDirStatus, dir_stats, gc_path_dir_status};
use super::lock_file::{ExistingLockProbe, probe_existing_lock, remove_unused_lock_after_probe};
use super::report::GcReport;

type RemoveDirAllFuture<'a> = Pin<Box<dyn Future<Output = std::io::Result<()>> + 'a>>;
type RemoveDirAllFn = for<'a> fn(&'a Path) -> RemoveDirAllFuture<'a>;

fn real_remove_dir_all(path: &Path) -> RemoveDirAllFuture<'_> {
    Box::pin(tokio::fs::remove_dir_all(path))
}

#[derive(Default)]
pub(super) struct WorkspaceGcSummary {
    workspaces_cleaned: u32,
    bytes_freed: u64,
    base_dir_locks_removed: u64,
}

impl From<WorkspaceGcSummary> for GcReport {
    fn from(summary: WorkspaceGcSummary) -> Self {
        Self::cleanup(
            u64::from(summary.workspaces_cleaned) + summary.base_dir_locks_removed,
            summary.bytes_freed,
        )
    }
}

struct DeadRunnerBaseDirLease {
    base_dir: Option<PathBuf>,
    lock_path: PathBuf,
    lock_name: String,
    lock_guard: Flock<std::fs::File>,
}

struct DeadRunnerBaseDirLockCandidate {
    lock_path: PathBuf,
    lock_name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BaseDirLockDecision {
    RemoveIfStillFree,
    Preserve,
}

pub(super) fn is_base_dir_lock_name(name: &str) -> bool {
    name.starts_with("base-dir-") && name.ends_with(".lock")
}

fn parse_base_dir_lock_content(
    content: &[u8],
    lock_path: &Path,
    lock_name: &str,
) -> Option<PathBuf> {
    if content.is_empty() {
        return None;
    }
    let base_dir = PathBuf::from(OsString::from_vec(content.to_vec()));
    if !base_dir.is_absolute() {
        warn!(
            "workspace gc: {} contains non-absolute base_dir {}, treating lock as unusable",
            lock_path.display(),
            base_dir.display()
        );
        return None;
    }
    let expected_lock_name = base_dir_lock_name(&base_dir);
    if lock_name != expected_lock_name {
        warn!(
            "workspace gc: {} contains base_dir {}, but lock name should be {}; treating lock as unusable",
            lock_path.display(),
            base_dir.display(),
            expected_lock_name
        );
        return None;
    }
    Some(base_dir)
}

/// Find base-dir lock paths that are free before ownership discovery.
fn discover_initially_free_base_dir_lock_candidates(
    locks_dir: &Path,
) -> Vec<DeadRunnerBaseDirLockCandidate> {
    let entries = match std::fs::read_dir(locks_dir) {
        Ok(rd) => rd,
        Err(e) => {
            warn!("workspace gc: cannot read {}: {e}", locks_dir.display());
            return Vec::new();
        }
    };

    let mut candidates = Vec::new();
    for result in entries {
        let entry = match result {
            Ok(entry) => entry,
            Err(e) => {
                warn!("workspace gc: read entry in {}: {e}", locks_dir.display());
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_base_dir_lock_name(name) {
            continue;
        }
        let candidate = DeadRunnerBaseDirLockCandidate {
            lock_path: entry.path(),
            lock_name: name.to_string(),
        };
        match probe_existing_lock(&candidate.lock_path) {
            ExistingLockProbe::Free(lock_guard) => {
                drop(lock_guard);
                candidates.push(candidate);
            }
            ExistingLockProbe::Held | ExistingLockProbe::Missing => {}
            ExistingLockProbe::Error(e) => {
                warn!(
                    "workspace gc: cannot probe base-dir lock {} during candidate discovery: {e}",
                    candidate.lock_path.display()
                );
            }
        }
    }
    candidates
}

/// Acquire a base-dir lock candidate whose runner is dead, while keeping the
/// lock held for the caller.
///
/// Some old or corrupted lock files do not contain a usable absolute base_dir.
/// They are still returned as leases so workspace GC can safely remove the
/// free lock file instead of leaving retry metadata behind forever.
///
/// Live runners manage their own workspaces via the factory — GC must not
/// touch them because CowPool pre-warmed slots would be indistinguishable
/// from orphaned workspaces.
fn acquire_dead_runner_base_dir_lease(
    candidate: DeadRunnerBaseDirLockCandidate,
) -> Option<DeadRunnerBaseDirLease> {
    // Only include locks from dead runners (lock not held). Hold the lock while
    // reading the file to prevent a new runner from starting and overwriting the
    // content between the probe and the read, and keep it held while workspace
    // GC deletes under the base_dir or removes an unusable free lock file.
    let lock_guard = match probe_existing_lock(&candidate.lock_path) {
        ExistingLockProbe::Free(lock_guard) => lock_guard,
        ExistingLockProbe::Held | ExistingLockProbe::Missing => return None,
        ExistingLockProbe::Error(e) => {
            warn!(
                "workspace gc: cannot probe base-dir lock {}: {e}",
                candidate.lock_path.display()
            );
            return None;
        }
    };
    let content = match std::fs::read(&candidate.lock_path) {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "workspace gc: cannot read {}: {e}",
                candidate.lock_path.display()
            );
            return None;
        }
    };
    Some(DeadRunnerBaseDirLease {
        base_dir: parse_base_dir_lock_content(&content, &candidate.lock_path, &candidate.lock_name),
        lock_path: candidate.lock_path,
        lock_name: candidate.lock_name,
        lock_guard,
    })
}

fn active_workspace_paths(
    firecrackers: &[crate::process::FirecrackerProcessInfo],
) -> HashSet<PathBuf> {
    firecrackers
        .iter()
        .filter_map(|fc| {
            fc.base_dir
                .as_ref()
                .map(|bd| bd.join("workspaces").join(&fc.sandbox_id))
        })
        .collect()
}

async fn workspace_firecracker_discovery_uncertain(
    firecrackers: &[crate::process::FirecrackerProcessInfo],
    live_runner_pids: &[u32],
) -> bool {
    for firecracker in firecrackers
        .iter()
        .filter(|firecracker| firecracker.workspace_identity_incomplete())
    {
        match crate::process::process_has_ancestor(firecracker.pid, live_runner_pids).await {
            Some(true) => {}
            Some(false) | None => return true,
        }
    }
    false
}

/// Remove workspace directories from dead runners.
///
/// Only scans base_dirs whose runner lock is NOT held (dead runners). Live
/// runners manage their own workspaces via the factory — touching them would
/// risk deleting CowPool pre-warmed slots that are indistinguishable from
/// orphaned workspaces.
///
/// Even for dead runners, workspaces owned by still-running orphaned
/// Firecracker processes are protected via process discovery. Recently-created
/// workspaces (< [`GC_MIN_AGE`]) are also skipped as a safety margin.
pub(super) async fn gc_workspace_orphans(
    home: &HomePaths,
    dry_run: bool,
) -> RunnerResult<WorkspaceGcSummary> {
    // The initial free-lock observation, later ownership snapshots, fixed age
    // boundary, and final held lease form one safety invariant. Keep this
    // ordering: a runner holding a base-dir lock here must be excluded for the
    // entire pass, while a runner entering later can only create workspaces
    // newer than this age reference.
    let workspace_age_reference = SystemTime::now();
    let locks_dir = home.locks_dir();
    let candidates = tokio::task::spawn_blocking(move || {
        discover_initially_free_base_dir_lock_candidates(&locks_dir)
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("discover base-dir locks task failed: {e}")))?;

    if candidates.is_empty() {
        return Ok(WorkspaceGcSummary::default());
    }

    // Discover active workspaces after initial candidate selection. This
    // protects orphaned Firecrackers whose parent runner already died but
    // whose sandbox is still running.
    let discovered = crate::process::discover_all_with_status().await;
    if !discovered.proc_scan_complete {
        warn!(
            "workspace gc: process discovery scan is incomplete; skipping workspace orphan cleanup"
        );
        return Ok(WorkspaceGcSummary::default());
    }
    let discovered = discovered.processes;
    let live_runners = match crate::live_runner_instances::try_list(home).await {
        Ok(runners) => runners,
        Err(e) => {
            warn!(
                "workspace gc: cannot list live runner instances ({e}); skipping workspace orphan cleanup"
            );
            return Ok(WorkspaceGcSummary::default());
        }
    };
    let live_runner_pids: Vec<u32> = live_runners.iter().map(|runner| runner.pid).collect();
    let live_runner_base_dirs: HashSet<PathBuf> = live_runners
        .iter()
        .map(|runner| runner.base_dir.clone())
        .collect();
    if workspace_firecracker_discovery_uncertain(&discovered.firecrackers, &live_runner_pids).await
    {
        warn!(
            "workspace gc: Firecracker discovery is incomplete; skipping workspace orphan cleanup"
        );
        return Ok(WorkspaceGcSummary::default());
    }

    gc_workspace_orphans_with_candidates(
        candidates,
        &discovered.firecrackers,
        &live_runner_base_dirs,
        false,
        workspace_age_reference,
        dry_run,
    )
    .await
}

async fn gc_workspace_orphans_with_candidates(
    candidates: Vec<DeadRunnerBaseDirLockCandidate>,
    firecrackers: &[crate::process::FirecrackerProcessInfo],
    live_runner_base_dirs: &HashSet<PathBuf>,
    process_discovery_uncertain: bool,
    workspace_age_reference: SystemTime,
    dry_run: bool,
) -> RunnerResult<WorkspaceGcSummary> {
    gc_workspace_orphans_with_candidates_and_remove(
        candidates,
        firecrackers,
        live_runner_base_dirs,
        process_discovery_uncertain,
        workspace_age_reference,
        dry_run,
        real_remove_dir_all,
    )
    .await
}

async fn gc_workspace_orphans_with_candidates_and_remove(
    candidates: Vec<DeadRunnerBaseDirLockCandidate>,
    firecrackers: &[crate::process::FirecrackerProcessInfo],
    live_runner_base_dirs: &HashSet<PathBuf>,
    process_discovery_uncertain: bool,
    workspace_age_reference: SystemTime,
    dry_run: bool,
    remove_dir_all: RemoveDirAllFn,
) -> RunnerResult<WorkspaceGcSummary> {
    if process_discovery_uncertain {
        warn!("workspace gc: process discovery is incomplete; skipping workspace orphan cleanup");
        return Ok(WorkspaceGcSummary::default());
    }

    let active = active_workspace_paths(firecrackers);
    let mut summary = WorkspaceGcSummary::default();

    for candidate in candidates {
        let lease =
            tokio::task::spawn_blocking(move || acquire_dead_runner_base_dir_lease(candidate))
                .await
                .map_err(|e| {
                    RunnerError::Internal(format!("acquire base-dir lease task failed: {e}"))
                })?;
        let Some(lease) = lease else {
            continue;
        };

        let Some(base_dir) = lease.base_dir.as_deref() else {
            if remove_unused_lock_after_probe(
                &lease.lock_path,
                &lease.lock_guard,
                &lease.lock_name,
                dry_run,
            )
            .await
            {
                summary.base_dir_locks_removed += 1;
            }
            continue;
        };

        if live_runner_base_dirs.contains(base_dir) {
            warn!(
                "workspace gc: {} is listed as a live runner base directory, skipping",
                base_dir.display()
            );
            continue;
        }

        let (cleaned, freed, lock_decision) = gc_workspace_orphans_in_base_dir(
            base_dir,
            &active,
            workspace_age_reference,
            dry_run,
            remove_dir_all,
        )
        .await;
        summary.workspaces_cleaned += cleaned;
        summary.bytes_freed += freed;

        if lock_decision == BaseDirLockDecision::RemoveIfStillFree
            && remove_unused_lock_after_probe(
                &lease.lock_path,
                &lease.lock_guard,
                &lease.lock_name,
                dry_run,
            )
            .await
        {
            summary.base_dir_locks_removed += 1;
        }
    }

    Ok(summary)
}

async fn gc_workspace_orphans_in_base_dir(
    base_dir: &Path,
    active: &HashSet<PathBuf>,
    workspace_age_reference: SystemTime,
    dry_run: bool,
    remove_dir_all: RemoveDirAllFn,
) -> (u32, u64, BaseDirLockDecision) {
    match gc_path_dir_status(base_dir).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing) => return (0, 0, BaseDirLockDecision::RemoveIfStillFree),
        Ok(GcDirStatus::NotDirectory) => {
            warn!(
                "workspace gc: {} is not a real base directory, skipping",
                base_dir.display()
            );
            return (0, 0, BaseDirLockDecision::Preserve);
        }
        Err(e) => {
            warn!(
                "workspace gc: cannot stat base directory {}: {e}",
                base_dir.display()
            );
            return (0, 0, BaseDirLockDecision::Preserve);
        }
    }

    let workspaces_dir = base_dir.join("workspaces");
    match gc_path_dir_status(&workspaces_dir).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing) => return (0, 0, BaseDirLockDecision::RemoveIfStillFree),
        Ok(GcDirStatus::NotDirectory) => {
            warn!(
                "workspace gc: {} is not a real directory, skipping",
                workspaces_dir.display()
            );
            return (0, 0, BaseDirLockDecision::Preserve);
        }
        Err(e) => {
            warn!(
                "workspace gc: cannot stat {}: {e}",
                workspaces_dir.display()
            );
            return (0, 0, BaseDirLockDecision::Preserve);
        }
    }

    let mut entries = match tokio::fs::read_dir(&workspaces_dir).await {
        Ok(rd) => rd,
        Err(e) => {
            warn!(
                "workspace gc: cannot read {}: {e}",
                workspaces_dir.display()
            );
            return (0, 0, BaseDirLockDecision::Preserve);
        }
    };

    let mut cleaned: u32 = 0;
    let mut freed: u64 = 0;
    let mut preserve_lock = false;

    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                warn!(
                    "workspace gc: read entry in {}: {e}",
                    workspaces_dir.display()
                );
                preserve_lock = true;
                break;
            }
        };
        let path = entry.path();
        let meta = match gc_path_dir_status(&path).await {
            Ok(GcDirStatus::RealDir(meta)) => meta,
            Ok(GcDirStatus::Missing | GcDirStatus::NotDirectory) => continue,
            Err(e) => {
                warn!("workspace gc: cannot stat {}: {e}", path.display());
                preserve_lock = true;
                continue;
            }
        };

        // Skip if actively owned by a running process.
        if active.contains(&path) {
            preserve_lock = true;
            continue;
        }

        // Age-gate: skip recently created workspaces.
        let age = meta
            .modified()
            .ok()
            .and_then(|mtime| workspace_age_reference.duration_since(mtime).ok())
            .unwrap_or_default();
        if age < GC_MIN_AGE {
            preserve_lock = true;
            continue;
        }

        let (size, _) = dir_stats(&path).await;
        if dry_run {
            info!(
                "[dry-run] would remove orphaned workspace {} ({})",
                path.display(),
                human_bytes(size)
            );
        } else {
            match remove_dir_all(&path).await {
                Ok(()) => {}
                Err(e) => {
                    warn!("workspace gc: cannot remove {}: {e}", path.display());
                    preserve_lock = true;
                    continue;
                }
            }
        }
        cleaned += 1;
        freed += size;
    }

    let lock_decision = if preserve_lock {
        BaseDirLockDecision::Preserve
    } else {
        BaseDirLockDecision::RemoveIfStillFree
    };

    (cleaned, freed, lock_decision)
}

runner_test_group!(cmd_gc_build; #[cfg(test)]
mod tests;);
