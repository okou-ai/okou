use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::home_observation::{
    HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
};
use runner_host::test_fixtures::home_observation::RecordedHomeObservations;

#[tokio::test]
async fn publication_observations_follow_synced_commit_and_replaced_generation_removal() {
    let mut f = Fixture::new().await;
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_observations(recorded.handle());
    let old = f
        .commit("thread", b"old-home", "2026-10-09T09:00:00Z")
        .await;
    let new = f
        .commit("thread", b"new-home", "2026-10-09T09:01:00Z")
        .await;
    assert!(!f.image("thread", &old).exists());
    assert!(f.image("thread", &new).exists());
    let events = recorded.events();
    let publication: Vec<_> = events
        .iter()
        .filter(|event| event.kind == Kind::Publication)
        .collect();
    assert_eq!(publication.len(), 2);
    assert_eq!(publication[1].outcome, Outcome::Published);
    assert_eq!(
        publication[1].image_generation.as_deref(),
        Some(new.image_generation.as_str())
    );
    assert_eq!(publication[1].allocated_bytes, Some(new.allocated_bytes));
    assert_eq!(
        publication[1].run_id.map(|run| run.to_string()),
        Some(new.image_generation)
    );
    assert_eq!(publication[1].reuse_key.as_deref(), Some("thread"));
    assert_eq!(publication[1].profile_name.as_deref(), Some(PROFILE));
    let removal: Vec<_> = events
        .iter()
        .filter(|event| event.kind == Kind::Removal)
        .collect();
    assert_eq!(removal.len(), 1);
    assert_eq!(removal[0].outcome, Outcome::Deleted);
    assert_eq!(
        removal[0].image_generation.as_deref(),
        Some(old.image_generation.as_str())
    );
    assert_eq!(removal[0].reason.as_deref(), Some("replaced_generation"));
}

#[tokio::test]
async fn publication_skips_and_failures_do_not_claim_success_or_remove_previous_commit() {
    let mut f = Fixture::new().await;
    let old = f
        .commit("thread", b"old-home", "2026-10-09T09:00:00Z")
        .await;
    let recorded = RecordedHomeObservations::default();
    f.cache = f
        .cache_under_pressure()
        .with_observations(recorded.handle());
    let context = f
        .context(
            "thread",
            b"candidate",
            "2026-10-09T09:01:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    assert!(f.paths.active_home_image(&context.sandbox_id()).exists());
    assert!(f.image("thread", &old).exists());
    assert_eq!(recorded.events().len(), 1);
    assert_eq!(recorded.events()[0].outcome, Outcome::Skipped);
    assert_eq!(recorded.events()[0].reason.as_deref(), Some("disk_reserve"));
    drop(context);

    let mut f = Fixture::new().await;
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_observations(recorded.handle());
    let context = f
        .context(
            "failure",
            b"candidate",
            "2026-10-09T09:01:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    f.cache.inner.publication_fault.store(
        PublicationFault::BeforeMetadataRename as usize,
        std::sync::atomic::Ordering::SeqCst,
    );
    assert!(context.promote().await.is_err());
    assert!(!f.cache.entry_paths(&f.key("failure")).metadata().exists());
    assert_eq!(recorded.events().len(), 1);
    assert_eq!(recorded.events()[0].outcome, Outcome::Failed);
    assert_eq!(
        recorded.events()[0].reason.as_deref(),
        Some("publication_error")
    );
}

#[tokio::test]
async fn checkout_fallback_records_known_context_without_claiming_a_generation() {
    let mut f = Fixture::new().await;
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_observations(recorded.handle());
    let paths = f.cache.entry_paths(&f.key("thread"));
    tokio::fs::create_dir_all(paths.entry_dir()).await.unwrap();
    tokio::fs::write(paths.metadata(), b"invalid metadata")
        .await
        .unwrap();
    let lease = f.lease("thread").await;
    assert_eq!(lease.result(), HomeCacheCheckoutResult::Miss);
    assert!(!paths.entry_dir().exists());
    let events = recorded.events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].kind, Kind::Consumption);
    assert_eq!(events[0].outcome, Outcome::Fallback);
    assert_eq!(events[0].reason.as_deref(), Some("invalid_metadata"));
    assert_eq!(events[0].reuse_key.as_deref(), Some("thread"));
    assert_eq!(events[0].cache_key, Some(f.key("thread")));
    assert!(events[0].run_id.is_some());
    assert!(events[0].image_generation.is_none());
    assert_eq!(events[1].kind, Kind::Removal);
    assert_eq!(events[1].outcome, Outcome::Deleted);
    assert_eq!(events[1].cache_key, Some(f.key("thread")));
    assert_eq!(events[1].reason.as_deref(), Some("invalid_metadata"));
    assert!(events[1].image_generation.is_none());
}

#[tokio::test]
async fn gc_reports_the_removed_current_generation_and_dry_run_has_no_deletion_fact() {
    let mut f = Fixture::new().await;
    let old = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let recorded = RecordedHomeObservations::default();
    f.cache = f
        .cache_under_pressure()
        .with_observations(recorded.handle());
    assert!(f.cache.gc(true).await.unwrap() > 0);
    assert!(f.image("thread", &old).exists());
    assert!(recorded.events().is_empty());
    let freed = f.cache.gc(false).await.unwrap();
    assert!(freed > 0);
    assert!(!f.cache.entry_paths(&f.key("thread")).entry_dir().exists());
    let events = recorded.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, Kind::Removal);
    assert_eq!(events[0].outcome, Outcome::Deleted);
    assert_eq!(events[0].image_generation, Some(old.image_generation));
    assert_eq!(events[0].allocated_bytes, Some(freed));
    assert_eq!(events[0].reason.as_deref(), Some("cache_budget"));
    assert!(events[0].run_id.is_none());
}
