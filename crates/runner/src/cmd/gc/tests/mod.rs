use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use super::*;
use clap::{CommandFactory, Parser};
use tokio::sync::oneshot;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use crate::cmd::gc::test_support::test_home;

#[derive(Parser)]
struct GcCli {
    #[command(flatten)]
    args: GcArgs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SafetyGcPhase {
    AnalyzeVersions,
    ProtectedImageRefs,
    Images,
    OrphanedLocks,
    Versions,
    OrphanedVersionServiceLocks,
}

struct FakeGcOperations {
    events: Vec<SafetyGcPhase>,
    expected_analysis: VersionGcAnalysis,
    first_phase_gate: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
}

impl FakeGcOperations {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            expected_analysis: versions::empty_complete_version_gc_analysis(),
            first_phase_gate: None,
        }
    }

    fn with_first_phase_gate(entered: oneshot::Sender<()>, resume: oneshot::Receiver<()>) -> Self {
        Self {
            first_phase_gate: Some((entered, resume)),
            ..Self::new()
        }
    }
}

impl GcOperations for FakeGcOperations {
    async fn analyze_versions(
        &mut self,
        _home: &HomePaths,
        _protect_version: Option<&str>,
        _keep_latest: Option<usize>,
    ) -> RunnerResult<VersionGcAnalysis> {
        self.events.push(SafetyGcPhase::AnalyzeVersions);
        if let Some((entered, resume)) = self.first_phase_gate.take() {
            entered.send(()).unwrap();
            resume.await.unwrap();
        }
        Ok(self.expected_analysis.clone())
    }

    async fn protected_image_refs(
        &mut self,
        _home: &HomePaths,
        version_analysis: &VersionGcAnalysis,
    ) -> ProtectedImageRefs {
        self.events.push(SafetyGcPhase::ProtectedImageRefs);
        assert_eq!(version_analysis, &self.expected_analysis);
        ProtectedImageRefs::incomplete()
    }

    async fn gc_images(
        &mut self,
        _home: &HomePaths,
        _keep_latest: Option<usize>,
        _dry_run: bool,
        protected_image_refs: &ProtectedImageRefs,
    ) -> RunnerResult<GcReport> {
        self.events.push(SafetyGcPhase::Images);
        assert!(!protected_image_refs.is_complete());
        Ok(GcReport::default())
    }

    async fn gc_nbd_orphans(&mut self, _dry_run: bool) -> RunnerResult<GcReport> {
        Ok(GcReport::default())
    }

    async fn gc_workspace_orphans(
        &mut self,
        _home: &HomePaths,
        _dry_run: bool,
    ) -> RunnerResult<GcReport> {
        Ok(GcReport::default())
    }

    async fn gc_orphaned_locks(
        &mut self,
        _home: &HomePaths,
        _dry_run: bool,
    ) -> RunnerResult<GcReport> {
        self.events.push(SafetyGcPhase::OrphanedLocks);
        Ok(GcReport::default())
    }

    async fn gc_job_logs(&mut self, _home: &HomePaths, _dry_run: bool) -> RunnerResult<GcReport> {
        Ok(GcReport::default())
    }

    async fn gc_versions(
        &mut self,
        _home: &HomePaths,
        _dry_run: bool,
        version_analysis: VersionGcAnalysis,
    ) -> RunnerResult<GcReport> {
        self.events.push(SafetyGcPhase::Versions);
        assert_eq!(version_analysis, self.expected_analysis);
        Ok(GcReport::default())
    }

    async fn gc_orphaned_version_service_locks(
        &mut self,
        _home: &HomePaths,
        _dry_run: bool,
    ) -> RunnerResult<GcReport> {
        self.events.push(SafetyGcPhase::OrphanedVersionServiceLocks);
        Ok(GcReport::default())
    }

    async fn gc_debootstrap(
        &mut self,
        _home: &HomePaths,
        _keep_latest: Option<usize>,
        _dry_run: bool,
    ) -> RunnerResult<GcReport> {
        Ok(GcReport::default())
    }

    async fn gc_storage_cache(
        &mut self,
        _home: &HomePaths,
        _dry_run: bool,
    ) -> RunnerResult<GcReport> {
        Ok(GcReport::default())
    }
}

#[tokio::test]
async fn gc_coordinator_preserves_safety_critical_phase_order() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let args = GcArgs {
        dry_run: true,
        keep_latest: Some(2),
        protect_version: Some("v1.2.3".to_string()),
    };
    let mut operations = FakeGcOperations::new();

    run_gc_with_operations(&args, &home, &mut operations)
        .await
        .unwrap();

    let image_chain: Vec<_> = operations
        .events
        .iter()
        .copied()
        .filter(|phase| {
            matches!(
                phase,
                SafetyGcPhase::AnalyzeVersions
                    | SafetyGcPhase::ProtectedImageRefs
                    | SafetyGcPhase::Images
            )
        })
        .collect();
    assert_eq!(
        image_chain,
        [
            SafetyGcPhase::AnalyzeVersions,
            SafetyGcPhase::ProtectedImageRefs,
            SafetyGcPhase::Images,
        ]
    );

    let version_lock_chain: Vec<_> = operations
        .events
        .iter()
        .copied()
        .filter(|phase| {
            matches!(
                phase,
                SafetyGcPhase::OrphanedLocks
                    | SafetyGcPhase::Versions
                    | SafetyGcPhase::OrphanedVersionServiceLocks
            )
        })
        .collect();
    assert_eq!(
        version_lock_chain,
        [
            SafetyGcPhase::OrphanedLocks,
            SafetyGcPhase::Versions,
            SafetyGcPhase::OrphanedVersionServiceLocks,
        ]
    );
}

