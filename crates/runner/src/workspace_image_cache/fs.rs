use std::path::{Path, PathBuf};
use std::time::Duration;

use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use tokio::fs;

use chrono::SecondsFormat;

use crate::bounded_command::{
    BoundedCommandError, BoundedCommandOutcome, CommandOutputPolicy, run_output_bounded,
};
use crate::error::{RunnerError, RunnerResult};

use super::WorkspaceImageCache;
use super::types::{CacheBudget, FsStats};

pub(super) const WORKSPACE_IMAGE_COPY_TIMEOUT: Duration = Duration::from_secs(300);

impl WorkspaceImageCache {
    pub(super) async fn fs_stats(&self) -> RunnerResult<FsStats> {
        #[cfg(test)]
        {
            Ok(self.inner.fs_stats_override)
        }

        #[cfg(not(test))]
        {
            self.query_fs_stats().await
        }
    }

    runner_test_support!(storage; pub(super) async fn query_fs_stats(&self) -> RunnerResult<FsStats> {
        let path = self.workspace_image_cache_fs_stats_path();
        statvfs_bytes(&path).await
    });

    pub(super) async fn ensure_workspace_cache_entry_dir(
        &self,
        cache_key: &str,
    ) -> RunnerResult<()> {
        crate::host_file::ensure_dir(
            self.workspace_image_cache_dir(),
            crate::host_file::DirMode::Private,
            "workspace image cache root",
        )?;
        let entry_dir = self.workspace_image_cache_entry_dir(cache_key);
        remove_non_directory_workspace_cache_entry(&entry_dir).await?;
        crate::host_file::ensure_dir(
            &entry_dir,
            crate::host_file::DirMode::Private,
            "workspace image cache entry",
        )?;
        Ok(())
    }
}

pub(super) fn is_workspace_tmp_path_name(name: &str) -> bool {
    name.starts_with("current.ext4.tmp.")
        || name.starts_with("metadata.json.tmp.")
        || name.starts_with("session-history.blob.tmp.")
        || name.starts_with("session-history.metadata.json.tmp.")
}

pub(super) fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

pub(super) fn fs_stats_with_additional_available(stats: FsStats, bytes: u64) -> FsStats {
    FsStats {
        total_bytes: stats.total_bytes,
        available_bytes: stats
            .available_bytes
            .saturating_add(bytes)
            .min(stats.total_bytes),
    }
}

runner_test_support!(storage; pub(super) fn existing_fs_stats_path(path: &Path) -> PathBuf {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match std::fs::metadata(candidate) {
            Ok(_) => return candidate.to_path_buf(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                current = candidate.parent();
            }
            Err(_) => return candidate.to_path_buf(),
        }
    }
    path.to_path_buf()
});

pub(super) async fn workspace_cache_path_allocated_bytes(path: &Path) -> u64 {
    match workspace_cache_existing_path_allocated_bytes(path).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) | Err(_) => 0,
    }
}

pub(super) async fn workspace_cache_existing_path_allocated_bytes(
    path: &Path,
) -> std::io::Result<Option<u64>> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(Some(path_tree_allocated_bytes(path, metadata).await))
}

pub(super) async fn remove_workspace_cache_path_if_exists(path: &Path) -> std::io::Result<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_file(path).await?;
    }
    Ok(true)
}

pub(super) async fn remove_non_directory_workspace_cache_entry(path: &Path) -> RunnerResult<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if metadata.is_dir() {
        return Ok(false);
    }
    remove_workspace_cache_path_if_exists(path).await?;
    Ok(true)
}

pub(super) fn secure_workspace_cache_publication_file(path: &Path) -> RunnerResult<()> {
    crate::host_file::validate_private_file_destination(
        path,
        "workspace image cache publication file",
    )?;
    Ok(())
}

pub(super) fn has_copy_headroom(stats: FsStats, budget: CacheBudget, allocated_bytes: u64) -> bool {
    stats.available_bytes.saturating_sub(allocated_bytes) >= budget.min_free_bytes
}

pub(super) async fn sparse_copy(src: &Path, dst: &Path) -> RunnerResult<()> {
    sparse_copy_with_timeout(src, dst, WORKSPACE_IMAGE_COPY_TIMEOUT).await
}

