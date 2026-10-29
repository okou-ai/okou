use super::*;

#[tokio::test]
async fn read_missing_file_returns_none() {
    let dir = tempfile::tempdir().unwrap();

    let status = read_as::<StatusForGate>(dir.path()).await.unwrap();

    assert!(status.is_none());
}

#[tokio::test]
async fn read_malformed_json_returns_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(dir.path().join("status.json"), "not json")
        .await
        .unwrap();

    let error = read_as::<StatusForGate>(dir.path()).await.unwrap_err();

    assert!(matches!(error, StatusFileReadError::ParseJson { .. }));
}

#[tokio::test]
async fn read_full_writer_payload_preserves_doctor_fields() {
    let dir = tempfile::tempdir().unwrap();
    let content = r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {
                    "run_id":"0191c4e0-0000-7000-8000-000000000001",
                    "sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001",
                    "phase":"preparing",
                    "phase_started_at":"2026-04-13T00:00:01.000Z"
                }
            ],
            "idle_sandboxes": [
                {"reuse_key":"sess-1","sandbox_id":"bbbbbbbb-0000-7000-8000-000000000001"}
            ],
            "proxy_port": 8080,
            "dns_port": 5300,
            "started_at": "2026-04-13T00:00:00.000Z",
            "updated_at": "2026-04-13T00:05:00.000Z"
        }"#;
    tokio::fs::write(dir.path().join("status.json"), content)
        .await
        .unwrap();

    let status = read_as::<StatusForDoctor>(dir.path())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(status.mode, "running");
    assert_eq!(status.started_at, "2026-04-13T00:00:00.000Z");
    assert_eq!(status.proxy_port, Some(8080));
    assert_eq!(status.dns_port, Some(5300));
    assert_eq!(status.active_runs.len(), 1);
    assert_eq!(
        status.active_runs[0].run_id,
        "0191c4e0-0000-7000-8000-000000000001"
    );
    assert_eq!(status.active_runs[0].phase, "preparing");
    assert_eq!(
        status.active_runs[0].phase_started_at,
        "2026-04-13T00:00:01.000Z"
    );
    assert_eq!(status.idle_sandboxes().len(), 1);
    assert_eq!(status.idle_sandboxes()[0].reuse_key, "sess-1");
}

#[tokio::test]
async fn doctor_defaults_omitted_idle_sandboxes_to_empty() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{"mode":"running","started_at":"2026-04-13T00:00:00.000Z"}"#,
    )
    .await
    .unwrap();

    let status = read_as::<StatusForDoctor>(dir.path())
        .await
        .unwrap()
        .unwrap();

    assert!(status.idle_sandboxes().is_empty());
}

#[tokio::test]
async fn doctor_accepts_explicit_empty_idle_sandboxes() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{"mode":"running","started_at":"2026-04-13T00:00:00.000Z","idle_sandboxes":[]}"#,
    )
    .await
    .unwrap();

    let status = read_as::<StatusForDoctor>(dir.path())
        .await
        .unwrap()
        .unwrap();

    assert!(status.idle_sandboxes().is_empty());
}

#[tokio::test]
async fn doctor_rejects_malformed_present_idle_sandboxes() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{
                "mode":"running",
                "started_at":"2026-04-13T00:00:00.000Z",
                "idle_sandboxes":null
            }"#,
    )
    .await
    .unwrap();

    let error = read_as::<StatusForDoctor>(dir.path()).await.unwrap_err();

    assert!(matches!(error, StatusFileReadError::ParseJson { .. }));
}

#[tokio::test]
async fn active_runs_only_defaults_missing_active_runs_to_empty() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{"mode":"running","started_at":"2026-04-13T00:00:00.000Z"}"#,
    )
    .await
    .unwrap();

    let status = read_as::<StatusActiveRunsOnly>(dir.path())
        .await
        .unwrap()
        .unwrap();

    assert!(status.active_runs.is_empty());
}

#[tokio::test]
async fn gate_shape_ignores_unneeded_malformed_fields() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{
                "mode":"running",
                "active_runs":[],
                "started_at":"2026-04-13T00:00:00.000Z",
                "idle_sandboxes":null
            }"#,
    )
    .await
    .unwrap();

    let status = read_as::<StatusForGate>(dir.path()).await.unwrap().unwrap();

    assert_eq!(status.mode, "running");
}

#[tokio::test]
async fn readiness_shape_reads_only_mode_and_max_concurrent() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{
                "mode":"running",
                "max_concurrent":4,
                "active_runs":null,
                "started_at":{}
            }"#,
    )
    .await
    .unwrap();

    let status = read_as::<StatusForReadiness>(dir.path())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(status.mode, "running");
    assert_eq!(status.max_concurrent, 4);
}

#[tokio::test]
async fn active_runs_only_ignores_unneeded_malformed_top_level_fields() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{
                "mode": {},
                "active_runs": [
                    {"run_id":"run-a","sandbox_id":"sandbox-a"}
                ],
                "started_at": [],
                "idle_sandboxes": null
            }"#,
    )
    .await
    .unwrap();

    let status = read_as::<StatusActiveRunsOnly>(dir.path())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(status.active_runs.len(), 1);
    assert_eq!(status.active_runs[0].run_id, "run-a");
    assert_eq!(status.active_runs[0].sandbox_id, "sandbox-a");
}

#[tokio::test]
async fn active_runs_only_rejects_null_active_runs() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{"mode":"running","active_runs":null}"#,
    )
    .await
    .unwrap();

    let error = read_as::<StatusActiveRunsOnly>(dir.path())
        .await
        .unwrap_err();

    assert!(matches!(error, StatusFileReadError::ParseJson { .. }));
}

#[tokio::test]
async fn active_runs_only_ignores_unneeded_malformed_phase_fields() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        dir.path().join("status.json"),
        r#"{
                "active_runs": [
                    {
                        "run_id":"run-a",
                        "sandbox_id":"sandbox-a",
                        "phase":42,
                        "phase_started_at":{}
                    }
                ]
            }"#,
    )
    .await
    .unwrap();

    let status = read_as::<StatusActiveRunsOnly>(dir.path())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(status.active_runs.len(), 1);
    assert_eq!(status.active_runs[0].run_id, "run-a");
    assert_eq!(status.active_runs[0].sandbox_id, "sandbox-a");
}

#[cfg(unix)]
#[tokio::test]
async fn read_rejects_symlink_to_valid_status() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("outside-status.json");
    let path = dir.path().join("status.json");
    std::fs::write(
        &target,
        r#"{"mode":"running","active_runs":[],"started_at":"2026-04-13T00:00:00.000Z"}"#,
    )
    .unwrap();
    symlink(&target, &path).unwrap();

    let error = read_as::<StatusForGate>(dir.path()).await.unwrap_err();

    assert!(matches!(error, StatusFileReadError::Read { .. }));
}
