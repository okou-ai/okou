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

/// Collect a best-effort manifest of regular files readable at checkpoint time.
///
/// Artifact membership is intentionally based on what the walk can read and
/// hash. An unreadable descendant is not part of the artifact for this
/// checkpoint; omitting it lets other readable files be saved instead of
/// failing the entire checkpoint. A new version may therefore omit paths that
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
/// checkpoint failure rather than a best-effort omission.
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
/// `walk_dir_handles_hardlinks` in this module's tests. The checkpoint caller
/// that consumes the resulting list is
/// `crate::checkpoint::artifact::snapshot_artifact_entries`.
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
    // walking the rest of the root rather than failing the checkpoint.
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
    // A failed directory entry cannot be included in this checkpoint's
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
        "artifact checkpoint traversal limit exceeded: observed entries {observed_entries}/{max_entries}, directory depth {observed_depth}/{max_depth}, active UTF-8 path bytes {observed_path_bytes}/{max_path_bytes}"
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
        "artifact checkpoint manifest limit exceeded: candidate files {observed_files}/{max_files}, candidate UTF-8 path bytes {observed_path_bytes}/{max_path_bytes}"
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
mod tests {
    use super::*;
    use std::ffi::{CString, OsStr};
    use std::io::Cursor;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs as unix_fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn extract_archive(tar_path: &Path, extract_dir: &Path) -> io::Result<()> {
        let file = File::open(tar_path)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        archive.unpack(extract_dir)
    }

    fn make_fifo(path: &Path) -> io::Result<()> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let rc = unsafe { libc::mkfifo(path.as_ptr(), 0o644) };
        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn disable_system_log() {
        guest_telemetry::log::clear_system_log_file();
    }

    struct FailingWriter;

    impl io::Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("forced append failure"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn select_manifest_entries(files: &[FileEntry], expected_paths: &[&str]) -> Vec<FileEntry> {
        let selected: Vec<FileEntry> = expected_paths
            .iter()
            .filter_map(|expected_path| {
                files
                    .iter()
                    .find(|file| file.path == *expected_path)
                    .cloned()
            })
            .collect();
        let paths: Vec<&str> = selected.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, expected_paths);
        selected
    }

