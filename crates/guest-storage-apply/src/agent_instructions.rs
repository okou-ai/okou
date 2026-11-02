//! Inspect or apply Storage-delivered instructions without replacing native homes.

use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::agent_instructions::{
    InstructionApplication, InstructionPaths, MAX_METADATA_BYTES, SOURCE_FILENAME,
    instruction_paths,
};
use std::{fs, io, path::Path};

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
/// Missing targets return `false`; unsafe paths and inspection failures are errors.
pub fn check_agent_instructions(home: &Path, metadata: &[u8]) -> io::Result<bool> {
    let (_, paths) = input(home, metadata)?;
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
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(io::Error::other("Instruction target is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
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
