//! Immutable extracted files in the existing storage-cache GC/lock domain.

use super::*;
use crate::host_file::{self, DirMode};
use crate::lock::{self, ExistingTryLock, TryLock};
use crate::paths::{HomePaths, short_digest, touch_mtime};
use nix::fcntl::{OFlag, openat};
use nix::sys::stat::Mode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

#[cfg(test)]
mod tests;

const INDEX_LIMIT: usize = 256 * 1024;

// Bound directory inodes as well as file count. Ordinary extraction remains
// available for deeper or unusually wide trees.
pub(super) fn admitted_paths(files: &[StorageFile]) -> bool {
    let mut parents = std::collections::HashSet::new();
    for file in files {
        let path = Path::new(&file.path);
        if path.components().any(|part| part.as_os_str().len() > 255) {
            return false;
        }
        for parent in path
            .ancestors()
            .skip(1)
            .filter(|path| !path.as_os_str().is_empty())
        {
            parents.insert(parent);
            if parents.len() > 64 {
                return false;
            }
        }
    }
    true
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    name: String,
    version: String,
    compressed_bytes: usize,
    files: Option<Vec<FileInfo>>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileInfo {
    path: String,
    mode: u32,
    mtime: u64,
    size: usize,
    sha256: String,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn check_cancel(cancel: &CancellationToken) -> io::Result<()> {
    if cancel.is_cancelled() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "decoded cache stopped",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(super) fn paths(home: &HomePaths, name: &str, version: &str) -> (PathBuf, PathBuf) {
    entry_paths(home, name, version, false)
}

fn version_key(version: &str, rejected: bool) -> String {
    let kind = if rejected { "rejected-" } else { "" };
    format!("decoded-v1-{kind}{}", short_digest(version))
}

fn entry_paths(home: &HomePaths, name: &str, version: &str, rejected: bool) -> (PathBuf, PathBuf) {
    let name = short_digest(name);
    // The format is part of the version-directory identity. Previous archive
    // readers never open this entry; previous GC uses the same name/key lock
    // and recursively accounts its real files, including .tmp staging.
    let version = version_key(version, rejected);
    (
        home.storages_dir().join(&name).join(&version),
        home.storage_lock_for_cache_key(&name, &version),
    )
}

fn open_directory(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

fn open_entry(home: &HomePaths, name: &str, version: &str, rejected: bool) -> io::Result<File> {
    let mut directory = open_directory(&home.storages_dir())?;
    for component in [short_digest(name), version_key(version, rejected)] {
        directory = File::from(
            openat(
                &directory,
                component.as_str(),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(io::Error::from)?,
        );
    }
    Ok(directory)
}

fn read_file(root: &File, relative: &str, limit: usize) -> io::Result<Vec<u8>> {
    let parts: Vec<_> = Path::new(relative).components().collect();
    if parts
        .iter()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid("invalid decoded cache relative path"));
    }
    let (filename, parents) = parts
        .split_last()
        .ok_or_else(|| invalid("empty decoded cache path"))?;
    let mut directory = root.try_clone()?;
    for part in parents {
        directory = File::from(
            openat(
                &directory,
                Path::new(part.as_os_str()),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(io::Error::from)?,
        );
    }
    let mut file = File::from(
        openat(
            &directory,
            Path::new(filename.as_os_str()),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?,
    );
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > limit as u64 {
        return Err(invalid("invalid decoded cache file type or size"));
    }
    let mut bytes = vec![0; metadata.len() as usize];
    file.read_exact(&mut bytes)?;
    if file.read(&mut [0])? != 0 {
        return Err(invalid("decoded cache file grew during read"));
    }
    Ok(bytes)
}

/// Foreground lookup only opens positive extracted-file entries. Admission
/// rejections live in a separate version key, inspected only by background fill.
pub(super) fn read(
    home: &HomePaths,
    name: &str,
    version: &str,
    cancel: &CancellationToken,
) -> io::Result<Option<Option<Vec<StorageFile>>>> {
    read_entry(home, name, version, false, cancel)
}

pub(super) fn is_rejected(
    home: &HomePaths,
    name: &str,
    version: &str,
    cancel: &CancellationToken,
) -> io::Result<bool> {
    read_entry(home, name, version, true, cancel).map(|entry| entry.is_some())
}

fn read_entry(
    home: &HomePaths,
    name: &str,
    version: &str,
    rejected: bool,
    cancel: &CancellationToken,
) -> io::Result<Option<Option<Vec<StorageFile>>>> {
    check_cancel(cancel)?;
    let (path, lock_path) = entry_paths(home, name, version, rejected);
    // Most first uses have no extracted entry. A miss needs no flock or lock
    // namespace walk. Present data is still reopened and validated under its
    // lock below; publication racing this probe can safely wait for the next run.
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(invalid("decoded cache target is not a directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    let _lock = match lock::try_acquire_existing_shared_or_missing_blocking(&lock_path)
        .map_err(io::Error::other)?
    {
        ExistingTryLock::Acquired(lock) => lock,
        ExistingTryLock::Busy => return Ok(None),
        ExistingTryLock::Missing => {
            // Existing Runner GC removes free lock files independently from
            // their cached data. Recreate for the observed entry, then reopen
            // it under the validated lock (GC may have removed it meanwhile).
            match lock::try_acquire_or_busy_blocking(&lock_path).map_err(io::Error::other)? {
                TryLock::Acquired(lock) => lock,
                TryLock::Busy => return Ok(None),
            }
        }
    };
    let root = match open_entry(home, name, version, rejected) {
        Ok(root) => root,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let index: Index = serde_json::from_slice(&read_file(&root, "index.json", INDEX_LIMIT)?)
        .map_err(io::Error::other)?;
    if index.name != name
        || index.version != version
        || index.compressed_bytes > storage_files::MAX_STORAGE_BYTES
        || index.files.is_none() != rejected
    {
        return Err(invalid("decoded cache identity or admission mismatch"));
    }
    let Some(metadata) = index.files else {
        touch_mtime(&path);
        return Ok(Some(None));
    };
    if index.compressed_bytes == 0
        || metadata.is_empty()
        || metadata.len() > storage_files::MAX_FILES
    {
        return Err(invalid("invalid decoded cache file count"));
    }
    let mut files = metadata
        .iter()
        .map(|entry| StorageFile {
            path: entry.path.clone(),
            mode: entry.mode,
            mtime: entry.mtime,
            content: Vec::new(),
        })
        .collect::<Vec<_>>();
    storage_files::validate_files(&files)?;
    if !admitted_paths(&files) {
        return Err(invalid("decoded cache directory limit exceeded"));
    }
    let mut total = 0usize;
    for entry in &metadata {
        if entry.size > storage_files::MAX_FILE_BYTES
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid("invalid decoded cache file metadata"));
        }
        total = total
            .checked_add(entry.size)
            .ok_or_else(|| invalid("decoded size overflow"))?;
    }
    if total > storage_files::MAX_STORAGE_BYTES || total > index.compressed_bytes.saturating_mul(4)
    {
        return Err(invalid("decoded cache expansion exceeds admission"));
    }
    let data = File::from(
        openat(
            &root,
            "files",
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?,
    );
    for (file, entry) in files.iter_mut().zip(metadata) {
        check_cancel(cancel)?;
        file.content = read_file(&data, &file.path, entry.size)?;
        if file.content.len() != entry.size
            || hex::encode(Sha256::digest(&file.content)) != entry.sha256
        {
            return Err(invalid("decoded cache content mismatch"));
        }
    }
    check_cancel(cancel)?;
    touch_mtime(&path);
    Ok(Some(Some(files)))
}

pub(super) fn publish(
    home: &HomePaths,
    name: &str,
    version: &str,
    compressed_bytes: usize,
    files: Option<&[StorageFile]>,
    cancel: &CancellationToken,
) -> io::Result<()> {
    check_cancel(cancel)?;
    let (path, lock_path) = entry_paths(home, name, version, files.is_none());
    let _lock = match lock::try_acquire_or_busy_blocking(&lock_path).map_err(io::Error::other)? {
        TryLock::Acquired(lock) => lock,
        TryLock::Busy => return Ok(()),
    };
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => return Ok(()),
        Ok(_) => return Err(invalid("decoded cache target is not a directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("missing decoded cache parent"))?;
    host_file::ensure_dir(parent, DirMode::TrustedParent, "decoded cache parent")?;
    let staging = path.with_extension("tmp");
    match fs::symlink_metadata(&staging) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&staging)?,
        Ok(_) => return Err(invalid("decoded staging is not a directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    host_file::ensure_dir(&staging, DirMode::Private, "decoded cache staging")?;
    // The exact .tmp path shares the final entry's lock with existing GC.
    let operation = (|| {
        let metadata = files.map(|files| {
            files
                .iter()
                .map(|file| FileInfo {
                    path: file.path.clone(),
                    mode: file.mode,
                    mtime: file.mtime,
                    size: file.content.len(),
                    sha256: hex::encode(Sha256::digest(&file.content)),
                })
                .collect()
        });
        let index = serde_json::to_vec(&Index {
            name: name.to_owned(),
            version: version.to_owned(),
            compressed_bytes,
            files: metadata,
        })
        .map_err(io::Error::other)?;
        if index.len() > INDEX_LIMIT {
            return Err(invalid("decoded cache index too large"));
        }
        if let Some(files) = files {
            storage_files::validate_files(files)?;
            if !admitted_paths(files) {
                return Err(invalid("decoded cache directory limit exceeded"));
            }
            for file in files {
                check_cancel(cancel)?;
                let target = staging.join("files").join(&file.path);
                host_file::ensure_dir(
                    target
                        .parent()
                        .ok_or_else(|| invalid("missing file parent"))?,
                    DirMode::Private,
                    "decoded cache files",
                )?;
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(target)?;
                output.write_all(&file.content)?;
                output.sync_all()?;
            }
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(staging.join("index.json"))?;
        output.write_all(&index)?;
        output.sync_all()?;
        check_cancel(cancel)?;
        fs::rename(&staging, &path)?;
        Ok(())
    })();
    if operation.is_err() {
        // A failed optional fill must not leave live work after its lock drops.
        if let Err(error) = fs::remove_dir_all(&staging) {
            tracing::warn!(%error, "failed to clean extracted cache staging; storage GC will retry");
        }
    }
    operation
}
