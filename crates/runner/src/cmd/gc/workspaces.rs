use crate::error::RunnerResult;
use runner_host::gc::workspaces::{WorkspaceGcPolicy, WorkspaceGcReport};
use runner_host::paths::HomePaths;

use super::GC_MIN_AGE;
use super::report::GcReport;

fn workspace_gc_policy() -> WorkspaceGcPolicy {
    WorkspaceGcPolicy {
        min_age: GC_MIN_AGE,
    }
}

impl From<WorkspaceGcReport> for GcReport {
    fn from(report: WorkspaceGcReport) -> Self {
        Self::cleanup(
            u64::from(report.workspaces_cleaned()) + report.base_dir_locks_removed(),
            report.bytes_freed(),
        )
    }
}

pub(super) async fn gc_workspace_orphans(
    home: &HomePaths,
    dry_run: bool,
) -> RunnerResult<GcReport> {
    let report =
        runner_host::gc::workspaces::gc_workspace_orphans(home, workspace_gc_policy(), dry_run)
            .await?;
    Ok(report.into())
}

#[cfg(test)]
mod tests;
