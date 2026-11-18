use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::home_observation::HomeObservationOutcome;
use runner_storage::operation_test_support::RecordedHomeObservations;

#[tokio::test]
async fn reclamation_queue_observation_does_not_complete_on_cancellation_or_release_permits() {
    for required in [false, true] {
        let mut f = Fixture::new().await;
        let recorded = RecordedHomeObservations::default();
        f.cache = f.cache.with_telemetry(recorded.handle());
        let context = f
            .context(
                "queued-timing",
                b"home",
                "2026-11-18T00:00:00Z",
                HomeCacheTerminalStatus::Success,
                StorageFingerprints::default(),
            )
            .await;
        let permits = f.cache.idle_home_reclamation.permits.clone();
        let capacity = permits.available_permits();
        let held = permits
            .clone()
            .acquire_many_owned(capacity as u32)
            .await
            .unwrap();
        let mut waiting = Box::pin(async {
            if required {
                let _permit = context
                    .acquire_required_idle_home_reclamation_permit()
                    .await
                    .unwrap();
            } else {
                let _permit = context
                    .acquire_idle_home_reclamation_permit()
                    .await
                    .unwrap();
            }
        });
        assert!(futures_util::poll!(waiting.as_mut()).is_pending());
        assert!(recorded.timings().is_empty());
        drop(waiting);
        let timings = recorded.timings();
        assert_eq!(timings.len(), 1);
        let home = timings[0].home.as_ref().unwrap();
        assert_eq!(home.reason.as_deref(), Some("idle_reclamation_admission"));
        assert_eq!(home.outcome, HomeObservationOutcome::Incomplete);
        assert!(!timings[0].success);
        assert_eq!(
            permits.available_permits(),
            0,
            "an observer cannot release another owner's custody"
        );
        drop(held);
        if required {
            let permit = context
                .acquire_required_idle_home_reclamation_permit()
                .await
                .unwrap();
            assert_eq!(permits.available_permits(), capacity - 1);
            drop(permit);
        } else {
            let permit = context
                .acquire_idle_home_reclamation_permit()
                .await
                .unwrap();
            assert_eq!(permits.available_permits(), capacity - 1);
            drop(permit);
        }
        let timings = recorded.timings();
        assert_eq!(timings.len(), 2);
        assert_eq!(
            timings[1].home.as_ref().unwrap().outcome,
            HomeObservationOutcome::Completed
        );
        assert_eq!(permits.available_permits(), capacity);
    }
}
