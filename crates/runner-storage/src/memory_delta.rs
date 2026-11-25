//! Optional, process-local packages derived from committed Member Memory
//! archives. All archive reads, validation, and compression happen off startup.

use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Read};
use std::sync::{Arc, Mutex};

use flate2::bufread::GzDecoder;
use guest_contracts::{
    memory_tree,
    storage_content_hash::compute_content_hash,
    storage_files::{self, StorageFile},
};
use sha2::{Digest, Sha256};

const MAX_READY_DELTAS: usize = 128;
/// Minimum compressed size for a version that can justify incremental restore.
pub const MIN_ARCHIVE_BYTES: u64 = 1024 * 1024;
const MAX_CHANGED_BYTES: usize = 512 * 1024;
const MAX_CHANGED_PATHS: usize = 128;
// Tar block rounding and long names are separate from the file content budget.
const MAX_TAR_BYTES: u64 = 2 * memory_tree::MAX_CONTENT_BYTES;

/// A successful publication of a nonempty target has one direct base.
#[derive(Clone)]
pub struct MemoryDeltaBase {
    pub memory_id: String,
    pub parent_version_id: String,
}

/// A ready patch for one immutable base and target of the same Memory.
pub struct MemoryDelta {
    /// Member Memory owning both archived versions.
    pub memory_id: String,
    parent_version: String,
    /// Authoritative version that this patch materializes.
    pub target_version: String,
    base_digest: [u8; 32],
    /// Paths absent from the target, to unlink before applying file changes.
    pub remove: Vec<String>,
    /// Already decoded new and changed files.
    pub files: Vec<StorageFile>,
}

#[derive(Default)]
pub(crate) struct ReadyMemoryDeltas(Mutex<VecDeque<Arc<MemoryDelta>>>);

impl ReadyMemoryDeltas {
    pub(crate) fn insert(&self, delta: MemoryDelta) {
        let Ok(mut ready) = self.0.lock() else {
            return;
        };
        ready.retain(|old| {
            old.memory_id != delta.memory_id
                || old.target_version != delta.target_version
                || old.parent_version != delta.parent_version
        });
        if ready.len() == MAX_READY_DELTAS {
            ready.pop_front();
        }
        ready.push_back(Arc::new(delta));
    }

    pub(crate) fn ready(
        &self,
        memory_id: &str,
        target: &str,
        base_digest: &[u8; 32],
    ) -> Option<Arc<MemoryDelta>> {
        self.0
            .try_lock()
            .ok()?
            .iter()
            .rev()
            .find(|entry| {
                entry.memory_id == memory_id
                    && entry.target_version == target
                    && &entry.base_digest == base_digest
            })
            .cloned()
    }
}

pub(crate) fn build_memory_delta(
    base: &MemoryDeltaBase,
    target_version: &str,
    parent_archive: &[u8],
    target_archive: &[u8],
) -> io::Result<Option<MemoryDelta>> {
    if (target_archive.len() as u64) < MIN_ARCHIVE_BYTES || base.parent_version_id == target_version
    {
        return Ok(None);
    }
    let mut parent = scan_archive(parent_archive, |_, _, _| Ok(()))?;
    if !matches_version(&parent, &base.memory_id, &base.parent_version_id) {
        return Ok(None);
    }
    let base_digest = memory_tree::digest(&parent);
    let parent_dirs = memory_tree::parent_directories(parent.keys().map(String::as_str))
        .ok_or_else(unsupported)?;
    let parent_dirs: Vec<String> = parent_dirs.into_iter().map(str::to_owned).collect();
    let mut files = Vec::new();
    let mut changed_paths = 0;
    let mut changed_bytes = 0;
    let target = scan_archive(target_archive, |path, state, bytes| {
        let previous = parent.remove(path);
        if previous.as_ref() == Some(state) {
            return Ok(());
        }
        changed_paths += 1;
        changed_bytes += bytes.len();
        if changed_paths > MAX_CHANGED_PATHS || changed_bytes > MAX_CHANGED_BYTES {
            return Err(unsupported());
        }
        files.push(StorageFile {
            path: path.to_owned(),
            mode: state.mode,
            mtime: state.mtime,
            content: bytes.to_vec(),
        });
        Ok(())
    })?;
    if changed_paths + parent.len() > MAX_CHANGED_PATHS
        || !matches_version(&target, &base.memory_id, target_version)
    {
        return Ok(None);
    }
    let target_dirs = memory_tree::parent_directories(target.keys().map(String::as_str))
        .ok_or_else(unsupported)?;
    // Directory creation and retention have defaults outside the tar file
    // metadata. Only reuse a tree when both versions expect the same dirs.
    if !parent_dirs.iter().map(String::as_str).eq(target_dirs) {
        return Ok(None);
    }
    let remove: Vec<String> = parent.into_keys().collect();
    let path_bytes: usize = remove.iter().map(String::len).sum();
    let file_bytes: usize = files
        .iter()
        .map(|file| 20 + file.path.len() + file.content.len())
        .sum();
    // Leave a fixed allowance for appending the absolute mount to the cleanup
    // paths and escaping them in the storage manifest.
    if path_bytes > 4096
        || file_bytes + path_bytes >= target_archive.len() / 4
        || (!files.is_empty() && storage_files::validate_files(&files).is_err())
    {
        return Ok(None);
    }
    Ok(Some(MemoryDelta {
        memory_id: base.memory_id.clone(),
        parent_version: base.parent_version_id.clone(),
        target_version: target_version.to_owned(),
        base_digest,
        remove,
        files,
    }))
}

