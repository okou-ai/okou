use super::*;
use std::time::Duration;

#[tokio::test(start_paused = true)]
async fn saturated_admission_exclusions_preserve_live_waiters_and_expire_individually() {
    let holds = AdmissionDeferrals::new();
    let first = RunId::new_v4();
    let now = Instant::now();
    assert!(matches!(
        holds.defer(first, (now + Duration::from_secs(1)).into_std()),
        AdmissionDeferralRecord::Changed
    ));
    for _ in 1..RUNNER_POLL_EXCLUDED_RUN_IDS_MAX {
        assert!(matches!(
            holds.defer(RunId::new_v4(), (now + Duration::from_secs(30)).into_std()),
            AdmissionDeferralRecord::Changed
        ));
    }
    assert!(matches!(
        holds.defer(RunId::new_v4(), (now + Duration::from_secs(60)).into_std()),
        AdmissionDeferralRecord::Saturated
    ));
    assert!(matches!(
        holds.defer(first, (now + Duration::from_secs(60)).into_std()),
        AdmissionDeferralRecord::Unchanged
    ));
    assert_eq!(
        holds.snapshot().next_deadline,
        Some(now + Duration::from_secs(1))
    );
    assert!(holds.contains(first));
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(!holds.contains(first));
    assert_eq!(
        holds.snapshot().run_ids.len(),
        RUNNER_POLL_EXCLUDED_RUN_IDS_MAX as usize - 1
    );
    assert_eq!(
        holds.snapshot().next_deadline,
        Some(now + Duration::from_secs(30))
    );
}
