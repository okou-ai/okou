//! System metrics collection: CPU, memory, disk.
//!
//! Reads `/proc/stat` for CPU, `/proc/meminfo` for memory, and uses
//! `libc::statvfs` for disk. Writes JSONL to the metrics log file.

use crate::constants;
use crate::workload_containment::CgroupCpuStatPaths;
use serde::Serialize;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

#[derive(Serialize)]
struct MetricsEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    memory: Option<guest_contracts::oom_evidence::OomEvidence>,
    ts: String,
    cpu: f64,
    cpu_steal_percent: f64,
    scheduled_lag_ms: u64,
    mem_used: u64,
    mem_total: u64,
    disk_used: u64,
    disk_total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_cpu_usage_usec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_cpu_nr_throttled: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_cpu_throttled_usec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workload_cpu_usage_usec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workload_cpu_nr_throttled: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workload_cpu_throttled_usec: Option<u64>,
}

/// Fixed metric sources for one Guest metrics task.
#[derive(Debug)]
pub struct MetricsSources {
    proc_stat: PathBuf,
    cgroup_cpu_stat: Option<CgroupCpuStatPaths>,
    evidence: Option<(
        crate::workload_containment::WorkloadContainment,
        crate::telemetry::IncidentReporter,
    )>,
}

impl MetricsSources {
    /// Build metric sources from an aggregate proc-stat path and optional cgroups.
    pub fn new(proc_stat: PathBuf, cgroup_cpu_stat: Option<CgroupCpuStatPaths>) -> Self {
        Self {
            proc_stat,
            cgroup_cpu_stat,
            evidence: None,
        }
    }

    /// Reuse the existing metrics tick for the root-owned evidence capture.
    pub fn with_evidence(
        mut self,
        containment: crate::workload_containment::WorkloadContainment,
        reporter: crate::telemetry::IncidentReporter,
    ) -> Self {
        self.evidence = Some((containment, reporter));
        self
    }
}

/// Loop-owned metrics destination with a lazily opened append handle.
///
/// The retained descriptor continues targeting the opened inode across path
/// replacement. A write failure drops it so the next tick securely reopens the
/// configured path.
struct MetricsSink {
    path: String,
    file: Option<File>,
}

impl MetricsSink {
    fn new(path: String) -> Self {
        Self { path, file: None }
    }

