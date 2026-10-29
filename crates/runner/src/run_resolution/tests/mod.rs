use super::*;

fn live_runner(base_dir: &Path) -> LiveRunnerInstance {
    LiveRunnerInstance {
        pid: 1,
        starttime: 1,
        config_path: base_dir.join("runner.yaml"),
        base_dir: base_dir.to_path_buf(),
        runner_group: "vm0/test".into(),
        subcommand: "start".into(),
        started_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

fn live_runner_with_subcommand(base_dir: &Path, subcommand: &str) -> LiveRunnerInstance {
    LiveRunnerInstance {
        subcommand: subcommand.into(),
        ..live_runner(base_dir)
    }
}

fn mappings(entries: Vec<(String, String)>) -> ActiveRunMappings {
    let total = if entries.is_empty() { 0 } else { 1 };
    ActiveRunMappings {
        entries,
        runners_total: total,
        runners_failed: 0,
    }
}

#[tokio::test]
async fn read_active_runs_normal() {
    let dir = tempfile::tempdir().unwrap();
    let status = r#"{
            "mode": "running",
            "active_runs": [
                {"run_id": "R1", "sandbox_id": "S1"},
                {"run_id": "R2", "sandbox_id": "S2"}
            ],
            "started_at": "2026-01-01T00:00:00.000Z"
        }"#;
    std::fs::write(dir.path().join("status.json"), status).unwrap();
    let runs = read_active_runs(dir.path()).await.unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0], ("R1".into(), "S1".into()));
}

#[tokio::test]
async fn read_active_runs_ignores_phase_fields() {
    let dir = tempfile::tempdir().unwrap();
    let status = r#"{
            "mode": "running",
            "active_runs": [
                {
                    "run_id": "R1",
                    "sandbox_id": "S1",
                    "phase": 42,
                    "phase_started_at": {"unexpected": true}
                },
                {
                    "run_id": "R2",
                    "sandbox_id": "S2",
                    "phase": "running",
                    "phase_started_at": "2026-01-01T00:00:01.000Z"
                }
            ],
            "started_at": "2026-01-01T00:00:00.000Z"
        }"#;
    std::fs::write(dir.path().join("status.json"), status).unwrap();

    let runs = read_active_runs(dir.path()).await.unwrap();

    assert_eq!(
        runs,
        vec![("R1".into(), "S1".into()), ("R2".into(), "S2".into())]
    );
}

#[tokio::test]
async fn read_active_runs_missing_field_defaults_empty() {
    let dir = tempfile::tempdir().unwrap();
    // status.json without active_runs field — serde(default) kicks in
    std::fs::write(dir.path().join("status.json"), r#"{"mode":"running"}"#).unwrap();
    let runs = read_active_runs(dir.path()).await.unwrap();
    assert!(runs.is_empty());
}

#[tokio::test]
async fn read_active_runs_missing_entry_identifier_is_unparseable() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("status.json"),
        r#"{"active_runs":[{"run_id":"run-a"}]}"#,
    )
    .unwrap();

    assert!(read_active_runs(dir.path()).await.is_none());
}

#[tokio::test]
async fn read_active_runs_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    assert!(read_active_runs(dir.path()).await.is_none());
}

#[tokio::test]
async fn read_active_runs_malformed_json() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("status.json"), "not json").unwrap();
    assert!(read_active_runs(dir.path()).await.is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn read_active_runs_skips_status_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    std::fs::create_dir(&path).unwrap();

    assert!(read_active_runs(dir.path()).await.is_none());
}

#[tokio::test]
async fn collect_active_run_mappings_reads_registry_base_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let base_a = dir.path().join("runner-a");
    let base_b = dir.path().join("runner-b");
    std::fs::create_dir_all(&base_a).unwrap();
    std::fs::create_dir_all(&base_b).unwrap();
    std::fs::write(
        base_a.join("status.json"),
        r#"{"active_runs":[{"run_id":"run-a","sandbox_id":"sandbox-a"}]}"#,
    )
    .unwrap();
    std::fs::write(
        base_b.join("status.json"),
        r#"{"active_runs":[{"run_id":"run-b","sandbox_id":"sandbox-b"}]}"#,
    )
    .unwrap();
    let runners = vec![live_runner(&base_a), live_runner(&base_b)];

    let mappings = collect_active_run_mappings(&runners).await;

    assert_eq!(mappings.runners_total, 2);
    assert_eq!(mappings.runners_failed, 0);
    assert_eq!(
        mappings.entries,
        vec![
            ("run-a".into(), "sandbox-a".into()),
            ("run-b".into(), "sandbox-b".into()),
        ]
    );
}

