use serde_json::Value;
use std::error::Error;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const METRICS_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(unix)]
const WRITE_FAILURE_CHILD_ENV: &str = "OKOU_TEST_METRICS_WRITE_FAILURE_CHILD";

type TestResult<T = ()> = Result<T, Box<dyn Error>>;

async fn wait_for_line_count(path: &Path, expected: usize) -> TestResult {
    for _ in 0..1_000 {
        let count = std::fs::read_to_string(path)
            .map(|content| content.lines().count())
            .unwrap_or(0);
        if count == expected {
            return Ok(());
        }
        tokio::task::yield_now().await;
    }

    let observed = std::fs::read_to_string(path)
        .map(|content| content.lines().count())
        .unwrap_or(0);
    Err(std::io::Error::other(format!(
        "expected {expected} metrics records in {}, observed {observed}",
        path.display()
    ))
    .into())
}

async fn settle_runnable_tasks() {
    for _ in 0..1_000 {
        tokio::task::yield_now().await;
    }
}

fn metrics_entries(path: &Path) -> TestResult<Vec<Value>> {
    let content = std::fs::read_to_string(path)?;
    let entries = content
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries)
}

fn assert_valid_metrics_entries(path: &Path, expected: usize) -> TestResult {
    let entries = metrics_entries(path)?;
    assert_eq!(entries.len(), expected);
    for entry in entries {
        assert!(entry.get("ts").is_some_and(Value::is_string));
        assert!(entry.get("cpu").is_some_and(Value::is_f64));
        assert!(entry.get("cpu_steal_percent").is_some_and(Value::is_f64));
        assert!(entry.get("scheduled_lag_ms").is_some_and(Value::is_u64));
        assert!(entry.get("mem_used").is_some_and(Value::is_u64));
        assert!(entry.get("mem_total").is_some_and(Value::is_u64));
        assert!(entry.get("disk_used").is_some_and(Value::is_u64));
        assert!(entry.get("disk_total").is_some_and(Value::is_u64));
        assert!(entry.get("control_cpu_usage_usec").is_none());
        assert!(entry.get("workload_cpu_usage_usec").is_none());
    }
    Ok(())
}

fn spawn_metrics_loop(
    path: PathBuf,
    sources: guest_agent::metrics::MetricsSources,
) -> (CancellationToken, JoinHandle<()>) {
    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::metrics::metrics_loop_for_path(
            task_shutdown,
            path.to_string_lossy().into_owned(),
            sources,
        )
        .await;
    });
    (shutdown, handle)
}

fn system_metrics_sources() -> guest_agent::metrics::MetricsSources {
    guest_agent::metrics::MetricsSources::new(PathBuf::from("/proc/stat"), None)
}

async fn stop_metrics_loop(shutdown: CancellationToken, handle: JoinHandle<()>) -> TestResult {
    shutdown.cancel();
    handle.await?;
    Ok(())
}

fn keep_paused_clock_stable() -> JoinHandle<()> {
    tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    })
}