#[tokio::test]
async fn gc_coordinator_serializes_complete_runs_and_initializes_lock_path() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let first_home = home.clone();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (resume_tx, resume_rx) = oneshot::channel();

    let first_gc = tokio::spawn(async move {
        let args = GcArgs {
            dry_run: true,
            keep_latest: None,
            protect_version: None,
        };
        let mut operations = FakeGcOperations::with_first_phase_gate(entered_tx, resume_rx);
        run_gc_with_operations(&args, &first_home, &mut operations).await
    });

    entered_rx.await.unwrap();
    assert_eq!(
        std::fs::metadata(home.locks_dir())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(home.gc_lock())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let second_args = GcArgs {
        dry_run: true,
        keep_latest: None,
        protect_version: None,
    };
    let mut second_operations = FakeGcOperations::new();
    let mut second_gc = Box::pin(run_gc_with_operations(
        &second_args,
        &home,
        &mut second_operations,
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut second_gc)
            .await
            .is_err(),
        "a second GC must wait while the first GC is inside a phase"
    );

    resume_tx.send(()).unwrap();
    first_gc.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut second_gc)
        .await
        .expect("second GC should acquire the released global lock")
        .unwrap();
}

#[test]
fn gc_protect_version_flag_is_accepted() {
    let r = GcCli::try_parse_from(["gc", "--protect-version", "v0.78.3"]);
    assert!(r.is_ok(), "--protect-version must be accepted");
    let cli = r.unwrap();
    assert_eq!(cli.args.protect_version.as_deref(), Some("v0.78.3"));
}

#[test]
fn gc_keep_latest_help_describes_retention_policy() {
    let help = GcCli::command()
        .render_help()
        .to_string()
        .to_ascii_lowercase();
    for phrase in [
        "each independent retention policy",
        "managed runner versions",
        "semantic version",
        "image snapshots",
        "stable debootstrap tarballs",
        "modification time",
        "recent, active, locked, referenced, incomplete, and temporary artifacts",
        "temporary debootstrap tarballs do not consume a stable retention slot",
        "omit this option or set it to 0 to disable top-n retention",
    ] {
        assert!(
            help.contains(phrase),
            "runner gc help is missing {phrase:?}:\n{help}"
        );
    }

    assert_eq!(
        GcCli::try_parse_from(["gc"]).unwrap().args.keep_latest,
        None
    );
    assert_eq!(
        GcCli::try_parse_from(["gc", "--keep-latest", "0"])
            .unwrap()
            .args
            .keep_latest,
        Some(0)
    );
}

async fn capture_orphaned_lock_phase(home: &HomePaths, dry_run: bool) -> (GcReport, Vec<String>) {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    let phase = gc_orphaned_locks(home, dry_run).await.unwrap();
    let mut total = GcReport::default();
    record_gc_phase(&mut total, "orphaned locks", phase, dry_run);

    drop(guard);
    let messages = captured
        .entries()
        .into_iter()
        .filter_map(|event| event.fields.get("message").cloned())
        .collect();
    (total, messages)
}

#[tokio::test(flavor = "current_thread")]
async fn gc_orphaned_lock_output_is_bounded_in_real_mode() {
    const LOCK_COUNT: usize = 2_000;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();
    for index in 0..LOCK_COUNT {
        std::fs::write(locks_dir.join(format!("unused-{index}.lock")), "").unwrap();
    }

    let (dry_run_report, dry_run_messages) = capture_orphaned_lock_phase(&home, true).await;
    assert_eq!(dry_run_report, GcReport::cleanup(LOCK_COUNT as u64, 0));
    assert_eq!(dry_run_messages.len(), LOCK_COUNT + 1);
    assert_eq!(
        dry_run_messages
            .iter()
            .filter(|message| message.starts_with("[dry-run] would remove unused lock "))
            .count(),
        LOCK_COUNT
    );
    assert_eq!(
        dry_run_messages.last().map(String::as_str),
        Some("gc orphaned locks complete: would_clean=2000, would_free=0 B")
    );
    assert_eq!(std::fs::read_dir(&locks_dir).unwrap().count(), LOCK_COUNT);

    let (real_report, real_messages) = capture_orphaned_lock_phase(&home, false).await;
    assert_eq!(real_report, GcReport::cleanup(LOCK_COUNT as u64, 0));
    assert_eq!(
        real_messages,
        ["gc orphaned locks complete: cleaned=2000, freed=0 B"]
    );
    assert_eq!(std::fs::read_dir(&locks_dir).unwrap().count(), 0);
}
