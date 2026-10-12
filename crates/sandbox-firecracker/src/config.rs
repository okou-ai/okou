//! Configuration types for the Firecracker sandbox backend.

use std::num::NonZeroU64;
use std::path::PathBuf;

pub(crate) const RATE_LIMITER_REFILL_TIME_MS: u64 = 100;
const MILLIS_PER_SECOND: u64 = 1000;
const RATE_LIMITER_REFILLS_PER_SECOND: u64 = MILLIS_PER_SECOND / RATE_LIMITER_REFILL_TIME_MS;

/// Configuration used to create Firecracker sandbox factories.
#[derive(Debug, Clone)]
pub struct FirecrackerConfig {
    /// Path to the Firecracker executable.
    pub binary_path: PathBuf,
    /// Path to the kernel image used to boot the microVM.
    pub kernel_path: PathBuf,
    /// Path to the rootfs image used as the microVM drive.
    pub rootfs_path: PathBuf,
    /// Base directory for runtime data (workspaces, COW devices, etc.).
    pub base_dir: PathBuf,
    /// Profile name (e.g., "vm0/default") used for per-profile isolation.
    pub profile: String,
    /// Host proxy port for outbound TCP redirects. When `dns_port` is also set,
    /// those redirects exclude TCP 53 and 853: TCP 53 is redirected to
    /// `dns_port`, while TCP 853 is blocked.
    pub proxy_port: Option<u16>,
    /// Port of the DNS proxy. When set, iptables rules redirect DNS queries through it.
    pub dns_port: Option<u16>,
    /// Snapshot to restore from. When set, VMs boot via snapshot restore instead of fresh boot.
    pub snapshot: Option<SnapshotConfig>,
}

/// Snapshot restore artifacts and bind-path metadata for Firecracker.
#[derive(Debug, Clone)]
pub struct SnapshotConfig {
    /// Path to the snapshot state file.
    pub snapshot_path: PathBuf,
    /// Path to the memory dump file.
    pub memory_path: PathBuf,
    /// Path to the golden COW file shipped with the snapshot.
    pub cow_path: PathBuf,
    /// Drive path recorded in the snapshot's Firecracker config (bind mount target).
    pub drive_bind_path: PathBuf,
    /// Workspace drive path recorded in the snapshot's Firecracker config.
    pub home_drive_bind_path: PathBuf,
    /// Vsock directory recorded in the snapshot's Firecracker config.
    ///
    /// Restore expects this to be the private runtime bind target
    /// `/run/vm0/sock/<snapshot-id>/vsock`.
    pub vsock_bind_dir: PathBuf,
}

/// Firecracker-specific token bucket configuration used in API payloads.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct TokenBucketConfig {
    /// Token bucket capacity over `refill_time`.
    ///
    /// The token unit depends on the containing rate limiter dimension: bytes
    /// for bandwidth buckets, operations for ops buckets.
    pub size: u64,
    /// Time, in milliseconds, for Firecracker to refill the bucket to `size`.
    pub refill_time: u64,
}

/// Firecracker-specific rate limiter configuration used in API payloads.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct RateLimiterConfig {
    /// Byte-rate token bucket for bandwidth limiting.
    ///
    /// When `None`, this dimension is omitted from the Firecracker payload and
    /// is not applied to the device.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bandwidth: Option<TokenBucketConfig>,
    /// Operation-rate token bucket for operation-count limiting.
    ///
    /// When `None`, this dimension is omitted from the Firecracker payload and
    /// is not applied to the device.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops: Option<TokenBucketConfig>,
}

/// Firecracker device rate limiters.
///
/// This is the Firecracker-specific representation. Provider-neutral sandbox
/// creation should use `sandbox::DeviceRateLimits`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirecrackerDeviceRateLimits {
    /// Sandbox-level block-device budget.
    ///
    /// Firecracker limiters are attached per drive, so callers must split this
    /// budget across all block drives they attach for a sandbox.
    pub block: sandbox::BlockRateLimits,
    /// Receive-side rate limiter applied to the Firecracker network interface.
    ///
    /// The provider-neutral conversion populates bandwidth only and leaves ops
    /// unset for network receive traffic.
    pub net_rx: RateLimiterConfig,
    /// Transmit-side rate limiter applied to the Firecracker network interface.
    ///
    /// The provider-neutral conversion populates bandwidth only and leaves ops
    /// unset for network transmit traffic.
    pub net_tx: RateLimiterConfig,
}

