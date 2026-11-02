use super::FileEntry;
#[cfg(target_os = "linux")]
use crate::nofollow_fs::Dir;
#[cfg(target_os = "linux")]
use api_contracts::generated::constants::storages::{
    STORAGE_MANIFEST_MAX_FILES, STORAGE_MANIFEST_MAX_PATH_BYTES,
};
use flate2::Compression;
use flate2::write::GzEncoder;
use guest_telemetry::log_warn;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Maximum entries returned by `ReadDir` across one artifact walk.
///
/// This is deliberately independent from the retained-file limit. The larger
/// value leaves room for directory structure while bounding skipped entries.
#[cfg(target_os = "linux")]
pub(crate) const ARTIFACT_TRAVERSAL_MAX_ENTRIES: u64 = 100_000;
/// Maximum directory levels traversed below the configured artifact root.
#[cfg(target_os = "linux")]
pub(crate) const ARTIFACT_TRAVERSAL_MAX_DEPTH: u64 = 256;
/// Maximum bytes in the active UTF-8 path relative to the artifact root.
#[cfg(target_os = "linux")]
pub(crate) const ARTIFACT_TRAVERSAL_MAX_PATH_BYTES: u64 = 64 * 1024;

/// Collect a best-effort manifest of regular files readable at finalization time.
///
/// Artifact membership is intentionally based on what the walk can read and
/// hash. An unreadable descendant is not part of the artifact for this
/// finalization; omitting it lets other readable files be saved instead of
/// failing the entire finalization. A new version may therefore omit paths that
/// were present in the mounted parent version.
///
/// On Linux, access to the configured artifact root is strict: the root must be
/// opened and its directory listing must be initialized successfully. Below
/// that readable root, traversal is best-effort. The returned `Ok(Vec<FileEntry>)`
/// contains only regular files that were successfully observed, opened,
/// inspected, and hashed; it is not proof that every descendant was included.
/// A nested directory iteration, child open, metadata, or file read/hash
/// failure can therefore omit an entry or subtree while the walk still
/// succeeds. On non-Linux targets, root access is unsupported.
/// Every successfully yielded directory entry consumes a separate traversal
/// budget, including excluded and non-regular entries. Exceeding that budget,
/// the directory-depth limit, or the active relative-path limit is a hard
/// finalization failure rather than a best-effort omission.
///
/// Entries named `.git` or `.vm0`, symlinks, FIFOs, and other non-regular
/// entries are intentionally excluded. The root and descendant descriptors use
/// the existing fd-relative no-follow opening boundary, so symlinks are not
/// followed. Hard-linked names remain independent manifest paths even when
/// they refer to the same underlying file. Hash/read failures currently emit a
/// warning, but warning absence is not a completeness signal because not every
/// omission path has a diagnostic.
///
/// The exclusion and hardlink behavior is covered by
/// `walk_dir_skips_symlinks`, `walk_dir_does_not_follow_directory_symlink`,
/// `walk_dir_skips_fifo`, `collect_file_metadata_excludes_git_and_vm0`, and
/// `walk_dir_handles_hardlinks` in this module's tests. The finalization caller
/// that consumes the resulting list is
/// `crate::finalization::artifact::snapshot_artifact_entries`.
#[cfg(target_os = "linux")]
pub(super) fn collect_file_metadata(dir_path: &str) -> Result<Vec<FileEntry>, ArchiveError> {
    let mut files = Vec::new();
    let mut path_bytes = 0;
    let mut observed_entries = 0;
    let root_path = Path::new(dir_path);
    let root = open_artifact_root(root_path)?;
    let entries = read_artifact_root(&root, root_path)?;
    walk_entries(
        &root,
        "",
        entries,
        0,
        &mut observed_entries,
        &mut files,
        &mut path_bytes,
    )?;
    Ok(files)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn collect_file_metadata(dir_path: &str) -> Result<Vec<FileEntry>, ArchiveError> {
    Err(ArchiveError::UnsupportedRoot {
        path: PathBuf::from(dir_path),
    })
}

#[cfg(target_os = "linux")]
fn walk_dir(
    current: &Dir,
    relative: &str,
    depth: u64,
    observed_entries: &mut u64,
    out: &mut Vec<FileEntry>,
    path_bytes: &mut u64,
) -> Result<(), ArchiveError> {
    // An unreadable descendant subtree contributes no artifact files. Keep
    // walking the rest of the root rather than failing the finalization.
    let entries = match current.read_dir() {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    walk_entries(
        current,
        relative,
        entries,
        depth,
        observed_entries,
        out,
        path_bytes,
    )
}

#[cfg(target_os = "linux")]
fn walk_entries(
    current: &Dir,
    relative: &str,
    entries: fs::ReadDir,
    depth: u64,
    observed_entries: &mut u64,
    out: &mut Vec<FileEntry>,
    path_bytes: &mut u64,
) -> Result<(), ArchiveError> {
    // A failed directory entry cannot be included in this finalization's
    // artifact, but it should not prevent other entries from being saved.
    for entry in entries.flatten() {
        let candidate_entries = observed_entries.saturating_add(1);
        enforce_traversal_limits(
            candidate_entries,
            depth,
            u64::try_from(relative.len()).unwrap_or(u64::MAX),
        )?;
        *observed_entries = candidate_entries;

        let name = entry.file_name();
        if is_excluded_artifact_entry(&name) {
            continue;
        }

        let (try_directory, try_file) = match entry.file_type() {
            Ok(file_type) => (file_type.is_dir(), file_type.is_file()),
            Err(_) => (true, true),
        };
        if try_directory && let Ok(dir) = current.open_child_dir(&name) {
            let name_str = artifact_path_component(&name, relative)?;
            let rel = relative_artifact_path(relative, name_str);
            let child_depth = depth.saturating_add(1);
            enforce_traversal_limits(
                *observed_entries,
                child_depth,
                u64::try_from(rel.len()).unwrap_or(u64::MAX),
            )?;
            walk_dir(&dir, &rel, child_depth, observed_entries, out, path_bytes)?;
            continue;
        }
        if !try_file {
            continue;
        }

        // A regular file joins the artifact only when it can be opened,
        // inspected, and hashed. Access failures exclude that file by policy.
        let Ok(file) = current.open_child_file(&name) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let name_str = artifact_path_component(&name, relative)?;
        let rel = relative_artifact_path(relative, name_str);
        enforce_traversal_limits(
            *observed_entries,
            depth,
            u64::try_from(rel.len()).unwrap_or(u64::MAX),
        )?;
        let observed_files = u64::try_from(out.len())
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        let observed_path_bytes =
            path_bytes.saturating_add(u64::try_from(rel.len()).unwrap_or(u64::MAX));
        if observed_files > STORAGE_MANIFEST_MAX_FILES
            || observed_path_bytes > STORAGE_MANIFEST_MAX_PATH_BYTES
        {
            return Err(ArchiveError::ManifestLimitExceeded {
                observed_files,
                max_files: STORAGE_MANIFEST_MAX_FILES,
                observed_path_bytes,
                max_path_bytes: STORAGE_MANIFEST_MAX_PATH_BYTES,
            });
        }
        match compute_file_hash_from_reader(file) {
            Ok((hash, size)) => {
                *path_bytes = observed_path_bytes;
                out.push(FileEntry {
                    path: rel,
                    hash,
                    size,
                });
            }
            Err(e) => {
                log_warn!(LOG_TAG, "Could not process file {rel}: {e}");
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn enforce_traversal_limits(
    observed_entries: u64,
    observed_depth: u64,
    observed_path_bytes: u64,
) -> Result<(), ArchiveError> {
    if observed_entries > ARTIFACT_TRAVERSAL_MAX_ENTRIES
        || observed_depth > ARTIFACT_TRAVERSAL_MAX_DEPTH
        || observed_path_bytes > ARTIFACT_TRAVERSAL_MAX_PATH_BYTES
    {
        return Err(ArchiveError::TraversalLimitExceeded {
            observed_entries,
            max_entries: ARTIFACT_TRAVERSAL_MAX_ENTRIES,
            observed_depth,
            max_depth: ARTIFACT_TRAVERSAL_MAX_DEPTH,
            observed_path_bytes,
            max_path_bytes: ARTIFACT_TRAVERSAL_MAX_PATH_BYTES,
        });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn is_excluded_artifact_entry(name: &std::ffi::OsStr) -> bool {
    name == std::ffi::OsStr::new(".git") || name == std::ffi::OsStr::new(".vm0")
}

#[cfg(target_os = "linux")]
fn relative_artifact_path(parent: &str, component: &str) -> String {
    if parent.is_empty() {
        component.to_string()
    } else {
        format!("{parent}/{component}")
    }
}

#[cfg(target_os = "linux")]
fn artifact_path_component<'a>(
    name: &'a std::ffi::OsStr,
    parent: &str,
) -> Result<&'a str, ArchiveError> {
    name.to_str()
        .ok_or_else(|| ArchiveError::NonUtf8PathComponent {
            parent: if parent.is_empty() {
                ".".to_string()
            } else {
                parent.to_string()
            },
            component: format!("{name:?}"),
        })
}

#[cfg(test)]
fn compute_file_hash(path: &Path) -> Result<(String, u64), std::io::Error> {
    compute_file_hash_from_reader(std::fs::File::open(path)?)
}

fn compute_file_hash_from_reader(mut reader: impl Read) -> Result<(String, u64), std::io::Error> {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let Some(chunk) = buf.get(..n) else { break };
        hasher.update(chunk);
        total += n as u64;
    }
    let hash = hex::encode(hasher.finalize());
    Ok((hash, total))
}

#[derive(Debug, Error)]
pub(super) enum ArchiveError {
    #[error("failed to open artifact root {}: {source}", path.display())]
    RootOpen { path: PathBuf, source: io::Error },
    #[error("failed to read artifact root {}: {source}", path.display())]
    RootRead { path: PathBuf, source: io::Error },
    #[cfg(not(target_os = "linux"))]
    #[error(
        "artifact root access requires Linux no-follow path opening: {}",
        path.display()
    )]
    UnsupportedRoot { path: PathBuf },
    #[error(
        "artifact path component is not valid UTF-8 under {parent:?}: {component}; artifact paths must be valid UTF-8"
    )]
    NonUtf8PathComponent { parent: String, component: String },
    #[error(
        "artifact finalization traversal limit exceeded: observed entries {observed_entries}/{max_entries}, directory depth {observed_depth}/{max_depth}, active UTF-8 path bytes {observed_path_bytes}/{max_path_bytes}"
    )]
    TraversalLimitExceeded {
        observed_entries: u64,
        max_entries: u64,
        observed_depth: u64,
        max_depth: u64,
        observed_path_bytes: u64,
        max_path_bytes: u64,
    },
    #[error(
        "artifact finalization manifest limit exceeded: candidate files {observed_files}/{max_files}, candidate UTF-8 path bytes {observed_path_bytes}/{max_path_bytes}"
    )]
    ManifestLimitExceeded {
        observed_files: u64,
        max_files: u64,
        observed_path_bytes: u64,
        max_path_bytes: u64,
    },
    #[error("failed to create archive output {}: {source}", path.display())]
    CreateOutput { path: PathBuf, source: io::Error },
    #[error("invalid archive path {path:?}: path must be relative and stay within the artifact")]
    InvalidPath { path: String },
    #[error("failed to read metadata for {path:?}: {source}")]
    Metadata { path: String, source: io::Error },
    #[error("archive path {path:?} is not a regular file")]
    NonRegular { path: String },
    #[error(
        "archive file {path:?} size changed after manifest collection: expected {expected}, got {actual}"
    )]
    SizeChanged {
        path: String,
        expected: u64,
        actual: u64,
    },
    #[error(
        "archive file {path:?} content changed after manifest collection: expected sha256 {expected}, got {actual}"
    )]
    HashMismatch {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("failed to open {path:?}: {source}")]
    Open { path: String, source: io::Error },
    #[error("failed to append {path:?} to archive: {source}")]
    Append { path: String, source: io::Error },
    #[error("failed to verify archived content for {path:?}: {source}")]
    Verify { path: String, source: io::Error },
    #[error("failed to finish tar archive: {source}")]
    FinishTar { source: io::Error },
    #[error("failed to finish gzip stream: {source}")]
    FinishGzip { source: io::Error },
}

