use crate::storage_fingerprints::StorageFingerprints;

/// Retains fingerprints whose mount paths are within the normalized workspace scope.
///
/// Filtering is applied independently to both the storage and artifact maps. The
/// paths are normalized only for the membership check; retained entries keep
/// their original map keys and fingerprint values. If the working directory or
/// a mount path is unsafe, that entry is excluded.
pub(super) fn filter_storage_fingerprints_for_working_dir(
    fingerprints: &StorageFingerprints,
    working_dir: &str,
) -> StorageFingerprints {
    let keep_path = |mount_path: &str| is_workspace_scoped_path(mount_path, working_dir);
    StorageFingerprints {
        storages: fingerprints
            .storages
            .iter()
            .filter(|(path, _)| keep_path(path))
            .map(|(path, value)| (path.clone(), value.clone()))
            .collect(),
        artifacts: fingerprints
            .artifacts
            .iter()
            .filter(|(path, _)| keep_path(path))
            .map(|(path, value)| (path.clone(), value.clone()))
            .collect(),
    }
}

/// Returns whether `path` satisfies the cache-safe guest working-directory grammar.
///
/// A safe path starts with `/`, is not root, contains no NUL byte, and has no
/// `.` or `..` component. Empty components from repeated or trailing separators
/// are allowed because normalization removes them. This predicate checks the
/// path string and does not access the filesystem.
pub(super) fn is_safe_guest_working_dir(path: &str) -> bool {
    normalize_safe_guest_working_dir(path).is_some()
}

/// Validates and normalizes a guest path for cache identity and scope checks.
///
/// The returned path has one `/` between non-empty components and no trailing
/// separator. The function returns `None` for relative paths, root, NUL bytes,
/// or components equal to `.` or `..`; it does not resolve filesystem symlinks
/// or otherwise canonicalize a host path.
pub(super) fn normalize_safe_guest_working_dir(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.as_bytes().contains(&0) {
        return None;
    }

    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" => {}
            "." | ".." => return None,
            _ => components.push(component),
        }
    }

    if components.is_empty() {
        return None;
    }

    Some(format!("/{}", components.join("/")))
}

/// Returns whether a mount path belongs to a working directory's workspace scope.
///
/// Both paths are normalized before comparison. An exact normalized match and
/// a descendant with `/` at the component boundary are accepted; invalid paths
/// are rejected. This intentionally avoids raw string-prefix matching, so
/// `/workspace2` is not a descendant of `/workspace`.
pub(super) fn is_workspace_scoped_path(mount_path: &str, working_dir: &str) -> bool {
    let Some(mount_path) = normalize_safe_guest_working_dir(mount_path) else {
        return false;
    };
    let Some(working_dir) = normalize_safe_guest_working_dir(working_dir) else {
        return false;
    };
    if mount_path == working_dir {
        return true;
    }
    let Some(suffix) = mount_path.strip_prefix(&working_dir) else {
        return false;
    };
    suffix.starts_with('/')
}
