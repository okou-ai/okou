//! Orphan active-run reconciliation for `runner start`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use sandbox::SandboxId;
use tracing::{info, warn};

use crate::idle_lifecycle::SharedIdlePool;
use crate::ownership::{OwnershipTransitions, RunSandbox};
use runner_host::process;
use runner_lifecycle::status::StatusTracker;
use runner_types::ids::RunId;

const ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OrphanedActiveRun {
    run_id: RunId,
    sandbox_id: SandboxId,
}

struct OrphanedActiveRunState {
    sandbox_id: SandboxId,
    absent_scans: u8,
    retained_budget: Option<crate::resource_budget::BudgetLease>,
}

/// Claimed runs whose outer task is gone but whose sandbox ownership is uncertain.
#[derive(Clone, Default)]
pub struct OrphanedActiveRuns {
    inner: Arc<Mutex<BTreeMap<RunId, OrphanedActiveRunState>>>,
}

impl OrphanedActiveRuns {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    pub(crate) fn has_retained_budget(&self, run_id: RunId, sandbox_id: SandboxId) -> bool {
        self.lock()
            .get(&run_id)
            .is_some_and(|state| state.sandbox_id == sandbox_id && state.retained_budget.is_some())
    }

    pub(crate) fn insert(&self, run_id: RunId, sandbox_id: SandboxId) {
        let mut runs = self.lock();
        if let Some(current) = runs.get_mut(&run_id)
            && current.sandbox_id == sandbox_id
        {
            current.absent_scans = 0;
            return;
        }
        if runs
            .get(&run_id)
            .is_some_and(|current| current.retained_budget.is_some())
        {
            warn!(%run_id, %sandbox_id, "retaining unresolved blank recovery capacity for its original physical owner");
            return;
        }
        let state = OrphanedActiveRunState {
            sandbox_id,
            absent_scans: 0,
            retained_budget: None,
        };
        runs.insert(run_id, state);
    }

    /// Keep failed blank activation capacity until ordinary orphan discovery
    /// proves this physical sandbox absent or owned by the idle pool.
    pub(crate) fn insert_retaining_budget(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        lease: crate::resource_budget::BudgetLease,
    ) {
        let mut runs = self.lock();
        runs.insert(
            run_id,
            OrphanedActiveRunState {
                sandbox_id,
                absent_scans: 0,
                retained_budget: Some(lease),
            },
        );
    }

    pub(crate) fn remove_if_matching(&self, run_id: RunId, sandbox_id: SandboxId) -> bool {
        let removed = {
            let mut runs = self.lock();
            if matches!(runs.get(&run_id), Some(current) if current.sandbox_id == sandbox_id) {
                runs.remove(&run_id)
            } else {
                None
            }
        };
        match removed {
            Some(mut state) => {
                drop(state.retained_budget.take());
                true
            }
            None => false,
        }
    }

    fn reset_absent_scans_if_matching(&self, run_id: RunId, sandbox_id: SandboxId) {
        let mut runs = self.lock();
        if let Some(current) = runs.get_mut(&run_id)
            && current.sandbox_id == sandbox_id
        {
            current.absent_scans = 0;
        }
    }

    fn mark_absent_if_matching(&self, run_id: RunId, sandbox_id: SandboxId) -> Option<u8> {
        let mut runs = self.lock();
        let current = runs.get_mut(&run_id)?;
        if current.sandbox_id != sandbox_id {
            return None;
        }
        current.absent_scans = current.absent_scans.saturating_add(1);
        Some(current.absent_scans)
    }

