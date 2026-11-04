//! Shared lexical path identity for Storage planning and Guest filesystem operations.

use std::path::{Component, Path, PathBuf};

/// Collapse `.` and resolvable `..` components without accessing the filesystem.
///
/// This does not resolve symlinks. Absolute paths stop at the root; relative
/// paths retain leading parent components that cannot be collapsed.
pub fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match components.last() {
                Some(Component::Normal(_)) => {
                    components.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => components.push(component),
            },
            _ => components.push(component),
        }
    }

    let mut normalized = PathBuf::new();
    for component in components {
        normalized.push(component.as_os_str());
    }
    normalized
}
