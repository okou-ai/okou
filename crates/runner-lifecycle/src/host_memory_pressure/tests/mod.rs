use std::num::NonZeroUsize;
use std::time::Duration;

use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};

use crate::host_memory_policy::HostMemoryBounds;
use crate::host_memory_pressure::{
    HostMemoryPressure, HostPressurePolicy, HostPressurePolicyError, HostPressureState,
    HostPressureUnknown,
};

mod scheduling;

const MIB: u64 = 1024 * 1024;

fn policy() -> HostPressurePolicy {
    // Synthetic arithmetic/clock fixture, not measured production values.
    HostPressurePolicy {
        bounds: HostMemoryBounds {
            host_total_bytes: 64 * MIB,
            operating_floor_bytes: MIB,
            cleanup_reserve_bytes: MIB,
            critical_available_bytes: 2 * MIB,
            recovery_available_bytes: 8 * MIB,
        },
        max_sample_age: Duration::from_secs(10),
        recovery_sustain: Duration::from_secs(3),
        wave_cooldown: Duration::from_secs(4),
        optional_start_interval: Duration::from_secs(2),
        max_wave_entries: NonZeroUsize::new(2).unwrap(),
    }
}

struct Input {
    dir: tempfile::TempDir,
}

impl Input {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    async fn text(&self, text: &str) -> HostMemoryObservation {
        // Advance policy time, not kernel I/O. Every observation really reads
        // the file; distinct reads keep distinct monotonic start timestamps.
        tokio::time::advance(Duration::from_millis(1)).await;
        let path = self.dir.path().join("meminfo");
        tokio::fs::write(&path, text).await.unwrap();
        HostMemoryObservation::read_at(&path).await
    }

    async fn available(&self, mib: u64) -> HostMemoryObservation {
        self.text(&format!("MemAvailable: {} kB\n", mib * 1024))
            .await
    }

    async fn recover(&self, pressure: &mut HostMemoryPressure) {
        assert_eq!(
            pressure.observe(self.available(16).await).state,
            HostPressureState::Recovering
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        pressure.observe(self.available(16).await);
        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(
            pressure.observe(self.available(16).await).state,
            HostPressureState::Ready
        );
    }
}

#[test]
fn invalid_supplied_policy_is_not_replaced_with_defaults() {
    for invalid in [
        HostPressurePolicy {
            max_sample_age: Duration::ZERO,
            ..policy()
        },
        HostPressurePolicy {
            recovery_sustain: Duration::ZERO,
            ..policy()
        },
        HostPressurePolicy {
            wave_cooldown: Duration::ZERO,
            ..policy()
        },
        HostPressurePolicy {
            optional_start_interval: Duration::ZERO,
            ..policy()
        },
    ] {
        assert!(matches!(
            HostMemoryPressure::new(invalid),
            Err(HostPressurePolicyError::ZeroInterval)
        ));
    }
    assert!(matches!(
        HostMemoryPressure::new(HostPressurePolicy {
            bounds: HostMemoryBounds {
                host_total_bytes: 0,
                ..policy().bounds
            },
            ..policy()
        }),
        Err(HostPressurePolicyError::Bounds(_))
    ));
}

#[tokio::test(start_paused = true)]
async fn critical_zero_unknown_and_excess_total_suppress_optional_without_a_job() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    assert_eq!(pressure.decision().state, HostPressureState::Unknown);
    assert!(!pressure.take_optional_start());
    for mib in [0, 2] {
        let decision = pressure.observe(input.available(mib).await);
        assert_eq!(decision.state, HostPressureState::Critical);
        assert_eq!(decision.available_bytes, Some(mib * MIB));
        assert!(decision.wave_ready);
        assert!(!pressure.take_optional_start());
    }
    let malformed = pressure.observe(input.text("MemAvailable: broken kB\n").await);
    assert_eq!(malformed.state, HostPressureState::Unknown);
    assert_eq!(
        malformed.unknown,
        Some(HostPressureUnknown::Observation(
            HostMemoryUnknown::Malformed
        ))
    );
    assert!(!malformed.wave_ready);
    assert!(!pressure.take_optional_start());
    let excess = pressure.observe(input.available(65).await);
    assert_eq!(excess.unknown, Some(HostPressureUnknown::ExceedsHostTotal));
    assert!(!excess.wave_ready);
    assert!(!pressure.take_optional_start());
    tokio::time::advance(Duration::from_millis(1)).await;
    let missing = HostMemoryObservation::read_at(&input.dir.path().join("absent")).await;
    let decision = pressure.observe(missing);
    assert_eq!(
        decision.unknown,
        Some(HostPressureUnknown::Observation(
            HostMemoryUnknown::ReadFailed(std::io::ErrorKind::NotFound)
        ))
    );
    assert!(!decision.optional_start_ready);
}