#[tokio::test(start_paused = true)]
async fn metrics_loop_reuses_retained_handle_across_ticks() -> TestResult {
    let clock_guard = keep_paused_clock_stable();
    let temp = tempfile::tempdir()?;
    let metrics_path = temp.path().join("runtime").join("metrics.jsonl");
    let moved_path = temp.path().join("runtime").join("moved-metrics.jsonl");
    let (shutdown, handle) = spawn_metrics_loop(metrics_path.clone(), system_metrics_sources());

    wait_for_line_count(&metrics_path, 1).await?;
    std::fs::rename(&metrics_path, &moved_path)?;

    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&moved_path, 2).await?;

    assert!(!metrics_path.exists());
    assert_valid_metrics_entries(&moved_path, 2)?;

    stop_metrics_loop(shutdown, handle).await?;
    clock_guard.abort();
    let _ = clock_guard.await;
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn metrics_loop_reports_steal_and_preserves_cpu_state_across_invalid_samples() -> TestResult {
    let clock_guard = keep_paused_clock_stable();
    let temp = tempfile::tempdir()?;
    let metrics_path = temp.path().join("runtime").join("metrics.jsonl");
    let proc_stat = temp.path().join("proc-stat");
    // guest and guest_nice are already included in user and nice.
    std::fs::write(&proc_stat, "cpu 8 2 0 90 0 0 0 0 4 1\n")?;
    let sources = guest_agent::metrics::MetricsSources::new(proc_stat.clone(), None);
    let (shutdown, handle) = spawn_metrics_loop(metrics_path.clone(), sources);

    wait_for_line_count(&metrics_path, 1).await?;
    std::fs::write(&proc_stat, "cpu 16 4 0 170 0 0 0 10 8 2\n")?;
    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 2).await?;

    std::fs::write(&proc_stat, "cpu malformed\n")?;
    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 3).await?;

    std::fs::write(&proc_stat, format!("cpu {} 1 0 0 0 0 0 0\n", u64::MAX))?;
    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 4).await?;

    std::fs::write(&proc_stat, "cpu 1 0 0 9 0 0 0 0\n")?;
    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 5).await?;

    std::fs::write(&proc_stat, "cpu 24 6 0 250 0 0 0 20 12 3\n")?;
    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 6).await?;

    let entries = metrics_entries(&metrics_path)?;
    let [initial, updated, malformed, overflow, regressed, restored] = entries.as_slice() else {
        return Err(std::io::Error::other("expected six CPU metric entries").into());
    };
    assert_eq!(initial["cpu"].as_f64(), Some(10.0));
    assert_eq!(initial["cpu_steal_percent"].as_f64(), Some(0.0));
    assert_eq!(updated["cpu"].as_f64(), Some(20.0));
    assert_eq!(updated["cpu_steal_percent"].as_f64(), Some(10.0));
    for entry in [malformed, overflow, regressed] {
        assert_eq!(entry["cpu"].as_f64(), Some(0.0));
        assert_eq!(entry["cpu_steal_percent"].as_f64(), Some(0.0));
    }
    assert_eq!(restored["cpu"].as_f64(), Some(20.0));
    assert_eq!(restored["cpu_steal_percent"].as_f64(), Some(10.0));

    stop_metrics_loop(shutdown, handle).await?;
    clock_guard.abort();
    let _ = clock_guard.await;
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn metrics_loop_emits_only_complete_cgroup_cpu_samples() -> TestResult {
    let clock_guard = keep_paused_clock_stable();
    let temp = tempfile::tempdir()?;
    let metrics_path = temp.path().join("runtime").join("metrics.jsonl");
    let proc_stat = temp.path().join("proc-stat");
    let control = temp.path().join("control").join("cpu.stat");
    let workload = temp.path().join("workload").join("cpu.stat");
    std::fs::create_dir_all(
        control
            .parent()
            .ok_or_else(|| std::io::Error::other("control path has no parent"))?,
    )?;
    std::fs::create_dir_all(
        workload
            .parent()
            .ok_or_else(|| std::io::Error::other("workload path has no parent"))?,
    )?;
    std::fs::write(&proc_stat, "cpu 10 0 0 90 0 0 0 0\n")?;
    std::fs::write(
        &control,
        "usage_usec 11\nuser_usec 7\nnr_throttled 12\nthrottled_usec 13\n",
    )?;
    std::fs::write(
        &workload,
        "usage_usec 21\nnr_throttled 22\nthrottled_usec 23\n",
    )?;
    let cgroups = guest_agent::workload_containment::CgroupCpuStatPaths::new(
        control.clone(),
        workload.clone(),
    );
    let sources = guest_agent::metrics::MetricsSources::new(proc_stat, Some(cgroups));
    let (shutdown, handle) = spawn_metrics_loop(metrics_path.clone(), sources);

    wait_for_line_count(&metrics_path, 1).await?;
    std::fs::write(
        &control,
        "usage_usec 31\nnr_throttled 32\nthrottled_usec 33\n",
    )?;
    std::fs::remove_file(&workload)?;
    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 2).await?;

    std::fs::write(&control, "usage_usec invalid\n")?;
    std::fs::write(
        &workload,
        "usage_usec 41\nnr_throttled 42\nthrottled_usec 43\n",
    )?;
    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 3).await?;

    let entries = metrics_entries(&metrics_path)?;
    let [complete, missing_workload, malformed_control] = entries.as_slice() else {
        return Err(std::io::Error::other("expected three cgroup metric entries").into());
    };
    assert_eq!(complete["control_cpu_usage_usec"].as_u64(), Some(11));
    assert_eq!(complete["control_cpu_nr_throttled"].as_u64(), Some(12));
    assert_eq!(complete["control_cpu_throttled_usec"].as_u64(), Some(13));
    assert_eq!(complete["workload_cpu_usage_usec"].as_u64(), Some(21));
    assert_eq!(complete["workload_cpu_nr_throttled"].as_u64(), Some(22));
    assert_eq!(complete["workload_cpu_throttled_usec"].as_u64(), Some(23));

    assert_eq!(
        missing_workload["control_cpu_usage_usec"].as_u64(),
        Some(31)
    );
    assert_eq!(
        missing_workload["control_cpu_nr_throttled"].as_u64(),
        Some(32)
    );
    assert_eq!(
        missing_workload["control_cpu_throttled_usec"].as_u64(),
        Some(33)
    );
    assert!(missing_workload.get("workload_cpu_usage_usec").is_none());
    assert!(missing_workload.get("workload_cpu_nr_throttled").is_none());
    assert!(
        missing_workload
            .get("workload_cpu_throttled_usec")
            .is_none()
    );

    assert!(malformed_control.get("control_cpu_usage_usec").is_none());
    assert!(malformed_control.get("control_cpu_nr_throttled").is_none());
    assert!(
        malformed_control
            .get("control_cpu_throttled_usec")
            .is_none()
    );
    assert_eq!(
        malformed_control["workload_cpu_usage_usec"].as_u64(),
        Some(41)
    );
    assert_eq!(
        malformed_control["workload_cpu_nr_throttled"].as_u64(),
        Some(42)
    );
    assert_eq!(
        malformed_control["workload_cpu_throttled_usec"].as_u64(),
        Some(43)
    );

    stop_metrics_loop(shutdown, handle).await?;
    clock_guard.abort();
    let _ = clock_guard.await;
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn metrics_loop_delays_after_a_missed_tick_without_catching_up() -> TestResult {
    let clock_guard = keep_paused_clock_stable();
    let temp = tempfile::tempdir()?;
    let metrics_path = temp.path().join("runtime").join("metrics.jsonl");
    let (shutdown, handle) = spawn_metrics_loop(metrics_path.clone(), system_metrics_sources());

    wait_for_line_count(&metrics_path, 1).await?;
    tokio::time::advance(METRICS_INTERVAL * 3).await;
    settle_runnable_tasks().await;

    let delayed_entries = metrics_entries(&metrics_path)?;
    let [_, delayed] = delayed_entries.as_slice() else {
        return Err(std::io::Error::other("expected one delayed metric entry").into());
    };
    assert_eq!(delayed["scheduled_lag_ms"].as_u64(), Some(10_000));

    tokio::time::advance(Duration::from_millis(4_999)).await;
    settle_runnable_tasks().await;
    assert_eq!(metrics_entries(&metrics_path)?.len(), 2);

    tokio::time::advance(Duration::from_millis(1)).await;
    wait_for_line_count(&metrics_path, 3).await?;
    let restored_entries = metrics_entries(&metrics_path)?;
    let [_, _, restored] = restored_entries.as_slice() else {
        return Err(std::io::Error::other("expected restored metric cadence").into());
    };
    assert_eq!(restored["scheduled_lag_ms"].as_u64(), Some(0));

    stop_metrics_loop(shutdown, handle).await?;
    clock_guard.abort();
    let _ = clock_guard.await;
    Ok(())
}