#[tokio::test]
async fn collect_active_run_mappings_counts_unreadable_status_without_config_read() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("runner");
    std::fs::create_dir_all(&base).unwrap();
    let config_path = base.join("runner.yaml");
    std::fs::write(&config_path, "base_dir: /wrong\n").unwrap();
    let runner = LiveRunnerInstance {
        config_path,
        ..live_runner(&base)
    };

    let mappings = collect_active_run_mappings(&[runner]).await;

    assert!(mappings.entries.is_empty());
    assert_eq!(mappings.runners_total, 1);
    assert_eq!(mappings.runners_failed, 1);
}

#[tokio::test]
async fn collect_active_run_mappings_ignores_non_start_runners() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("benchmark-runner");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::write(
        base.join("status.json"),
        r#"{"active_runs":[{"run_id":"stale-run","sandbox_id":"stale-sandbox"}]}"#,
    )
    .unwrap();

    let mappings =
        collect_active_run_mappings(&[live_runner_with_subcommand(&base, "benchmark")]).await;

    assert!(mappings.entries.is_empty());
    assert_eq!(mappings.runners_total, 0);
    assert_eq!(mappings.runners_failed, 0);
}

#[tokio::test]
async fn collect_active_run_mappings_from_home_reads_live_registry() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let base = dir.path().join("runner-base");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::write(
        base.join("status.json"),
        r#"{"active_runs":[{"run_id":"run-live","sandbox_id":"sandbox-live"}]}"#,
    )
    .unwrap();
    let handle = crate::live_runner_instances::publish(
        &home,
        crate::live_runner_instances::LiveRunnerInstanceMetadata {
            config_path: base.join("runner.yaml"),
            base_dir: base,
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
        },
    )
    .await
    .unwrap();

    let mappings = collect_active_run_mappings_from_home(&home).await.unwrap();

    assert_eq!(mappings.runners_total, 1);
    assert_eq!(mappings.runners_failed, 0);
    assert_eq!(
        mappings.entries,
        vec![("run-live".into(), "sandbox-live".into())]
    );
    assert!(handle.remove_if_current().await.unwrap());
}

#[tokio::test]
async fn collect_active_run_mappings_from_home_fails_when_registry_cannot_be_validated() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    std::fs::create_dir_all(dir.path().join("home")).unwrap();
    std::fs::write(home.live_runner_instances_dir(), b"not a directory").unwrap();

    let error = match collect_active_run_mappings_from_home(&home).await {
        Ok(_) => panic!("expected unreadable registry to fail"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("validate live runner instances"),
        "{error}"
    );
}

#[test]
fn run_prefix_resolves_to_sandbox_id() {
    let status = mappings(vec![(
        "550e8400-run-1111-2222-aaaaaaaaaaaa".into(),
        "sbox-9999".into(),
    )]);
    let result = resolve_run_to_sandbox("550e8400", &status);
    assert_eq!(result.unwrap(), "sbox-9999");
}

#[test]
fn run_prefix_resolves_full_mapping() {
    let status = mappings(vec![(
        "550e8400-run-1111-2222-aaaaaaaaaaaa".into(),
        "sbox-9999".into(),
    )]);

    let result = resolve_run_mapping("550e8400", &status).unwrap();

    assert_eq!(result.run_id, "550e8400-run-1111-2222-aaaaaaaaaaaa");
    assert_eq!(result.sandbox_id, "sbox-9999");
}

