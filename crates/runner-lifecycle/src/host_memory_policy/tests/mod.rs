use super::*;

// Synthetic arithmetic fixture, deliberately not a production policy/default.
fn bounds() -> HostMemoryBounds {
    HostMemoryBounds {
        host_total_bytes: 64 * 1024 * 1024,
        operating_floor_bytes: 2 * 1024 * 1024,
        cleanup_reserve_bytes: 1024 * 1024,
        critical_available_bytes: 2 * 1024 * 1024,
        recovery_available_bytes: 4 * 1024 * 1024,
    }
}

#[test]
fn supplied_bounds_and_full_profile_growth_validate() {
    assert_eq!(bounds().validate(), Ok(()));
    assert_eq!(bounds().growth_bytes(8, 1024), Ok(8 * 1024 * 1024 + 1024));
    assert_eq!(bounds().growth_bytes(61, 0), Ok(61 * 1024 * 1024));
    assert_eq!(
        bounds().growth_bytes(62, 0),
        Err(HostMemoryBoundsError::UnsupportedGrowth)
    );
    assert_eq!(
        bounds().growth_bytes(0, 0),
        Err(HostMemoryBoundsError::ZeroProfile)
    );
    assert_eq!(
        bounds().growth_bytes(1, u64::MAX),
        Err(HostMemoryBoundsError::Overflow)
    );
}

#[test]
fn zero_overflow_and_protected_capacity_are_not_defaults() {
    for invalid in [
        HostMemoryBounds {
            host_total_bytes: 0,
            ..bounds()
        },
        HostMemoryBounds {
            operating_floor_bytes: 0,
            ..bounds()
        },
        HostMemoryBounds {
            cleanup_reserve_bytes: 0,
            ..bounds()
        },
    ] {
        assert_eq!(invalid.validate(), Err(HostMemoryBoundsError::ZeroCapacity));
    }
    assert_eq!(
        HostMemoryBounds {
            operating_floor_bytes: u64::MAX,
            ..bounds()
        }
        .validate(),
        Err(HostMemoryBoundsError::Overflow)
    );
    assert_eq!(
        HostMemoryBounds {
            cleanup_reserve_bytes: 64 * 1024 * 1024,
            ..bounds()
        }
        .validate(),
        Err(HostMemoryBoundsError::ProtectedCapacityDoesNotFit)
    );
}

#[test]
fn inconsistent_watermarks_are_rejected() {
    for invalid in [
        HostMemoryBounds {
            critical_available_bytes: 1,
            ..bounds()
        },
        HostMemoryBounds {
            recovery_available_bytes: 2 * 1024 * 1024,
            ..bounds()
        },
        HostMemoryBounds {
            recovery_available_bytes: 65 * 1024 * 1024,
            ..bounds()
        },
        HostMemoryBounds {
            critical_available_bytes: 5 * 1024 * 1024,
            ..bounds()
        },
    ] {
        assert_eq!(
            invalid.validate(),
            Err(HostMemoryBoundsError::InvalidWatermarks)
        );
    }
}
