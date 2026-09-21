//! Orphan active-run reconciliation for `runner start`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use sandbox::SandboxId;
use tracing::{info, warn};

use super::idle_lifecycle::SharedIdlePool;
use super::ownership::{OwnershipTransitions, RunSandbox};
use crate::ids::RunId;
use crate::process;
use crate::status::StatusTracker;

const ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OrphanedActiveRun {
    run_id: RunId,
    sandbox_id: SandboxId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OrphanedActiveRunState {
    sandbox_id: SandboxId,
    absent_scans: u8,
}

/// Claimed runs whose outer task is gone but whose sandbox ownership is uncertain.
#[derive(Clone)]
pub(super) struct OrphanedActiveRuns {
    inner: Arc<Mutex<BTreeMap<RunId, OrphanedActiveRunState>>>,
}

impl OrphanedActiveRuns {
    pub(super) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    pub(super) fn insert(&self, run_id: RunId, sandbox_id: SandboxId) {
        let state = OrphanedActiveRunState {
            sandbox_id,
            absent_scans: 0,
        };
        self.lock().insert(run_id, state);
    }

    pub(super) fn remove_if_matching(&self, run_id: RunId, sandbox_id: SandboxId) -> bool {
        let mut runs = self.lock();
        let removed =
            matches!(runs.get(&run_id), Some(current) if current.sandbox_id == sandbox_id);
        if removed {
            runs.remove(&run_id);
        }
        removed
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

    runner_test_support!(cmd_start; #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.lock().len()
    });

    fn lock(&self) -> MutexGuard<'_, BTreeMap<RunId, OrphanedActiveRunState>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone)]
pub(super) struct OrphanReapProcessDiscovery {
    pub(super) firecrackers: Arc<Vec<process::FirecrackerProcessInfo>>,
    pub(super) proc_scan_complete: bool,
    pub(super) incomplete_for_current_runner: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum OrphanReapMode {
    /// Fast path after a job task is reaped. Only reconciles ownership that is
    /// already proven by in-memory runner state.
    Immediate,
    /// Periodic path allowed to advance `/proc` absence confirmation.
    ConfirmAbsent,
    /// Shutdown path: no future periodic tick is guaranteed, so a single
    /// conclusive absent scan is enough to clear stale active status.
    ShutdownFinal,
}

pub(super) async fn reap_orphaned_active_runs(
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

runner_test_group!(cmd_start; #[cfg(test)]
mod tests {
    use super::*;
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkResult, test_support::ParkedIdleCandidateBuilder,
    };
    use crate::resource_budget::ResourceBudget;
    struct OrphanReapFixture {
        _dir: tempfile::TempDir,
        status_path: std::path::PathBuf,
        status: StatusTracker,
        idle_pool: SharedIdlePool,
        orphans: OrphanedActiveRuns,
    }

    impl OrphanReapFixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let status_path = dir.path().join("status.json");
            let status = StatusTracker::new(status_path.clone(), 4, None, None);
            let idle_pool: SharedIdlePool =
                Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                    max_idle: 10,
                })));
            Self {
                _dir: dir,
                status_path,
                status,
                idle_pool,
                orphans: OrphanedActiveRuns::new(),
            }
        }

        async fn add_active_orphan(&self, run_id: RunId, sandbox_id: SandboxId) {
            self.status.add_run(run_id, sandbox_id).await.unwrap();
            self.orphans.insert(run_id, sandbox_id);
        }

        async fn park_idle_candidate(
            &self,
            reuse_key: &str,
            sandbox_id: SandboxId,
            mock_name: &str,
        ) {
            let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
            let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
            let candidate = ParkedIdleCandidateBuilder::new(reuse_key, lease)
                .with_mock_sandbox_name(mock_name)
                .with_sandbox_id(sandbox_id)
                .build();
            let result = {
                let mut idle_pool = self.idle_pool.lock().await;
                idle_pool.park(candidate)
            };
            match result {
                ParkResult::Parked => {}
                ParkResult::Replaced(job) => {
                    job.run().await;
                    self.destroy_all_idle_entries().await;
                    panic!("expected synthetic idle candidate to park without replacement");
                }
                ParkResult::Rejected(rejected) => {
                    let (payload, lease) = rejected.into_active_destroy_parts();
                    let _ = payload.stop_and_destroy().await;
                    drop(lease);
                    self.destroy_all_idle_entries().await;
                    panic!("expected synthetic idle candidate to be accepted by the idle pool");
                }
            }
        }

        async fn destroy_all_idle_entries(&self) {
            let jobs = {
                let mut idle_pool = self.idle_pool.lock().await;
                idle_pool.drain()
            };
            for job in jobs {
                job.run().await;
            }
        }

        async fn reap(&self, mode: OrphanReapMode) {
            reap_orphaned_active_runs(&self.orphans, &self.idle_pool, &self.status, mode, None)
                .await;
        }

        async fn reap_with_discovery(
            &self,
            mode: OrphanReapMode,
            discovery: &OrphanReapProcessDiscovery,
        ) {
            reap_orphaned_active_runs(
                &self.orphans,
                &self.idle_pool,
                &self.status,
                mode,
                Some(discovery),
            )
            .await;
        }

        async fn reap_records(&self, records: Vec<OrphanedActiveRun>, mode: OrphanReapMode) {
            reap_orphaned_active_run_records(
                &self.orphans,
                &self.idle_pool,
                &self.status,
                records,
                mode,
                None,
            )
            .await;
        }

        async fn reap_current_orphans_with_firecrackers(
            &self,
            firecrackers: &[process::FirecrackerProcessInfo],
            discovery_incomplete_for_current_runner: bool,
            absent_scans_before_remove: u8,
        ) {
            self.reap_records_with_firecrackers(
                self.orphans.snapshot(),
                firecrackers,
                discovery_incomplete_for_current_runner,
                absent_scans_before_remove,
            )
            .await;
        }

        async fn reap_records_with_firecrackers(
            &self,
            records: Vec<OrphanedActiveRun>,
            firecrackers: &[process::FirecrackerProcessInfo],
            discovery_incomplete_for_current_runner: bool,
            absent_scans_before_remove: u8,
        ) {
            reap_orphaned_active_runs_with_firecrackers(
                &self.orphans,
                &self.status,
                records,
                firecrackers,
                discovery_incomplete_for_current_runner,
                absent_scans_before_remove,
            )
            .await;
        }

        async fn assert_status(
            &self,
            expected_idle_sandboxes: &[(&str, SandboxId)],
            expected_active_runs: &[(RunId, SandboxId)],
        ) {
            let (idle_sandboxes, active_runs) = self.status_idle_sandboxes_and_active_runs().await;
            let mut expected_idle_sandboxes = expected_idle_sandboxes
                .iter()
                .map(|(reuse_key, sandbox_id)| ((*reuse_key).to_string(), sandbox_id.to_string()))
                .collect::<Vec<_>>();
            expected_idle_sandboxes.sort_unstable();
            let mut expected_active_runs = expected_active_runs
                .iter()
                .map(|(run_id, sandbox_id)| (run_id.to_string(), sandbox_id.to_string()))
                .collect::<Vec<_>>();
            expected_active_runs.sort_unstable();

            assert_eq!(idle_sandboxes, expected_idle_sandboxes);
            assert_eq!(active_runs, expected_active_runs);
        }

        async fn assert_orphans(&self, expected: &[(RunId, SandboxId)]) {
            let remaining = self.orphans.snapshot();
            let mut remaining = remaining
                .iter()
                .map(|record| (record.run_id.to_string(), record.sandbox_id.to_string()))
                .collect::<Vec<_>>();
            remaining.sort_unstable();
            let mut expected = expected
                .iter()
                .map(|(run_id, sandbox_id)| (run_id.to_string(), sandbox_id.to_string()))
                .collect::<Vec<_>>();
            expected.sort_unstable();
            assert_eq!(remaining, expected);
        }

        async fn assert_orphan_count(&self, expected: usize) {
            assert_eq!(self.orphans.len(), expected);
            assert_eq!(self.orphans.is_empty(), expected == 0);
        }

        async fn status_idle_sandboxes_and_active_runs(
            &self,
        ) -> (Vec<(String, String)>, Vec<(String, String)>) {
            let raw = tokio::fs::read_to_string(&self.status_path).await.unwrap();
            let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let mut idle_sandboxes: Vec<(String, String)> = status
                .get("idle_sandboxes")
                .and_then(|v| v.as_array())
                .map(|idle_sandboxes| {
                    idle_sandboxes
                        .iter()
                        .map(|sandbox| {
                            let reuse_key = sandbox
                                .get("reuse_key")
                                .and_then(|reuse_key| reuse_key.as_str())
                                .expect("idle sandbox must include reuse_key");
                            let sandbox_id = sandbox
                                .get("sandbox_id")
                                .and_then(|sandbox| sandbox.as_str())
                                .expect("idle sandbox must include sandbox_id");
                            (reuse_key.to_string(), sandbox_id.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default();
            idle_sandboxes.sort_unstable();
            let mut active_runs: Vec<(String, String)> = status["active_runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|run| {
                    let run_id = run
                        .get("run_id")
                        .and_then(|run_id| run_id.as_str())
                        .expect("active run must include run_id");
                    let sandbox_id = run
                        .get("sandbox_id")
                        .and_then(|sandbox| sandbox.as_str())
                        .expect("active run must include sandbox_id");
                    (run_id.to_string(), sandbox_id.to_string())
                })
                .collect();
            active_runs.sort_unstable();
            (idle_sandboxes, active_runs)
        }
    }

    #[tokio::test]
    async fn orphan_reaper_stale_snapshot_does_not_remove_reinserted_active_run() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let stale_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, stale_sandbox_id).await;
        let stale_records = fixture.orphans.snapshot();

        fixture.add_active_orphan(run_id, current_sandbox_id).await;

        fixture
            .reap_records_with_firecrackers(
                stale_records,
                &[],
                false,
                OrphanReapMode::ShutdownFinal.absent_scans_before_remove(),
            )
            .await;

        fixture
            .assert_status(&[], &[(run_id, current_sandbox_id)])
            .await;
        fixture
            .assert_orphans(&[(run_id, current_sandbox_id)])
            .await;
    }

    #[tokio::test]
    async fn orphan_reaper_stale_idle_owned_snapshot_does_not_remove_reinserted_active_run() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let stale_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        fixture
            .park_idle_candidate(
                "sess-stale-idle-owned-reaper",
                stale_sandbox_id,
                "stale-idle-owned-reaper",
            )
            .await;
        fixture.add_active_orphan(run_id, stale_sandbox_id).await;
        let stale_records = fixture.orphans.snapshot();

        fixture.add_active_orphan(run_id, current_sandbox_id).await;

        fixture
            .reap_records(stale_records, OrphanReapMode::Immediate)
            .await;

        fixture
            .assert_status(&[], &[(run_id, current_sandbox_id)])
            .await;
        fixture
            .assert_orphans(&[(run_id, current_sandbox_id)])
            .await;

        fixture.destroy_all_idle_entries().await;
    }

    #[tokio::test]
    async fn orphan_reaper_removes_active_run_when_idle_pool_owns_sandbox() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture
            .park_idle_candidate("sess-idle-owned-reaper", sandbox_id, "idle-owned-reaper")
            .await;
        fixture.add_active_orphan(run_id, sandbox_id).await;

        fixture.reap(OrphanReapMode::Immediate).await;

        fixture
            .assert_status(&[("sess-idle-owned-reaper", sandbox_id)], &[])
            .await;
        fixture.assert_orphan_count(0).await;
        fixture.destroy_all_idle_entries().await;
    }

    #[tokio::test]
    async fn orphan_reaper_reconciles_mixed_idle_owned_and_absent_records() {
        let fixture = OrphanReapFixture::new();
        let idle_run_id = RunId::new_v4();
        let idle_sandbox_id = SandboxId::new_v4();
        let absent_run_id = RunId::new_v4();
        let absent_sandbox_id = SandboxId::new_v4();
        fixture
            .park_idle_candidate(
                "sess-mixed-idle",
                idle_sandbox_id,
                "mixed-idle-owned-reaper",
            )
            .await;
        fixture
            .add_active_orphan(idle_run_id, idle_sandbox_id)
            .await;
        fixture
            .add_active_orphan(absent_run_id, absent_sandbox_id)
            .await;
        let discovery = OrphanReapProcessDiscovery {
            firecrackers: Arc::new(Vec::new()),
            proc_scan_complete: true,
            incomplete_for_current_runner: false,
        };

        fixture
            .reap_with_discovery(OrphanReapMode::ShutdownFinal, &discovery)
            .await;

        fixture
            .assert_status(&[("sess-mixed-idle", idle_sandbox_id)], &[])
            .await;
        fixture.assert_orphan_count(0).await;
        fixture.destroy_all_idle_entries().await;
    }

    #[tokio::test]
    async fn orphan_reaper_reconciles_mixed_live_and_absent_records() {
        let fixture = OrphanReapFixture::new();
        let live_run_id = RunId::new_v4();
        let live_sandbox_id = SandboxId::new_v4();
        let absent_run_id = RunId::new_v4();
        let absent_sandbox_id = SandboxId::new_v4();
        fixture
            .add_active_orphan(live_run_id, live_sandbox_id)
            .await;
        fixture
            .add_active_orphan(absent_run_id, absent_sandbox_id)
            .await;
        let live_firecracker = process::FirecrackerProcessInfo {
            pid: 1234,
            ppid: Some(1),
            sandbox_id: live_sandbox_id.to_string(),
            base_dir: None,
            generation: None,
        };

        fixture
            .reap_current_orphans_with_firecrackers(
                &[live_firecracker],
                false,
                OrphanReapMode::ShutdownFinal.absent_scans_before_remove(),
            )
            .await;

        fixture
            .assert_status(&[], &[(live_run_id, live_sandbox_id)])
            .await;
        fixture
            .assert_orphans(&[(live_run_id, live_sandbox_id)])
            .await;
    }

    #[tokio::test]
    async fn orphan_reaper_reconciles_idle_owned_records_when_discovery_is_incomplete() {
        let fixture = OrphanReapFixture::new();
        let idle_run_id = RunId::new_v4();
        let idle_sandbox_id = SandboxId::new_v4();
        let uncertain_run_id = RunId::new_v4();
        let uncertain_sandbox_id = SandboxId::new_v4();
        fixture
            .park_idle_candidate(
                "sess-incomplete-discovery-idle",
                idle_sandbox_id,
                "incomplete-discovery-idle-owned-reaper",
            )
            .await;
        fixture
            .add_active_orphan(idle_run_id, idle_sandbox_id)
            .await;
        fixture
            .add_active_orphan(uncertain_run_id, uncertain_sandbox_id)
            .await;
        let unresolved_firecracker = process::FirecrackerProcessInfo {
            pid: 1234,
            ppid: Some(1),
            sandbox_id: "pid-1234".to_string(),
            base_dir: None,
            generation: None,
        };
        let discovery = OrphanReapProcessDiscovery {
            firecrackers: Arc::new(vec![unresolved_firecracker]),
            proc_scan_complete: true,
            incomplete_for_current_runner: true,
        };

        fixture
            .reap_with_discovery(OrphanReapMode::ShutdownFinal, &discovery)
            .await;

        fixture
            .assert_status(
                &[("sess-incomplete-discovery-idle", idle_sandbox_id)],
                &[(uncertain_run_id, uncertain_sandbox_id)],
            )
            .await;
        fixture
            .assert_orphans(&[(uncertain_run_id, uncertain_sandbox_id)])
            .await;
        fixture.destroy_all_idle_entries().await;
    }

    #[tokio::test]
    async fn orphan_reaper_immediate_mode_does_not_count_absent_scan() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;

        fixture.reap(OrphanReapMode::Immediate).await;
        fixture.reap(OrphanReapMode::ConfirmAbsent).await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;
    }

    #[tokio::test]
    async fn orphan_reaper_removes_active_run_after_two_absent_scans() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[]).await;
        fixture.assert_orphan_count(0).await;
    }

    #[tokio::test]
    async fn orphan_reaper_shutdown_final_removes_active_run_after_one_absent_scan() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                OrphanReapMode::ShutdownFinal.absent_scans_before_remove(),
            )
            .await;

        fixture.assert_status(&[], &[]).await;
        fixture.assert_orphan_count(0).await;
    }

    #[tokio::test]
    async fn orphan_reaper_incomplete_proc_scan_does_not_count_as_periodic_absence() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;
        let incomplete_discovery = OrphanReapProcessDiscovery {
            firecrackers: Arc::new(Vec::new()),
            proc_scan_complete: false,
            incomplete_for_current_runner: false,
        };
        let complete_discovery = OrphanReapProcessDiscovery {
            firecrackers: Arc::new(Vec::new()),
            proc_scan_complete: true,
            incomplete_for_current_runner: false,
        };

        fixture
            .reap_with_discovery(OrphanReapMode::ConfirmAbsent, &incomplete_discovery)
            .await;
        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphans(&[(run_id, sandbox_id)]).await;

        fixture
            .reap_with_discovery(OrphanReapMode::ConfirmAbsent, &complete_discovery)
            .await;
        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphans(&[(run_id, sandbox_id)]).await;

        fixture
            .reap_with_discovery(OrphanReapMode::ConfirmAbsent, &complete_discovery)
            .await;
        fixture.assert_status(&[], &[]).await;
        fixture.assert_orphan_count(0).await;
    }

    #[tokio::test]
    async fn orphan_reaper_shutdown_final_preserves_active_run_after_incomplete_proc_scan() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;
        let discovery = OrphanReapProcessDiscovery {
            firecrackers: Arc::new(Vec::new()),
            proc_scan_complete: false,
            incomplete_for_current_runner: false,
        };

        fixture
            .reap_with_discovery(OrphanReapMode::ShutdownFinal, &discovery)
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphans(&[(run_id, sandbox_id)]).await;
    }

    #[tokio::test]
    async fn orphan_reaper_defers_incomplete_discovery_without_resetting_absent_confirmation() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;
        let unresolved_firecracker = process::FirecrackerProcessInfo {
            pid: 1234,
            ppid: Some(1),
            sandbox_id: "pid-1234".to_string(),
            base_dir: None,
            generation: None,
        };
        fixture
            .reap_current_orphans_with_firecrackers(
                &[unresolved_firecracker],
                true,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;
        let (_idle_sandboxes, active_runs) = fixture.status_idle_sandboxes_and_active_runs().await;
        assert!(
            active_runs.is_empty(),
            "incomplete discovery should not count as absent, but should not globally reset prior conclusive absence"
        );
        fixture.assert_orphan_count(0).await;
    }

    #[tokio::test]
    async fn orphan_reaper_live_firecracker_resets_absent_confirmation() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;

        let firecracker = process::FirecrackerProcessInfo {
            pid: 1234,
            ppid: Some(1),
            sandbox_id: sandbox_id.to_string(),
            base_dir: None,
            generation: None,
        };
        fixture
            .reap_current_orphans_with_firecrackers(
                &[firecracker],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[]).await;
        fixture.assert_orphan_count(0).await;
    }

    #[tokio::test]
    async fn orphan_reaper_live_firecracker_resets_absent_confirmation_when_discovery_incomplete() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;

        let firecracker = process::FirecrackerProcessInfo {
            pid: 1234,
            ppid: Some(1),
            sandbox_id: sandbox_id.to_string(),
            base_dir: None,
            generation: None,
        };
        fixture
            .reap_current_orphans_with_firecrackers(
                &[firecracker],
                true,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;

        fixture
            .reap_current_orphans_with_firecrackers(
                &[],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[]).await;
        fixture.assert_orphan_count(0).await;
    }

    #[tokio::test]
    async fn orphan_reaper_preserves_active_run_when_firecracker_live() {
        let fixture = OrphanReapFixture::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        fixture.add_active_orphan(run_id, sandbox_id).await;
        let firecracker = process::FirecrackerProcessInfo {
            pid: 1234,
            ppid: Some(1),
            sandbox_id: sandbox_id.to_string(),
            base_dir: None,
            generation: None,
        };

        fixture
            .reap_current_orphans_with_firecrackers(
                &[firecracker],
                false,
                ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            )
            .await;

        fixture.assert_status(&[], &[(run_id, sandbox_id)]).await;
        fixture.assert_orphan_count(1).await;
    }
});