#[tokio::test(start_paused = true)]
async fn repeated_read_does_not_manufacture_sustained_recovery() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    let read = input.available(16).await;
    assert_eq!(
        pressure.observe(read.clone()).state,
        HostPressureState::Recovering
    );
    tokio::time::advance(Duration::from_secs(3)).await;
    assert_eq!(pressure.observe(read).state, HostPressureState::Recovering);
    assert!(!pressure.take_optional_start());
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Ready
    );
    assert!(pressure.take_optional_start());
}

#[tokio::test(start_paused = true)]
async fn recovered_hysteresis_band_does_not_start_optional_work_or_reclaim() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    assert_eq!(
        pressure.observe(input.available(6).await).state,
        HostPressureState::Constrained
    );
    input.recover(&mut pressure).await;
    let band = pressure.observe(input.available(6).await);
    assert_eq!(band.state, HostPressureState::Ready);
    assert!(!band.wave_ready);
    assert!(!pressure.take_optional_start());
    assert!(
        pressure
            .observe(input.available(16).await)
            .optional_start_ready
    );
    let critical = pressure.observe(input.available(2).await);
    assert_eq!(critical.state, HostPressureState::Critical);
    assert!(!critical.optional_start_ready);
}

#[tokio::test(start_paused = true)]
async fn failed_observation_and_long_read_gap_restart_recovery() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    input.recover(&mut pressure).await;
    pressure.observe(input.text("MemTotal: 65536 kB\n").await);
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Recovering
    );
    tokio::time::advance(Duration::from_secs(2)).await;
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Recovering
    );
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Ready
    );
    tokio::time::advance(policy().max_sample_age).await;
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Recovering
    );
    assert!(!pressure.take_optional_start());
}

#[tokio::test(start_paused = true)]
async fn cached_readiness_expires_at_consumption_and_cannot_be_replayed() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    input.recover(&mut pressure).await;
    let read = input.available(16).await;
    assert!(pressure.observe(read.clone()).optional_start_ready);
    tokio::time::advance(policy().max_sample_age).await;
    assert_eq!(pressure.decision().state, HostPressureState::Unknown);
    assert!(!pressure.take_optional_start());
    let stale = pressure.observe(read);
    assert_eq!(
        stale.unknown,
        Some(HostPressureUnknown::Observation(HostMemoryUnknown::Stale))
    );
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Recovering
    );
}

#[tokio::test(start_paused = true)]
async fn out_of_order_success_invalidates_the_current_recovery_corridor() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    let earlier = input.available(16).await;
    input.recover(&mut pressure).await;
    let decision = pressure.observe(earlier);
    assert_eq!(decision.unknown, Some(HostPressureUnknown::OutOfOrder));
    assert!(!pressure.take_optional_start());
    assert_eq!(
        pressure.observe(input.available(16).await).state,
        HostPressureState::Recovering
    );
}

#[tokio::test(start_paused = true)]
async fn short_watermark_oscillation_never_completes_sustained_recovery() {
    let input = Input::new();
    let mut pressure = HostMemoryPressure::new(policy()).unwrap();
    for _ in 0..3 {
        pressure.observe(input.available(16).await);
        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(
            pressure.observe(input.available(16).await).state,
            HostPressureState::Recovering
        );
        assert!(!pressure.take_optional_start());
        pressure.observe(input.available(6).await);
    }
    input.recover(&mut pressure).await;
    assert!(pressure.take_optional_start());
}
