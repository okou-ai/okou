use super::*;
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

static TELEMETRY_TEST_LOCK: Mutex<()> = Mutex::new(());

fn lock_test_state() -> MutexGuard<'static, ()> {
    TELEMETRY_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct SandboxOpsOverrideGuard;

impl SandboxOpsOverrideGuard {
    fn set(path: impl AsRef<Path>) -> Self {
        set_sandbox_ops_log_file(path);
        Self
    }
}

impl Drop for SandboxOpsOverrideGuard {
    fn drop(&mut self) {
        clear_sandbox_ops_log_file();
    }
}

#[test]
fn startup_resource_is_captured_with_the_sink_and_cleared_on_replacement() {
    use guest_contracts::sandbox_startup::SandboxStartupPath;

    let _guard = lock_test_state();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sandbox-ops.jsonl");
    let _override_guard = SandboxOpsOverrideGuard::set(&path);
    for startup in [
        SandboxStartupPath::Sandbox,
        SandboxStartupPath::Home,
        SandboxStartupPath::Blank,
        SandboxStartupPath::Cold,
    ] {
        set_sandbox_ops_log_file_with_startup_path(&path, Some(startup));
        record_sandbox_op("api_to_agent_start", Duration::ZERO, true, None);
    }
    set_sandbox_ops_log_file(&path);
    record_sandbox_op("api_to_agent_start", Duration::ZERO, true, None);

    let records: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let paths: Vec<_> = records
        .iter()
        .map(|record| {
            record
                .get("runner_startup_path")
                .and_then(|value| value.as_str())
        })
        .collect();
    assert_eq!(
        paths,
        [
            Some("sandbox"),
            Some("home"),
            Some("blank"),
            Some("cold"),
            None
        ]
    );
}

#[test]
fn record_sandbox_op_writes_and_appends_jsonl() {
    let _guard = lock_test_state();
    clear_sandbox_ops_log_file();
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir
        .path()
        .join("runtime")
        .join("logs")
        .join("sandbox-ops.jsonl");
    let _override_guard = SandboxOpsOverrideGuard::set(&log_path);

    record_sandbox_op("op_a", Duration::from_millis(10), true, None);
    record_sandbox_op("op_b", Duration::from_millis(20), false, Some("fail"));
    record_sandbox_op("op_max", Duration::MAX, true, None);

    const THREAD_COUNT: usize = 8;
    const RECORDS_PER_THREAD: usize = 64;

    std::thread::scope(|scope| {
        for thread_index in 0..THREAD_COUNT {
            scope.spawn(move || {
                for record_index in 0..RECORDS_PER_THREAD {
                    let action_type = format!("op_{thread_index}_{record_index}");
                    let error = format!("error_{thread_index}_{record_index}");
                    record_sandbox_op(
                        &action_type,
                        Duration::from_millis(record_index as u64),
                        false,
                        Some(&error),
                    );
                }
            });
        }
    });

    let content = std::fs::read_to_string(&log_path).unwrap();
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 3 + THREAD_COUNT * RECORDS_PER_THREAD);

    let a: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(a["action_type"], "op_a");
    assert_eq!(a["duration_ms"], 10);
    assert!(a["success"].as_bool().unwrap());
    assert!(a["ts"].is_string());

    let b: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(b["action_type"], "op_b");
    assert_eq!(b["error"], "fail");
    assert!(!b["success"].as_bool().unwrap());

    let max_duration: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
    assert_eq!(max_duration["action_type"], "op_max");
    assert_eq!(max_duration["duration_ms"], u64::MAX);
    assert!(max_duration["success"].as_bool().unwrap());

    let mut actions = HashSet::new();
    for line in lines {
        let entry: serde_json::Value = serde_json::from_str(line).unwrap();
        actions.insert(entry["action_type"].as_str().unwrap().to_string());
    }

    assert_eq!(actions.len(), 3 + THREAD_COUNT * RECORDS_PER_THREAD);
    assert!(actions.contains("op_a"));
    assert!(actions.contains("op_b"));
    assert!(actions.contains("op_max"));
    for thread_index in 0..THREAD_COUNT {
        for record_index in 0..RECORDS_PER_THREAD {
            assert!(actions.contains(&format!("op_{thread_index}_{record_index}")));
        }
    }

    let _ = std::fs::remove_file(&log_path);
}

#[test]
fn record_sandbox_op_writes_optional_dimensions() {
    let _guard = lock_test_state();
    clear_sandbox_ops_log_file();
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("sandbox-ops.jsonl");
    let _override_guard = SandboxOpsOverrideGuard::set(&log_path);

    record_sandbox_op_with_dimensions(
        "session_history_prune",
        Duration::from_millis(5),
        true,
        None,
        SandboxOpDimensions {
            outcome: Some("ineligible"),
            reason: Some("source_within_guard"),
        },
    );

    let content = std::fs::read_to_string(&log_path).unwrap();
    let entry: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
    assert_eq!(entry["outcome"], "ineligible");
    assert_eq!(entry["reason"], "source_within_guard");
    assert!(entry.get("error").is_none());
}

