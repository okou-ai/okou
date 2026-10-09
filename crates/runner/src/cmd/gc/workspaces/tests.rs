use std::error::Error;
use std::time::Duration;

use runner_host::HostError;
use runner_host::gc::test_support::{test_home, workspace_gc_report};
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use super::super::report::{log_gc_phase_summary, log_gc_summary};
use super::super::{GcOperations, RealGcOperations};
use super::*;
use crate::error::RunnerError;

#[tokio::test]
async fn workspace_gc_adapter_preserves_default_policy_and_empty_dry_run() {
    assert_eq!(workspace_gc_policy().min_age, Duration::from_secs(600));
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let mut operations = RealGcOperations;
    for dry_run in [true, false] {
        let report = operations
            .gc_workspace_orphans(&home, dry_run)
            .await
            .unwrap();
        assert_eq!(report, GcReport::default());
        assert!(
            !home.locks_dir().exists(),
            "missing lock metadata must not be created"
        );
    }
}

#[test]
fn workspace_gc_adapter_preserves_independent_activity_phase_and_total_reports() {
    for (workspaces, bytes, locks) in [(0, 0, 2), (1, 0, 0), (2, 4096, 3)] {
        for dry_run in [false, true] {
            let report = GcReport::from(workspace_gc_report(workspaces, bytes, locks));
            let activity = u64::from(workspaces) + locks;
            assert_eq!(report, GcReport::cleanup(activity, bytes));
            assert!(
                !report.is_empty(),
                "lock-only and zero-byte cleanup are activity"
            );
            let captured = CapturedEvents::default();
            let subscriber = tracing_subscriber::registry().with(captured.clone());
            let guard = tracing::subscriber::set_default(subscriber);
            tracing::callsite::rebuild_interest_cache();
            log_gc_phase_summary("workspaces", &report, dry_run);
            let mut total = GcReport::cleanup(2, 512);
            total += report;
            log_gc_summary(&total, dry_run);
            drop(guard);
            assert_eq!(total.activity_count, activity + 2);
            assert_eq!(total.freed_bytes, bytes + 512);
            let messages: Vec<_> = captured
                .entries()
                .into_iter()
                .filter_map(|entry| entry.fields.get("message").cloned())
                .collect();
            let (cleaned, freed) = if dry_run {
                ("would_clean", "would_free")
            } else {
                ("cleaned", "freed")
            };
            assert_eq!(
                messages,
                [
                    format!(
                        "gc workspaces complete: {cleaned}={activity}, {freed}={}",
                        runner_host::byte_size::human_bytes(bytes)
                    ),
                    format!(
                        "total: {cleaned}={}, {freed}={}",
                        activity + 2,
                        runner_host::byte_size::human_bytes(bytes + 512)
                    ),
                ]
            );
        }
    }
}

#[test]
fn workspace_gc_adapter_preserves_host_error_categories_display_and_io_source() {
    let internal = RunnerError::from(HostError::Internal(
        "discover base-dir locks task failed: fixture".into(),
    ));
    assert!(
        matches!(&internal, RunnerError::Internal(message) if message == "discover base-dir locks task failed: fixture")
    );
    assert_eq!(
        internal.to_string(),
        "internal error: discover base-dir locks task failed: fixture"
    );
    let config = RunnerError::from(HostError::Config("fixture".into()));
    assert!(matches!(&config, RunnerError::Config(message) if message == "fixture"));
    assert_eq!(config.to_string(), "config error: fixture");
    let dir = tempfile::tempdir().unwrap();
    let io = std::fs::read(dir.path().join("missing")).unwrap_err();
    let kind = io.kind();
    let message = io.to_string();
    let mapped = RunnerError::from(HostError::Io(io));
    assert!(
        matches!(&mapped, RunnerError::Io(error) if error.kind() == kind && error.to_string() == message)
    );
    assert_eq!(mapped.to_string(), format!("io error: {message}"));
    assert_eq!(mapped.source().unwrap().to_string(), message);
}
