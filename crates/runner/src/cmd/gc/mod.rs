use std::time::Duration;

use clap::Args;

use crate::error::RunnerResult;
use runner_host::paths::HomePaths;

mod debootstrap;
mod filesystem;
mod image_refs;
mod images;
mod job_logs;
mod lock_file;
mod nbd;
mod orphaned_locks;
mod report;
mod storage;
mod version_service_locks;
mod versions;
mod workspaces;

#[cfg(test)]
mod test_support;

use debootstrap::gc_debootstrap;
use image_refs::{ProtectedImageRefs, protected_image_refs_for_gc};
use images::gc_nested_images_with_protected_refs;
use job_logs::gc_job_logs;
use nbd::gc_nbd_orphans;
use orphaned_locks::gc_orphaned_locks;
use report::{GcReport, log_gc_phase_summary, log_gc_summary};
use storage::gc_storage_cache;
use version_service_locks::gc_orphaned_version_service_locks;
use versions::{VersionGcAnalysis, analyze_version_gc, gc_versions_with_analysis};
use workspaces::gc_workspace_orphans;

/// Artifacts younger than this are unconditionally kept, regardless of lock
/// status or `--keep-latest`. This prevents races between `runner build`
/// releasing its lock and `runner start` acquiring a shared lock.
const GC_MIN_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Args)]
pub struct GcArgs {
    /// Show what would be deleted without actually deleting
    #[arg(long)]
    dry_run: bool,
    /// Keep the N newest eligible items in each independent retention policy: managed runner
    /// versions (by semantic version), image snapshots (by modification time), and stable
    /// debootstrap tarballs (by modification time). Recent, active, locked, referenced, incomplete,
    /// and temporary artifacts follow their own safety rules; temporary debootstrap tarballs do not
    /// consume a stable retention slot.
    /// Omit this option or set it to 0 to disable top-N retention.
    #[arg(long)]
    keep_latest: Option<usize>,
    /// Version name to protect from GC (e.g. "v0.78.3").
    /// Used during deployment to prevent deleting the version being deployed.
    #[arg(long)]
    protect_version: Option<String>,
}

trait GcOperations {
    async fn analyze_versions(
        &mut self,
        home: &HomePaths,
        protect_version: Option<&str>,
        keep_latest: Option<usize>,
    ) -> RunnerResult<VersionGcAnalysis>;

    async fn protected_image_refs(
        &mut self,
        home: &HomePaths,
        version_analysis: &VersionGcAnalysis,
    ) -> ProtectedImageRefs;

    async fn gc_images(
        &mut self,
        home: &HomePaths,
        keep_latest: Option<usize>,
        dry_run: bool,
        protected_image_refs: &ProtectedImageRefs,
    ) -> RunnerResult<GcReport>;

    async fn gc_nbd_orphans(&mut self, dry_run: bool) -> RunnerResult<GcReport>;

    async fn gc_workspace_orphans(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
    ) -> RunnerResult<GcReport>;

    async fn gc_orphaned_locks(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
    ) -> RunnerResult<GcReport>;

    async fn gc_job_logs(&mut self, home: &HomePaths, dry_run: bool) -> RunnerResult<GcReport>;

    async fn gc_versions(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
        version_analysis: VersionGcAnalysis,
    ) -> RunnerResult<GcReport>;

    async fn gc_orphaned_version_service_locks(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
    ) -> RunnerResult<GcReport>;

    async fn gc_debootstrap(
        &mut self,
        home: &HomePaths,
        keep_latest: Option<usize>,
        dry_run: bool,
    ) -> RunnerResult<GcReport>;

    async fn gc_storage_cache(&mut self, home: &HomePaths, dry_run: bool)
    -> RunnerResult<GcReport>;
}

struct RealGcOperations;

impl GcOperations for RealGcOperations {
    async fn analyze_versions(
        &mut self,
        home: &HomePaths,
        protect_version: Option<&str>,
        keep_latest: Option<usize>,
    ) -> RunnerResult<VersionGcAnalysis> {
        analyze_version_gc(home, protect_version, keep_latest).await
    }

    async fn protected_image_refs(
        &mut self,
        home: &HomePaths,
        version_analysis: &VersionGcAnalysis,
    ) -> ProtectedImageRefs {
        protected_image_refs_for_gc(home, version_analysis).await
    }

    async fn gc_images(
        &mut self,
        home: &HomePaths,
        keep_latest: Option<usize>,
        dry_run: bool,
        protected_image_refs: &ProtectedImageRefs,
    ) -> RunnerResult<GcReport> {
        gc_nested_images_with_protected_refs(home, keep_latest, dry_run, protected_image_refs).await
    }

