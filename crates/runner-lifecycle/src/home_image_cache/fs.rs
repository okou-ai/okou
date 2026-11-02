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
use super::io_context::with_path;
use super::types::{FsStats, HomeCachePressureThresholds};

mod staging;
pub(super) use staging::StagingFile;

pub(super) const HOME_IMAGE_COPY_TIMEOUT: Duration = Duration::from_secs(300);

impl HomeImageCache {
    pub(super) async fn fs_stats(&self) -> LifecycleResult<FsStats> {
        #[cfg(any(test, feature = "test-support"))]
        {
            if !self.use_actual_fs_stats {
                return Ok(*self
                    .inner
                    .fs_stats_override
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner));
            }
        }

        self.query_fs_stats().await
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
    let Some(metadata) = allocation_path_metadata(path).await? else {
        return Ok(None);
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
        Err(e) => return Err(with_path(e, "symlink_metadata", path)),
    };
    runner_host::host_file::validate_dir(
        runner_host::host_file::file_parent(path),
        runner_host::host_file::DirMode::TrustedParent,
        "home reclamation parent",
    )?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
            .await
            .map_err(|error| with_path(error, "remove_dir_all", path))?;
    } else {
        fs::remove_file(path)
            .await
            .map_err(|error| with_path(error, "remove_file", path))?;
    }
    Ok(true)
}

pub(super) async fn remove_non_directory_home_cache_entry(path: &Path) -> LifecycleResult<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(with_path(e, "symlink_metadata", path).into()),
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

pub(super) fn has_copy_headroom(
    stats: FsStats,
    pressure: HomeCachePressureThresholds,
    allocated_bytes: u64,
) -> bool {
    pressure.reserve_feasible
        && allocated_bytes <= stats.available_bytes
        && stats.available_bytes - allocated_bytes >= pressure.reserve_bytes
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
        Err(e) => Err(with_path(e, "symlink_metadata", path).into()),
    }
}

pub(super) async fn entry_file_type_matches(
    entry: &fs::DirEntry,
    matches: fn(&std::fs::FileType) -> bool,
) -> LifecycleResult<bool> {
    match entry.file_type().await {
        Ok(file_type) => Ok(matches(&file_type)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(with_path(e, "DirEntry::file_type", &entry.path()).into()),
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
        return Err(with_path(std::io::Error::last_os_error(), "statvfs", path).into());
    }
    Ok(unsafe { stats.assume_init() })
}

pub(super) fn fs_stats_from_statvfs(stats: &libc::statvfs) -> FsStats {
    let block_size = stats.f_frsize;
    FsStats {
        total_bytes: stats.f_blocks.saturating_mul(block_size),
        available_bytes: stats.f_bavail.saturating_mul(block_size),
        total_inodes: stats.f_files,
        available_inodes: stats.f_favail,
    }
}

async fn allocation_path_metadata(path: &Path) -> std::io::Result<Option<std::fs::Metadata>> {
    #[cfg(test)]
    super::tests::allocation_scan::pause(path, super::tests::allocation_scan::ScanPoint::Metadata)
        .await;
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(with_path(error, "symlink_metadata", path)),
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

    // Concurrent entry-local GC and checkout can remove discovered descendants.
    // Missing descendants add no further allocation; retain already-counted
    // blocks conservatively and propagate other errors.
    let mut pending = vec![(path.to_path_buf(), true)];
    while let Some((dir, is_root)) = pending.pop() {
        if !is_root {
            let Some(metadata) = allocation_path_metadata(&dir).await? else {
                continue;
            };
            total = total.saturating_add(allocated_bytes(&metadata));
            if !metadata.file_type().is_dir() {
                continue;
            }
        }

        #[cfg(test)]
        super::tests::allocation_scan::pause(
            &dir,
            super::tests::allocation_scan::ScanPoint::ReadDirectory,
        )
        .await;
        let mut entries = match fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(error) if !is_root && error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(with_path(error, "read_dir", &dir)),
        };
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| with_path(error, "ReadDir::next_entry", &dir))?
        {
            let path = entry.path();
            let file_type = match entry.file_type().await {
                Ok(file_type) => file_type,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(with_path(error, "DirEntry::file_type", &path)),
            };
            if file_type.is_dir() {
                pending.push((path, false));
            } else {
                let Some(metadata) = allocation_path_metadata(&path).await? else {
                    continue;
                };
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
            .open(path)
            .map_err(|error| with_path(error, "open_image", path))?;
        let metadata = file
            .metadata()
            .map_err(|error| with_path(error, "File::metadata", path))?;
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
        let descriptor = self
            .file
            .metadata()
            .map_err(|error| with_path(error, "File::metadata", path))?;
        let observed = std::fs::symlink_metadata(path)
            .map_err(|error| with_path(error, "symlink_metadata", path))?;
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
    pub(super) async fn sync_owned(
        &self,
        path: &Path,
        before_sync: impl FnOnce() + Send + 'static,
    ) -> LifecycleResult<()> {
        sync_descriptor(&self.file, path, before_sync).await
    }
    pub(super) fn identity(&self) -> super::metadata::HomeImageFileIdentity {
        self.identity
    }
    pub(super) fn clone_file_for_observation(&self) -> std::io::Result<std::fs::File> {
        self.file.try_clone()
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

async fn sync_descriptor(
    file: &std::fs::File,
    path: &Path,
    before_sync: impl FnOnce() + Send + 'static,
) -> LifecycleResult<()> {
    let file = file.try_clone()?;
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        before_sync();
        file.sync_all()
            .map_err(|error| with_path(error, "sync_image", &path))
    })
    .await
    .map_err(|error| LifecycleError::Internal(format!("home image sync task failed: {error}")))??;
    Ok(())
}

pub(super) async fn sync_directory(path: &Path) -> LifecycleResult<()> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || sync_directory_blocking(&path))
        .await
        .map_err(|error| {
            LifecycleError::Internal(format!("home directory sync task failed: {error}"))
        })?
}

fn sync_directory_blocking(path: &Path) -> LifecycleResult<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| with_path(error, "open_directory", path))?;
    file.sync_all()
        .map_err(|error| with_path(error, "sync_directory", path))?;
    Ok(())
}

/// Linux cache publication cannot replace even an orphan of the same UUID.
pub(super) fn move_noreplace(src: &Path, dst: &Path) -> std::io::Result<()> {
    let src = std::ffi::CString::new(src.as_os_str().as_bytes())?;
    let dst = std::ffi::CString::new(dst.as_os_str().as_bytes())?;
    // Call the Linux syscall directly: supported musl toolchains need not
    // export the renameat2 libc wrapper. Preserve atomic NOREPLACE semantics
    // and errno, including EXDEV; never fall back to a replacing rename.
    // SAFETY: both paths are live NUL-terminated strings, the directory
    // selectors are AT_FDCWD, and the flags contain only RENAME_NOREPLACE.
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
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
    retained_target: &mut Option<StagingFile>,
    after_create: impl FnOnce() -> LifecycleResult<()>,
) -> LifecycleResult<PinnedImage> {
    let target = match retained_target {
        Some(target) => target,
        slot @ None => slot.insert(StagingFile::create(dst)?),
    };
    target.validate_path(dst)?;
    after_create()?;
    use std::os::fd::AsRawFd;
    let target_path = format!(
        "/proc/{}/fd/{}",
        std::process::id(),
        target.descriptor().as_raw_fd()
    );
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
    let target_metadata = target
        .descriptor()
        .metadata()
        .map_err(|error| with_path(error, "File::metadata", dst))?;
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

#[cfg(test)]
mod tests;
