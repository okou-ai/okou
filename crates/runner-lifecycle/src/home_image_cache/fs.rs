use std::path::{Path, PathBuf};
use std::time::Duration;

use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use tokio::fs;

use chrono::SecondsFormat;

use crate::error::{LifecycleError, LifecycleResult};
use runner_host::bounded_command::{
    BoundedCommandError, BoundedCommandOutcome, CommandOutputPolicy, run_output_bounded,
};

use super::HomeImageCache;
use super::types::{CacheBudget, FsStats};

pub(super) const HOME_IMAGE_COPY_TIMEOUT: Duration = Duration::from_secs(300);

impl HomeImageCache {
    pub(super) async fn fs_stats(&self) -> LifecycleResult<FsStats> {
        #[cfg(any(test, feature = "test-support"))]
        {
            Ok(self.inner.fs_stats_override)
        }

        #[cfg(not(any(test, feature = "test-support")))]
        {
            self.query_fs_stats().await
        }
    }

    pub(super) async fn query_fs_stats(&self) -> LifecycleResult<FsStats> {
        let path = self.home_image_cache_fs_stats_path();
        statvfs_bytes(&path).await
    }

    pub(super) async fn ensure_home_cache_entry_dir(&self, cache_key: &str) -> LifecycleResult<()> {
        runner_host::host_file::ensure_dir(
            self.home_image_cache_dir(),
            runner_host::host_file::DirMode::Private,
            "home image cache root",
        )?;
        let entry_dir = self.home_image_cache_entry_dir(cache_key);
        remove_non_directory_home_cache_entry(&entry_dir).await?;
        runner_host::host_file::ensure_dir(
            &entry_dir,
            runner_host::host_file::DirMode::Private,
            "home image cache entry",
        )?;
        Ok(())
    }
}

pub(super) fn is_home_tmp_path_name(name: &str) -> bool {
    name.starts_with("metadata.json.tmp.")
        || name
            .strip_prefix("image-")
            .and_then(|s| s.strip_suffix(".ext4.tmp"))
            .is_some_and(super::entry::valid_generation)
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

pub(super) fn existing_fs_stats_path(path: &Path) -> PathBuf {
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
}

pub(super) async fn home_cache_existing_path_allocated_bytes(
    path: &Path,
) -> std::io::Result<Option<u64>> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    runner_host::host_file::validate_dir(
        runner_host::host_file::file_parent(path),
        runner_host::host_file::DirMode::TrustedParent,
        "home allocation parent",
    )?;
    Ok(Some(path_tree_allocated_bytes(path, metadata).await?))
}

pub(super) async fn remove_home_cache_path_if_exists(path: &Path) -> std::io::Result<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    runner_host::host_file::validate_dir(
        runner_host::host_file::file_parent(path),
        runner_host::host_file::DirMode::TrustedParent,
        "home reclamation parent",
    )?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_file(path).await?;
    }
    Ok(true)
}

pub(super) async fn remove_non_directory_home_cache_entry(path: &Path) -> LifecycleResult<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    runner_host::host_file::validate_dir(
        runner_host::host_file::file_parent(path),
        runner_host::host_file::DirMode::TrustedParent,
        "home cache entry parent",
    )?;
    if metadata.is_dir() {
        return Ok(false);
    }
    remove_home_cache_path_if_exists(path).await?;
    Ok(true)
}

pub(super) fn secure_home_cache_publication_file(path: &Path) -> LifecycleResult<()> {
    runner_host::host_file::validate_private_file_destination(
        path,
        "home image cache publication file",
    )?;
    Ok(())
}

pub(super) fn has_copy_headroom(stats: FsStats, budget: CacheBudget, allocated_bytes: u64) -> bool {
    stats.available_bytes.saturating_sub(allocated_bytes) >= budget.min_free_bytes
}

