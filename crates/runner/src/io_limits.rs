//! Runner-owned I/O limiter policy.
//!
//! Host-local capacity is optional and belongs at the runner boundary. This
//! module converts that capacity into provider-neutral per-sandbox limits.

use std::collections::BTreeMap;

use sandbox::{BlockRateLimits, DeviceRateLimits, NetworkRateLimits};

use crate::config::ProfileConfig;
use crate::resource_budget::ResourceBudget;
use runner_host::host_env::{self, HostEnvValue, RunnerHostEnv, RunnerIoEnvValues};

const MIB: f64 = 1024.0 * 1024.0;
// Keep host-level headroom outside Firecracker token buckets for system daemons,
// filesystem metadata bursts, and other non-sandbox traffic.
const IO_CAPACITY_PERCENT: u128 = 100;
const IO_RESERVE_PERCENT: u128 = 20;
const MIN_POSITIVE_SANDBOX_RATE: u64 = 1;
const MIN_WRITABLE_BLOCK_DRIVES_PER_SANDBOX: u64 = 2;
const MAX_DENOMINATOR_DP_CELLS: usize = 1_000_000;
const MAX_DENOMINATOR_DP_STEPS: usize = 5_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IoLimitResolution {
    Disabled,
    Misconfigured {
        reason: String,
    },
    Configured {
        limits: DeviceRateLimits,
        denominator: u64,
    },
}

impl IoLimitResolution {
    pub(crate) fn device_rate_limits(&self) -> Option<DeviceRateLimits> {
        match self {
            Self::Configured { limits, .. } => Some(limits.clone()),
            Self::Disabled | Self::Misconfigured { .. } => None,
        }
    }
}

pub(crate) fn resolve_io_limits(
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
    host_env: &RunnerHostEnv,
) -> IoLimitResolution {
    let values = host_env.io_values();
    resolve_io_limits_from_values(&values, profiles, budget)
}