    fn assert_archive_inputs_rejected(
        root: &Path,
        files: &[FileEntry],
        expected_fragments: &[&str],
    ) -> io::Result<()> {
        let root_str = root.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "artifact root is not UTF-8")
        })?;
        let validate_err = match validate_archive_inputs(root_str, files) {
            Ok(()) => {
                return Err(io::Error::other(
                    "validate_archive_inputs unexpectedly succeeded",
                ));
            }
            Err(error) => error,
        };
        assert_error_contains(&validate_err, expected_fragments);

        let output_dir = tempfile::tempdir()?;
        let tar_path = output_dir.path().join("archive.tar.gz");
        let archive_err = match create_archive(root_str, &tar_path, files) {
            Ok(()) => return Err(io::Error::other("create_archive unexpectedly succeeded")),
            Err(error) => error,
        };
        assert_error_contains(&archive_err, expected_fragments);
        Ok(())
    }

    fn assert_error_contains(error: &ArchiveError, expected_fragments: &[&str]) {
        let msg = error.to_string();
        for fragment in expected_fragments {
            assert!(msg.contains(fragment), "got: {msg}");
        }
    }

    fn assert_unsafe_artifact_root_rejected(root: &Path, files: &[FileEntry]) -> io::Result<()> {
        let root_str = root.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "artifact root is not UTF-8")
        })?;

        assert!(matches!(
            collect_file_metadata(root_str),
            Err(ArchiveError::RootOpen { .. })
        ));
        assert!(matches!(
            validate_archive_inputs(root_str, &[]),
            Err(ArchiveError::RootOpen { .. })
        ));
        assert!(matches!(
            validate_archive_inputs(root_str, files),
            Err(ArchiveError::RootOpen { .. })
        ));

        let output_dir = tempfile::tempdir()?;
        let tar_path = output_dir.path().join("archive.tar.gz");
        assert!(matches!(
            create_archive(root_str, &tar_path, files),
            Err(ArchiveError::RootOpen { .. })
        ));
        assert!(!tar_path.exists());
        Ok(())
    }

    #[test]
    fn artifact_root_requires_absolute_path() {
        let error = match open_artifact_root(Path::new("relative")) {
            Ok(_) => panic!("relative artifact root unexpectedly opened"),
            Err(error) => error,
        };
        let ArchiveError::RootOpen { source, .. } = error else {
            panic!("expected artifact root open error, got: {error}");
        };

        assert_eq!(source.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn walk_dir_skips_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular file
        std::fs::write(root.join("real.txt"), "hello").unwrap();

        // Symlink to file
        unix_fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();

        // Symlink to directory outside
        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/inner.txt"), "inner").unwrap();
        unix_fs::symlink(root.join("subdir"), root.join("link_dir")).unwrap();

        // Dangling symlink
        unix_fs::symlink("/nonexistent", root.join("dangling")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        // Regular files should be included
        assert!(paths.contains(&"real.txt"));
        assert!(paths.contains(&"subdir/inner.txt"));

        // Symlinks should NOT be included
        assert!(!paths.contains(&"link.txt"));
        assert!(!paths.contains(&"link_dir"));
        assert!(!paths.contains(&"dangling"));

        // link_dir contents should NOT appear (symlink dir skipped, not followed)
        assert!(!paths.iter().any(|p| p.starts_with("link_dir/")));
    }

    #[test]
    fn walk_dir_does_not_follow_directory_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("real.txt"), "real").unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        unix_fs::symlink(&outside, root.join("link_dir")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(paths.contains(&"real.txt"));
        assert!(!paths.contains(&"link_dir/secret.txt"));
        assert!(!paths.iter().any(|p| p.starts_with("link_dir/")));
    }

    #[test]
    fn walk_dir_skips_fifo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("real.txt"), "hello").unwrap();
        make_fifo(&root.join("pipe")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(paths.contains(&"real.txt"));
        assert!(!paths.contains(&"pipe"));
    }

    #[test]
    fn collect_file_metadata_skips_non_utf8_paths_for_ignored_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("real.txt"), "hello").unwrap();

        let symlink_name = OsStr::from_bytes(b"link\xff.txt");
        unix_fs::symlink(root.join("real.txt"), root.join(Path::new(symlink_name))).unwrap();

        let fifo_name = OsStr::from_bytes(b"pipe\xff");
        make_fifo(&root.join(Path::new(fifo_name))).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert_eq!(paths, vec!["real.txt"]);
    }

    #[test]
    fn walk_dir_handles_hardlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("original.txt"), "content").unwrap();
        std::fs::hard_link(root.join("original.txt"), root.join("hardlink.txt")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        // Both original and hardlink should be recorded as independent files
        assert!(paths.contains(&"original.txt"));
        assert!(paths.contains(&"hardlink.txt"));

        // Both should have the same hash
        let original = files.iter().find(|f| f.path == "original.txt").unwrap();
        let hardlink = files.iter().find(|f| f.path == "hardlink.txt").unwrap();
        assert_eq!(original.hash, hardlink.hash);
        assert_eq!(original.size, hardlink.size);
    }

    #[test]
    fn archive_excludes_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular files
        std::fs::write(root.join("real.txt"), "hello").unwrap();
        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/inner.txt"), "inner").unwrap();

        // Symlinks (should NOT end up in the archive)
        unix_fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();
        unix_fs::symlink("/nonexistent", root.join("dangling")).unwrap();

        // Collect metadata (skips symlinks)
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();

        // Create archive using only manifest file list
        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(root.to_str().unwrap(), &tar_path, &files).is_ok());

        // Extract and verify archive contents match manifest exactly
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        extract_archive(&tar_path, &extract_dir).unwrap();

        // Manifest files should exist
        assert!(extract_dir.join("real.txt").exists());
        assert!(extract_dir.join("subdir/inner.txt").exists());

        // Symlinks should NOT exist in the archive
        assert!(!extract_dir.join("link.txt").exists());
        assert!(!extract_dir.join("dangling").exists());
    }

    #[test]
    fn archive_handles_special_filenames() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Files with spaces and special characters
        std::fs::write(root.join("file with spaces.txt"), "spaces").unwrap();
        std::fs::create_dir(root.join("dir with spaces")).unwrap();
        std::fs::write(root.join("dir with spaces/inner.txt"), "inner").unwrap();
        std::fs::write(root.join("file-with-dashes.txt"), "dashes").unwrap();
        // File with newline in name
        std::fs::write(root.join("line1\nline2.txt"), "newline").unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();

        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(root.to_str().unwrap(), &tar_path, &files).is_ok());

        // Extract and verify
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        extract_archive(&tar_path, &extract_dir).unwrap();

        assert!(extract_dir.join("file with spaces.txt").exists());
        assert!(extract_dir.join("dir with spaces/inner.txt").exists());
        assert!(extract_dir.join("file-with-dashes.txt").exists());
        assert!(extract_dir.join("line1\nline2.txt").exists());
    }

    #[test]
    fn archive_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("empty.tar.gz");
        assert!(create_archive("/tmp", &tar_path, &[]).is_ok());
        assert!(tar_path.exists());

        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        extract_archive(&tar_path, &extract_dir).unwrap();
        assert!(std::fs::read_dir(&extract_dir).unwrap().next().is_none());
    }

    #[test]
    fn archive_empty_files_requires_existing_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let tar_path = dir.path().join("empty.tar.gz");

        let err = create_archive(missing.to_str().unwrap(), &tar_path, &[]).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn archive_empty_files_rejects_symlink_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        std::fs::create_dir(&real).unwrap();
        unix_fs::symlink(&real, &link).unwrap();
        let tar_path = dir.path().join("empty.tar.gz");

        let err = create_archive(link.to_str().unwrap(), &tar_path, &[]).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn artifact_operations_reject_intermediate_symlink_root() {
        let dir = tempfile::tempdir().unwrap();
        let outside_parent = dir.path().join("outside");
        let outside_root = outside_parent.join("artifact");
        let alias = dir.path().join("alias");
        std::fs::create_dir_all(&outside_root).unwrap();
        std::fs::write(outside_root.join("sentinel.txt"), "outside").unwrap();
        let files = collect_file_metadata(outside_root.to_str().unwrap()).unwrap();
        unix_fs::symlink(&outside_parent, &alias).unwrap();
        assert_eq!(
            std::fs::read_to_string(alias.join("artifact/sentinel.txt")).unwrap(),
            "outside"
        );

        assert_unsafe_artifact_root_rejected(&alias.join("artifact"), &files).unwrap();
    }

    #[test]
    fn artifact_operations_reject_proc_magic_link_root() {
        let dir = tempfile::tempdir().unwrap();
        let outside_root = dir.path().join("artifact");
        std::fs::create_dir(&outside_root).unwrap();
        std::fs::write(outside_root.join("sentinel.txt"), "outside").unwrap();
        let files = collect_file_metadata(outside_root.to_str().unwrap()).unwrap();
        let process_relative_root = Path::new("/proc/self/root").join(
            outside_root
                .strip_prefix("/")
                .expect("temporary directory path must be absolute"),
        );
        assert_eq!(
            std::fs::read_to_string(process_relative_root.join("sentinel.txt")).unwrap(),
            "outside"
        );

        assert_unsafe_artifact_root_rejected(&process_relative_root, &files).unwrap();
    }

    #[test]
    fn validate_archive_inputs_empty_files_requires_existing_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");

        let err = validate_archive_inputs(missing.to_str().unwrap(), &[]).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn validate_archive_inputs_empty_files_rejects_symlink_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        std::fs::create_dir(&real).unwrap();
        unix_fs::symlink(&real, &link).unwrap();

        let err = validate_archive_inputs(link.to_str().unwrap(), &[]).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn archive_hardlinks_as_independent_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("original.txt"), "content").unwrap();
        std::fs::hard_link(root.join("original.txt"), root.join("hardlink.txt")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();

        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(root.to_str().unwrap(), &tar_path, &files).is_ok());

        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        extract_archive(&tar_path, &extract_dir).unwrap();

        let original = extract_dir.join("original.txt");
        let hardlink = extract_dir.join("hardlink.txt");
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "content");
        assert_eq!(std::fs::read_to_string(&hardlink).unwrap(), "content");
        assert_ne!(
            std::fs::metadata(&original).unwrap().ino(),
            std::fs::metadata(&hardlink).unwrap().ino()
        );
    }

    #[test]
    fn archive_preserves_executable_mode_in_header() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let script = root.join("script.sh");

        std::fs::write(&script, "echo ok\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(root.to_str().unwrap(), &tar_path, &files).is_ok());

        let file = File::open(&tar_path).unwrap();
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        let mut entries = archive.entries().unwrap();
        let entry = entries.next().unwrap().unwrap();

        assert_eq!(entry.path().unwrap().as_ref(), Path::new("script.sh"));
        assert_eq!(entry.header().mode().unwrap() & 0o7777, 0o755);
    }

    #[test]
    fn archive_append_failure_remains_append_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "content").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let entry = files.iter().find(|file| file.path == "target.txt").unwrap();
        let root = open_artifact_root(root).unwrap();
        let mut builder = tar::Builder::new(FailingWriter);

        let err = append_archive_file(&root, &mut builder, entry).unwrap_err();

        let ArchiveError::Append { path, source } = err else {
            panic!("expected append error, got: {err}");
        };
        assert_eq!(path, "target.txt");
        assert!(
            source.to_string().contains("forced append failure"),
            "got: {source}"
        );
    }

    #[test]
    fn archive_inputs_fail_if_listed_file_size_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        std::fs::write(root.join("target.txt"), "after-size-change").unwrap();

        assert_archive_inputs_rejected(root, &files, &["target.txt", "size changed"]).unwrap();
    }

    #[test]
    fn archive_inputs_fail_if_listed_file_content_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        std::fs::write(root.join("target.txt"), "after!").unwrap();

        assert_archive_inputs_rejected(root, &files, &["target.txt", "content changed"]).unwrap();
    }

    #[test]
    fn archive_reader_rejects_extra_bytes_after_declared_size() {
        let mut reader = ArchiveFileReader::new(Cursor::new(b"abcdef".as_slice()), 3);
        let mut archived = Vec::new();

        io::copy(&mut reader, &mut archived).unwrap();
        let err = reader.finish_hash().unwrap_err();

        assert_eq!(archived, b"abc");
        assert!(err.to_string().contains("file grew"), "got: {err}");
    }

    #[test]
    fn archive_inputs_fail_if_listed_file_becomes_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        std::fs::write(root.join("outside.txt"), "outside").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let archive_files = select_manifest_entries(&files, &["target.txt"]);

        std::fs::remove_file(root.join("target.txt")).unwrap();
        unix_fs::symlink(root.join("outside.txt"), root.join("target.txt")).unwrap();

        assert_archive_inputs_rejected(root, &archive_files, &["target.txt", "failed to open"])
            .unwrap();
    }

    #[test]
    fn archive_inputs_fail_if_listed_file_becomes_fifo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let archive_files = select_manifest_entries(&files, &["target.txt"]);

        std::fs::remove_file(root.join("target.txt")).unwrap();
        make_fifo(&root.join("target.txt")).unwrap();

        assert_archive_inputs_rejected(root, &archive_files, &["target.txt", "not a regular file"])
            .unwrap();
    }

    #[test]
    fn archive_rejects_invalid_manifest_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let tar_path = root.join("archive.tar.gz");

        for path in [
            "",
            "/absolute.txt",
            ".",
            "./relative.txt",
            "dir/../file.txt",
        ] {
            let files = vec![FileEntry {
                path: path.to_string(),
                hash: "unused".to_string(),
                size: 0,
            }];
            let err = create_archive(root.to_str().unwrap(), &tar_path, &files).unwrap_err();
            assert!(
                err.to_string().contains("invalid archive path"),
                "path {path:?} produced: {err}"
            );
        }
    }

    #[test]
    fn archive_rejects_manifest_path_with_nul() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("bad"), "data").unwrap();
        let tar_path = root.join("archive.tar.gz");
        let files = vec![FileEntry {
            path: "bad\0name".to_string(),
            hash: "unused".to_string(),
            size: 0,
        }];

        let err = create_archive(root.to_str().unwrap(), &tar_path, &files).unwrap_err();

        assert!(
            err.to_string().to_ascii_lowercase().contains("nul"),
            "got: {err}"
        );
    }

    #[test]
    fn archive_inputs_fail_if_parent_dir_becomes_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/file.txt"), "before").unwrap();
        std::fs::create_dir(root.join("outside")).unwrap();
        std::fs::write(root.join("outside/file.txt"), "outside").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let archive_files = select_manifest_entries(&files, &["subdir/file.txt"]);

        std::fs::remove_dir_all(root.join("subdir")).unwrap();
        unix_fs::symlink(root.join("outside"), root.join("subdir")).unwrap();

        assert_archive_inputs_rejected(
            root,
            &archive_files,
            &["subdir/file.txt", "failed to open"],
        )
        .unwrap();
    }

    #[test]
    fn archive_inputs_fail_if_listed_file_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("gone.txt"), "data").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let archive_files = select_manifest_entries(&files, &["gone.txt"]);

        std::fs::remove_file(root.join("gone.txt")).unwrap();

        assert_archive_inputs_rejected(root, &archive_files, &["gone.txt", "failed to open"])
            .unwrap();
    }

    #[test]
    fn collect_file_metadata_excludes_git_and_vm0() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular file
        std::fs::write(root.join("main.rs"), "fn main() {}").unwrap();

        // .git directory (should be excluded)
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        std::fs::create_dir(root.join(".git/objects")).unwrap();
        std::fs::write(root.join(".git/objects/pack"), "data").unwrap();

        // .vm0 directory (should be excluded)
        std::fs::create_dir(root.join(".vm0")).unwrap();
        std::fs::write(root.join(".vm0/config.json"), "{}").unwrap();

        // Nested directory with a .git-like name (should NOT be excluded)
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn hello() {}").unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(paths.contains(&"main.rs"));
        assert!(paths.contains(&"src/lib.rs"));

        // .git and .vm0 contents must NOT be present
        assert!(!paths.iter().any(|p| p.starts_with(".git")));
        assert!(!paths.iter().any(|p| p.starts_with(".vm0")));
    }

    #[test]
    fn collect_file_metadata_rejects_non_utf8_path_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let filename = OsStr::from_bytes(b"bad\xff.txt");
        std::fs::write(root.join(Path::new(filename)), "data").unwrap();

        let err = collect_file_metadata(root.to_str().unwrap()).unwrap_err();

        let ArchiveError::NonUtf8PathComponent { parent, component } = &err else {
            panic!("expected non-UTF-8 path component error, got: {err}");
        };
        assert_eq!(parent, ".");
        assert!(component.contains("bad"), "got: {component}");
        assert!(
            err.to_string()
                .contains("artifact path component is not valid UTF-8"),
            "got: {err}"
        );
    }

    #[test]
    fn collect_file_metadata_rejects_non_utf8_directory_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let dirname = OsStr::from_bytes(b"bad\xffdir");
        let nested = root.join(Path::new(dirname));
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("file.txt"), "data").unwrap();

        let err = collect_file_metadata(root.to_str().unwrap()).unwrap_err();

        let ArchiveError::NonUtf8PathComponent { parent, component } = &err else {
            panic!("expected non-UTF-8 path component error, got: {err}");
        };
        assert_eq!(parent, ".");
        assert!(component.contains("bad"), "got: {component}");
    }

    #[test]
    fn collect_file_metadata_rejects_nested_non_utf8_path_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let parent = root.join("parent");
        std::fs::create_dir(&parent).unwrap();
        let filename = OsStr::from_bytes(b"bad\xff.txt");
        std::fs::write(parent.join(Path::new(filename)), "data").unwrap();

        let err = collect_file_metadata(root.to_str().unwrap()).unwrap_err();

        let ArchiveError::NonUtf8PathComponent { parent, component } = &err else {
            panic!("expected non-UTF-8 path component error, got: {err}");
        };
        assert_eq!(parent, "parent");
        assert!(component.contains("bad"), "got: {component}");
    }

    #[test]
    fn compute_file_hash_known_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "hello world").unwrap();

        let (hash, size) = compute_file_hash(&path).unwrap();
        assert_eq!(size, 11);
        // SHA-256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn compute_file_hash_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.txt");
        std::fs::write(&path, "").unwrap();

        let (hash, size) = compute_file_hash(&path).unwrap();
        assert_eq!(size, 0);
        // SHA-256 of empty string
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn collect_file_metadata_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let files = collect_file_metadata(dir.path().to_str().unwrap()).unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn collect_file_metadata_nonexistent_dir() {
        let _system_log_state_guard = crate::lock_system_log_test_state();
        disable_system_log();
        let err = collect_file_metadata("/nonexistent/path/that/does/not/exist").unwrap_err();
        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn collect_file_metadata_rejects_symlink_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        std::fs::create_dir(&real).unwrap();
        unix_fs::symlink(&real, &link).unwrap();

        let err = collect_file_metadata(link.to_str().unwrap()).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }
}
