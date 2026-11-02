use std::process::Command;

use crate::metrics::float_to_u64;

/// Snapshot of /proc/diskstats for a specific device.
#[derive(Debug, Clone)]
pub(crate) struct DiskStats {
    reads_completed: u64,
    writes_completed: u64,
}

impl DiskStats {
    fn total_ios(&self) -> u64 {
        self.reads_completed.saturating_add(self.writes_completed)
    }
}

pub(crate) fn calculate_host_disk_iops(
    before: &DiskStats,
    after: &DiskStats,
    elapsed_secs: f64,
) -> Result<u64, String> {
    if !elapsed_secs.is_finite() || elapsed_secs < 0.0 {
        return Err("host disk IOPS duration is invalid".to_string());
    }
    if elapsed_secs == 0.0 {
        return Ok(0);
    }

    let before_ios = before.total_ios();
    let after_ios = after.total_ios();
    if after_ios < before_ios {
        return Err("host disk IOPS counters decreased during fio run".to_string());
    }

    let delta_ios = after_ios - before_ios;
    float_to_u64(delta_ios as f64 / elapsed_secs, "host disk IOPS")
}

/// Read /proc/diskstats for a given device name.
///
/// Format: major minor name rd_ios rd_merges rd_sectors rd_ticks
///         wr_ios wr_merges wr_sectors wr_ticks ...
pub(crate) fn read_diskstats(device_name: &str) -> Result<DiskStats, String> {
    let content =
        std::fs::read_to_string("/proc/diskstats").map_err(|e| format!("read diskstats: {e}"))?;
    parse_diskstats(&content, device_name)
}

fn parse_diskstats(content: &str, device_name: &str) -> Result<DiskStats, String> {
    for (line_number, line) in content.lines().enumerate() {
        let mut fields = line.split_whitespace();
        let _major = fields.next();
        let _minor = fields.next();
        let Some(name) = fields.next() else {
            continue;
        };

        if name == device_name {
            let Some(reads_field) = fields.next() else {
                return Err(format!(
                    "diskstats line {} for {device_name} has too few fields",
                    line_number + 1
                ));
            };
            for _ in 0..3 {
                if fields.next().is_none() {
                    return Err(format!(
                        "diskstats line {} for {device_name} has too few fields",
                        line_number + 1
                    ));
                }
            }
            let Some(writes_field) = fields.next() else {
                return Err(format!(
                    "diskstats line {} for {device_name} has too few fields",
                    line_number + 1
                ));
            };
            let reads = reads_field.parse::<u64>().map_err(|e| {
                format!(
                    "diskstats line {} has invalid read count for {device_name}: {e}",
                    line_number + 1
                )
            })?;
            let writes = writes_field.parse::<u64>().map_err(|e| {
                format!(
                    "diskstats line {} has invalid write count for {device_name}: {e}",
                    line_number + 1
                )
            })?;
            return Ok(DiskStats {
                reads_completed: reads,
                writes_completed: writes,
            });
        }
    }

    Err(format!("device {device_name} not found in /proc/diskstats"))
}

fn diskstats_contains_device(content: &str, device_name: &str) -> bool {
    content.lines().any(|line| {
        line.split_whitespace()
            .nth(2)
            .is_some_and(|name| name == device_name)
    })
}

/// Select the host device whose `/proc/diskstats` counters will be sampled.
///
/// The direct lookup runs `df /tmp`. If its device can be normalized and found
/// in `/proc/diskstats`, that device is selected. If `df` cannot be started or
/// its output has no usable mapped device, including an unmappable filesystem
/// such as `overlay` or the special `/dev/root` result, selection falls back to
/// the following order:
///
/// 1. The first available device among `nvme0n1`, `xvda`, `sda`, and `vda`.
/// 2. The first likely whole-disk entry in `/proc/diskstats` whose name starts
///    with `nvme`, `mmcblk`, `xvd`, `sd`, or `vd`.
///
/// A fallback is heuristic. It does not prove that the selected device backs
/// `/tmp` or the benchmark work directory, which is created under the process
/// temp-directory configuration and may use a different path.
pub(crate) fn detect_host_disk() -> Result<String, String> {
    let stats =
        std::fs::read_to_string("/proc/diskstats").map_err(|e| format!("read diskstats: {e}"))?;

    // Try to find the device for /tmp via df
    if let Ok(output) = Command::new("df").arg("/tmp").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(line) = stdout.lines().nth(1)
            && let Some(dev) = line.split_whitespace().next()
            && let Some(device) = host_disk_from_df_device(dev, &stats)
        {
            return Ok(device);
        }
    }

    known_host_disk_candidate(&stats)
        .ok_or_else(|| "failed to detect a host disk present in /proc/diskstats".to_string())
}

fn host_disk_from_df_device(dev: &str, diskstats: &str) -> Option<String> {
    if dev == "/dev/root" {
        return known_host_disk_candidate(diskstats);
    }

    let device = diskstats_device_name(dev);
    diskstats_contains_device(diskstats, &device).then_some(device)
}

fn known_host_disk_candidate(diskstats: &str) -> Option<String> {
    ["nvme0n1", "xvda", "sda", "vda"]
        .iter()
        .find(|candidate| diskstats_contains_device(diskstats, candidate))
        .map(|candidate| (*candidate).to_string())
        .or_else(|| {
            diskstats
                .lines()
                .filter_map(|line| line.split_whitespace().nth(2))
                .find(|device| is_likely_host_disk_device(device))
                .map(str::to_string)
        })
}

fn is_likely_host_disk_device(device: &str) -> bool {
    ["nvme", "mmcblk", "xvd", "sd", "vd"]
        .iter()
        .any(|prefix| device.starts_with(prefix))
        && diskstats_device_name(&format!("/dev/{device}")) == device
}

fn diskstats_device_name(path: &str) -> String {
    let name = path.trim_start_matches("/dev/");

    if let Some((base, partition)) = name.rsplit_once('p')
        && !partition.is_empty()
        && partition.chars().all(|c| c.is_ascii_digit())
        && ["nvme", "mmcblk", "nbd", "loop"]
            .iter()
            .any(|prefix| base.starts_with(prefix))
    {
        return base.to_string();
    }

    let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
    if base.len() != name.len()
        && ["sd", "vd", "xvd"]
            .iter()
            .any(|prefix| base.starts_with(prefix))
    {
        return base.to_string();
    }

    name.to_string()
}

#[cfg(test)]
mod tests;