fn resolve_io_limits_from_values(
    values: &RunnerIoEnvValues,
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
) -> IoLimitResolution {
    let entries = [
        (
            host_env::RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
            values.disk_bandwidth_mib_per_sec.as_ref(),
        ),
        (host_env::RUNNER_DISK_IOPS_ENV, values.disk_iops.as_ref()),
        (
            host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV,
            values.net_rx_mib_per_sec.as_ref(),
        ),
        (
            host_env::RUNNER_NET_TX_MIB_PER_SEC_ENV,
            values.net_tx_mib_per_sec.as_ref(),
        ),
    ];

    let present = entries.iter().filter(|(_, value)| value.is_some()).count();
    if present == 0 {
        return IoLimitResolution::Disabled;
    }
    if present != entries.len() {
        let missing = entries
            .iter()
            .filter_map(|(key, value)| value.is_none().then_some(*key))
            .collect::<Vec<_>>()
            .join(", ");
        return IoLimitResolution::Misconfigured {
            reason: format!("incomplete I/O limiter host env config; missing: {missing}"),
        };
    }

    let Some(disk_bandwidth_bytes_per_sec) =
        parse_mib_per_sec(values.disk_bandwidth_mib_per_sec.as_ref())
    else {
        return invalid_value_resolution(host_env::RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV);
    };
    let Some(disk_ops_per_sec) = parse_positive_u64(values.disk_iops.as_ref()) else {
        return IoLimitResolution::Misconfigured {
            reason: format!(
                "{} must be a positive integer",
                host_env::RUNNER_DISK_IOPS_ENV
            ),
        };
    };
    let Some(net_rx_bytes_per_sec) = parse_mib_per_sec(values.net_rx_mib_per_sec.as_ref()) else {
        return invalid_value_resolution(host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV);
    };
    let Some(net_tx_bytes_per_sec) = parse_mib_per_sec(values.net_tx_mib_per_sec.as_ref()) else {
        return invalid_value_resolution(host_env::RUNNER_NET_TX_MIB_PER_SEC_ENV);
    };

    let denominator = admitted_sandbox_denominator(profiles, budget);
    let Some(block_bandwidth_bytes_per_sec) = per_sandbox_capacity(
        disk_bandwidth_bytes_per_sec,
        denominator,
        MIN_WRITABLE_BLOCK_DRIVES_PER_SANDBOX,
    ) else {
        return insufficient_capacity_resolution(
            host_env::RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
            denominator,
            MIN_WRITABLE_BLOCK_DRIVES_PER_SANDBOX,
        );
    };
    let Some(block_ops_per_sec) = per_sandbox_capacity(
        disk_ops_per_sec,
        denominator,
        MIN_WRITABLE_BLOCK_DRIVES_PER_SANDBOX,
    ) else {
        return insufficient_capacity_resolution(
            host_env::RUNNER_DISK_IOPS_ENV,
            denominator,
            MIN_WRITABLE_BLOCK_DRIVES_PER_SANDBOX,
        );
    };
    let Some(net_rx_bytes_per_sec) =
        per_sandbox_capacity(net_rx_bytes_per_sec, denominator, MIN_POSITIVE_SANDBOX_RATE)
    else {
        return insufficient_capacity_resolution(
            host_env::RUNNER_NET_RX_MIB_PER_SEC_ENV,
            denominator,
            MIN_POSITIVE_SANDBOX_RATE,
        );
    };
    let Some(net_tx_bytes_per_sec) =
        per_sandbox_capacity(net_tx_bytes_per_sec, denominator, MIN_POSITIVE_SANDBOX_RATE)
    else {
        return insufficient_capacity_resolution(
            host_env::RUNNER_NET_TX_MIB_PER_SEC_ENV,
            denominator,
            MIN_POSITIVE_SANDBOX_RATE,
        );
    };

    IoLimitResolution::Configured {
        denominator,
        limits: DeviceRateLimits {
            block: BlockRateLimits {
                bandwidth_bytes_per_sec: block_bandwidth_bytes_per_sec,
                ops_per_sec: block_ops_per_sec,
            },
            network: NetworkRateLimits {
                rx_bytes_per_sec: net_rx_bytes_per_sec,
                tx_bytes_per_sec: net_tx_bytes_per_sec,
            },
        },
    }
}

fn invalid_value_resolution(key: &'static str) -> IoLimitResolution {
    IoLimitResolution::Misconfigured {
        reason: format!("{key} must be a positive finite number"),
    }
}

fn insufficient_capacity_resolution(
    key: &'static str,
    denominator: u64,
    minimum_per_sandbox: u64,
) -> IoLimitResolution {
    let unit = if minimum_per_sandbox == 1 {
        "unit"
    } else {
        "units"
    };
    IoLimitResolution::Misconfigured {
        reason: format!(
            "{key} is too small to allocate at least {minimum_per_sandbox} {unit} per admitted sandbox after reserve (denominator: {denominator})"
        ),
    }
}

fn parse_mib_per_sec(value: Option<&HostEnvValue>) -> Option<u64> {
    parse_positive_f64(value).and_then(|mib_per_sec| {
        let bytes_per_sec = mib_per_sec * MIB;
        if !bytes_per_sec.is_finite() || bytes_per_sec < 1.0 || bytes_per_sec > u64::MAX as f64 {
            return None;
        }
        let bytes_per_sec = bytes_per_sec.floor() as u64;
        if bytes_per_sec > 0 {
            Some(bytes_per_sec)
        } else {
            None
        }
    })
}

fn parse_positive_u64(value: Option<&HostEnvValue>) -> Option<u64> {
    let value = value?;
    let parsed = value.value.parse::<u64>().ok()?;
    (parsed > 0).then_some(parsed)
}

fn parse_positive_f64(value: Option<&HostEnvValue>) -> Option<f64> {
    let value = value?;
    let parsed = value.value.parse::<f64>().ok()?;
    if !parsed.is_finite() || parsed <= 0.0 || parsed > u64::MAX as f64 {
        return None;
    }
    Some(parsed)
}

