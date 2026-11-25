//! An isolated update to an already restored Member Memory tree.
//!
//! The Runner establishes the exact parent from a frozen Home before sending
//! this operation. A failed mutation leaves the normal full-restore caller
//! responsible for replacing the entire tree.

use std::fs;
use std::io;
use std::path::Path;

use guest_contracts::memory_tree::{mount_relative_to_home, valid_file_path};
use guest_contracts::storage_files::{MEMORY_DELTA_URL, StorageFiles};
use guest_contracts::storage_manifest::Manifest;

use crate::cleanup_directory::CleanupDirectory;

pub(super) fn is_memory_delta(manifest: &Manifest) -> bool {
    manifest
        .artifacts
        .first()
        .and_then(|artifact| artifact.archive_url.as_deref())
        == Some(MEMORY_DELTA_URL)
}

pub(super) fn apply(manifest: &Manifest, groups: &[StorageFiles<&[u8]>]) -> io::Result<()> {
    let [artifact] = manifest.artifacts.as_slice() else {
        return Err(invalid());
    };
    let mount = &artifact.mount_path;
    if !manifest.storages.is_empty()
        || !manifest.instruction_cleanups.is_empty()
        || manifest.archive_readiness.is_some()
        || mount_relative_to_home(mount).is_none()
        || artifact.empty
        || artifact.cached
        || artifact.vas_storage_name.as_deref() != Some("memory")
        || artifact
            .vas_storage_id
            .as_ref()
            .is_none_or(String::is_empty)
        || artifact
            .vas_version_id
            .as_ref()
            .is_none_or(String::is_empty)
    {
        return Err(invalid());
    }
    let files = match groups {
        [] if !manifest.cleanup_paths.is_empty() => &[][..],
        [group] if &group.mount_path == mount => group.files.as_slice(),
        _ => return Err(invalid()),
    };
    let prefix = format!("{mount}/");
    if manifest
        .cleanup_paths
        .iter()
        .any(|path| !path.strip_prefix(&prefix).is_some_and(valid_file_path))
    {
        return Err(invalid());
    }
    let root = Path::new(mount);
    // Keep full-restore responsibility with the caller if the verified root
    // is no longer available. Never create a partial replacement root.
    let _directory = CleanupDirectory::open(root)?;
    for path in &manifest.cleanup_paths {
        let (parent, name) = CleanupDirectory::open_parent(Path::new(path))?;
        let anchored = parent.proc_path().join(name);
        if !fs::symlink_metadata(&anchored)?.is_file() {
            return Err(invalid());
        }
        fs::remove_file(anchored)?;
    }
    crate::files::materialize(files, root, 1)
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid Memory delta manifest or tree",
    )
}
