//! Bounded host-wide availability observations, not logical admission or RAM reservations.

use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::time::Instant;

const MEMINFO_PATH: &str = "/proc/meminfo";
const MAX_MEMINFO_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HostMemoryUnknown {
    #[error("no host observation yet")]
    NotObserved,
    #[error("host memory observer stopped")]
    ObserverStopped,
    #[error("procfs read failed: {0:?}")]
    ReadFailed(ErrorKind),
    #[error("procfs input exceeds the byte bound")]
    Oversized,
    #[error("MemAvailable is missing")]
    Missing,
    #[error("MemAvailable is duplicated")]
    Duplicate,
    #[error("MemAvailable is malformed")]
    Malformed,
    #[error("MemAvailable byte arithmetic overflowed")]
    Overflow,
    #[error("host observation is stale")]
    Stale,
    #[error("host observation has inconsistent monotonic timing")]
    InvalidTiming,
    #[error("host observation read timed out")]
    ReadTimeout,
}

/// The read-start timestamp deliberately includes read latency in sample age.
#[derive(Clone, Debug)]
pub struct HostMemoryObservation {
    started_at: Instant,
    read_duration: Duration,
    available_bytes: Result<u64, HostMemoryUnknown>,
}

impl HostMemoryObservation {
    pub async fn read() -> Self {
        Self::read_at(Path::new(MEMINFO_PATH)).await
    }

    /// Path injection is an I/O boundary for fixtures, not Runner configuration.
    pub async fn read_at(path: &Path) -> Self {
        let started_at = Instant::now();
        let available_bytes = read_available_bytes(path).await;
        Self {
            started_at,
            read_duration: started_at.elapsed(),
            available_bytes,
        }
    }

    pub fn unknown(reason: HostMemoryUnknown) -> Self {
        Self {
            started_at: Instant::now(),
            read_duration: Duration::ZERO,
            available_bytes: Err(reason),
        }
    }

    /// Cached bytes are diagnostic only. A later growth decision must read again.
    /// Zero is valid; missing, failed, future or expired samples are never healthy.
    pub fn available_bytes_at(
        &self,
        now: Instant,
        max_age: Duration,
    ) -> Result<u64, HostMemoryUnknown> {
        let bytes = self.available_bytes.clone()?;
        let age = now
            .checked_duration_since(self.started_at)
            .ok_or(HostMemoryUnknown::InvalidTiming)?;
        if age < self.read_duration {
            return Err(HostMemoryUnknown::InvalidTiming);
        }
        if age >= max_age {
            return Err(HostMemoryUnknown::Stale);
        }
        Ok(bytes)
    }

    pub fn age_at(&self, now: Instant) -> Option<Duration> {
        now.checked_duration_since(self.started_at)
    }

    pub fn read_duration(&self) -> Duration {
        self.read_duration
    }
}

async fn read_available_bytes(path: &Path) -> Result<u64, HostMemoryUnknown> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| HostMemoryUnknown::ReadFailed(error.kind()))?;
    let mut bytes = Vec::new();
    file.take((MAX_MEMINFO_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| HostMemoryUnknown::ReadFailed(error.kind()))?;
    parse_available_bytes(&bytes)
}

