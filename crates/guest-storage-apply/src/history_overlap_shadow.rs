//! Read-only Guest classification for storage/session-history write-root overlap.
//!
//! This module observes current filesystem identities before storage cleanup. It does not retain
//! reservations and its result must never authorize concurrent writes.

use std::fs;
use std::path::{Component, Path, PathBuf};

use guest_contracts::storage_manifest::HistoryOverlapShadow;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Classification {
    EligibleDisjoint,
    IneligibleLogicalOverlap,
    IneligiblePhysicalOverlap,
    IneligibleUnresolvedIdentity,
}

pub(crate) fn classify(shadow: &HistoryOverlapShadow) -> Classification {
    let Ok(history_logical) = normalize_absolute(&shadow.history_root) else {
        return Classification::IneligibleUnresolvedIdentity;
    };
    let storage_logical = match shadow
        .storage_write_roots
        .iter()
        .map(|path| normalize_absolute(path))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(paths) => paths,
        Err(()) => return Classification::IneligibleUnresolvedIdentity,
    };

    if storage_logical
        .iter()
        .any(|storage| paths_conflict(&history_logical, storage))
    {
        return Classification::IneligibleLogicalOverlap;
    }

    let Ok(history_physical) = resolve_existing_directory(&history_logical) else {
        return Classification::IneligibleUnresolvedIdentity;
    };
    for storage in &storage_logical {
        let Ok(storage_physical) = resolve_existing_directory(storage) else {
            return Classification::IneligibleUnresolvedIdentity;
        };
        if paths_conflict(&history_physical, &storage_physical) {
            return Classification::IneligiblePhysicalOverlap;
        }
    }

    Classification::EligibleDisjoint
}

fn normalize_absolute(path: &str) -> Result<PathBuf, ()> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(());
    }
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => names.push(name.to_os_string()),
            Component::ParentDir => {
                if names.pop().is_none() {
                    return Err(());
                }
            }
            Component::Prefix(_) => return Err(()),
        }
    }
    let mut normalized = PathBuf::from("/");
    for name in names {
        normalized.push(name);
    }
    Ok(normalized)
}

fn resolve_existing_directory(path: &Path) -> Result<PathBuf, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        return Err(());
    }
    let canonical = fs::canonicalize(path).map_err(|_| ())?;
    if !fs::metadata(&canonical).map_err(|_| ())?.is_dir() {
        return Err(());
    }
    Ok(canonical)
}

fn paths_conflict(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    fn shadow(history: &Path, storages: &[&Path]) -> HistoryOverlapShadow {
        HistoryOverlapShadow::new(
            history.to_string_lossy().into_owned(),
            storages
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        )
        .unwrap()
    }

    #[test]
    fn existing_disjoint_directories_are_eligible() {
        let dir = tempfile::tempdir().unwrap();
        let history = dir.path().join("history");
        let storage = dir.path().join("storage");
        fs::create_dir_all(&history).unwrap();
        fs::create_dir_all(&storage).unwrap();

        assert_eq!(
            classify(&shadow(&history, &[&storage])),
            Classification::EligibleDisjoint
        );
    }

    #[test]
    fn logical_equal_and_ancestor_paths_are_ineligible() {
        let dir = tempfile::tempdir().unwrap();
        let history = dir.path().join("history");
        fs::create_dir_all(&history).unwrap();

        for storage in [
            history.clone(),
            history.join("child"),
            dir.path().to_path_buf(),
        ] {
            assert_eq!(
                classify(&shadow(&history, &[&storage])),
                Classification::IneligibleLogicalOverlap
            );
        }
    }

    #[test]
    fn symlink_aliases_are_physical_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let physical = dir.path().join("physical");
        let history = physical.join("history");
        fs::create_dir_all(&history).unwrap();
        let alias = dir.path().join("alias");
        symlink(&physical, &alias).unwrap();
        let storage = alias.join("history");

        assert_eq!(
            classify(&shadow(&history, &[&storage])),
            Classification::IneligiblePhysicalOverlap
        );
    }

    #[test]
    fn missing_and_dangling_roots_are_unresolved_without_creation() {
        let dir = tempfile::tempdir().unwrap();
        let history = dir.path().join("history");
        let missing = dir.path().join("missing").join("storage");
        fs::create_dir_all(&history).unwrap();
        assert_eq!(
            classify(&shadow(&history, &[&missing])),
            Classification::IneligibleUnresolvedIdentity
        );
        assert!(!missing.exists());
        assert!(!dir.path().join("missing").exists());

        let dangling = dir.path().join("dangling");
        symlink(dir.path().join("absent"), &dangling).unwrap();
        assert_eq!(
            classify(&shadow(&history, &[&dangling])),
            Classification::IneligibleUnresolvedIdentity
        );
    }

    #[test]
    fn relative_root_escape_and_regular_file_are_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        let history = dir.path().join("history");
        let file = dir.path().join("file");
        fs::create_dir_all(&history).unwrap();
        fs::write(&file, b"content").unwrap();

        let relative = HistoryOverlapShadow::new(
            history.to_string_lossy().into_owned(),
            vec!["relative".into()],
        )
        .unwrap();
        assert_eq!(
            classify(&relative),
            Classification::IneligibleUnresolvedIdentity
        );
        let escaped = HistoryOverlapShadow::new(
            "/../../history".into(),
            vec![file.to_string_lossy().into_owned()],
        )
        .unwrap();
        assert_eq!(
            classify(&escaped),
            Classification::IneligibleUnresolvedIdentity
        );
        assert_eq!(
            classify(&shadow(&history, &[&file])),
            Classification::IneligibleUnresolvedIdentity
        );
    }
}
