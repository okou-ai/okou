use std::process::Stdio;

use serde_json::Value;
use tokio::process::Command as TokioCommand;

use crate::diskstats::{calculate_host_disk_iops, read_diskstats};
use crate::metrics::float_to_u64;

pub(crate) struct FioWorkload {
    pub(crate) name: &'static str,
    pub(crate) args: &'static str,
}

#[derive(Debug, Default)]
pub(crate) struct FioResult {
    /// IOPS as seen by the VM / fio
    pub(crate) vm_iops: u64,
    pub(crate) lat_p50_us: u64,
    pub(crate) lat_p99_us: u64,
    /// Read-plus-write completion IOPS observed on the selected host device.
    /// This is a whole-device counter delta and can include unrelated host I/O.
    pub(crate) host_disk_iops: u64,
}

/// Run fio while sampling `/proc/diskstats` before and after.
///
/// The host metric is the selected whole device's completed-read plus
/// completed-write counter delta divided by the fio interval. It can include
/// unrelated host I/O on that device and is not limited to requests issued by
/// fio.
pub(crate) async fn run_fio_with_iostat(
    device: &str,
    workload: &FioWorkload,
    host_disk: &str,
) -> Result<FioResult, String> {
    // Snapshot disk stats before
    let before = read_diskstats(host_disk)?;

    let start = std::time::Instant::now();

    let mut cmd = TokioCommand::new("fio");
    cmd.stdin(Stdio::null())
        .arg(format!("--name={}", workload.name))
        .arg(format!("--filename={device}"))
        .args(workload.args.split_whitespace())
        .arg("--runtime=10")
        .arg("--time_based")
        .arg("--output-format=json")
        .arg("--group_reporting=1")
        .arg("--unified_rw_reporting=1")
        .kill_on_drop(true);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("fio failed to start: {e}"))?;

    let elapsed_secs = start.elapsed().as_secs_f64();

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("fio failed: {stderr}"));
    }

    // Snapshot disk stats after
    let after = read_diskstats(host_disk)?;

    let mut result = parse_fio_json(&output.stdout)?;

    result.host_disk_iops = calculate_host_disk_iops(&before, &after, elapsed_secs)?;

    eprintln!(
        "    VM IOPS: {}, Selected host-device IOPS: {}, Duration: {:.1}s",
        result.vm_iops, result.host_disk_iops, elapsed_secs
    );

    Ok(result)
}

fn parse_fio_json(stdout: &[u8]) -> Result<FioResult, String> {
    let root: Value = serde_json::from_slice(stdout).map_err(|e| format!("parse fio JSON: {e}"))?;
    let jobs = fio_jobs(&root)?;
    let active_source = select_active_fio_source(jobs);
    let vm_iops = active_source_vm_iops(&active_source, jobs)?;
    let (lat_p50_us, lat_p99_us) = active_source_latency_us(&active_source)?;

    Ok(FioResult {
        vm_iops: float_to_u64(vm_iops, "fio JSON VM IOPS")?,
        lat_p50_us,
        lat_p99_us,
        host_disk_iops: 0,
    })
}

fn fio_jobs(root: &Value) -> Result<&[Value], String> {
    let jobs = root
        .get("jobs")
        .and_then(Value::as_array)
        .ok_or_else(|| "fio JSON missing jobs array".to_string())?;
    if jobs.is_empty() {
        return Err("fio JSON jobs array is empty".to_string());
    }
    Ok(jobs)
}

enum ActiveFioSource<'a> {
    Mixed(Vec<&'a Value>),
    Directions(ActiveDirections<'a>),
    None,
}

struct ActiveDirections<'a> {
    sections_in_iops_order: Vec<&'a Value>,
    by_direction: Vec<ActiveDirectionSections<'a>>,
}

struct ActiveDirectionSections<'a> {
    name: &'static str,
    sections: Vec<&'a Value>,
}

const DIRECTIONS: [&str; 3] = ["read", "write", "trim"];

fn select_active_fio_source(jobs: &[Value]) -> ActiveFioSource<'_> {
    let mixed_sections = active_sections(jobs, "mixed");
    if !mixed_sections.is_empty() {
        return ActiveFioSource::Mixed(mixed_sections);
    }

    let by_direction = DIRECTIONS
        .iter()
        .copied()
        .filter_map(|direction| {
            let sections = active_sections(jobs, direction);
            (!sections.is_empty()).then_some(ActiveDirectionSections {
                name: direction,
                sections,
            })
        })
        .collect::<Vec<_>>();

    if by_direction.is_empty() {
        ActiveFioSource::None
    } else {
        ActiveFioSource::Directions(ActiveDirections {
            sections_in_iops_order: active_direction_sections_in_iops_order(jobs),
            by_direction,
        })
    }
}

