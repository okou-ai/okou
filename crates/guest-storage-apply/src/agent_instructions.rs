//! Apply the current Run's Storage-delivered instruction file without replacing native homes.

use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::agent_instructions::{
    InstructionApplication, MAX_METADATA_BYTES, SOURCE_FILENAME, STORAGE_DIR,
};
use std::{fs, io, path::Path};

/// Consume instruction staging after Storage reconciliation and before Agent startup.
pub fn apply_agent_instructions(home: &Path, runtime: &Path, metadata: &[u8]) -> bool {
    match apply(home, runtime, metadata) {
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

fn apply(home: &Path, runtime: &Path, metadata: &[u8]) -> io::Result<()> {
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(io::Error::other("Instruction metadata exceeds bound"));
    }
    let input: InstructionApplication = serde_json::from_slice(metadata)
        .map_err(|_| io::Error::other("Invalid instruction application"))?;
    let staging = runtime.join(STORAGE_DIR);
    let source_directory = CleanupDirectory::open(&staging)?;
    let source = source_directory.proc_path().join(SOURCE_FILENAME);
    if !crate::instructions::apply_agent_instructions(home, &input.framework, &source) {
        return Err(io::Error::other(
            "Required instruction file application failed",
        ));
    }
    fs::remove_dir_all(staging)
}