    fn append(&mut self, entry: &MetricsEntry) {
        let Ok(json) = serde_json::to_string(entry) else {
            return;
        };

        let file = match self.file.as_mut() {
            Some(file) => file,
            None => {
                let Ok(file) = guest_contracts::runtime_paths::open_private_append(&self.path)
                else {
                    return;
                };
                self.file.insert(file)
            }
        };

        if writeln!(file, "{json}").is_err() {
            self.file = None;
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CpuCounters {
    idle: u64,
    total: u64,
    steal: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct CpuPercentages {
    busy: f64,
    steal: f64,
}

/// Tracks previous `/proc/stat` counters for delta-based CPU measurement.
struct CpuTracker {
    previous: CpuCounters,
}

impl CpuTracker {
    fn new() -> Self {
        Self {
            previous: CpuCounters::default(),
        }
    }

    /// Read `/proc/stat` and compute CPU usage over the interval since the
    /// last call. The first call returns the cumulative average since boot
    /// (acceptable); subsequent calls return the delta-based percentage.
    fn get_cpu_percentages(&mut self, proc_stat: &Path) -> CpuPercentages {
        let content = match std::fs::read_to_string(proc_stat) {
            Ok(c) => c,
            Err(_) => return CpuPercentages::default(),
        };
        let first_line = match content.lines().next() {
            Some(l) => l,
            None => return CpuPercentages::default(),
        };
        self.get_cpu_percentages_from_stat_line(first_line)
    }

    fn get_cpu_percentages_from_stat_line(&mut self, line: &str) -> CpuPercentages {
        let current = match parse_cpu_stat_line(line) {
            Some(cpu_stat) => cpu_stat,
            None => return CpuPercentages::default(),
        };

        let Some(delta_idle) = current.idle.checked_sub(self.previous.idle) else {
            return CpuPercentages::default();
        };
        let Some(delta_total) = current.total.checked_sub(self.previous.total) else {
            return CpuPercentages::default();
        };
        let Some(delta_steal) = current.steal.checked_sub(self.previous.steal) else {
            return CpuPercentages::default();
        };
        let Some(delta_busy) = delta_total.checked_sub(delta_idle) else {
            return CpuPercentages::default();
        };
        if delta_total == 0 || delta_steal > delta_busy {
            return CpuPercentages::default();
        }

        self.previous = current;

        CpuPercentages {
            busy: percentage(delta_busy, delta_total),
            steal: percentage(delta_steal, delta_total),
        }
    }
}

fn percentage(part: u64, total: u64) -> f64 {
    let value = 100.0 * part as f64 / total as f64;
    (value * 100.0).round() / 100.0
}

fn parse_cpu_stat_line(line: &str) -> Option<CpuCounters> {
    let mut fields = line.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }

    let values: Vec<u64> = fields.map(|v| v.parse()).collect::<Result<_, _>>().ok()?;

    // idle, iowait, and steal are zero-based fields 3, 4, and 7 after the label.
    let [_, _, _, idle_ticks, iowait_ticks, _, _, steal_ticks, ..] = values.as_slice() else {
        return None;
    };
    let idle = idle_ticks.checked_add(*iowait_ticks)?;
    // Linux includes guest and guest_nice in user and nice, respectively.
    let total = values
        .iter()
        .enumerate()
        .filter(|(index, _)| !matches!(*index, 8 | 9))
        .try_fold(0u64, |total, (_, value)| total.checked_add(*value))?;

    Some(CpuCounters {
        idle,
        total,
        steal: *steal_ticks,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CgroupCpuStat {
    usage_usec: u64,
    nr_throttled: u64,
    throttled_usec: u64,
}

fn read_cgroup_cpu_stat(path: &Path) -> Option<CgroupCpuStat> {
    let content = std::fs::read_to_string(path).ok()?;
    parse_cgroup_cpu_stat(&content)
}

fn parse_cgroup_cpu_stat(content: &str) -> Option<CgroupCpuStat> {
    let mut usage_usec = None;
    let mut nr_throttled = None;
    let mut throttled_usec = None;

    for line in content.lines() {
        let mut fields = line.split_ascii_whitespace();
        let key = fields.next()?;
        let value = fields.next()?.parse::<u64>().ok()?;
        if fields.next().is_some() {
            return None;
        }
        match key {
            "usage_usec" => usage_usec = Some(value),
            "nr_throttled" => nr_throttled = Some(value),
            "throttled_usec" => throttled_usec = Some(value),
            _ => {}
        }
    }

    Some(CgroupCpuStat {
        usage_usec: usage_usec?,
        nr_throttled: nr_throttled?,
        throttled_usec: throttled_usec?,
    })
}

/// Parse `/proc/meminfo` to get (used, total) in bytes.
fn get_memory_info() -> (u64, u64) {
    let content = match std::fs::read_to_string("/proc/meminfo") {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };
    memory_info_from_content(&content)
}

fn memory_info_from_content(content: &str) -> (u64, u64) {
    let mut total_kb = 0u64;
    let mut available_kb = 0u64;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total_kb = parse_meminfo_value(rest);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            available_kb = parse_meminfo_value(rest);
        }
    }
    memory_usage_from_kb(total_kb, available_kb).unwrap_or((0, 0))
}

fn memory_usage_from_kb(total_kb: u64, available_kb: u64) -> Option<(u64, u64)> {
    let total = total_kb.checked_mul(1024)?;
    let available = available_kb.checked_mul(1024)?;
    let used = total.saturating_sub(available);
    Some((used, total))
}

fn parse_meminfo_value(s: &str) -> u64 {
    // Format: "     12345 kB"
    s.split_whitespace()
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Get disk usage for `/` via `libc::statvfs`. Returns (used, total) in bytes.
fn get_disk_info() -> (u64, u64) {
    let path = c"/";
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };
    if ret != 0 {
        return (0, 0);
    }
    let block_size = stat.f_frsize;
    disk_usage_from_blocks(stat.f_blocks, stat.f_bfree, block_size).unwrap_or((0, 0))
}

fn disk_usage_from_blocks(blocks: u64, free_blocks: u64, block_size: u64) -> Option<(u64, u64)> {
    let total = blocks.checked_mul(block_size)?;
    let free = free_blocks.checked_mul(block_size)?;
    let used = total.saturating_sub(free);
    Some((used, total))
}

fn elapsed_ms_since(scheduled_at: Instant) -> u64 {
    u64::try_from(
        Instant::now()
            .saturating_duration_since(scheduled_at)
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

/// Collect one snapshot of system metrics.
async fn collect_metrics(
    cpu_tracker: &mut CpuTracker,
    sources: &MetricsSources,
    scheduled_lag_ms: u64,
) -> MetricsEntry {
    let cpu = cpu_tracker.get_cpu_percentages(&sources.proc_stat);
    let (mem_used, mem_total) = get_memory_info();
    let (disk_used, disk_total) = get_disk_info();
    let control_cpu = sources
        .cgroup_cpu_stat
        .as_ref()
        .and_then(|paths| read_cgroup_cpu_stat(paths.control()));
    let workload_cpu = sources
        .cgroup_cpu_stat
        .as_ref()
        .and_then(|paths| read_cgroup_cpu_stat(paths.workload()));
    let memory = match sources.evidence.as_ref() {
        Some((containment, reporter)) => containment
            .oom_evidence(guest_contracts::oom_evidence::CaptureReason::Sample)
            .await
            .map(|mut evidence| {
                reporter.record(evidence.clone());
                evidence.incidents.clear();
                evidence
            }),
        None => None,
    };
    MetricsEntry {
        memory,
        ts: guest_telemetry::log::timestamp(),
        cpu: cpu.busy,
        cpu_steal_percent: cpu.steal,
        scheduled_lag_ms,
        mem_used,
        mem_total,
        disk_used,
        disk_total,
        control_cpu_usage_usec: control_cpu.map(|stat| stat.usage_usec),
        control_cpu_nr_throttled: control_cpu.map(|stat| stat.nr_throttled),
        control_cpu_throttled_usec: control_cpu.map(|stat| stat.throttled_usec),
        workload_cpu_usage_usec: workload_cpu.map(|stat| stat.usage_usec),
        workload_cpu_nr_throttled: workload_cpu.map(|stat| stat.nr_throttled),
        workload_cpu_throttled_usec: workload_cpu.map(|stat| stat.throttled_usec),
    }
}

/// Background loop writing metrics JSONL to an explicit runtime metrics file.
pub async fn metrics_loop_for_path(
    shutdown: CancellationToken,
    metrics_log_file: String,
    sources: MetricsSources,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(constants::METRICS_INTERVAL_SECS));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut cpu_tracker = CpuTracker::new();
    let mut metrics_sink = MetricsSink::new(metrics_log_file);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            scheduled_at = interval.tick() => {
                let scheduled_lag_ms = elapsed_ms_since(scheduled_at);
                tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => break,
                    entry = collect_metrics(&mut cpu_tracker, &sources, scheduled_lag_ms) => {
                        metrics_sink.append(&entry);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
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
    fn disk_usage_from_blocks_rejects_total_overflow() {
        assert_eq!(disk_usage_from_blocks(u64::MAX / 2 + 1, 0, 2), None);
    }

    #[test]
    fn disk_usage_from_blocks_rejects_free_overflow() {
        assert_eq!(disk_usage_from_blocks(1, u64::MAX / 2 + 1, 2), None);
    }

    #[test]
    fn disk_usage_from_blocks_saturates_used_when_free_exceeds_total() {
        assert_eq!(disk_usage_from_blocks(1, 2, 1024), Some((0, 1024)));
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

    #[test]
    fn get_disk_info_returns_valid_values() {
        let (used, total) = get_disk_info();
        assert!(total > 0, "total disk should be > 0");
        assert!(used <= total, "used should be <= total");
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
        assert!(entry.disk_total > 0);
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
        assert!(parsed["disk_total"].is_u64());
        assert!(parsed.get("control_cpu_usage_usec").is_none());
        assert!(parsed.get("workload_cpu_usage_usec").is_none());
    }
}
