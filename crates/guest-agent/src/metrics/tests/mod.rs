use super::*;

#[test]
fn cpu_tracker_returns_valid_range() {
    // First call returns cumulative average, subsequent calls return delta
    let mut tracker = CpuTracker::new();
    let pct1 = tracker.get_cpu_percentages(Path::new("/proc/stat"));
    assert!((0.0..=100.0).contains(&pct1.busy));
    assert!((0.0..=100.0).contains(&pct1.steal));
    let pct2 = tracker.get_cpu_percentages(Path::new("/proc/stat"));
    assert!((0.0..=100.0).contains(&pct2.busy));
    assert!((0.0..=100.0).contains(&pct2.steal));
}

#[test]
fn parse_cpu_stat_line_accepts_valid_aggregate_line() {
    assert_eq!(
        parse_cpu_stat_line("cpu 1 2 3 4 5 6 7 8"),
        Some(CpuCounters {
            idle: 9,
            total: 36,
            steal: 8,
        })
    );
}

#[test]
fn parse_cpu_stat_line_accepts_whitespace_separated_fields() {
    assert_eq!(
        parse_cpu_stat_line("cpu\t1 2 3 4 5 6 7 8"),
        Some(CpuCounters {
            idle: 9,
            total: 36,
            steal: 8,
        })
    );
}

#[test]
fn parse_cpu_stat_line_rejects_short_line() {
    assert_eq!(parse_cpu_stat_line("cpu 1 2 3 4"), None);
}

#[test]
fn parse_cpu_stat_line_rejects_wrong_prefix() {
    assert_eq!(parse_cpu_stat_line("cpu0 1 2 3 4 5 6 7 8"), None);
}

#[test]
fn parse_cpu_stat_line_rejects_malformed_field() {
    assert_eq!(parse_cpu_stat_line("cpu 1 2 bad 4 5 6 7 8"), None);
    assert_eq!(parse_cpu_stat_line("cpu 1 2 3 4 5 6 7 8 bad 10"), None);
    assert_eq!(parse_cpu_stat_line("cpu 1 2 3 4 5 6 7 8 9 bad"), None);
}

#[test]
fn cpu_tracker_counts_guest_time_once_for_cumulative_and_interval_samples() {
    let mut tracker = CpuTracker::new();

    assert_eq!(
        tracker.get_cpu_percentages_from_stat_line("cpu 40 10 0 40 0 0 0 10 20 5"),
        CpuPercentages {
            busy: 60.0,
            steal: 10.0,
        }
    );
    assert_eq!(
        tracker.get_cpu_percentages_from_stat_line("cpu 70 20 0 100 0 0 0 10 35 10"),
        CpuPercentages {
            busy: 40.0,
            steal: 0.0,
        }
    );
}

#[test]
fn parse_cpu_stat_line_rejects_idle_overflow() {
    let line = format!("cpu 0 0 0 {} 1 0 0 0", u64::MAX);
    assert_eq!(parse_cpu_stat_line(&line), None);
}

#[test]
fn parse_cpu_stat_line_rejects_total_overflow() {
    let line = format!("cpu {} 1 0 0 0 0 0 0", u64::MAX);
    assert_eq!(parse_cpu_stat_line(&line), None);
}

#[test]
fn cpu_tracker_does_not_update_state_for_invalid_stat_line() {
    let mut tracker = CpuTracker::new();
    assert_eq!(
        tracker.get_cpu_percentages_from_stat_line("cpu 0 0 0 10 0 0 0 0"),
        CpuPercentages::default()
    );

    let line = format!("cpu 0 0 0 {} 1 0 0 0", u64::MAX);
    assert_eq!(
        tracker.get_cpu_percentages_from_stat_line(&line),
        CpuPercentages::default()
    );

    assert_eq!(
        tracker.previous,
        CpuCounters {
            idle: 10,
            total: 10,
            steal: 0,
        }
    );
}

#[test]
fn cpu_tracker_rejects_inconsistent_delta_without_updating_state() {
    let mut tracker = CpuTracker::new();
    assert_eq!(
        tracker.get_cpu_percentages_from_stat_line("cpu 0 90 0 10 0 0 0 0"),
        CpuPercentages {
            busy: 90.0,
            steal: 0.0,
        }
    );

    assert_eq!(
        tracker.get_cpu_percentages_from_stat_line("cpu 0 75 0 30 0 0 0 0"),
        CpuPercentages::default()
    );
    assert_eq!(
        tracker.previous,
        CpuCounters {
            idle: 10,
            total: 100,
            steal: 0,
        }
    );
}

#[test]
fn cpu_tracker_preserves_state_when_counters_regress() {
    let mut tracker = CpuTracker::new();
    assert_eq!(
        tracker.get_cpu_percentages_from_stat_line("cpu 0 90 0 10 0 0 0 0"),
        CpuPercentages {
            busy: 90.0,
            steal: 0.0,
        }
    );

    assert_eq!(
        tracker.get_cpu_percentages_from_stat_line("cpu 0 5 0 5 0 0 0 0"),
        CpuPercentages::default()
    );
    assert_eq!(
        tracker.previous,
        CpuCounters {
            idle: 10,
            total: 100,
            steal: 0,
        }
    );
}

#[test]
fn parse_meminfo_value_basic() {
    assert_eq!(parse_meminfo_value("  12345 kB"), 12345);
    assert_eq!(parse_meminfo_value("  0 kB"), 0);
    assert_eq!(parse_meminfo_value(""), 0);
}