#[test]
fn run_prefix_full_uuid() {
    let status = mappings(vec![(
        "550e8400-e29b-41d4-a716-446655440000".into(),
        "sbox-full".into(),
    )]);
    let result = resolve_run_to_sandbox("550e8400-e29b-41d4-a716-446655440000", &status);
    assert_eq!(result.unwrap(), "sbox-full");
}

#[test]
fn run_prefix_ambiguous() {
    let status = mappings(vec![
        ("abc-111".into(), "sbox-A".into()),
        ("abc-222".into(), "sbox-B".into()),
    ]);
    let Err(e) = resolve_run_to_sandbox("abc", &status) else {
        panic!("expected ambiguity error");
    };
    let msg = e.to_string();
    assert!(msg.contains("ambiguous"), "{msg}");
    assert!(msg.contains("abc-111"), "{msg}");
    assert!(msg.contains("abc-222"), "{msg}");
}

#[test]
fn run_prefix_no_match() {
    let status = mappings(vec![("abc-111".into(), "sbox-A".into())]);
    let result = resolve_run_to_sandbox("deadbeef", &status);
    assert!(result.is_err());
}

#[test]
fn run_prefix_empty_input() {
    let empty = mappings(vec![]);
    let result = resolve_run_to_sandbox("", &empty);
    assert!(result.is_err());
}

#[test]
fn run_prefix_dedups_duplicate_entries() {
    let status = mappings(vec![("R1".into(), "S1".into()), ("R1".into(), "S1".into())]);
    let result = resolve_run_to_sandbox("R1", &status);
    assert_eq!(result.unwrap(), "S1");
}

#[test]
fn run_prefix_dedup_preserves_true_ambiguity() {
    let status = mappings(vec![
        ("R1".into(), "S1".into()),
        ("R1".into(), "S1".into()),
        ("R2".into(), "S2".into()),
    ]);
    let Err(e) = resolve_run_to_sandbox("R", &status) else {
        panic!("expected ambiguity");
    };
    let msg = e.to_string();
    let r1_count = msg.matches("R1").count();
    assert_eq!(r1_count, 1, "R1 should appear once after dedup: {msg}");
    assert!(msg.contains("R2"), "{msg}");
}

#[test]
fn run_prefix_aggregated_across_runners() {
    let status = mappings(vec![
        ("aaa-111".into(), "sbox-A".into()),
        ("bbb-222".into(), "sbox-B".into()),
    ]);
    assert_eq!(resolve_run_to_sandbox("aaa", &status).unwrap(), "sbox-A");
    assert_eq!(resolve_run_to_sandbox("bbb", &status).unwrap(), "sbox-B");
}

#[test]
fn run_prefix_no_match_hints_unreadable_runners() {
    let m = ActiveRunMappings {
        entries: vec![],
        runners_total: 3,
        runners_failed: 2,
    };
    let err = resolve_run_to_sandbox("abc", &m).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("2 of 3"), "{msg}");
    assert!(msg.contains("trusted live runner status"), "{msg}");
    assert!(msg.contains("unreadable"), "{msg}");
}

#[test]
fn run_prefix_unique_match_fails_when_some_runners_unreadable() {
    let m = ActiveRunMappings {
        entries: vec![("run-abcdef".into(), "sandbox-1".into())],
        runners_total: 2,
        runners_failed: 1,
    };

    let err = resolve_run_to_sandbox("run-abc", &m).unwrap_err();

    assert!(err.to_string().contains("use the full run id"), "{err}");
}

#[test]
fn run_prefix_exact_match_succeeds_when_some_runners_unreadable() {
    let m = ActiveRunMappings {
        entries: vec![("run-abcdef".into(), "sandbox-1".into())],
        runners_total: 2,
        runners_failed: 1,
    };

    let sandbox_id = resolve_run_to_sandbox("run-abcdef", &m).unwrap();

    assert_eq!(sandbox_id, "sandbox-1");
}

#[test]
fn run_prefix_no_match_hints_no_runners() {
    let m = ActiveRunMappings {
        entries: vec![],
        runners_total: 0,
        runners_failed: 0,
    };
    let err = resolve_run_to_sandbox("abc", &m).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("no trusted live runner status"), "{msg}");
}