fn active_direction_sections_in_iops_order(jobs: &[Value]) -> Vec<&Value> {
    jobs.iter()
        .flat_map(|job| {
            DIRECTIONS
                .iter()
                .filter_map(move |direction| job.get(*direction))
        })
        .filter(|section| section_is_active(section))
        .collect()
}

fn active_sections<'a>(jobs: &'a [Value], section_name: &str) -> Vec<&'a Value> {
    jobs.iter()
        .filter_map(|job| job.get(section_name))
        .filter(|section| section_is_active(section))
        .collect()
}

fn active_source_vm_iops(
    active_source: &ActiveFioSource<'_>,
    jobs: &[Value],
) -> Result<f64, String> {
    match active_source {
        ActiveFioSource::Mixed(sections) => sum_section_iops(sections, "mixed"),
        ActiveFioSource::Directions(directions) => {
            sum_section_iops(&directions.sections_in_iops_order, "active direction")
        }
        ActiveFioSource::None => fallback_direction_iops(jobs),
    }
}

fn fallback_direction_iops(jobs: &[Value]) -> Result<f64, String> {
    let mut saw_iops = false;
    let total = jobs
        .iter()
        .flat_map(|job| DIRECTIONS.iter().map(move |direction| (job, *direction)))
        .filter_map(|(job, direction)| {
            section_iops(job, direction).inspect(|_| {
                saw_iops = true;
            })
        })
        .sum::<f64>();

    if !saw_iops {
        return Err("fio JSON missing IOPS fields".to_string());
    }
    Ok(total)
}

fn active_source_latency_us(active_source: &ActiveFioSource<'_>) -> Result<(u64, u64), String> {
    match active_source {
        ActiveFioSource::Mixed(sections) => single_latency_section(sections, "mixed"),
        ActiveFioSource::None => {
            Err("fio JSON has no active read/write/trim direction".to_string())
        }
        ActiveFioSource::Directions(directions) => match directions.by_direction.as_slice() {
            [] => Err("fio JSON has no active read/write/trim direction".to_string()),
            [direction] => single_latency_section(&direction.sections, direction.name),
            directions => {
                let direction_names = directions
                    .iter()
                    .map(|direction| direction.name)
                    .collect::<Vec<_>>();
                Err(format!(
                    "fio JSON has mixed directions ({}) but no unified mixed latency; rerun with --unified_rw_reporting=1",
                    direction_names.join(",")
                ))
            }
        },
    }
}

fn section_iops(job: &Value, section: &str) -> Option<f64> {
    nonnegative_f64(job.get(section)?.get("iops")?)
}

fn sum_section_iops(sections: &[&Value], section_name: &str) -> Result<f64, String> {
    sections
        .iter()
        .map(|section| {
            section
                .get("iops")
                .and_then(nonnegative_f64)
                .ok_or_else(|| format!("fio JSON missing {section_name} IOPS for active section"))
        })
        .sum()
}

fn section_is_active(section: &Value) -> bool {
    section_total_ios(section).unwrap_or(0) > 0
        || section.get("iops").and_then(nonnegative_f64).unwrap_or(0.0) > 0.0
}

fn section_total_ios(section: &Value) -> Option<u64> {
    section.get("total_ios")?.as_u64()
}

fn section_latency_us(section: &Value, section_name: &str) -> Result<(u64, u64), String> {
    let p50 = percentile_us(section, "50.000000")
        .ok_or_else(|| format!("fio JSON missing {section_name} p50 latency"))?;
    let p99 = percentile_us(section, "99.000000")
        .ok_or_else(|| format!("fio JSON missing {section_name} p99 latency"))?;
    Ok((p50, p99))
}

fn single_latency_section(sections: &[&Value], section_name: &str) -> Result<(u64, u64), String> {
    match sections {
        [] => Err(format!(
            "fio JSON missing {section_name} latency percentiles"
        )),
        [section] => section_latency_us(section, section_name),
        _ => Err(format!(
            "fio JSON has multiple {section_name} latency sections; rerun with --group_reporting=1"
        )),
    }
}

fn percentile_us(section: &Value, percentile: &str) -> Option<u64> {
    let value = section.get("clat_ns")?.get("percentile")?.get(percentile)?;
    let ns = value.as_u64().or_else(|| {
        nonnegative_f64(value)
            .filter(|value| *value < u64::MAX as f64)
            .map(|value| value as u64)
    })?;
    Some(ns / 1000)
}

fn nonnegative_f64(value: &Value) -> Option<f64> {
    let value = value.as_f64()?;
    value
        .is_finite()
        .then_some(value)
        .filter(|value| *value >= 0.0)
}

#[cfg(test)]
mod tests;
