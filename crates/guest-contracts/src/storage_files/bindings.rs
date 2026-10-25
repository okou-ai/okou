//! Logical mount ownership, shared by decoded selection and both wire boundaries.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Component, Path};

use crate::storage_manifest::{ArtifactEntry, Manifest, StorageEntry};

/// Return the original spellings of mounts that conflict with another owner.
///
/// Equal paths, aliases and ancestor/descendant pairs conflict. An invalid path
/// conflicts with every other mount; a sole entry has no other owner to compare.
/// These logical results do not replace physical target conflict scheduling.
pub fn conflicting_mounts<'a>(mounts: impl IntoIterator<Item = &'a str>) -> HashSet<&'a str> {
    let mut paths = mounts.into_iter().collect::<Vec<_>>();
    if paths.len() > 1 && paths.iter().any(|mount| !absolute_mount(Path::new(mount))) {
        return paths.into_iter().collect();
    }
    paths.sort_unstable_by_key(|mount| Path::new(*mount));
    let mut conflicts = HashSet::new();
    let Some(mut ancestor) = paths.first().copied() else {
        return conflicts;
    };
    // Component ordering keeps an owner's complete subtree contiguous. Retain
    // its first ancestor, rather than losing it after the first child/sibling.
    for path in paths.into_iter().skip(1) {
        if Path::new(path).starts_with(ancestor) {
            conflicts.insert(ancestor);
            conflicts.insert(path);
        } else {
            ancestor = path;
        }
    }
    conflicts
}

/// Validate decoded ownership against the complete manifest before transport splitting.
pub fn validate_bindings<'a>(
    manifest: &Manifest,
    mounts: impl IntoIterator<Item = &'a str>,
) -> io::Result<()> {
    let mut bindings = HashMap::with_capacity(manifest.storages.len() + manifest.artifacts.len());
    let entries = manifest
        .storages
        .iter()
        .map(|entry| (entry.mount_path.as_str(), DecodedBinding::Storage(entry)))
        .chain(
            manifest
                .artifacts
                .iter()
                .map(|entry| (entry.mount_path.as_str(), DecodedBinding::Artifact(entry))),
        );
    for (mount, binding) in entries {
        if bindings.insert(mount, binding).is_some() {
            return Err(io::Error::other("duplicate storage manifest mount"));
        }
    }
    let mut mounts = mounts.into_iter().peekable();
    if mounts.peek().is_none() {
        return Ok(());
    }
    let conflicts = conflicting_mounts(
        manifest
            .storages
            .iter()
            .map(|entry| entry.mount_path.as_str())
            .chain(
                manifest
                    .artifacts
                    .iter()
                    .map(|entry| entry.mount_path.as_str()),
            ),
    );
    let mut selected = HashSet::new();
    for mount in mounts {
        if !selected.insert(mount) {
            return Err(io::Error::other("duplicate decoded mount"));
        }
        let binding = bindings
            .get(mount)
            .ok_or_else(|| io::Error::other("decoded mount absent"))?;
        match *binding {
            DecodedBinding::Storage(entry) => {
                if entry.cached || !valid_archive_url(entry.archive_url.as_deref()) {
                    return Err(io::Error::other(
                        "decoded storage source is not an ordinary download",
                    ));
                }
            }
            DecodedBinding::Artifact(entry) => {
                if entry.empty
                    || entry.cached
                    || !valid_archive_url(entry.archive_url.as_deref())
                    || !present_identity(&entry.vas_storage_name)
                    || !present_identity(&entry.vas_storage_id)
                    || !present_identity(&entry.vas_version_id)
                {
                    return Err(io::Error::other(
                        "decoded artifact source is not a fresh complete download",
                    ));
                }
            }
        };
        if conflicts.contains(mount) {
            return Err(io::Error::other("decoded mount overlaps another mount"));
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum DecodedBinding<'a> {
    Storage(&'a StorageEntry),
    Artifact(&'a ArtifactEntry),
}

fn valid_archive_url(url: Option<&str>) -> bool {
    url.is_some_and(|url| !url.is_empty() && url != "null")
}

fn present_identity(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|value| !value.is_empty())
}

fn absolute_mount(path: &Path) -> bool {
    path.is_absolute()
        && !path.as_os_str().as_encoded_bytes().contains(&0)
        && path
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
}

#[cfg(test)]
mod tests;
