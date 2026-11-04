use super::*;
use runner_lifecycle::status::{BlankSandbox, IdleSandbox};

async fn status_idle_reuse_keys_and_active_runs(
    status_path: &std::path::Path,
) -> (Vec<String>, Vec<(String, String)>) {
    let raw = tokio::fs::read_to_string(status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut reuse_keys: Vec<String> = status
        .get("idle_sandboxes")
        .and_then(|v| v.as_array())
        .map(|idle_sandboxes| {
            idle_sandboxes
                .iter()
                .filter_map(|sandbox| {
                    sandbox
                        .get("reuse_key")
                        .and_then(|reuse_key| reuse_key.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    reuse_keys.sort_unstable();
    let mut active_runs: Vec<(String, String)> = status["active_runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| {
            (
                run["run_id"].as_str().unwrap().to_string(),
                run["sandbox_id"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    active_runs.sort_unstable();
    (reuse_keys, active_runs)
}

fn idle_snapshot(reuse_key: &str, sandbox_id: SandboxId) -> IdlePoolSnapshot {
    IdlePoolSnapshot {
        revision: 1,
        blank_sandboxes: vec![],
        idle_sandboxes: vec![IdleSandbox {
            reuse_key: reuse_key.to_string(),
            sandbox_id,
        }],
    }
}

#[tokio::test]
async fn active_idle_pool_owned_publishes_idle_status_and_removes_active() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    let transitions = OwnershipTransitions::new(&status);
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    status.add_run(run_id, sandbox_id).await.unwrap();

    assert!(
        transitions
            .active_idle_pool_owned(
                RunSandbox::new(run_id, sandbox_id),
                idle_snapshot("sess-owned", sandbox_id),
            )
            .await
    );

    let (idle_reuse_keys, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert_eq!(idle_reuse_keys, vec!["sess-owned"]);
    assert!(active_runs.is_empty());
}

#[tokio::test]
async fn active_idle_pool_owned_preserves_reinserted_active_run() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    let transitions = OwnershipTransitions::new(&status);
    let run_id = RunId::new_v4();
    let stale_sandbox_id = SandboxId::new_v4();
    let current_sandbox_id = SandboxId::new_v4();
    status.add_run(run_id, stale_sandbox_id).await.unwrap();
    status.add_run(run_id, current_sandbox_id).await.unwrap();

    assert!(
        !transitions
            .active_idle_pool_owned(
                RunSandbox::new(run_id, stale_sandbox_id),
                idle_snapshot("sess-stale", stale_sandbox_id),
            )
            .await
    );

    let (idle_reuse_keys, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert_eq!(idle_reuse_keys, vec!["sess-stale"]);
    assert_eq!(
        active_runs,
        vec![(run_id.to_string(), current_sandbox_id.to_string())]
    );
}

#[tokio::test]
async fn active_ownership_unknown_registers_orphan_and_keeps_active_visible() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    let transitions = OwnershipTransitions::new(&status);
    let orphans = OrphanedActiveRuns::new();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    status.add_run(run_id, sandbox_id).await.unwrap();

    transitions.active_ownership_unknown(&orphans, RunSandbox::new(run_id, sandbox_id));

    let (_idle_reuse_keys, active_runs) =
        status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert_eq!(
        active_runs,
        vec![(run_id.to_string(), sandbox_id.to_string())]
    );
    assert_eq!(orphans.len(), 1);
}

#[tokio::test]
async fn orphan_idle_owned_skips_stale_orphan_record() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    let transitions = OwnershipTransitions::new(&status);
    let orphans = OrphanedActiveRuns::new();
    let run_id = RunId::new_v4();
    let stale_sandbox_id = SandboxId::new_v4();
    let current_sandbox_id = SandboxId::new_v4();
    status.add_run(run_id, stale_sandbox_id).await.unwrap();
    orphans.insert(run_id, stale_sandbox_id);
    status.add_run(run_id, current_sandbox_id).await.unwrap();
    orphans.insert(run_id, current_sandbox_id);

    let reconciled = transitions
        .orphan_reconciled_idle_owned(
            &orphans,
            [RunSandbox::new(run_id, stale_sandbox_id)],
            idle_snapshot("sess-stale", stale_sandbox_id),
        )
        .await;

    assert!(reconciled.is_empty());
    let (idle_reuse_keys, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(idle_reuse_keys.is_empty());
    assert_eq!(
        active_runs,
        vec![(run_id.to_string(), current_sandbox_id.to_string())]
    );
    assert_eq!(orphans.len(), 1);
}

#[tokio::test]
async fn orphan_absent_clears_stale_orphan_without_removing_reinserted_active_run() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    let transitions = OwnershipTransitions::new(&status);
    let orphans = OrphanedActiveRuns::new();
    let run_id = RunId::new_v4();
    let stale_sandbox_id = SandboxId::new_v4();
    let current_sandbox_id = SandboxId::new_v4();
    status.add_run(run_id, stale_sandbox_id).await.unwrap();
    orphans.insert(run_id, stale_sandbox_id);
    status.add_run(run_id, current_sandbox_id).await.unwrap();

    assert!(
        !transitions
            .orphan_confirmed_absent(&orphans, RunSandbox::new(run_id, stale_sandbox_id))
            .await
    );

    let (_idle_reuse_keys, active_runs) =
        status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert_eq!(
        active_runs,
        vec![(run_id.to_string(), current_sandbox_id.to_string())]
    );
    assert_eq!(orphans.len(), 0);
}

#[tokio::test]
async fn orphan_idle_owned_requires_exact_or_blank_snapshot_membership() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    let transitions = OwnershipTransitions::new(&status);
    let orphans = OrphanedActiveRuns::new();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let idle_sandbox_id = SandboxId::new_v4();
    status.add_run(run_id, sandbox_id).await.unwrap();
    orphans.insert(run_id, sandbox_id);

    let reconciled = transitions
        .orphan_reconciled_idle_owned(
            &orphans,
            [RunSandbox::new(run_id, sandbox_id)],
            idle_snapshot("sess-different", idle_sandbox_id),
        )
        .await;

    assert!(reconciled.is_empty());
    let (idle_reuse_keys, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(idle_reuse_keys.is_empty());
    assert_eq!(
        active_runs,
        vec![(run_id.to_string(), sandbox_id.to_string())]
    );
    assert_eq!(orphans.len(), 1);

    let reconciled = transitions
        .orphan_reconciled_idle_owned(
            &orphans,
            [RunSandbox::new(run_id, sandbox_id)],
            IdlePoolSnapshot {
                revision: 2,
                idle_sandboxes: vec![],
                blank_sandboxes: vec![BlankSandbox { sandbox_id }],
            },
        )
        .await;
    assert_eq!(reconciled, vec![RunSandbox::new(run_id, sandbox_id)]);
    assert_eq!(orphans.len(), 0);
    let persisted = tokio::fs::read_to_string(&status_path).await.unwrap();
    let persisted: serde_json::Value = serde_json::from_str(&persisted).unwrap();
    assert_eq!(persisted["active_runs"], serde_json::json!([]));
    assert!(persisted.get("idle_sandboxes").is_none());
    assert_eq!(
        persisted["blank_sandboxes"],
        serde_json::json!([{ "sandbox_id": sandbox_id.to_string() }])
    );
}
