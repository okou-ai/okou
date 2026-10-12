//! Retire proven dead WSS ownership through the existing Runner GC lifecycle.

use std::io;

use uuid::Uuid;

use crate::paths::HomePaths;

use super::namespace::{self, NamespaceLock};
use super::owner::Owner;

/// Cap destructive work, not traversal: active IDs at the front of a directory
/// must not starve retired IDs. Unrecorded sockets/temp files are never guessed
/// to be ours. Only canonical per-ID lock files are candidates.
pub const WSS_GC_MAX_IDS: u64 = 100;

pub fn gc_wss_sockets(home: &HomePaths, dry_run: bool) -> io::Result<u64> {
    let directory = home.wss_dir();
    match std::fs::symlink_metadata(&directory) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    }
    let (parent, group) = namespace::open(&directory)?;
    let mut retired = 0;
    let entries = std::fs::read_dir(super::owner::directory_path(&parent, &directory))?;
    for entry in entries {
        let name = entry?.file_name();
        let Some(id_text) = name.to_str().and_then(|name| name.strip_suffix(".lock")) else {
            continue;
        };
        let Ok(id) = Uuid::parse_str(id_text) else {
            continue;
        };
        if id.to_string() != id_text {
            continue;
        }
        let guard = NamespaceLock::acquire(&parent)?;
        let Ok(owner) = Owner::existing(&guard, &directory, id) else {
            continue;
        };
        let final_name = format!("{id}.sock");
        // Validate the complete candidate before touching any of its links.
        if owner.dead_paths(&final_name, group).is_err() {
            continue;
        }
        if !dry_run {
            // Once mutation starts, an IO failure may follow successful unlinks.
            // Stop instead of spending uncounted destructive work on more IDs.
            owner.recover(&final_name, group)?;
            owner.retire_locked(&guard)?;
        }
        retired += 1;
        if retired == WSS_GC_MAX_IDS {
            break;
        }
    }
    Ok(retired)
}

#[cfg(test)]
mod tests;
