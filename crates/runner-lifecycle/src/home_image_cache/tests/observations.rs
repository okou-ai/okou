use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::home_observation::{
    HomeObservationKind as Kind, HomeObservationOutcome as Outcome,
};
use runner_storage::operation_test_support::RecordedHomeObservations;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[tokio::test]
async fn publication_observations_follow_synced_commit_and_replaced_generation_removal() {
    let mut f = Fixture::new().await;
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_telemetry(recorded.handle());
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
    f.cache = f.cache_under_pressure().with_telemetry(recorded.handle());
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
    f.cache = f.cache.with_telemetry(recorded.handle());
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
    f.cache = f.cache.with_telemetry(recorded.handle());
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
    f.cache = f.cache_under_pressure().with_telemetry(recorded.handle());
    assert!(f.cache.gc(true).await.unwrap() > 0);
    assert!(f.image("thread", &old).exists());
    assert!(recorded.events().is_empty());
    let local = CapturedEvents::default();
    let guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(local.clone()));
    let freed = f.cache.gc(false).await.unwrap();
    drop(guard);
    assert!(freed > 0);
    assert!(!f.cache.entry_paths(&f.key("thread")).entry_dir().exists());
    let events = recorded.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, Kind::Removal);
    assert_eq!(events[0].outcome, Outcome::Deleted);
    assert_eq!(events[0].image_generation, Some(old.image_generation));
    assert_eq!(events[0].allocated_bytes, Some(freed));
    assert_eq!(events[0].reason.as_deref(), Some("filesystem_pressure"));
    assert!(events[0].run_id.is_none());
    let records = local.entries();
    let local: Vec<_> = records
        .iter()
        .filter(|record| {
            record
                .fields
                .get("op_type")
                .is_some_and(|op| op == "runner_home_image_removal")
        })
        .collect();
    assert_eq!(
        local.len(),
        1,
        "successful removal has one canonical local record"
    );
    assert_eq!(local[0].fields["op_type"], "runner_home_image_removal");
    assert_eq!(local[0].fields["outcome"], "deleted");
    assert_eq!(
        local[0].fields["image_generation"],
        events[0].image_generation.as_deref().unwrap()
    );
    let recovery = records
        .iter()
        .find(|record| {
            record
                .fields
                .get("message")
                .is_some_and(|message| message == "home cache reclaim turn completed")
        })
        .unwrap();
    assert_eq!(recovery.fields["available_before"], "1");
    assert_eq!(recovery.fields["available_after"], "1");
}

#[tokio::test]
async fn gc_keeps_unusable_detail_and_temporary_path_in_the_canonical_local_record() {
    let mut f = Fixture::new().await;
    let current = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let paths = f.cache.entry_paths(&f.key("thread"));
    let temporary = paths.tmp_metadata(runner_types::ids::RunId::new_v4());
    std::fs::write(&temporary, b"pending metadata").unwrap();
    let broken = f.cache.entry_paths(&f.key("broken"));
    std::fs::create_dir_all(broken.entry_dir()).unwrap();
    std::fs::write(broken.metadata(), b"invalid metadata").unwrap();
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_telemetry(recorded.handle());
    let local = CapturedEvents::default();
    let guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(local.clone()));
    assert!(f.cache.gc(false).await.unwrap() > 0);
    drop(guard);
    assert!(!temporary.exists());
    assert!(!broken.entry_dir().exists());
    assert!(f.image("thread", &current).exists());
    let facts = recorded.events();
    assert_eq!(facts.len(), 2);
    assert!(
        facts
            .iter()
            .all(|fact| fact.kind == Kind::Removal && fact.outcome == Outcome::Deleted)
    );
    let local = local.entries();
    assert_eq!(local.len(), 2);
    let unusable = local
        .iter()
        .find(|event| event.fields["reason"] == "unusable_entry")
        .unwrap();
    assert!(!unusable.fields["local_detail"].is_empty());
    let temporary_event = local
        .iter()
        .find(|event| event.fields["reason"] == "temporary_path")
        .unwrap();
    assert_eq!(
        temporary_event.fields["local_path"],
        temporary.display().to_string()
    );
}
