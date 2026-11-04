use super::*;
use runner_lifecycle::status::IdleSandbox;

fn read_active_run_phase(path: &std::path::Path) -> String {
    let raw = std::fs::read_to_string(path).unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    status["active_runs"][0]["phase"]
        .as_str()
        .unwrap()
        .to_string()
}

fn idle_snapshot() -> IdlePoolSnapshot {
    IdlePoolSnapshot {
        revision: 1,
        blank_sandboxes: vec![],
        idle_sandboxes: vec![IdleSandbox {
            reuse_key: "sess-removed-from-pool".into(),
            sandbox_id: SandboxId::new_v4(),
        }],
    }
}

#[tokio::test]
async fn publish_active_run_status_writes_preparing_after_reuse_miss_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    publish_active_run_status(
        &status,
        RunId::new_v4(),
        SandboxId::new_v4(),
        false,
        Some(idle_snapshot()),
    )
    .await
    .unwrap();
    assert_eq!(read_active_run_phase(&status_path), "preparing");
}

#[tokio::test]
async fn publish_active_run_status_writes_running_for_reused_idle_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    publish_active_run_status(
        &status,
        RunId::new_v4(),
        SandboxId::new_v4(),
        true,
        Some(idle_snapshot()),
    )
    .await
    .unwrap();
    assert_eq!(read_active_run_phase(&status_path), "running");
}

#[tokio::test]
async fn uncertain_cleanup_keeps_the_exact_active_record_for_orphan_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    status.write_initial().await.unwrap();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    status.add_run(run_id, sandbox_id).await.unwrap();
    let orphaned = OrphanedActiveRuns::new();

    retain_uncertain_activation_ownership(
        &status,
        &orphaned,
        run_id,
        sandbox_id,
        "uncertain_activation_test",
    );
    assert_eq!(orphaned.len(), 1);
    let raw: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&status_path).await.unwrap()).unwrap();
    assert_eq!(raw["active_runs"][0]["run_id"], run_id.to_string());
    assert_eq!(raw["active_runs"][0]["sandbox_id"], sandbox_id.to_string());

    remove_failed_activation_status(&status, run_id, SandboxId::new_v4()).await;
    let raw: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&status_path).await.unwrap()).unwrap();
    assert_eq!(raw["active_runs"].as_array().unwrap().len(), 1);
}
