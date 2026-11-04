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
