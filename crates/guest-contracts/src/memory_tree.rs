//! Equality of the regular-file tree described by a Memory archive and an
//! exclusively owned Home. Each caller must validate its source tree before
//! supplying entries. This digest is distinct from the VAS content version.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use sha2::{Digest, Sha256};

/// Upper bound on regular files eligible for the incremental path.
pub const MAX_FILES: usize = 4096;
/// Upper bound on directories, including the implicit archive root.
pub const MAX_DIRECTORIES: usize = 1024;
/// Upper bound on actual file bytes in one eligible version.
pub const MAX_CONTENT_BYTES: u64 = 16 * 1024 * 1024;
/// Upper bound on the decoded path bytes in one eligible version.
pub const MAX_PATH_BYTES: usize = 512 * 1024;
/// Maximum nesting depth admitted for proof capture.
pub const MAX_DEPTH: usize = 32;

/// The metadata restored for a plain file by Memory archive extraction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileState {
    /// File content hash.
    pub sha256: [u8; 32],
    /// Ordinary POSIX permission bits.
    pub mode: u32,
    /// Whole Unix seconds with the tar extractor's epoch-zero adjustment.
    pub mtime: u64,
}

/// Validate the textual identity of an archive or Home leaf.
pub fn valid_file_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= crate::storage_files::MAX_PATH_BYTES
        && !path.contains('\0')
        && path.split('/').count() <= MAX_DEPTH
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

/// The directories implicitly created by extracting a plain-file archive.
/// The empty root is always implicit and is omitted from the result.
pub fn parent_directories<'a>(files: impl Iterator<Item = &'a str>) -> Option<BTreeSet<&'a str>> {
    let mut parents = BTreeSet::new();
    for path in files {
        let mut parent = path;
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if !parents.insert(prefix) {
                break;
            }
            if parents.len() >= MAX_DIRECTORIES {
                return None;
            }
            parent = prefix;
        }
    }
    Some(parents)
}

/// Verify that the mount is a directly addressable path on the canonical Home.
pub fn mount_relative_to_home(mount: &str) -> Option<&str> {
    let home = api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;
    let relative = Path::new(mount).strip_prefix(home).ok()?.to_str()?;
    let canonical = mount.strip_prefix(home)?.strip_prefix('/')?;
    (relative == canonical && valid_file_path(canonical)).then_some(canonical)
}

/// Digest the complete regular-file projection in canonical path order.
pub fn digest(files: &BTreeMap<String, FileState>) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"okou-member-memory-tree-v1\0");
    for (path, state) in files {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(state.mode.to_le_bytes());
        hash.update(state.mtime.to_le_bytes());
        hash.update(state.sha256);
    }
    hash.finalize().into()
}
