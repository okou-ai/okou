use super::*;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

fn capture_gc_summary(report: &GcReport, dry_run: bool) -> Vec<String> {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    log_gc_summary(report, dry_run);
    drop(guard);
    captured
        .entries()
        .into_iter()
        .filter_map(|event| event.fields.get("message").cloned())
        .collect()
}

fn capture_gc_phase_summary(domain: &str, report: &GcReport, dry_run: bool) -> Vec<String> {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    log_gc_phase_summary(domain, report, dry_run);
    drop(guard);
    captured
        .entries()
        .into_iter()
        .filter_map(|event| event.fields.get("message").cloned())
        .collect()
}

#[test]
fn gc_report_composition_preserves_all_summary_fields() {
    let mut report = GcReport::cleanup(2, 512);
    report += GcReport::removed_versions(vec!["v1.0.0".into(), "v2.0.0".into()]);
    report += GcReport::version_service_locks_removed(3);
    report += GcReport::cleanup(1, 1024);

    assert_eq!(report.freed_bytes, 1536);
    assert_eq!(report.activity_count, 8);
    assert_eq!(report.removed_versions, ["v1.0.0", "v2.0.0"]);
    assert_eq!(report.version_service_locks_removed, 3);
    assert!(!report.is_empty());
}

#[test]
fn gc_summary_distinguishes_true_noop_from_nonzero_bytes() {
    assert_eq!(
        capture_gc_summary(&GcReport::default(), false),
        ["nothing to clean up"]
    );
    assert_eq!(
        capture_gc_summary(&GcReport::cleanup(0, 1024), false),
        ["total: cleaned=0, freed=1.0 KiB"]
    );
}

#[test]
fn gc_summary_reports_zero_byte_activity_in_real_and_dry_run_modes() {
    let report = GcReport::cleanup(1, 0);

    assert_eq!(
        capture_gc_summary(&report, false),
        ["total: cleaned=1, freed=0 B"]
    );
    assert_eq!(
        capture_gc_summary(&report, true),
        ["total: would_clean=1, would_free=0 B"]
    );
}

#[test]
fn gc_summary_reports_typed_details_in_real_and_dry_run_modes() {
    let mut report = GcReport::removed_versions(vec!["v1.0.0".into(), "v2.0.0".into()]);
    report += GcReport::version_service_locks_removed(2);

    assert_eq!(
        capture_gc_summary(&report, false),
        [
            "total: cleaned=4, freed=0 B",
            "versions removed: v1.0.0, v2.0.0",
            "version service locks removed: 2",
        ]
    );
    assert_eq!(
        capture_gc_summary(&report, true),
        [
            "total: would_clean=4, would_free=0 B",
            "versions that would be removed: v1.0.0, v2.0.0",
            "version service locks that would be removed: 2",
        ]
    );
}

#[test]
fn gc_phase_summary_reports_completion_in_real_and_dry_run_modes() {
    assert_eq!(
        capture_gc_phase_summary("orphaned locks", &GcReport::default(), false),
        ["gc orphaned locks complete: cleaned=0, freed=0 B"]
    );
    assert_eq!(
        capture_gc_phase_summary("orphaned locks", &GcReport::cleanup(2, 1024), true),
        ["gc orphaned locks complete: would_clean=2, would_free=1.0 KiB"]
    );
}