impl ArchiveError {
    pub(super) fn is_root_not_found(&self) -> bool {
        matches!(
            self,
            Self::RootOpen { source, .. } | Self::RootRead { source, .. }
                if source.kind() == io::ErrorKind::NotFound
        )
    }
}

/// Create a tar.gz archive containing only the listed manifest files.
///
/// This ensures the archive matches the manifest exactly — no symlinks or other
/// entries that `walk_dir` skipped will be included, and files that changed
/// after manifest collection fail the snapshot instead of producing a mismatched
/// archive.
pub(super) fn create_archive(
    dir_path: &str,
    tar_path: &Path,
    files: &[FileEntry],
) -> Result<(), ArchiveError> {
    let root_path = Path::new(dir_path);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (tar_path, files);
        return Err(ArchiveError::UnsupportedRoot {
            path: root_path.to_owned(),
        });
    }
    #[cfg(target_os = "linux")]
    {
        let root = open_artifact_root(root_path)?;
        if files.is_empty() {
            ensure_readable_artifact_root(&root, root_path)?;
        }

        let output = File::create(tar_path).map_err(|source| ArchiveError::CreateOutput {
            path: tar_path.to_owned(),
            source,
        })?;
        let encoder = GzEncoder::new(output, Compression::default());
        let mut builder = tar::Builder::new(encoder);

        for file in files {
            append_archive_file(&root, &mut builder, file)?;
        }

        let encoder = builder
            .into_inner()
            .map_err(|source| ArchiveError::FinishTar { source })?;
        encoder
            .finish()
            .map_err(|source| ArchiveError::FinishGzip { source })?;
        Ok(())
    }
}