fn cp_command_error(error: BoundedCommandError) -> LifecycleError {
    match error {
        BoundedCommandError::Spawn(error) => LifecycleError::Internal(format!("exec cp: {error}")),
        BoundedCommandError::Wait(error) => LifecycleError::Internal(format!("wait cp: {error}")),
        BoundedCommandError::Lifecycle(message) => LifecycleError::Internal(message),
        BoundedCommandError::OutputTooLarge { stream, limit } => LifecycleError::Internal(format!(
            "cp {stream} exceeded output limit of {limit} bytes"
        )),
    }
}

pub(super) async fn statvfs_bytes(path: &Path) -> LifecycleResult<FsStats> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || statvfs_bytes_sync(&path))
        .await
        .map_err(|e| LifecycleError::Internal(format!("statvfs task failed: {e}")))?
}

pub(super) async fn entry_file_type_is_dir(entry: &fs::DirEntry) -> LifecycleResult<bool> {
    entry_file_type_matches(entry, std::fs::FileType::is_dir).await
}

pub(super) async fn cache_entry_dir_is_dir(path: &Path) -> LifecycleResult<bool> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub(super) async fn entry_file_type_matches(
    entry: &fs::DirEntry,
    matches: fn(&std::fs::FileType) -> bool,
) -> LifecycleResult<bool> {
    match entry.file_type().await {
        Ok(file_type) => Ok(matches(&file_type)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub(super) fn statvfs_bytes_sync(path: &Path) -> LifecycleResult<FsStats> {
    let stats = statvfs_for_path(path)?;
    Ok(fs_stats_from_statvfs(&stats))
}

pub(super) fn statvfs_for_path(path: &Path) -> LifecycleResult<libc::statvfs> {
    let bytes = path.as_os_str().as_bytes();
    let c_path = std::ffi::CString::new(bytes)
        .map_err(|_| LifecycleError::Internal("statvfs path contains nul byte".to_owned()))?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { stats.assume_init() })
}

pub(super) fn fs_stats_from_statvfs(stats: &libc::statvfs) -> FsStats {
    let block_size = stats.f_frsize;
    FsStats {
        total_bytes: stats.f_blocks.saturating_mul(block_size),
        available_bytes: stats.f_bavail.saturating_mul(block_size),
    }
}

async fn path_tree_allocated_bytes(
    path: &Path,
    metadata: std::fs::Metadata,
) -> std::io::Result<u64> {
    let mut total = allocated_bytes(&metadata);
    if !metadata.file_type().is_dir() {
        return Ok(total);
    }

    let mut pending = vec![(path.to_path_buf(), true)];
    while let Some((dir, metadata_counted)) = pending.pop() {
        if !metadata_counted {
            let metadata = fs::symlink_metadata(&dir).await?;
            total = total.saturating_add(allocated_bytes(&metadata));
            if !metadata.file_type().is_dir() {
                continue;
            }
        }

        let mut entries = fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let file_type = entry.file_type().await?;
            if file_type.is_dir() {
                pending.push((path, false));
            } else {
                let metadata = fs::symlink_metadata(&path).await?;
                total = total.saturating_add(allocated_bytes(&metadata));
            }
        }
    }
    Ok(total)
}

/// A descriptor pins the regular file through move/copy and directory changes.
/// No-follow opens, one-link ownership, and path/descriptor revalidation prevent
/// a replacement path from becoming cache authority.
pub(super) struct PinnedImage {
    file: std::fs::File,
    identity: super::metadata::HomeImageFileIdentity,
}
impl PinnedImage {
    pub(super) fn open(path: &Path, expected_size: u64) -> LifecycleResult<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        secure_home_cache_publication_file(path)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() != expected_size {
            return Err(LifecycleError::Internal(
                "home image is not an owned exact-shape regular file".into(),
            ));
        }
        let pinned = Self {
            file,
            identity: super::metadata::HomeImageFileIdentity::from_metadata(&metadata),
        };
        pinned.validate_path(path)?;
        Ok(pinned)
    }
    pub(super) fn validate_path(&self, path: &Path) -> LifecycleResult<std::fs::Metadata> {
        let descriptor = self.file.metadata()?;
        let observed = std::fs::symlink_metadata(path)?;
        if !observed.is_file()
            || observed.nlink() != 1
            || descriptor.nlink() != 1
            || super::metadata::HomeImageFileIdentity::from_metadata(&descriptor) != self.identity
            || super::metadata::HomeImageFileIdentity::from_metadata(&observed) != self.identity
        {
            return Err(LifecycleError::Internal("pinned home image changed".into()));
        }
        Ok(observed)
    }
    pub(super) fn sync(&self) -> LifecycleResult<()> {
        self.file.sync_all()?;
        Ok(())
    }
    pub(super) fn identity(&self) -> super::metadata::HomeImageFileIdentity {
        self.identity
    }
    pub(super) fn descriptor_path(&self) -> PathBuf {
        use std::os::fd::AsRawFd;
        PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            self.file.as_raw_fd()
        ))
    }
}