    async fn gc_nbd_orphans(&mut self, dry_run: bool) -> RunnerResult<GcReport> {
        gc_nbd_orphans(dry_run).await
    }

    async fn gc_workspace_orphans(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
    ) -> RunnerResult<GcReport> {
        gc_workspace_orphans(home, dry_run).await
    }

    async fn gc_orphaned_locks(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
    ) -> RunnerResult<GcReport> {
        gc_orphaned_locks(home, dry_run).await
    }

    async fn gc_job_logs(&mut self, home: &HomePaths, dry_run: bool) -> RunnerResult<GcReport> {
        gc_job_logs(home, dry_run).await
    }

    async fn gc_versions(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
        version_analysis: VersionGcAnalysis,
    ) -> RunnerResult<GcReport> {
        gc_versions_with_analysis(home, dry_run, version_analysis).await
    }

    async fn gc_orphaned_version_service_locks(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
    ) -> RunnerResult<GcReport> {
        gc_orphaned_version_service_locks(home, dry_run).await
    }

    async fn gc_debootstrap(
        &mut self,
        home: &HomePaths,
        keep_latest: Option<usize>,
        dry_run: bool,
    ) -> RunnerResult<GcReport> {
        gc_debootstrap(home, keep_latest, dry_run).await
    }

    async fn gc_storage_cache(
        &mut self,
        home: &HomePaths,
        dry_run: bool,
    ) -> RunnerResult<GcReport> {
        gc_storage_cache(home, dry_run).await
    }
}

pub async fn run_gc(args: GcArgs) -> RunnerResult<()> {
    let home = HomePaths::new()?;
    let mut operations = RealGcOperations;
    run_gc_with_operations(&args, &home, &mut operations).await
}

async fn run_gc_with_operations(
    args: &GcArgs,
    home: &HomePaths,
    operations: &mut impl GcOperations,
) -> RunnerResult<()> {
    let _gc_lock = runner_host::lock::acquire(home.gc_lock()).await?;

    // Retained version and service configs protect their image pairs before
    // version cleanup consumes the same retention analysis.
    let version_analysis = operations
        .analyze_versions(home, args.protect_version.as_deref(), args.keep_latest)
        .await?;
    let protected_image_refs = operations
        .protected_image_refs(home, &version_analysis)
        .await;

    let mut report = GcReport::default();
    let images_report = operations
        .gc_images(home, args.keep_latest, args.dry_run, &protected_image_refs)
        .await?;
    record_gc_phase(&mut report, "images", images_report, args.dry_run);

    let nbd_report = operations.gc_nbd_orphans(args.dry_run).await?;
    record_gc_phase(&mut report, "nbd orphans", nbd_report, args.dry_run);

    let workspace_report = operations.gc_workspace_orphans(home, args.dry_run).await?;
    record_gc_phase(
        &mut report,
        "workspace orphans",
        workspace_report,
        args.dry_run,
    );

    // General lock GC preserves service locks needed by version cleanup.
    let lock_report = operations.gc_orphaned_locks(home, args.dry_run).await?;
    record_gc_phase(&mut report, "orphaned locks", lock_report, args.dry_run);

    let job_log_report = operations.gc_job_logs(home, args.dry_run).await?;
    record_gc_phase(&mut report, "job logs", job_log_report, args.dry_run);

    let version_report = operations
        .gc_versions(home, args.dry_run, version_analysis)
        .await?;
    record_gc_phase(&mut report, "versions", version_report, args.dry_run);

    // Version service locks become orphaned only after version cleanup.
    let version_lock_report = operations
        .gc_orphaned_version_service_locks(home, args.dry_run)
        .await?;
    record_gc_phase(
        &mut report,
        "version service locks",
        version_lock_report,
        args.dry_run,
    );

    let debootstrap_report = operations
        .gc_debootstrap(home, args.keep_latest, args.dry_run)
        .await?;
    record_gc_phase(
        &mut report,
        "debootstrap cache",
        debootstrap_report,
        args.dry_run,
    );

    let storage_report = operations.gc_storage_cache(home, args.dry_run).await?;
    record_gc_phase(&mut report, "storage cache", storage_report, args.dry_run);

    log_gc_summary(&report, args.dry_run);

    Ok(())
}

fn record_gc_phase(total: &mut GcReport, domain: &str, phase: GcReport, dry_run: bool) {
    log_gc_phase_summary(domain, &phase, dry_run);
    *total += phase;
}

#[cfg(test)]
mod tests;