    fn snapshot(&self) -> Vec<OrphanedActiveRun> {
        self.lock()
            .iter()
            .map(|(&run_id, state)| OrphanedActiveRun {
                run_id,
                sandbox_id: state.sandbox_id,
            })
            .collect()
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<RunId, OrphanedActiveRunState>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

mod process_discovery {
    use std::sync::Arc;

    use runner_host::process;

    #[derive(Clone)]
    pub struct OrphanReapProcessDiscovery {
        pub firecrackers: Arc<Vec<process::FirecrackerProcessInfo>>,
        pub proc_scan_complete: bool,
        pub incomplete_for_current_runner: bool,
    }
}

#[cfg(not(any(test, feature = "test-support")))]
use process_discovery::OrphanReapProcessDiscovery;
#[cfg(any(test, feature = "test-support"))]
pub use process_discovery::OrphanReapProcessDiscovery;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrphanReapMode {
    /// Fast path after a job task is reaped. Only reconciles ownership that is
    /// already proven by in-memory runner state.
    Immediate,
    /// Periodic path allowed to advance `/proc` absence confirmation.
    ConfirmAbsent,
    /// Shutdown path: no future periodic tick is guaranteed, so a single
    /// conclusive absent scan is enough to clear stale active status.
    ShutdownFinal,
}

pub async fn reap_orphaned_active_runs(
    orphaned_active_runs: &OrphanedActiveRuns,
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    mode: OrphanReapMode,
) {
    reap_orphaned_active_runs_inner(orphaned_active_runs, idle_pool, status, mode, None).await;
}

/// Deterministic process-discovery seam for cross-crate recovery tests.
#[cfg(any(test, feature = "test-support"))]
pub async fn reap_orphaned_active_runs_with_discovery(
    orphaned_active_runs: &OrphanedActiveRuns,
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    mode: OrphanReapMode,
    process_discovery_override: Option<&OrphanReapProcessDiscovery>,
) {
    reap_orphaned_active_runs_inner(
        orphaned_active_runs,
        idle_pool,
        status,
        mode,
        process_discovery_override,
    )
    .await;
}

async fn reap_orphaned_active_runs_inner(
    orphaned_active_runs: &OrphanedActiveRuns,
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    mode: OrphanReapMode,
    process_discovery_override: Option<&OrphanReapProcessDiscovery>,
) {
    let records = orphaned_active_runs.snapshot();
    if records.is_empty() {
        return;
    }

    reap_orphaned_active_run_records(
        orphaned_active_runs,
        idle_pool,
        status,
        records,
        mode,
        process_discovery_override,
    )
    .await;
}

async fn reap_orphaned_active_run_records(
    orphaned_active_runs: &OrphanedActiveRuns,
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    records: Vec<OrphanedActiveRun>,
    mode: OrphanReapMode,
    process_discovery_override: Option<&OrphanReapProcessDiscovery>,
) {
    if records.is_empty() {
        return;
    }

    let pool = idle_pool.lock().await;
    let idle_snapshot = pool.status_snapshot();
    let idle_owned_records: Vec<OrphanedActiveRun> = records
        .iter()
        .copied()
        .filter(|record| pool.contains_sandbox_id(record.sandbox_id))
        .collect();
    drop(pool);
    let mut non_idle_records = Vec::new();
    let ownership = OwnershipTransitions::new(status);
    let idle_owned_runs = idle_owned_records
        .iter()
        .copied()
        .map(|record| RunSandbox::new(record.run_id, record.sandbox_id));
    let reconciled_idle_runs = ownership
        .orphan_reconciled_idle_owned(orphaned_active_runs, idle_owned_runs, idle_snapshot)
        .await;
    for run in reconciled_idle_runs {
        info!(
            run_id = %run.run_id(),
            sandbox_id = %run.sandbox_id(),
            "orphaned active run reconciled as idle-pool owned"
        );
    }
    for record in records {
        if idle_owned_records.contains(&record) {
            continue;
        } else {
            non_idle_records.push(record);
        }
    }

    if non_idle_records.is_empty() {
        return;
    }

    if mode == OrphanReapMode::Immediate {
        return;
    }

    let discovered;
    let (firecrackers, proc_scan_complete, identity_incomplete_for_current_runner) =
        if let Some(discovery) = process_discovery_override {
            (
                discovery.firecrackers.as_slice(),
                discovery.proc_scan_complete,
                discovery.incomplete_for_current_runner,
            )
        } else {
            discovered = process::discover_all_with_status().await;
            (
                discovered.processes.firecrackers.as_slice(),
                discovered.proc_scan_complete,
                firecracker_discovery_incomplete_for_current_runner(
                    &discovered.processes.firecrackers,
                )
                .await,
            )
        };
    let discovery_incomplete_for_current_runner =
        !proc_scan_complete || identity_incomplete_for_current_runner;
    reap_orphaned_active_runs_with_firecrackers(
        orphaned_active_runs,
        status,
        non_idle_records,
        firecrackers,
        discovery_incomplete_for_current_runner,
        mode.absent_scans_before_remove(),
    )
    .await;
}

impl OrphanReapMode {
    fn absent_scans_before_remove(self) -> u8 {
        match self {
            Self::Immediate => ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            Self::ConfirmAbsent => ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            Self::ShutdownFinal => 1,
        }
    }
}

async fn firecracker_discovery_incomplete_for_current_runner(
    firecrackers: &[process::FirecrackerProcessInfo],
) -> bool {
    let current_runner_pid = std::process::id();
    for firecracker in firecrackers
        .iter()
        .filter(|firecracker| firecracker.workspace_identity_incomplete())
    {
        match process::process_has_ancestor(firecracker.pid, &[current_runner_pid]).await {
            Some(false) => {}
            Some(true) | None => return true,
        }
    }
    false
}

async fn reap_orphaned_active_runs_with_firecrackers(
    orphaned_active_runs: &OrphanedActiveRuns,
    status: &StatusTracker,
    records: Vec<OrphanedActiveRun>,
    firecrackers: &[process::FirecrackerProcessInfo],
    discovery_incomplete_for_current_runner: bool,
    absent_scans_before_remove: u8,
) {
    for record in records {
        let sandbox_id = record.sandbox_id.to_string();
        if process::firecracker_process_exists_for_sandbox_id(firecrackers, &sandbox_id) {
            orphaned_active_runs.reset_absent_scans_if_matching(record.run_id, record.sandbox_id);
            warn!(
                run_id = %record.run_id,
                sandbox_id = %record.sandbox_id,
                "orphaned active run still has a live non-idle Firecracker process; keeping active status visible"
            );
            continue;
        }

        if discovery_incomplete_for_current_runner {
            warn!(
                run_id = %record.run_id,
                sandbox_id = %record.sandbox_id,
                "Firecracker discovery was incomplete; keeping orphaned active run visible"
            );
            continue;
        }

        let Some(absent_scans) =
            orphaned_active_runs.mark_absent_if_matching(record.run_id, record.sandbox_id)
        else {
            continue;
        };
        if absent_scans < absent_scans_before_remove {
            warn!(
                run_id = %record.run_id,
                sandbox_id = %record.sandbox_id,
                absent_scans,
                required_absent_scans = absent_scans_before_remove,
                "orphaned active run Firecracker absent; waiting for confirmation before removing active status"
            );
            continue;
        }

        let ownership = OwnershipTransitions::new(status);
        if !ownership
            .orphan_confirmed_absent(
                orphaned_active_runs,
                RunSandbox::new(record.run_id, record.sandbox_id),
            )
            .await
        {
            continue;
        }
        info!(
            run_id = %record.run_id,
            sandbox_id = %record.sandbox_id,
            absent_scans,
            "orphaned active run removed after Firecracker process was absent"
        );
    }
}

#[cfg(test)]
mod tests;
