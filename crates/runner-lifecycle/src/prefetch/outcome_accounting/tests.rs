use super::*;

#[test]
fn every_outcome_accumulates_consumed_bytes_and_preserves_error_precedence() {
    for (outcome, expected) in [
        (
            PrefetchOutcome::Complete { bytes: 11 },
            (3, 3, 5, 18, Some("settlement failed")),
        ),
        (
            PrefetchOutcome::Cancelled { bytes: 13 },
            (2, 4, 5, 20, Some("settlement failed")),
        ),
        (
            PrefetchOutcome::OpenFailed {
                error: std::io::Error::other("open failed"),
            },
            (2, 3, 6, 7, Some("open failed")),
        ),
        (
            PrefetchOutcome::ReadFailed {
                bytes: 17,
                error: std::io::Error::other("read failed"),
            },
            (2, 3, 6, 24, Some("read failed")),
        ),
    ] {
        let (mut completed, mut cancelled, mut failed, mut read_bytes) = (2, 3, 5, 7);
        let mut last_error = Some("settlement failed".to_owned());
        ReaderAccounting {
            completed: &mut completed,
            cancelled: &mut cancelled,
            failed: &mut failed,
            read_bytes: &mut read_bytes,
            last_error: &mut last_error,
        }
        .record(&outcome);
        assert_eq!(
            (
                completed,
                cancelled,
                failed,
                read_bytes,
                last_error.as_deref()
            ),
            expected
        );
    }
}

#[test]
fn byte_totals_saturate_for_complete_cancelled_and_failed_reads() {
    for (outcome, counts) in [
        (PrefetchOutcome::Complete { bytes: 2 }, (1, 0, 0)),
        (PrefetchOutcome::Cancelled { bytes: 2 }, (0, 1, 0)),
        (
            PrefetchOutcome::ReadFailed {
                bytes: 2,
                error: std::io::Error::other("read failed"),
            },
            (0, 0, 1),
        ),
    ] {
        let (mut completed, mut cancelled, mut failed) = (0, 0, 0);
        let mut read_bytes = u64::MAX - 1;
        let mut last_error = None;
        ReaderAccounting {
            completed: &mut completed,
            cancelled: &mut cancelled,
            failed: &mut failed,
            read_bytes: &mut read_bytes,
            last_error: &mut last_error,
        }
        .record(&outcome);
        assert_eq!(read_bytes, u64::MAX);
        assert_eq!((completed, cancelled, failed), counts);
    }
}