fn parse_available_bytes(bytes: &[u8]) -> Result<u64, HostMemoryUnknown> {
    if bytes.len() > MAX_MEMINFO_BYTES {
        return Err(HostMemoryUnknown::Oversized);
    }
    let content = std::str::from_utf8(bytes).map_err(|_| HostMemoryUnknown::Malformed)?;
    let mut available = None;
    for line in content.lines() {
        let Some(value) = line.strip_prefix("MemAvailable:") else {
            continue;
        };
        if available.is_some() {
            return Err(HostMemoryUnknown::Duplicate);
        }
        let mut fields = value.split_ascii_whitespace();
        let amount = fields.next().ok_or(HostMemoryUnknown::Malformed)?;
        if !amount.bytes().all(|byte| byte.is_ascii_digit())
            || fields.next() != Some("kB")
            || fields.next().is_some()
        {
            return Err(HostMemoryUnknown::Malformed);
        }
        let kib: u64 = amount.parse().map_err(|_| HostMemoryUnknown::Overflow)?;
        available = Some(kib.checked_mul(1024).ok_or(HostMemoryUnknown::Overflow)?);
    }
    available.ok_or(HostMemoryUnknown::Missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_units_checked_bytes_and_zero() {
        assert_eq!(
            parse_available_bytes(b"MemTotal: 1234 kB\nMemAvailable: 42 kB\n"),
            Ok(43008)
        );
        assert_eq!(parse_available_bytes(b"MemAvailable:\t0 kB\n"), Ok(0));
        assert_eq!(
            parse_available_bytes(b"MemAvailable: 1 kB\nMemAvailable: 2 kB\n"),
            Err(HostMemoryUnknown::Duplicate)
        );
        assert_eq!(
            parse_available_bytes(b"MemAvailableX: 42 kB\n"),
            Err(HostMemoryUnknown::Missing)
        );
    }

    #[test]
    fn malformed_missing_and_overflow_are_unknown() {
        for input in [
            "MemAvailable:",
            "MemAvailable: 1",
            "MemAvailable: -1 kB",
            "MemAvailable: +1 kB",
            "MemAvailable: 1 MB",
            "MemAvailable: 1 kB extra",
            "MemAvailable: 1.0 kB",
        ] {
            assert_eq!(
                parse_available_bytes(input.as_bytes()),
                Err(HostMemoryUnknown::Malformed),
                "{input}"
            );
        }
        for input in [
            "MemAvailable: 18446744073709551616 kB",
            "MemAvailable: 18014398509481984 kB",
        ] {
            assert_eq!(
                parse_available_bytes(input.as_bytes()),
                Err(HostMemoryUnknown::Overflow)
            );
        }
        assert_eq!(
            parse_available_bytes(b"MemTotal: 1 kB\n"),
            Err(HostMemoryUnknown::Missing)
        );
        assert_eq!(
            parse_available_bytes(&[255]),
            Err(HostMemoryUnknown::Malformed)
        );
        assert_eq!(
            parse_available_bytes(&vec![b' '; MAX_MEMINFO_BYTES + 1]),
            Err(HostMemoryUnknown::Oversized)
        );
    }

    #[tokio::test]
    async fn real_file_failure_replaces_success_and_read_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meminfo");
        tokio::fs::write(&path, "MemAvailable: 42 kB\n")
            .await
            .unwrap();
        let valid = HostMemoryObservation::read_at(&path).await;
        assert_eq!(
            valid.available_bytes_at(Instant::now(), Duration::from_secs(1)),
            Ok(43008)
        );
        tokio::fs::write(&path, vec![b' '; MAX_MEMINFO_BYTES + 1])
            .await
            .unwrap();
        let oversized = HostMemoryObservation::read_at(&path).await;
        assert_eq!(
            oversized.available_bytes_at(Instant::now(), Duration::from_secs(1)),
            Err(HostMemoryUnknown::Oversized)
        );
        tokio::fs::remove_file(&path).await.unwrap();
        let failed = HostMemoryObservation::read_at(&path).await;
        assert_eq!(
            failed.available_bytes_at(Instant::now(), Duration::from_secs(1)),
            Err(HostMemoryUnknown::ReadFailed(ErrorKind::NotFound))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn freshness_includes_read_latency_and_never_renews_at_completion() {
        let started_at = Instant::now();
        let sample = HostMemoryObservation {
            started_at,
            read_duration: Duration::from_secs(3),
            available_bytes: Ok(0),
        };
        assert_eq!(
            sample.available_bytes_at(started_at + Duration::from_secs(2), Duration::from_secs(4)),
            Err(HostMemoryUnknown::InvalidTiming)
        );
        tokio::time::advance(Duration::from_secs(3)).await;
        assert_eq!(
            sample.available_bytes_at(Instant::now(), Duration::from_secs(4)),
            Ok(0)
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(
            sample.available_bytes_at(Instant::now(), Duration::from_secs(4)),
            Err(HostMemoryUnknown::Stale)
        );
        assert_eq!(
            sample.available_bytes_at(started_at - Duration::from_secs(1), Duration::from_secs(4)),
            Err(HostMemoryUnknown::InvalidTiming)
        );
        assert_eq!(
            sample.available_bytes_at(Instant::now(), Duration::ZERO),
            Err(HostMemoryUnknown::Stale)
        );
    }
}
