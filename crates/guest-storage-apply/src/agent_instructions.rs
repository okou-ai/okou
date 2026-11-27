//! Inspect or apply Storage-delivered instructions without replacing native homes.

use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::{
    agent_instructions::{
        InstructionApplication, InstructionCheck, InstructionCheckResult, InstructionPaths,
        MAX_METADATA_BYTES, SOURCE_FILENAME, instruction_paths,
    },
    env::CliAgentTypeSelection,
    home_mount::HOME_DIR,
    storage_manifest::member_memory_mount,
};
use std::{fs, io, path::Path};

/// Consume instruction staging after Storage reconciliation and before Agent startup.
pub fn apply_agent_instructions(home: &Path, metadata: &[u8]) -> bool {
    apply_agent_instructions_with_result(home, metadata).is_ok()
}

/// Apply a validated instructions input and distinguish unavailable local targets.
pub fn apply_agent_instructions_with_result(
    home: &Path,
    metadata: &[u8],
) -> Result<(), crate::ApplyFailure> {
    let (input, paths) = input(home, metadata).map_err(|error| {
        guest_telemetry::log_error!(crate::LOG_TAG, "Invalid instruction input: {error}");
        crate::ApplyFailure::Failed
    })?;
    match apply(home, input, paths) {
        Ok(()) => Ok(()),
        Err(error) => {
            guest_telemetry::log_error!(
                crate::LOG_TAG,
                "Agent instruction application failed: {error}"
            );
            Err(crate::ApplyFailure::from_target_io(&error))
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
/// After a successful Instructions check, optionally observe the framework's Memory root.
pub fn check_agent_instructions(
    home: &Path,
    metadata: &[u8],
) -> io::Result<InstructionCheckResult> {
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(io::Error::other("Instruction check metadata exceeds bound"));
    }
    let check: InstructionCheck = serde_json::from_slice(metadata)
        .map_err(|_| io::Error::other("Invalid instruction check"))?;
    let paths = instruction_paths(home, &check.framework)
        .ok_or_else(|| io::Error::other("Unsupported instruction framework"))?;
    let instructions_current = check_instruction_target(&paths.target)?;
    let memory_root_present = check.check_memory_root && instructions_current && {
        let framework = CliAgentTypeSelection::parse(&check.framework).framework();
        let mount = Path::new(member_memory_mount(framework));
        let relative = mount.strip_prefix(HOME_DIR).map_err(io::Error::other)?;
        // Match Storage Apply's directory check. On a miss, Runner still runs repair.
        home.join(relative).is_dir()
    };
    Ok(InstructionCheckResult {
        instructions_current,
        memory_root_present,
    })
}

fn check_instruction_target(target: &Path) -> io::Result<bool> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("Missing target parent"))?;
    let directory = match CleanupDirectory::open(parent) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let filename = target
        .file_name()
        .ok_or_else(|| io::Error::other("Missing target name"))?;
    match fs::symlink_metadata(directory.proc_path().join(filename)) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Instruction target is not a regular file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn apply(home: &Path, input: InstructionApplication, paths: InstructionPaths) -> io::Result<()> {
    let source_directory = CleanupDirectory::open(&paths.staging).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            io::Error::other(error)
        } else {
            error
        }
    })?;
    let source = source_directory.proc_path().join(SOURCE_FILENAME);
    crate::instructions::apply_agent_instructions(home, &input.framework, &source)?;
    fs::remove_dir_all(paths.staging)
}