pub(super) async fn sparse_copy_with_timeout(
    src: &Path,
    dst: &Path,
    timeout: Duration,
) -> RunnerResult<()> {
    let mut command = tokio::process::Command::new("cp");
    command
        .arg("--sparse=always")
        .arg("--no-dereference")
        .arg("--")
        .arg(src)
        .arg(dst);
    let output = match run_output_bounded(
        command,
        "cp",
        CommandOutputPolicy::diagnostic_stderr(),
        timeout,
    )
    .await
    .map_err(cp_command_error)?
    {
        BoundedCommandOutcome::Exited(output) => output,
        BoundedCommandOutcome::TimedOut => {
            return Err(RunnerError::Internal(format!(
                "cp --sparse=always --no-dereference {} {} timed out after {}ms",
                src.display(),
                dst.display(),
                timeout.as_millis()
            )));
        }
    };
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(RunnerError::Internal(format!(
        "cp --sparse=always --no-dereference {} {} failed: {}",
        src.display(),
        dst.display(),
        stderr.trim()
    )))
}

fn cp_command_error(error: BoundedCommandError) -> RunnerError {
    match error {
        BoundedCommandError::Spawn(error) => RunnerError::Internal(format!("exec cp: {error}")),
        BoundedCommandError::Wait(error) => RunnerError::Internal(format!("wait cp: {error}")),
        BoundedCommandError::Lifecycle(message) => RunnerError::Internal(message),
        BoundedCommandError::OutputTooLarge { stream, limit } => RunnerError::Internal(format!(
            "cp {stream} exceeded output limit of {limit} bytes"
        )),
    }
}

runner_test_support!(storage; pub(super) async fn statvfs_bytes(path: &Path) -> RunnerResult<FsStats> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || statvfs_bytes_sync(&path))
        .await
        .map_err(|e| RunnerError::Internal(format!("statvfs task failed: {e}")))?
});

pub(super) async fn entry_file_type_is_dir(entry: &fs::DirEntry) -> RunnerResult<bool> {
    entry_file_type_matches(entry, std::fs::FileType::is_dir).await
}

pub(super) async fn cache_entry_dir_is_dir(path: &Path) -> RunnerResult<bool> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub(super) async fn entry_file_type_matches(
    entry: &fs::DirEntry,
    matches: fn(&std::fs::FileType) -> bool,
) -> RunnerResult<bool> {
    match entry.file_type().await {
        Ok(file_type) => Ok(matches(&file_type)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

runner_test_support!(storage; pub(super) fn statvfs_bytes_sync(path: &Path) -> RunnerResult<FsStats> {
    let stats = statvfs_for_path(path)?;
    Ok(fs_stats_from_statvfs(&stats))
});

runner_test_support!(storage; pub(super) fn statvfs_for_path(path: &Path) -> RunnerResult<libc::statvfs> {
    let bytes = path.as_os_str().as_bytes();
    let c_path = std::ffi::CString::new(bytes)
        .map_err(|_| RunnerError::Internal("statvfs path contains nul byte".to_owned()))?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { stats.assume_init() })
});

runner_test_support!(storage; pub(super) fn fs_stats_from_statvfs(stats: &libc::statvfs) -> FsStats {
    let block_size = stats.f_frsize;
    FsStats {
        total_bytes: stats.f_blocks.saturating_mul(block_size),
        available_bytes: stats.f_bavail.saturating_mul(block_size),
    }
});

async fn path_tree_allocated_bytes(path: &Path, metadata: std::fs::Metadata) -> u64 {
    let mut total = allocated_bytes(&metadata);
    if !metadata.file_type().is_dir() {
        return total;
    }

    let mut pending = vec![(path.to_path_buf(), true)];
    while let Some((dir, metadata_counted)) = pending.pop() {
        if !metadata_counted {
            let Ok(metadata) = fs::symlink_metadata(&dir).await else {
                continue;
            };
            total = total.saturating_add(allocated_bytes(&metadata));
            if !metadata.file_type().is_dir() {
                continue;
            }
        }

        let mut entries = match fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if file_type.is_dir() {
                pending.push((path, false));
            } else {
                let Ok(metadata) = fs::symlink_metadata(&path).await else {
                    continue;
                };
                total = total.saturating_add(allocated_bytes(&metadata));
            }
        }
    }
    total
}

pub(super) fn local_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