impl TryFrom<&sandbox::DeviceRateLimits> for FirecrackerDeviceRateLimits {
    type Error = String;

    fn try_from(limits: &sandbox::DeviceRateLimits) -> Result<Self, Self::Error> {
        validate_positive(
            "block bandwidth_bytes_per_sec",
            limits.block.bandwidth_bytes_per_sec,
        )?;
        validate_positive("block ops_per_sec", limits.block.ops_per_sec)?;
        Ok(Self {
            block: limits.block.clone(),
            net_rx: RateLimiterConfig {
                bandwidth: Some(positive_token_bucket(
                    "network rx_bytes_per_sec",
                    limits.network.rx_bytes_per_sec,
                )?),
                ops: None,
            },
            net_tx: RateLimiterConfig {
                bandwidth: Some(positive_token_bucket(
                    "network tx_bytes_per_sec",
                    limits.network.tx_bytes_per_sec,
                )?),
                ops: None,
            },
        })
    }
}

impl FirecrackerDeviceRateLimits {
    /// Build the limiter applied to each writable block drive.
    ///
    /// `sandbox::DeviceRateLimits::block` is a sandbox-level budget. Since
    /// Firecracker limiters are per-drive, split that budget across all block
    /// drives to keep aggregate block I/O within the runner's per-sandbox
    /// allocation.
    pub(crate) fn block_drive_limiter(
        &self,
        drive_count: NonZeroU64,
    ) -> Result<RateLimiterConfig, String> {
        let drive_count = drive_count.get();
        let bandwidth = self.block.bandwidth_bytes_per_sec / drive_count;
        let ops = self.block.ops_per_sec / drive_count;
        Ok(RateLimiterConfig {
            bandwidth: Some(positive_token_bucket(
                "per-drive block bandwidth_bytes_per_sec",
                bandwidth,
            )?),
            ops: Some(positive_token_bucket("per-drive block ops_per_sec", ops)?),
        })
    }
}

fn validate_positive(name: &'static str, rate_per_sec: u64) -> Result<(), String> {
    NonZeroU64::new(rate_per_sec)
        .map(|_| ())
        .ok_or_else(|| format!("{name} must be positive"))
}

fn positive_token_bucket(
    name: &'static str,
    rate_per_sec: u64,
) -> Result<TokenBucketConfig, String> {
    let rate_per_sec =
        NonZeroU64::new(rate_per_sec).ok_or_else(|| format!("{name} must be positive"))?;
    Ok(token_bucket(rate_per_sec))
}