/// Validate archive inputs for a deduplicated snapshot.
///
/// This is the deduplicated-snapshot counterpart to [`create_archive`]. When
/// `/storages/prepare` reports an existing version, callers must run this before
/// committing that version as HEAD because the deduplicated path does not build
/// an archive.
///
/// The check opens the artifact root component by component without following
/// links, then reopens each listed file relative to that root descriptor. It
/// verifies that manifest paths are still non-empty relative paths with no
/// root, prefix, `.`, or `..` components, entries are still regular files, and
/// file size plus SHA-256 still match the pre-walked manifest.
/// Empty manifests still validate readable artifact-root access through the
/// no-follow root-opening path.
///
/// This validates the current artifact state before commit; it does not freeze
/// the filesystem after validation returns.
pub(super) fn validate_archive_inputs(
    dir_path: &str,
    files: &[FileEntry],
) -> Result<(), ArchiveError> {
    let root_path = Path::new(dir_path);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = files;
        return Err(ArchiveError::UnsupportedRoot {
            path: root_path.to_owned(),
        });
    }
    #[cfg(target_os = "linux")]
    {
        let root = open_artifact_root(root_path)?;
        if files.is_empty() {
            ensure_readable_artifact_root(&root, root_path)?;
        }

        for file in files {
            validate_archive_file(&root, file)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn validate_archive_file(root: &Dir, entry: &FileEntry) -> Result<(), ArchiveError> {
    consume_verified_archive_file(root, entry, |_, reader| {
        io::copy(reader, &mut io::sink()).map_err(|source| ArchiveError::Verify {
            path: entry.path.clone(),
            source,
        })?;
        Ok(())
    })
}

#[cfg(target_os = "linux")]
fn append_archive_file<W: io::Write>(
    root: &Dir,
    builder: &mut tar::Builder<W>,
    entry: &FileEntry,
) -> Result<(), ArchiveError> {
    consume_verified_archive_file(root, entry, |metadata, reader| {
        let mut header = tar::Header::new_gnu();
        header.set_metadata(metadata);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(archive_mode(metadata));
        header.set_size(entry.size);
        header.set_cksum();
        builder
            .append_data(&mut header, Path::new(entry.path.as_str()), reader)
            .map_err(|source| ArchiveError::Append {
                path: entry.path.clone(),
                source,
            })?;
        Ok(())
    })
}

#[cfg(target_os = "linux")]
fn consume_verified_archive_file(
    root: &Dir,
    entry: &FileEntry,
    consume: impl FnOnce(&Metadata, &mut ArchiveFileReader<File>) -> Result<(), ArchiveError>,
) -> Result<(), ArchiveError> {
    let (file, metadata) = open_manifest_file(root, entry)?;
    let mut reader = ArchiveFileReader::new(file, entry.size);
    consume(&metadata, &mut reader)?;

    let actual_hash = reader
        .finish_hash()
        .map_err(|source| ArchiveError::Verify {
            path: entry.path.clone(),
            source,
        })?;
    if actual_hash != entry.hash {
        return Err(ArchiveError::HashMismatch {
            path: entry.path.clone(),
            expected: entry.hash.clone(),
            actual: actual_hash,
        });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_manifest_file(root: &Dir, entry: &FileEntry) -> Result<(File, Metadata), ArchiveError> {
    let file_path = entry.path.as_str();
    let rel_path = archive_relative_path(file_path)?;

    let file = open_archive_file(root, rel_path).map_err(|source| ArchiveError::Open {
        path: file_path.to_string(),
        source,
    })?;
    let metadata = file.metadata().map_err(|source| ArchiveError::Metadata {
        path: file_path.to_string(),
        source,
    })?;
    if !metadata.is_file() {
        return Err(ArchiveError::NonRegular {
            path: file_path.to_string(),
        });
    }
    if metadata.len() != entry.size {
        return Err(ArchiveError::SizeChanged {
            path: file_path.to_string(),
            expected: entry.size,
            actual: metadata.len(),
        });
    }

    Ok((file, metadata))
}

#[cfg(target_os = "linux")]
fn archive_relative_path(path: &str) -> Result<&Path, ArchiveError> {
    let rel_path = Path::new(path);
    if rel_path.as_os_str().is_empty()
        || rel_path.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_)
                    | Component::RootDir
                    | Component::CurDir
                    | Component::ParentDir
            )
        })
    {
        return Err(ArchiveError::InvalidPath {
            path: path.to_string(),
        });
    }
    Ok(rel_path)
}

