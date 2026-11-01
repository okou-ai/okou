use super::*;
use crate::cmd::gc::test_support::test_home;

#[tokio::test]
async fn gc_job_logs_deletes_stale() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let logs_dir = home.logs_dir();
    std::fs::create_dir_all(&logs_dir).unwrap();

    let old_file = logs_dir.join("network-550e8400-e29b-41d4-a716-446655440000.jsonl");
    std::fs::write(&old_file, r#"{"timestamp":"2026-01-01T00:00:00"}"#).unwrap();
    let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
    std::fs::File::open(&old_file)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let report = gc_job_logs(&home, false).await.unwrap();
    assert_eq!(report.activity_count, 1);
    assert!(!old_file.exists());
}

#[tokio::test]
async fn gc_job_logs_keeps_recent() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let logs_dir = home.logs_dir();
    std::fs::create_dir_all(&logs_dir).unwrap();

    let recent = logs_dir.join("network-aabbccdd-1234-5678-9abc-def012345678.jsonl");
    std::fs::write(&recent, r#"{"timestamp":"2026-02-18T00:00:00"}"#).unwrap();

    let report = gc_job_logs(&home, false).await.unwrap();
    assert_eq!(report.activity_count, 0);
    assert!(recent.exists());
}

#[tokio::test]
async fn gc_job_logs_deletes_stale_runner_logs() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let logs_dir = home.logs_dir();
    std::fs::create_dir_all(&logs_dir).unwrap();

    // Old runner log file — should be deleted.
    let runner_log = logs_dir.join("runner-default.2026-02-10.log");
    std::fs::write(&runner_log, "log content").unwrap();
    let old_time = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
    std::fs::File::open(&runner_log)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let report = gc_job_logs(&home, false).await.unwrap();
    assert_eq!(report.activity_count, 1);
    assert!(!runner_log.exists());
}

#[tokio::test]
async fn gc_job_logs_keeps_recent_runner_logs() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let logs_dir = home.logs_dir();
    std::fs::create_dir_all(&logs_dir).unwrap();

    // Recent runner log — should be kept.
    let runner_log = logs_dir.join("runner-default.2026-03-19.log");
    std::fs::write(&runner_log, "log content").unwrap();

    let report = gc_job_logs(&home, false).await.unwrap();
    assert_eq!(report.activity_count, 0);
    assert!(runner_log.exists());
}

#[tokio::test]
async fn gc_job_logs_respects_age_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let logs_dir = home.logs_dir();
    std::fs::create_dir_all(&logs_dir).unwrap();

    let boundary = logs_dir.join("network-11111111-1111-1111-1111-111111111111.jsonl");
    std::fs::write(&boundary, r#"{"timestamp":"2026-02-11T00:00:00"}"#).unwrap();
    // Derive the fixed reference from the mtime the filesystem actually stored.
    let mtime = std::fs::metadata(&boundary).unwrap().modified().unwrap();
    let now = mtime + JOB_LOG_MAX_AGE;

    let report = gc_job_logs_with_clock(&home, false, || now).await.unwrap();
    assert_eq!(report.activity_count, 0);
    assert!(boundary.exists(), "file at max age should be kept");

    // Advance only the reference, avoiding another mtime write and its rounding.
    let report = gc_job_logs_with_clock(&home, false, || now + Duration::from_nanos(1))
        .await
        .unwrap();
    assert_eq!(report.activity_count, 1);
    assert!(
        !boundary.exists(),
        "file older than max age should be deleted"
    );
}

#[tokio::test]
async fn gc_job_logs_dry_run() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let logs_dir = home.logs_dir();
    std::fs::create_dir_all(&logs_dir).unwrap();

    let old_file = logs_dir.join("network-00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&old_file, r#"{"timestamp":"2026-01-01T00:00:00"}"#).unwrap();
    let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
    std::fs::File::open(&old_file)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let report = gc_job_logs(&home, true).await.unwrap();
    assert_eq!(report.activity_count, 1);
    assert!(old_file.exists(), "dry-run should not delete");
}

#[tokio::test]
async fn gc_job_logs_deletes_stale_system_metrics_and_sandbox_ops() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let logs_dir = home.logs_dir();
    std::fs::create_dir_all(&logs_dir).unwrap();

    let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);

    let system_log = logs_dir.join("system-550e8400-e29b-41d4-a716-446655440000.log");
    std::fs::write(&system_log, "log content").unwrap();
    std::fs::File::open(&system_log)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let metrics_log = logs_dir.join("metrics-550e8400-e29b-41d4-a716-446655440000.jsonl");
    std::fs::write(&metrics_log, "{}").unwrap();
    std::fs::File::open(&metrics_log)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let sandbox_ops_log = logs_dir.join("sandbox-ops-550e8400-e29b-41d4-a716-446655440000.jsonl");
    std::fs::write(&sandbox_ops_log, "{}").unwrap();
    std::fs::File::open(&sandbox_ops_log)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let report = gc_job_logs(&home, false).await.unwrap();
    assert_eq!(report.activity_count, 3);
    assert!(!system_log.exists());
    assert!(!metrics_log.exists());
    assert!(!sandbox_ops_log.exists());
}