fn matches_version(
    files: &BTreeMap<String, memory_tree::FileState>,
    memory_id: &str,
    version: &str,
) -> bool {
    let hashes: Vec<_> = files
        .iter()
        .map(|(path, state)| (path.as_str(), hex::encode(state.sha256)))
        .collect();
    compute_content_hash(
        memory_id,
        hashes.iter().map(|(path, hash)| (*path, hash.as_str())),
    ) == version
}

fn scan_archive(
    compressed: &[u8],
    mut visit: impl FnMut(&str, &memory_tree::FileState, &[u8]) -> io::Result<()>,
) -> io::Result<BTreeMap<String, memory_tree::FileState>> {
    let decoder = GzDecoder::new(compressed).take(MAX_TAR_BYTES + 1);
    let mut archive = tar::Archive::new(decoder);
    let mut files = BTreeMap::new();
    let mut path_bytes = 0;
    let mut content_bytes = 0;
    let mut long_name = None;
    let mut content = Vec::new();
    for entry in archive.entries()?.raw(true) {
        let mut entry = entry?;
        let is_gnu = entry.header().as_gnu().is_some();
        let kind = entry.header().entry_type();
        if is_gnu && kind.is_gnu_longname() {
            if long_name.is_some()
                || entry.size() > (guest_contracts::storage_files::MAX_PATH_BYTES + 1) as u64
            {
                return Err(unsupported());
            }
            let mut name = Vec::new();
            entry.read_to_end(&mut name)?;
            if name.pop() != Some(0) {
                return Err(unsupported());
            }
            long_name = Some(String::from_utf8(name).map_err(|_| unsupported())?);
            continue;
        }
        if !is_gnu || !kind.is_file() || files.len() == memory_tree::MAX_FILES {
            return Err(unsupported());
        }
        let path = match long_name.take() {
            Some(path) => path,
            None => entry.path()?.to_str().ok_or_else(unsupported)?.to_owned(),
        };
        let mode = entry.header().mode()?;
        let mtime = entry.header().mtime()?.max(1);
        path_bytes += path.len();
        content_bytes = u64::saturating_add(content_bytes, entry.size());
        if !memory_tree::valid_file_path(&path)
            || path_bytes > memory_tree::MAX_PATH_BYTES
            || content_bytes > memory_tree::MAX_CONTENT_BYTES
            || mode & !0o777 != 0
            || mtime > i64::MAX as u64
        {
            return Err(unsupported());
        }
        content.clear();
        entry.read_to_end(&mut content)?;
        if content.len() as u64 != entry.size() {
            return Err(unsupported());
        }
        let state = memory_tree::FileState {
            sha256: Sha256::digest(&content).into(),
            mode,
            mtime,
        };
        visit(&path, &state, &content)?;
        if files.insert(path, state).is_some() {
            return Err(unsupported());
        }
    }
    let mut decoder = archive.into_inner();
    let mut tail = [0; 8192];
    loop {
        let read = decoder.read(&mut tail)?;
        if read == 0 {
            break;
        }
        if tail[..read].iter().any(|&byte| byte != 0) {
            return Err(unsupported());
        }
    }
    if decoder.limit() == 0 || !decoder.into_inner().into_inner().is_empty() || long_name.is_some()
    {
        return Err(unsupported());
    }
    let dirs = memory_tree::parent_directories(files.keys().map(String::as_str))
        .ok_or_else(unsupported)?;
    if dirs.iter().any(|&dir| files.contains_key(dir)) {
        return Err(unsupported());
    }
    Ok(files)
}

fn unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "unsupported Memory delta input")
}

#[cfg(test)]
mod tests;