#[cfg(target_os = "linux")]
fn ensure_readable_artifact_root(root: &Dir, path: &Path) -> Result<(), ArchiveError> {
    read_artifact_root(root, path)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_artifact_root(root: &Path) -> Result<Dir, ArchiveError> {
    Dir::open_absolute(root).map_err(|source| ArchiveError::RootOpen {
        path: root.to_owned(),
        source,
    })
}

#[cfg(target_os = "linux")]
fn read_artifact_root(root: &Dir, path: &Path) -> Result<fs::ReadDir, ArchiveError> {
    root.read_dir().map_err(|source| ArchiveError::RootRead {
        path: path.to_owned(),
        source,
    })
}

#[cfg(unix)]
fn archive_mode(metadata: &Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o7777
}

struct ArchiveFileReader<R> {
    inner: R,
    remaining: u64,
    hasher: Sha256,
}

impl<R> ArchiveFileReader<R> {
    fn new(inner: R, size: u64) -> Self {
        Self {
            inner,
            remaining: size,
            hasher: Sha256::new(),
        }
    }

    fn finish_hash(mut self) -> io::Result<String>
    where
        R: Read,
    {
        if self.remaining != 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "file ended before manifest size was fully archived",
            ));
        }

        let mut extra = [0u8; 1];
        if self.inner.read(&mut extra)? != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "file grew after manifest size was verified",
            ));
        }

        Ok(hex::encode(self.hasher.finalize()))
    }
}

impl<R: Read> Read for ArchiveFileReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }

        let limit = self.remaining.min(buf.len() as u64) as usize;
        let read_buf = buf
            .get_mut(..limit)
            .ok_or_else(|| io::Error::other("archive read buffer limit is out of range"))?;
        let n = self.inner.read(read_buf)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "file ended before manifest size was fully archived",
            ));
        }
        let hashed = buf
            .get(..n)
            .ok_or_else(|| io::Error::other("archive read size is out of range"))?;
        self.hasher.update(hashed);
        self.remaining -= n as u64;
        Ok(n)
    }
}

#[cfg(not(unix))]
fn archive_mode(metadata: &Metadata) -> u32 {
    if metadata.permissions().readonly() {
        0o444
    } else {
        0o644
    }
}

#[cfg(target_os = "linux")]
fn open_archive_file(root: &Dir, rel_path: &Path) -> io::Result<File> {
    let mut dir = root.try_clone()?;
    let mut components = rel_path.components().peekable();

    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "archive path contains non-normal component",
            ));
        };
        let is_last = components.peek().is_none();
        if is_last {
            return dir.open_child_file(name);
        } else {
            dir = dir.open_child_dir(name)?;
        }
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "archive path is empty",
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
