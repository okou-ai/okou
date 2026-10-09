use super::super::super::*;
use super::wait::{WaitProbe, wait_for_probe};

#[derive(serde::Deserialize)]
struct StatusSnapshot {
    active_runs: Vec<ActiveRunSnapshot>,
    #[serde(default)]
    idle_sandboxes: Vec<IdleSandboxSnapshot>,
}

#[derive(serde::Deserialize)]
struct StatusModeSnapshot {
    mode: Option<String>,
}

enum StatusModeRead {
    FileMissing,
    ModeMissing,
    Mode(String),
}

#[derive(serde::Deserialize)]
struct ActiveRunSnapshot {
    run_id: String,
}

#[derive(serde::Deserialize)]
struct IdleSandboxSnapshot {
    reuse_key: String,
}

pub(in super::super) async fn status_idle_reuse_keys_and_active_runs(
    status_path: &std::path::Path,
) -> (Vec<String>, Vec<String>) {
    let raw = tokio::fs::read_to_string(status_path).await.unwrap();
    let status: StatusSnapshot = serde_json::from_str(&raw).unwrap();
    let mut reuse_keys: Vec<String> = status
        .idle_sandboxes
        .into_iter()
        .map(|sandbox| sandbox.reuse_key)
        .collect();
    reuse_keys.sort_unstable();
    let mut run_ids: Vec<String> = status
        .active_runs
        .into_iter()
        .map(|run| run.run_id)
        .collect();
    run_ids.sort_unstable();
    (reuse_keys, run_ids)
}

pub(in super::super) async fn status_idle_reuse_keys(status_path: &std::path::Path) -> Vec<String> {
    status_idle_reuse_keys_and_active_runs(status_path).await.0
}

async fn read_status_mode_if_exists(status_path: &std::path::Path) -> StatusModeRead {
    match tokio::fs::try_exists(status_path).await {
        Ok(true) => {
            let raw = tokio::fs::read_to_string(status_path).await.unwrap();
            let status: StatusModeSnapshot = serde_json::from_str(&raw).unwrap();
            match status.mode {
                Some(mode) => StatusModeRead::Mode(mode),
                None => StatusModeRead::ModeMissing,
            }
        }
        Ok(false) => StatusModeRead::FileMissing,
        Err(err) => panic!(
            "failed to check status file {}: {err}",
            status_path.display()
        ),
    }
}

pub(in super::super) async fn wait_status_mode(
    status_path: &std::path::Path,
    expected: &str,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        match read_status_mode_if_exists(status_path).await {
            StatusModeRead::Mode(mode) if mode == expected => WaitProbe::Ready(()),
            StatusModeRead::Mode(mode) => WaitProbe::Pending(format!(
                "status mode did not reach {expected:?} within {timeout:?} (actual: {mode:?})",
            )),
            StatusModeRead::ModeMissing => WaitProbe::Pending(format!(
                "status file {} did not contain mode within {timeout:?}",
                status_path.display(),
            )),
            StatusModeRead::FileMissing => WaitProbe::Pending(format!(
                "status file {} was not written within {timeout:?}",
                status_path.display(),
            )),
        }
    })
    .await;
}

#[tokio::test]
async fn status_parser_defaults_omitted_idle_sandboxes_to_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    tokio::fs::write(
        &path,
        r#"{"active_runs":[{"run_id":"run-b"},{"run_id":"run-a"}]}"#,
    )
    .await
    .unwrap();

    let (idle_reuse_keys, active_runs) = status_idle_reuse_keys_and_active_runs(&path).await;

    assert!(idle_reuse_keys.is_empty());
    assert_eq!(active_runs, vec!["run-a", "run-b"]);
}

#[tokio::test]
#[should_panic(expected = "missing field `active_runs`")]
async fn status_parser_requires_active_runs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    tokio::fs::write(&path, r#"{"idle_sandboxes":[]}"#)
        .await
        .unwrap();

    let _ = status_idle_reuse_keys_and_active_runs(&path).await;
}

pub(in super::super) async fn wait_status_idle_reuse_keys_and_active_runs(
    status_path: &std::path::Path,
    expected_idle_reuse_keys: &[&str],
    expected_active_runs: &[String],
    timeout: Duration,
) {
    let mut expected_idle_reuse_keys: Vec<String> = expected_idle_reuse_keys
        .iter()
        .map(|reuse_key| (*reuse_key).to_string())
        .collect();
    expected_idle_reuse_keys.sort_unstable();
    let mut expected_active_runs = expected_active_runs.to_vec();
    expected_active_runs.sort_unstable();

    wait_for_probe(timeout, || async {
        match status_idle_reuse_keys_and_active_runs_if_exists(status_path).await {
            Some((idle_reuse_keys, active_runs))
                if idle_reuse_keys == expected_idle_reuse_keys
                    && active_runs == expected_active_runs =>
            {
                WaitProbe::Ready(())
            }
            Some((idle_reuse_keys, active_runs)) => WaitProbe::Pending(format!(
                "status did not reach expected idle={expected_idle_reuse_keys:?} active={expected_active_runs:?} within {timeout:?} (actual idle={idle_reuse_keys:?} active={active_runs:?})",
            )),
            None => WaitProbe::Pending(format!(
                "status file {} was not written within {timeout:?}",
                status_path.display(),
            )),
        }
    })
    .await;
}

async fn status_idle_reuse_keys_and_active_runs_if_exists(
    status_path: &std::path::Path,
) -> Option<(Vec<String>, Vec<String>)> {
    match tokio::fs::try_exists(status_path).await {
        Ok(true) => Some(status_idle_reuse_keys_and_active_runs(status_path).await),
        Ok(false) => None,
        Err(err) => panic!(
            "failed to check status file {}: {err}",
            status_path.display()
        ),
    }
}

pub(in super::super) async fn publish_idle_status(pool: &SharedIdlePool, status: &StatusTracker) {
    let snapshot = pool.lock().await.status_snapshot();
    assert!(status.set_idle_snapshot(snapshot.clone()).await.unwrap());
}

pub(in super::super) async fn wait_status_idle_empty_with_active_run(
    status_path: &std::path::Path,
    run_id: RunId,
    timeout: Duration,
) {
    let expected = run_id.to_string();
    wait_for_probe(timeout, || async {
        let (idle_reuse_keys, active_runs) =
            status_idle_reuse_keys_and_active_runs(status_path).await;
        if idle_reuse_keys.is_empty() && active_runs.iter().any(|id| id == &expected) {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "status did not atomically clear idle_sandboxes and add active run {expected} within {timeout:?} (idle: {idle_reuse_keys:?}, active: {active_runs:?})",
            ))
        }
    })
    .await;
}
