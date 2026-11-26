//! Check the complete startup layout before the first managed write.

use crate::instructions::{InstructionCleanup, cleanup_filenames};
use guest_contracts::storage_manifest::Manifest;
use std::{
    collections::{BTreeMap, btree_map::Entry},
    io,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum TargetKind {
    Directory,
    InstructionFile,
}

pub(crate) fn check(
    manifest: &Manifest,
    additional_mounts: &[String],
    instruction_file: Option<&str>,
) -> io::Result<()> {
    let mut targets = BTreeMap::new();
    let mounts = manifest
        .storages
        .iter()
        .map(|entry| &entry.mount_path)
        .chain(manifest.artifacts.iter().map(|entry| &entry.mount_path))
        .chain(&manifest.cleanup_paths)
        .chain(additional_mounts);
    for mount in mounts {
        insert(&mut targets, Path::new(mount), TargetKind::Directory)?;
    }
    if let Some(file) = instruction_file {
        insert(&mut targets, Path::new(file), TargetKind::InstructionFile)?;
    }
    for cleanup in &manifest.instruction_cleanups {
        let entry =
            InstructionCleanup::new(cleanup.mount_path.clone(), cleanup.target_filename.clone());
        for name in cleanup_filenames(&entry)
            .ok_or_else(|| io::Error::other("Invalid instruction cleanup filename"))?
        {
            let path = Path::new(&cleanup.mount_path).join(name.as_str());
            insert(&mut targets, &path, TargetKind::InstructionFile)?;
        }
    }

    // Component-wise order puts the first descendant immediately after its
    // ancestor. Exact duplicates across the download and cleanup lists refer
    // to one managed object.
    let mut previous: Option<&Path> = None;
    for path in targets.keys() {
        if let Some(parent) = previous
            && path.starts_with(parent)
        {
            return Err(io::Error::other(format!(
                "Overlapping targets {} and {}",
                parent.display(),
                path.display(),
            )));
        }
        previous = Some(path);
    }
    check_filesystem(&targets)
}

fn insert(
    targets: &mut BTreeMap<PathBuf, TargetKind>,
    path: &Path,
    kind: TargetKind,
) -> io::Result<()> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path.components().any(|part| part == Component::ParentDir)
    {
        return Err(io::Error::other("Invalid startup target path"));
    }
    match targets.entry(path.to_path_buf()) {
        Entry::Vacant(entry) => {
            entry.insert(kind);
        }
        Entry::Occupied(entry) if *entry.get() != kind => {
            return Err(io::Error::other(format!(
                "Directory and instruction file share target {}",
                path.display()
            )));
        }
        Entry::Occupied(_) => {}
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn check_filesystem(targets: &BTreeMap<PathBuf, TargetKind>) -> io::Result<()> {
    use guest_contracts::home_mount::HOME_DIR;
    use rustix::fs::{CWD, FileType, Mode, OFlags, ResolveFlags, fstat, openat2};

    let Some(first) = targets.keys().next() else {
        return Ok(());
    };
    let home = Path::new(HOME_DIR);
    if targets.contains_key(home) {
        return Err(io::Error::other("Cannot manage the entire Guest Home"));
    }
    let anchor = if targets.keys().all(|path| path.starts_with(home)) {
        home
    } else {
        // Standalone helper inputs can run beneath a different mounted root.
        first
            .ancestors()
            .skip(1)
            .find(|anchor| {
                targets
                    .keys()
                    .all(|path| path != anchor && path.starts_with(anchor))
            })
            .ok_or_else(|| io::Error::other("Startup targets have no common root"))?
    };
    let flags = OFlags::PATH | OFlags::CLOEXEC;
    let root = match openat2(
        CWD,
        anchor,
        flags | OFlags::DIRECTORY,
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS,
    ) {
        Ok(root) => root,
        Err(rustix::io::Errno::NOENT) => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for (path, kind) in targets {
        let relative = path.strip_prefix(anchor).map_err(io::Error::other)?;
        let target_flags = match kind {
            TargetKind::Directory => flags | OFlags::DIRECTORY,
            TargetKind::InstructionFile => flags,
        };
        let target = match openat2(
            &root,
            relative,
            target_flags,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_XDEV,
        ) {
            Ok(target) => target,
            // The first missing component prevents the remaining descendants
            // from existing. A dangling symlink is reported as ELOOP.
            Err(rustix::io::Errno::NOENT) => continue,
            Err(error) => return Err(io::Error::other(format!("{}: {error}", path.display()))),
        };
        if *kind == TargetKind::InstructionFile {
            let metadata = fstat(&target)?;
            if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
                || metadata.st_nlink != 1
            {
                return Err(io::Error::other(format!(
                    "Instruction file is not an independent regular file: {}",
                    path.display()
                )));
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn check_filesystem(_: &BTreeMap<PathBuf, TargetKind>) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Startup target validation requires the Linux Guest",
    ))
}