fn token_bucket(rate_per_sec: NonZeroU64) -> TokenBucketConfig {
    let rate_per_sec = rate_per_sec.get();
    let size = rate_per_sec / RATE_LIMITER_REFILLS_PER_SECOND;
    if size > 0 {
        return TokenBucketConfig {
            size,
            refill_time: RATE_LIMITER_REFILL_TIME_MS,
        };
    }

    TokenBucketConfig {
        size: 1,
        refill_time: MILLIS_PER_SECOND.div_ceil(rate_per_sec),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonzero(value: u64) -> NonZeroU64 {
        NonZeroU64::new(value).expect("test rate must be non-zero")
    }

    fn positive_device_rate_limits() -> sandbox::DeviceRateLimits {
        sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 100 * 1024 * 1024,
                ops_per_sec: 10_000,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 50 * 1024 * 1024,
                tx_bytes_per_sec: 25 * 1024 * 1024,
            },
        }
    }

    fn assert_zero_rate_rejected(limits: &sandbox::DeviceRateLimits, expected_dimension: &str) {
        let err = FirecrackerDeviceRateLimits::try_from(limits).unwrap_err();

        assert!(
            err.contains(expected_dimension),
            "error does not identify {expected_dimension}: {err}"
        );
        assert!(
            err.contains("positive"),
            "error does not require a positive rate: {err}"
        );
    }

    #[test]
    fn token_bucket_uses_100ms_refill_window() {
        let bucket = token_bucket(nonzero(100 * 1024 * 1024));

        assert_eq!(bucket.size, 10 * 1024 * 1024);
        assert_eq!(bucket.refill_time, RATE_LIMITER_REFILL_TIME_MS);
    }

    #[test]
    fn token_bucket_uses_longer_refill_window_for_low_rates() {
        let bucket = token_bucket(nonzero(3));

        assert_eq!(bucket.size, 1);
        assert_eq!(bucket.refill_time, 334);
    }

    #[test]
    fn device_limits_convert_to_firecracker_limiters() {
        let limits = sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 100 * 1024 * 1024,
                ops_per_sec: 10_000,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 50 * 1024 * 1024,
                tx_bytes_per_sec: 25 * 1024 * 1024,
            },
        };

        let fc = FirecrackerDeviceRateLimits::try_from(&limits).unwrap();
        let block_limiter = fc.block_drive_limiter(nonzero(1)).unwrap();

        assert_eq!(fc.block, limits.block);
        assert_eq!(block_limiter.bandwidth.unwrap().size, 10 * 1024 * 1024);
        assert_eq!(block_limiter.ops.unwrap().size, 1_000);
        assert_eq!(fc.net_rx.bandwidth.unwrap().size, 5 * 1024 * 1024);
        assert_eq!(fc.net_tx.bandwidth.unwrap().size, 2_621_440);
        assert_eq!(fc.net_rx.ops, None);
        assert_eq!(fc.net_tx.ops, None);
    }

    #[test]
    fn block_drive_limiter_splits_budget_across_drives() {
        let limits = sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 100 * 1024 * 1024,
                ops_per_sec: 10_000,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 50 * 1024 * 1024,
                tx_bytes_per_sec: 25 * 1024 * 1024,
            },
        };
        let fc = FirecrackerDeviceRateLimits::try_from(&limits).unwrap();

        let block_limiter = fc.block_drive_limiter(nonzero(2)).unwrap();

        assert_eq!(block_limiter.bandwidth.unwrap().size, 5 * 1024 * 1024);
        assert_eq!(block_limiter.ops.unwrap().size, 500);
    }

    #[test]
    fn block_drive_limiter_rejects_bandwidth_budget_that_cannot_be_split() {
        let limits = sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 1,
                ops_per_sec: 2,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 1,
                tx_bytes_per_sec: 1,
            },
        };
        let fc = FirecrackerDeviceRateLimits::try_from(&limits).unwrap();

        let err = fc.block_drive_limiter(nonzero(2)).unwrap_err();

        assert!(err.contains("per-drive block bandwidth_bytes_per_sec"));
        assert!(err.contains("positive"));
    }

    #[test]
    fn block_drive_limiter_rejects_ops_budget_that_cannot_be_split() {
        let limits = sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 2,
                ops_per_sec: 1,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 1,
                tx_bytes_per_sec: 1,
            },
        };
        let fc = FirecrackerDeviceRateLimits::try_from(&limits).unwrap();

        let err = fc.block_drive_limiter(nonzero(2)).unwrap_err();

        assert!(err.contains("per-drive block ops_per_sec"));
        assert!(err.contains("positive"));
    }

    #[test]
    fn device_limits_reject_zero_block_bandwidth() {
        let mut limits = positive_device_rate_limits();
        limits.block.bandwidth_bytes_per_sec = 0;

        assert_zero_rate_rejected(&limits, "block bandwidth_bytes_per_sec");
    }

    #[test]
    fn device_limits_reject_zero_block_ops() {
        let mut limits = positive_device_rate_limits();
        limits.block.ops_per_sec = 0;

        assert_zero_rate_rejected(&limits, "block ops_per_sec");
    }

    #[test]
    fn device_limits_reject_zero_network_rx_bandwidth() {
        let mut limits = positive_device_rate_limits();
        limits.network.rx_bytes_per_sec = 0;

        assert_zero_rate_rejected(&limits, "network rx_bytes_per_sec");
    }

    #[test]
    fn device_limits_reject_zero_network_tx_bandwidth() {
        let mut limits = positive_device_rate_limits();
        limits.network.tx_bytes_per_sec = 0;

        assert_zero_rate_rejected(&limits, "network tx_bytes_per_sec");
    }
}
