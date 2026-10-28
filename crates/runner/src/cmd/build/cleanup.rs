//! Physical template cleanup retains its primary build authority after waiter cancellation.

use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use nix::fcntl::Flock;

use crate::error::{RunnerError, RunnerResult};

use super::{TEMPLATE_WARM_ATTEMPT_DIR_PREFIX, is_template_attempt_dir_name};

pub(super) struct TemplateCleanup {
    primary_lock: Arc<Flock<File>>,
}

impl TemplateCleanup {
    pub(super) fn new(primary_lock: Arc<Flock<File>>) -> Self {
        Self { primary_lock }
    }

    pub(super) async fn stale_attempts(
        &self,
        parent: &Path,
        prefix: &'static str,
    ) -> RunnerResult<()> {
        let parent = parent.to_path_buf();
        self.run(move || cleanup_stale_template_attempt_dirs(&parent, prefix))
            .await
    }

    pub(super) async fn warm_parent(&self, parent: &Path) -> RunnerResult<()> {
        let parent = parent.to_path_buf();
        self.run(move || {
            cleanup_template_warm_parent(&parent)?;
            remove_empty_dir_if_exists(&parent)
        })
        .await
    }

    pub(super) async fn finish_attempt(
        &self,
        path: &Path,
        label: &'static str,
        result: RunnerResult<()>,
    ) -> RunnerResult<()> {
        let path = path.to_path_buf();
        self.run(move || finish_temp_dir_result(&path, label, result))
            .await
    }

    pub(super) async fn finish_warm(
        &self,
        parent: &Path,
        attempt: &Path,
        result: RunnerResult<()>,
    ) -> RunnerResult<()> {
        let parent = parent.to_path_buf();
        let attempt = attempt.to_path_buf();
        self.run(move || finish_template_warm_dir_result(&parent, &attempt, result))
            .await
    }

    async fn run(
        &self,
        work: impl FnOnce() -> RunnerResult<()> + Send + 'static,
    ) -> RunnerResult<()> {
        let guard = Arc::clone(&self.primary_lock);
        let dispatcher = tracing::dispatcher::get_default(Clone::clone);
        let span = tracing::Span::current();
        // One accepted transaction owns the guard through all physical work.
        // Detaching its async observer cannot unlock a queued or running cleanup.
        tokio::task::spawn_blocking(move || {
            tracing::dispatcher::with_default(&dispatcher, || {
                span.in_scope(|| {
                    let result = work();
                    drop(guard);
                    result
                })
            })
        })
        .await
        .map_err(|error| RunnerError::Internal(format!("template cleanup task: {error}")))?
    }
}

fn cleanup_stale_template_attempt_dirs(parent: &Path, prefix: &str) -> RunnerResult<()> {
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read template attempt parent {}: {e}",
                parent.display()
            )));
        }
    };

    for entry in entries {
        let entry = entry.map_err(|e| {
            RunnerError::Internal(format!(
                "read template attempt entry in {}: {e}",
                parent.display()
            ))
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_template_attempt_dir_name(name, prefix) {
            remove_path_if_exists(&entry.path(), "stale template attempt dir")?;
        }
    }

    Ok(())
}

fn cleanup_template_warm_parent(parent: &Path) -> RunnerResult<()> {
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.is_dir() => {
            cleanup_stale_template_attempt_dirs(parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX)
        }
        Ok(_) => remove_path_if_exists(parent, "stale template warm parent"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat template warm parent {}: {e}",
            parent.display()
        ))),
    }
}

fn remove_path_if_exists(path: &Path, label: &str) -> RunnerResult<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat {label} {}: {e}",
            path.display()
        )))?,
    };

    let result = if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| RunnerError::Internal(format!("remove {label} {}: {e}", path.display())))
}

fn remove_dir_all_if_exists(path: &Path, label: &str) -> RunnerResult<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "remove {label} {}: {e}",
            path.display()
        ))),
    }
}

fn finish_temp_dir_result(path: &Path, label: &str, result: RunnerResult<()>) -> RunnerResult<()> {
    let cleanup = remove_dir_all_if_exists(path, label);
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(cleanup_err)) => Err(cleanup_err),
        (Err(original_err), Ok(())) => Err(original_err),
        (Err(original_err), Err(cleanup_err)) => {
            tracing::warn!(
                "failed to remove {label} {} after an earlier error: {cleanup_err}",
                path.display()
            );
            Err(original_err)
        }
    }
}

fn finish_template_warm_dir_result(
    parent: &Path,
    attempt: &Path,
    result: RunnerResult<()>,
) -> RunnerResult<()> {
    let result = finish_temp_dir_result(attempt, "template warm dir", result);
    match remove_empty_dir_if_exists(parent) {
        Ok(()) => result,
        Err(parent_err) => match result {
            Ok(()) => Err(parent_err),
            Err(original_err) => {
                tracing::warn!(
                    "failed to remove template warm parent {} after an earlier error: {parent_err}",
                    parent.display()
                );
                Err(original_err)
            }
        },
    }
}

fn remove_empty_dir_if_exists(path: &Path) -> RunnerResult<()> {
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(e) => Err(RunnerError::Internal(format!(
            "remove empty template warm parent {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests;