#[test]
fn parse_meminfo_value_large_values() {
    assert_eq!(parse_meminfo_value("  16384000 kB"), 16384000);
    assert_eq!(parse_meminfo_value("1 kB"), 1);
}

#[test]
fn parse_meminfo_value_non_numeric() {
    assert_eq!(parse_meminfo_value("  abc kB"), 0);
}

#[test]
fn memory_usage_from_kb_rejects_total_overflow() {
    assert_eq!(memory_usage_from_kb(u64::MAX / 1024 + 1, 0), None);
}

#[test]
fn memory_info_from_content_returns_zero_when_total_overflows() {
    let content = format!("MemTotal: {} kB\nMemAvailable: 0 kB\n", u64::MAX);
    assert_eq!(memory_info_from_content(&content), (0, 0));
}

#[test]
fn memory_info_from_content_returns_zero_when_available_overflows() {
    let content = format!("MemTotal: 1 kB\nMemAvailable: {} kB\n", u64::MAX);
    assert_eq!(memory_info_from_content(&content), (0, 0));
}

#[test]
fn memory_usage_from_kb_rejects_available_overflow() {
    assert_eq!(memory_usage_from_kb(1, u64::MAX / 1024 + 1), None);
}

#[test]
fn memory_usage_from_kb_saturates_used_when_available_exceeds_total() {
    assert_eq!(memory_usage_from_kb(1, 2), Some((0, 1024)));
}

#[test]
fn cpu_tracker_multiple_reads_are_consistent() {
    let mut tracker = CpuTracker::new();
    for i in 0..5 {
        let pct = tracker.get_cpu_percentages(Path::new("/proc/stat"));
        assert!(
            (0.0..=100.0).contains(&pct.busy),
            "read {i}: busy={} out of range",
            pct.busy
        );
        assert!(
            (0.0..=100.0).contains(&pct.steal),
            "read {i}: steal={} out of range",
            pct.steal
        );
    }
}

#[test]
fn get_memory_info_returns_valid_values() {
    let (used, total) = get_memory_info();
    // On Linux with /proc, total > 0
    if std::path::Path::new("/proc/meminfo").exists() {
        assert!(total > 0, "total memory should be > 0");
        assert!(used <= total, "used should be <= total");
    }
}

#[tokio::test]
async fn collect_metrics_returns_complete_entry() {
    let mut tracker = CpuTracker::new();
    let sources = MetricsSources::new(PathBuf::from("/proc/stat"), None);
    let entry = collect_metrics(&mut tracker, &sources, 0).await;
    assert!(!entry.ts.is_empty());
    assert!((0.0..=100.0).contains(&entry.cpu));
    assert!((0.0..=100.0).contains(&entry.cpu_steal_percent));
    assert!(entry.mem_total > 0);
    let rootfs = entry
        .rootfs
        .expect("rootfs observation should be available");
    assert!(rootfs.total_bytes > 0);
    assert!(rootfs.used_bytes <= rootfs.total_bytes);
    assert!(rootfs.available_bytes <= rootfs.total_bytes - rootfs.used_bytes);
    assert!(rootfs.used_inodes <= rootfs.total_inodes);
    assert!(rootfs.available_inodes <= rootfs.total_inodes - rootfs.used_inodes);
}

#[tokio::test]
async fn collect_metrics_serializes_to_valid_jsonl() {
    let mut tracker = CpuTracker::new();
    let sources = MetricsSources::new(PathBuf::from("/proc/stat"), None);
    let entry = collect_metrics(&mut tracker, &sources, 0).await;
    let json = serde_json::to_string(&entry).unwrap();
    // Verify it round-trips through the same path metrics_loop uses.
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(parsed["ts"].is_string());
    assert!(parsed["cpu"].is_f64());
    assert!(parsed["cpu_steal_percent"].is_f64());
    assert!(parsed["scheduled_lag_ms"].is_u64());
    assert!(parsed["mem_total"].is_u64());
    for filesystem in ["rootfs", "home"] {
        if let Some(observation) = parsed.get(filesystem) {
            for dimension in [
                "used_bytes",
                "total_bytes",
                "available_bytes",
                "used_inodes",
                "total_inodes",
                "available_inodes",
            ] {
                assert!(observation[dimension].is_u64());
            }
        }
    }
    assert!(parsed.get("control_cpu_usage_usec").is_none());
    assert!(parsed.get("workload_cpu_usage_usec").is_none());
}

#[tokio::test]
async fn serialization_preserves_independent_unavailable_and_zero_observations() {
    let mut tracker = CpuTracker::new();
    let sources = MetricsSources::new(PathBuf::from("/proc/stat"), None);
    let mut entry = collect_metrics(&mut tracker, &sources, 0).await;
    let zero = disk::FilesystemObservation {
        used_bytes: 0,
        total_bytes: 200,
        available_bytes: 190,
        used_inodes: 0,
        total_inodes: 20,
        available_inodes: 19,
    };
    let expected_zero = serde_json::json!({
        "used_bytes": 0,
        "total_bytes": 200,
        "available_bytes": 190,
        "used_inodes": 0,
        "total_inodes": 20,
        "available_inodes": 19,
    });
    for (rootfs, home) in [(None, Some(zero)), (Some(zero), None), (None, None)] {
        entry.rootfs = rootfs;
        entry.home = home;
        let parsed = serde_json::to_value(&entry).unwrap();
        for (name, observation) in [("rootfs", rootfs), ("home", home)] {
            let expected = observation.map(|_| &expected_zero);
            assert_eq!(parsed.get(name), expected);
        }
    }
}
