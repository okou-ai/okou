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
