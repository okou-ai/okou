//! File shape and canonical path validation at every decoded trust boundary.

use std::io;
use std::path::{Component, MAIN_SEPARATOR_STR, Path};

use super::{
    MAX_FILE_BYTES, MAX_FILES, MAX_PATH_BYTES, MAX_STORAGE_BYTES, MAX_TOTAL_PATH_BYTES,
    StorageFile, invalid,
};

/// Validate the admitted regular-file shape without touching the filesystem.
pub fn validate_files(files: &[StorageFile]) -> io::Result<()> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(invalid());
    }
    let mut paths = Vec::with_capacity(files.len());
    let mut total = 0usize;
    let mut path_bytes = 0usize;
    for file in files {
        if file.path.is_empty()
            || file.path.len() > MAX_PATH_BYTES
            || file.path.as_bytes().contains(&0)
            || !canonical_relative_path(Path::new(&file.path))
            || file.mode & !0o777 != 0
            || file.mtime > i64::MAX as u64
            || file.content.len() > MAX_FILE_BYTES
        {
            return Err(invalid());
        }
        total = total.checked_add(file.content.len()).ok_or_else(invalid)?;
        path_bytes = path_bytes
            .checked_add(file.path.len())
            .ok_or_else(invalid)?;
        if total > MAX_STORAGE_BYTES || path_bytes > MAX_TOTAL_PATH_BYTES {
            return Err(invalid());
        }
        paths.push(file.path.as_str());
    }
    if paths.len() == 1 {
        return Ok(());
    }
    // Canonical strings can use byte ordering without reparsing components.
    // Keep literal prefixes across distractors (a, a-b, a/b), including nested
    // distractors (a, a-b, a-b/c). An accepted longer owner cannot hide an
    // actual ancestor: that longer owner would itself already have conflicted.
    paths.sort_unstable();
    let mut prefixes = Vec::new();
    for path in paths {
        while prefixes
            .last()
            .is_some_and(|prefix| !path.starts_with(*prefix))
        {
            prefixes.pop();
        }
        if prefixes
            .last()
            .and_then(|prefix| path.strip_prefix(*prefix))
            .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with(MAIN_SEPARATOR_STR))
        {
            return Err(invalid());
        }
        prefixes.push(path);
    }
    Ok(())
}

fn canonical_relative_path(path: &Path) -> bool {
    let mut remaining = path.as_os_str().as_encoded_bytes();
    let mut first = true;
    for component in path.components() {
        let Component::Normal(component) = component else {
            return false;
        };
        // PathBuf::push reinterprets each component as a path. A drive-like
        // component can therefore reset reconstruction on prefix-aware hosts.
        if matches!(
            Path::new(component).components().next(),
            Some(Component::Prefix(_))
        ) {
            return false;
        }
        if !first {
            let Some(rest) = remaining.strip_prefix(MAIN_SEPARATOR_STR.as_bytes()) else {
                return false;
            };
            remaining = rest;
        }
        let Some(rest) = remaining.strip_prefix(component.as_encoded_bytes()) else {
            return false;
        };
        remaining = rest;
        first = false;
    }
    !first && remaining.is_empty()
}

#[cfg(test)]
mod tests;