#[test]
fn record_sandbox_op_replaces_and_clears_process_global_path() {
    let _guard = lock_test_state();
    let dir = tempfile::tempdir().unwrap();
    let log_dir = dir.path().join("runtime").join("logs");
    let first_path = log_dir.join("first.jsonl");
    let second_path = log_dir.join("second.jsonl");
    let _override_guard = SandboxOpsOverrideGuard::set(&first_path);

    record_sandbox_op("first_path", Duration::from_millis(12), true, None);
    set_sandbox_ops_log_file(&second_path);
    record_sandbox_op("second_path", Duration::from_millis(24), true, None);
    clear_sandbox_ops_log_file();
    record_sandbox_op("after_clear", Duration::from_millis(36), true, None);

    let first_content = std::fs::read_to_string(&first_path).unwrap();
    let first_lines: Vec<&str> = first_content.lines().collect();
    assert_eq!(first_lines.len(), 1);
    let first_entry: serde_json::Value = serde_json::from_str(first_lines[0]).unwrap();
    assert_eq!(first_entry["action_type"], "first_path");
    assert_eq!(first_entry["duration_ms"], 12);

    let second_content = std::fs::read_to_string(&second_path).unwrap();
    let second_lines: Vec<&str> = second_content.lines().collect();
    assert_eq!(second_lines.len(), 1);
    let second_entry: serde_json::Value = serde_json::from_str(second_lines[0]).unwrap();
    assert_eq!(second_entry["action_type"], "second_path");
    assert_eq!(second_entry["duration_ms"], 24);
}

#[cfg(unix)]
#[test]
fn record_sandbox_op_reuses_file_until_path_is_reinstalled() {
    let _guard = lock_test_state();
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("sandbox-ops.jsonl");
    let moved_path = dir.path().join("moved-sandbox-ops.jsonl");
    let _override_guard = SandboxOpsOverrideGuard::set(&log_path);

    assert!(!log_path.exists());
    record_sandbox_op("before_move", Duration::from_millis(1), true, None);
    std::fs::rename(&log_path, &moved_path).unwrap();
    record_sandbox_op("retained_file", Duration::from_millis(2), true, None);

    assert!(!log_path.exists());
    let moved_content = std::fs::read_to_string(&moved_path).unwrap();
    let moved_entries: Vec<serde_json::Value> = moved_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(moved_entries.len(), 2);
    assert_eq!(moved_entries[0]["action_type"], "before_move");
    assert_eq!(moved_entries[1]["action_type"], "retained_file");

    set_sandbox_ops_log_file(&log_path);
    record_sandbox_op("reopened_path", Duration::from_millis(3), true, None);

    let reopened_content = std::fs::read_to_string(&log_path).unwrap();
    let reopened_entries: Vec<serde_json::Value> = reopened_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(reopened_entries.len(), 1);
    assert_eq!(reopened_entries[0]["action_type"], "reopened_path");
}

#[test]
fn record_sandbox_op_retries_open_after_failure() {
    let _guard = lock_test_state();
    let dir = tempfile::tempdir().unwrap();
    let blocked_parent = dir.path().join("runtime");
    let log_path = blocked_parent.join("logs").join("sandbox-ops.jsonl");
    std::fs::write(&blocked_parent, "not a directory").unwrap();
    let _override_guard = SandboxOpsOverrideGuard::set(&log_path);

    record_sandbox_op("open_failed", Duration::from_millis(1), false, None);
    std::fs::remove_file(&blocked_parent).unwrap();
    record_sandbox_op("open_retried", Duration::from_millis(2), true, None);

    let content = std::fs::read_to_string(&log_path).unwrap();
    let entries: Vec<serde_json::Value> = content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["action_type"], "open_retried");
}

#[test]
fn cached_handle_write_failure_reopens_on_next_record() {
    let _guard = lock_test_state();
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("sandbox-ops.jsonl");
    std::fs::write(&log_path, "").unwrap();
    let read_only_file = File::open(&log_path).unwrap();
    let sink = SandboxOpsSink {
        startup_path: None,
        path: log_path.clone(),
        file: Mutex::new(Some(read_only_file)),
    };

    assert!(sink.append_record(b"failed\n").is_err());
    sink.append_record(b"recovered\n").unwrap();

    assert_eq!(std::fs::read_to_string(log_path).unwrap(), "recovered\n");
}

#[test]
fn record_sandbox_op_noops_without_explicit_log_path() {
    let _guard = lock_test_state();
    clear_sandbox_ops_log_file();
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir
        .path()
        .join("runtime")
        .join("logs")
        .join("sandbox-ops.jsonl");

    record_sandbox_op("op_without_path", Duration::from_millis(1), true, None);

    assert!(
        !log_path.exists(),
        "sandbox op logging should not create a file without an explicit path"
    );
}
