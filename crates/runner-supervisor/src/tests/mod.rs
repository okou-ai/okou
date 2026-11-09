//! Private persisted-status observers shared by Supervisor's unit tests.

pub(super) async fn status_active_run_records(
    status_path: &std::path::Path,
) -> Vec<(String, String)> {
    let raw = tokio::fs::read_to_string(status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    active_run_records(&status)
}

pub(super) fn active_run_records(status: &serde_json::Value) -> Vec<(String, String)> {
    let mut records: Vec<(String, String)> = status["active_runs"]
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
    records.sort_unstable();
    records
}
