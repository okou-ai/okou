//! Bounded metadata for applying claim-selected Workflow documents in one Guest helper.
//!
//! Document contents remain in private source files. This contract is internal to
//! one Runner/Guest artifact and its owned sandbox lifetime.

use std::collections::HashSet;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::file_write::WRITE_FILES_BATCH_FILE_LIMIT;

/// Maximum encoded metadata, matching the generic exec stdin budget.
pub const MAX_METADATA_BYTES: usize = 64 * 1024;

/// A claim-selected document's final mount and run-private source.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowDocumentSource {
    /// Framework skill directory whose SKILL.md is replaced.
    pub mount_path: String,
    /// Canonical run-private file named `workflow-<canonical UUID>`.
    pub source: String,
}

/// Decode bounded metadata and validate every source identity before application.
///
/// Rejects empty/oversized lists, duplicate mounts or sources, and paths outside
/// the captured run directory. Filesystem and framework checks belong to the Guest.
pub fn decode(input: &[u8], runtime_dir: &Path) -> io::Result<Vec<WorkflowDocumentSource>> {
    if input.len() > MAX_METADATA_BYTES {
        return Err(invalid());
    }
    let entries: Vec<WorkflowDocumentSource> =
        serde_json::from_slice(input).map_err(|_| invalid())?;
    if entries.is_empty() || entries.len() > WRITE_FILES_BATCH_FILE_LIMIT {
        return Err(invalid());
    }
    let mut sources = HashSet::new();
    let mut mounts = HashSet::new();
    for entry in &entries {
        let name = Path::new(&entry.source)
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("workflow-"))
            .ok_or_else(invalid)?;
        let id = uuid::Uuid::parse_str(name).map_err(|_| invalid())?;
        let expected = runtime_dir.join(format!("workflow-{id}"));
        if expected.to_str() != Some(entry.source.as_str())
            || !sources.insert(entry.source.as_str())
            || !mounts.insert(entry.mount_path.as_str())
        {
            return Err(invalid());
        }
    }
    Ok(entries)
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid Workflow document metadata",
    )
}
