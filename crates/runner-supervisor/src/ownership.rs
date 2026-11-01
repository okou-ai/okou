//! Active, idle, and orphan ownership transitions for `runner start`.
//!
//! This module owns the ordering of cross-structure transitions. It delegates
//! persisted status to [`StatusTracker`], orphan record storage to
//! [`OrphanedActiveRuns`], and idle-pool mutation to callers that already hold
//! the right pool context. Slow sandbox operations stay outside this module.

use sandbox::SandboxId;
use tracing::warn;

use crate::idle_lifecycle::set_idle_status_snapshot;
use crate::orphan_reap::OrphanedActiveRuns;
use runner_lifecycle::idle_pool::IdlePoolSnapshot;
use runner_lifecycle::status::StatusTracker;
use runner_types::ids::RunId;

/// Identity proving which sandbox a run cleanup path is allowed to affect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunSandbox {
    run_id: RunId,
    sandbox_id: SandboxId,
}

impl RunSandbox {
    pub fn new(run_id: RunId, sandbox_id: SandboxId) -> Self {
        Self { run_id, sandbox_id }
    }

    pub(crate) fn run_id(self) -> RunId {
        self.run_id
    }

    pub(crate) fn sandbox_id(self) -> SandboxId {
        self.sandbox_id
    }
}

/// Narrow facade for the ownership transitions that touch multiple structures.
pub struct OwnershipTransitions<'a> {
    status: &'a StatusTracker,
}

impl<'a> OwnershipTransitions<'a> {
    pub fn new(status: &'a StatusTracker) -> Self {
        Self { status }
    }

    /// Normal provider completion has been reported; remove matching active status.
    pub async fn active_completed(&self, run: RunSandbox) -> bool {
        self.remove_matching_active(run).await
    }

    /// Active sandbox destruction completed; remove matching active status.
    pub async fn active_destroy_completed(&self, run: RunSandbox) -> bool {
        self.remove_matching_active(run).await
    }

    /// Publish the idle-pool state after a caller transferred sandbox ownership.
    ///
    /// This intentionally does not remove active status; normal completion does
    /// that after `provider.complete`.
    pub async fn publish_idle_status_after_pool_transfer(&self, idle_snapshot: IdlePoolSnapshot) {
        set_idle_status_snapshot(self.status, idle_snapshot).await;
    }

    /// Idle pool owns this sandbox; publish idle status before removing active status.
    pub async fn active_idle_pool_owned(
        &self,
        run: RunSandbox,
        idle_snapshot: IdlePoolSnapshot,
    ) -> bool {
        set_idle_status_snapshot(self.status, idle_snapshot).await;
        self.remove_matching_active(run).await
    }

    /// Ownership is uncertain after panic; keep active status visible and track as orphan.
    pub fn active_ownership_unknown(
        &self,
        orphaned_active_runs: &OrphanedActiveRuns,
        run: RunSandbox,
    ) {
        orphaned_active_runs.insert(run.run_id, run.sandbox_id);
    }

    /// Idle pool now proves ownership for these orphan records.
    ///
    /// Only runs present in `idle_snapshot` are eligible. The idle snapshot is
    /// published once, before the first matching active removal. Stale orphan
    /// records are skipped by `(run_id, sandbox_id)`.
    pub(crate) async fn orphan_reconciled_idle_owned(
        &self,
        orphaned_active_runs: &OrphanedActiveRuns,
        runs: impl IntoIterator<Item = RunSandbox>,
        idle_snapshot: IdlePoolSnapshot,
    ) -> Vec<RunSandbox> {
        let mut reconciled = Vec::new();
        let mut refreshed_idle_status = false;
        for run in runs {
            if !idle_snapshot_contains_sandbox_id(&idle_snapshot, run.sandbox_id) {
                continue;
            }
            if !orphaned_active_runs.remove_if_matching(run.run_id, run.sandbox_id) {
                continue;
            }
            if !refreshed_idle_status {
                set_idle_status_snapshot(self.status, idle_snapshot.clone()).await;
                refreshed_idle_status = true;
            }
            self.remove_matching_active(run).await;
            reconciled.push(run);
        }
        reconciled
    }

    /// Process discovery confirmed the orphan sandbox absent; clear orphan state.
    ///
    /// Returns whether matching active status was also removed. A stale orphan
    /// can still be cleared when active status is already gone or points at a
    /// different sandbox.
    pub(crate) async fn orphan_confirmed_absent(
        &self,
        orphaned_active_runs: &OrphanedActiveRuns,
        run: RunSandbox,
    ) -> bool {
        if !orphaned_active_runs.remove_if_matching(run.run_id, run.sandbox_id) {
            return false;
        }
        self.remove_matching_active(run).await
    }

    async fn remove_matching_active(&self, run: RunSandbox) -> bool {
        match self
            .status
            .remove_run_if_matching(run.run_id, run.sandbox_id)
            .await
        {
            Ok(removed) => removed,
            Err(error) => {
                warn!(
                    run_id = %run.run_id,
                    sandbox_id = %run.sandbox_id,
                    %error,
                    "failed to persist active run removal after ownership recovery"
                );
                false
            }
        }
    }
}

fn idle_snapshot_contains_sandbox_id(
    idle_snapshot: &IdlePoolSnapshot,
    sandbox_id: SandboxId,
) -> bool {
    idle_snapshot
        .idle_sandboxes
        .iter()
        .any(|idle_sandbox| idle_sandbox.sandbox_id == sandbox_id)
        || idle_snapshot
            .blank_sandboxes
            .iter()
            .any(|blank| blank.sandbox_id == sandbox_id)
}

#[cfg(test)]
mod tests;