pub(super) async fn sync_private_file(path: &Path) -> LifecycleResult<()> {
    use std::os::unix::fs::OpenOptionsExt;
    secure_home_cache_publication_file(path)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.nlink() != 1 {
        return Err(LifecycleError::Internal(
            "sync target is not an owned regular file".into(),
        ));
    }
    file.sync_all()?;
    Ok(())
}

pub(super) async fn sync_directory(path: &Path) -> LifecycleResult<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.sync_all()?;
    Ok(())
}

/// Linux cache publication cannot replace even an orphan of the same UUID.
pub(super) fn move_noreplace(src: &Path, dst: &Path) -> std::io::Result<()> {
    let src = std::ffi::CString::new(src.as_os_str().as_bytes())?;
    let dst = std::ffi::CString::new(dst.as_os_str().as_bytes())?;
    let rc = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            src.as_ptr(),
            libc::AT_FDCWD,
            dst.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Cross-device copy reads the pinned descriptor, not a mutable tenant pathname.
/// The destination is exclusively created and itself pinned. cp only dereferences
/// these host-owned /proc descriptors; its usual timeout/drain owner is retained.
pub(super) async fn sparse_copy_pinned(
    source: &PinnedImage,
    dst: &Path,
    size: u64,
) -> LifecycleResult<PinnedImage> {
    use std::os::unix::fs::OpenOptionsExt;
    let target = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dst)?;
    use std::os::fd::AsRawFd;
    let target_path = format!("/proc/{}/fd/{}", std::process::id(), target.as_raw_fd());
    let mut command = tokio::process::Command::new("cp");
    command
        .arg("--sparse=always")
        .arg("--dereference")
        .arg("--")
        .arg(source.descriptor_path())
        .arg(target_path);
    let result = run_output_bounded(
        command,
        "cp",
        CommandOutputPolicy::diagnostic_stderr(),
        HOME_IMAGE_COPY_TIMEOUT,
    )
    .await
    .map_err(cp_command_error)?;
    match result {
        BoundedCommandOutcome::Exited(output) if output.status.success() => {}
        BoundedCommandOutcome::Exited(output) => {
            return Err(LifecycleError::Internal(format!(
                "pinned sparse copy failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        BoundedCommandOutcome::TimedOut => {
            return Err(LifecycleError::Internal(
                "pinned sparse copy timed out".into(),
            ));
        }
    }
    let copied = PinnedImage::open(dst, size)?;
    let target_metadata = target.metadata()?;
    if copied.identity().dev != target_metadata.dev()
        || copied.identity().ino != target_metadata.ino()
    {
        return Err(LifecycleError::Internal(
            "pinned sparse destination replaced".into(),
        ));
    }
    Ok(copied)
}

pub(super) async fn measured_entry_bytes(path: &Path) -> LifecycleResult<u64> {
    Ok(home_cache_existing_path_allocated_bytes(path)
        .await?
        .unwrap_or(0))
}

pub(super) fn local_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