#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn metrics_loop_reopens_after_cached_write_failure() -> TestResult {
    if std::env::var_os(WRITE_FAILURE_CHILD_ENV).as_deref() == Some(std::ffi::OsStr::new("1")) {
        return run_cached_write_failure_scenario().await;
    }

    let current_thread = std::thread::current();
    let child_test_name = current_thread
        .name()
        .ok_or_else(|| std::io::Error::other("metrics parent test thread has no libtest name"))?;
    let output = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            child_test_name,
            "--nocapture",
            "--test-threads=1",
        ])
        .env(WRITE_FAILURE_CHILD_ENV, "1")
        .output()?;

    if !output.status.success() {
        return Err(std::io::Error::other(format!(
            "isolated metrics write-failure test failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        ))
        .into());
    }
    Ok(())
}

#[cfg(unix)]
async fn run_cached_write_failure_scenario() -> TestResult {
    let clock_guard = keep_paused_clock_stable();
    let temp = tempfile::tempdir()?;
    let metrics_path = temp.path().join("runtime").join("metrics.jsonl");
    let moved_path = temp.path().join("runtime").join("moved-metrics.jsonl");
    let (shutdown, handle) = spawn_metrics_loop(metrics_path.clone(), system_metrics_sources());

    wait_for_line_count(&metrics_path, 1).await?;
    std::fs::rename(&metrics_path, &moved_path)?;
    let first_record_bytes = std::fs::metadata(&moved_path)?.len();

    let limit_guard = crate::common::set_soft_file_size_limit(first_record_bytes)?;

    tokio::time::advance(METRICS_INTERVAL).await;
    settle_runnable_tasks().await;
    assert_eq!(std::fs::metadata(&moved_path)?.len(), first_record_bytes);
    assert!(!metrics_path.exists());

    limit_guard.restore()?;

    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 1).await?;

    assert_valid_metrics_entries(&moved_path, 1)?;
    assert_valid_metrics_entries(&metrics_path, 1)?;

    stop_metrics_loop(shutdown, handle).await?;
    clock_guard.abort();
    let _ = clock_guard.await;
    Ok(())
}
