//! Inspect or apply Storage-delivered instructions without replacing native homes.

use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::agent_instructions::{
    InstructionApplication, InstructionCheck, InstructionPaths, MAX_CHECK_METADATA_BYTES,
    MAX_METADATA_BYTES, SOURCE_FILENAME, instruction_paths,
};
use guest_contracts::storage_paths::normalize_path;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Consume instruction staging after Storage reconciliation and before Agent startup.
pub fn apply_agent_instructions(home: &Path, metadata: &[u8]) -> bool {
    match apply(home, metadata) {
        Ok(()) => true,
        Err(error) => {
            guest_telemetry::log_error!(
                crate::LOG_TAG,
                "Agent instruction application failed: {error}"
            );
            false
        }
    }
}

fn input(home: &Path, metadata: &[u8]) -> io::Result<(InstructionApplication, InstructionPaths)> {
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(io::Error::other("Instruction metadata exceeds bound"));
    }
    let input: InstructionApplication = serde_json::from_slice(metadata)
        .map_err(|_| io::Error::other("Invalid instruction application"))?;
    let paths = instruction_paths(home, &input.framework)
        .ok_or_else(|| io::Error::other("Unsupported instruction framework"))?;
    Ok((input, paths))
}

/// Inspect the final file without reading content, creating paths or following symlinks.
/// Missing or affected targets return `false`; unsafe targets and inspection failures are errors.
pub fn check_agent_instructions(home: &Path, metadata: &[u8]) -> io::Result<bool> {
    if metadata.len() > MAX_CHECK_METADATA_BYTES {
        return Err(io::Error::other("Instruction check metadata exceeds bound"));
    }
    let check: InstructionCheck = serde_json::from_slice(metadata)
        .map_err(|_| io::Error::other("Invalid instruction check"))?;
    let paths = instruction_paths(home, &check.framework)
        .ok_or_else(|| io::Error::other("Unsupported instruction framework"))?;
    let parent = paths
        .target
        .parent()
        .ok_or_else(|| io::Error::other("Missing target parent"))?;
    let directory = match CleanupDirectory::open(parent) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let filename = paths
        .target
        .file_name()
        .ok_or_else(|| io::Error::other("Missing target name"))?;
    match fs::symlink_metadata(directory.proc_path().join(filename)) {
        Ok(metadata) if metadata.is_file() => {
            for mount in check.preserved_download_mounts {
                if paths
                    .target
                    .starts_with(resolve_existing_root(&home.join(mount))?)
                {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Ok(_) => Err(io::Error::other("Instruction target is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

// Target preparation creates missing directories, then canonicalizes the mount.
// Resolve its existing prefix without creating anything during a reuse check.
fn resolve_existing_root(path: &Path) -> io::Result<PathBuf> {
    for ancestor in path.ancestors() {
        match ancestor.canonicalize() {
            Ok(resolved) => {
                let suffix = path.strip_prefix(ancestor).map_err(io::Error::other)?;
                return Ok(normalize_path(&resolved.join(suffix)));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other(
        "Instruction check mount has no existing ancestor",
    ))
}

fn apply(home: &Path, metadata: &[u8]) -> io::Result<()> {
    let (input, paths) = input(home, metadata)?;
    let source_directory = CleanupDirectory::open(&paths.staging)?;
    let source = source_directory.proc_path().join(SOURCE_FILENAME);
    if !crate::instructions::apply_agent_instructions(home, &input.framework, &source) {
        return Err(io::Error::other(
            "Required instruction file application failed",
        ));
    }
    fs::remove_dir_all(paths.staging)
}
