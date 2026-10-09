//! Pure validation of supplied current bounds. No defaults, grants or calibrated policy selection.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostMemoryBounds {
    pub host_total_bytes: u64,
    pub operating_floor_bytes: u64,
    pub cleanup_reserve_bytes: u64,
    pub critical_available_bytes: u64,
    pub recovery_available_bytes: u64,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum HostMemoryBoundsError {
    #[error("host total, operating floor and cleanup reserve must be positive")]
    ZeroCapacity,
    #[error("host memory bound arithmetic overflowed")]
    Overflow,
    #[error("protected capacity must fit host total")]
    ProtectedCapacityDoesNotFit,
    #[error("critical/recovery bounds must be ordered within host total")]
    InvalidWatermarks,
    #[error("profile memory must be positive")]
    ZeroProfile,
    #[error("full-profile growth plus supplied preparation margin does not fit")]
    UnsupportedGrowth,
}

impl HostMemoryBounds {
    /// Inputs must come from reviewed current measurements before runtime use.
    /// Validation establishes arithmetic/ordering only, not calibration or OOM safety.
    pub fn validate(&self) -> Result<(), HostMemoryBoundsError> {
        if self.host_total_bytes == 0
            || self.operating_floor_bytes == 0
            || self.cleanup_reserve_bytes == 0
        {
            return Err(HostMemoryBoundsError::ZeroCapacity);
        }
        let protected = self.protected_bytes()?;
        if protected >= self.host_total_bytes {
            return Err(HostMemoryBoundsError::ProtectedCapacityDoesNotFit);
        }
        if self.critical_available_bytes < self.operating_floor_bytes
            || self.recovery_available_bytes <= self.critical_available_bytes
            || self.recovery_available_bytes < protected
            || self.recovery_available_bytes > self.host_total_bytes
        {
            return Err(HostMemoryBoundsError::InvalidWatermarks);
        }
        Ok(())
    }

    /// Conservative full declared profile plus an explicitly supplied measured margin.
    /// This does not substitute RSS, grant capacity or reserve physical RAM.
    pub fn growth_bytes(
        &self,
        profile_memory_mib: u32,
        preparation_margin_bytes: u64,
    ) -> Result<u64, HostMemoryBoundsError> {
        self.validate()?;
        if profile_memory_mib == 0 {
            return Err(HostMemoryBoundsError::ZeroProfile);
        }
        let growth = u64::from(profile_memory_mib)
            .checked_mul(1024 * 1024)
            .and_then(|profile| profile.checked_add(preparation_margin_bytes))
            .ok_or(HostMemoryBoundsError::Overflow)?;
        let required = growth
            .checked_add(self.protected_bytes()?)
            .ok_or(HostMemoryBoundsError::Overflow)?;
        if required > self.host_total_bytes {
            return Err(HostMemoryBoundsError::UnsupportedGrowth);
        }
        Ok(growth)
    }

    fn protected_bytes(&self) -> Result<u64, HostMemoryBoundsError> {
        self.operating_floor_bytes
            .checked_add(self.cleanup_reserve_bytes)
            .ok_or(HostMemoryBoundsError::Overflow)
    }
}

#[cfg(test)]
mod tests {
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
}