fn admitted_sandbox_denominator(
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
) -> u64 {
    let mut profile_shapes = profiles
        .values()
        .map(|profile| {
            (
                profile.vcpu.max(1) as usize,
                profile.memory_mb.max(1) as u64,
            )
        })
        .collect::<Vec<_>>();
    profile_shapes.sort_unstable();
    profile_shapes.dedup();
    let Some(min_vcpu) = profile_shapes.iter().map(|(vcpu, _)| *vcpu).min() else {
        return 1;
    };
    let Some(min_memory_mb) = profile_shapes.iter().map(|(_, memory_mb)| *memory_mb).min() else {
        return 1;
    };

    let cpu_capacity = budget.effective_vcpu().max(1) as usize;
    let memory_capacity = budget.effective_memory_mb().max(1) as u64;
    let cpu_upper_bound = cpu_capacity / min_vcpu;
    let memory_upper_bound = (memory_capacity / min_memory_mb) as usize;
    let mut count_upper_bound = cpu_upper_bound.min(memory_upper_bound);
    if budget.max_concurrent() > 0 {
        count_upper_bound = count_upper_bound.min(budget.max_concurrent());
    }
    let count_upper_bound = count_upper_bound.max(1);

    let width = cpu_capacity + 1;
    let Some(cells) = (count_upper_bound + 1).checked_mul(width) else {
        return count_upper_bound as u64;
    };
    if cells > MAX_DENOMINATOR_DP_CELLS {
        return count_upper_bound as u64;
    }
    if cells
        .checked_mul(profile_shapes.len().max(1))
        .is_none_or(|steps| steps > MAX_DENOMINATOR_DP_STEPS)
    {
        return count_upper_bound as u64;
    }

    // Exact admission count for heterogeneous profiles. The table stores the
    // minimum memory needed to run `count` sandboxes using exactly `cpu` vCPUs.
    let mut min_memory_by_count_and_cpu = vec![u64::MAX; cells];
    if let Some(origin) = min_memory_by_count_and_cpu.get_mut(0) {
        *origin = 0;
    }
    let mut best = 0usize;
    for count in 1..=count_upper_bound {
        for cpu in 1..=cpu_capacity {
            let mut min_memory = u64::MAX;
            for (profile_vcpu, profile_memory_mb) in &profile_shapes {
                if *profile_vcpu > cpu {
                    continue;
                }
                let Some(previous_index) =
                    denominator_table_index(count - 1, cpu - *profile_vcpu, width)
                else {
                    continue;
                };
                let Some(previous) = min_memory_by_count_and_cpu.get(previous_index).copied()
                else {
                    continue;
                };
                let Some(candidate) = previous.checked_add(*profile_memory_mb) else {
                    continue;
                };
                if candidate <= memory_capacity {
                    min_memory = min_memory.min(candidate);
                }
            }
            if let Some(index) = denominator_table_index(count, cpu, width)
                && let Some(cell) = min_memory_by_count_and_cpu.get_mut(index)
            {
                *cell = min_memory;
            }
            if min_memory <= memory_capacity {
                best = best.max(count);
            }
        }
    }

    best.max(1) as u64
}

fn denominator_table_index(count: usize, cpu: usize, width: usize) -> Option<usize> {
    count.checked_mul(width)?.checked_add(cpu)
}

fn per_sandbox_capacity(
    host_capacity: u64,
    denominator: u64,
    minimum_per_sandbox: u64,
) -> Option<u64> {
    let usable = ((host_capacity as u128) * (IO_CAPACITY_PERCENT - IO_RESERVE_PERCENT))
        / IO_CAPACITY_PERCENT;
    let usable = u64::try_from(usable).ok()?;
    let capacity = usable / denominator.max(1);
    (capacity >= minimum_per_sandbox).then_some(capacity)
}

#[cfg(test)]
mod tests;
