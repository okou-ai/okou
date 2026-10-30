//! `runner local cancel` — cancel a job running on a local runner via file queue.
//!
//! Writes a `{run_id}.cancel` file into the group cancel directory. The local
//! runner's cancel watcher picks it up and triggers the corresponding
//! cancellation token.

use std::process::ExitCode;

use clap::Args;

use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;
use runner_provider::local_queue;
use runner_types::ids::RunId;

#[derive(Args)]
pub struct CancelArgs {
    /// Run ID (full UUID or prefix) of the job to cancel
    #[arg(long)]
    run: String,
    /// Runner group name
    #[arg(long)]
    group: String,
}

pub async fn run_cancel(args: CancelArgs) -> RunnerResult<ExitCode> {
    run_cancel_with_home(
        args,
        HomePaths::new()?,
        read_claim_entries,
        inspect_claim_entry,
    )
    .await
}

async fn run_cancel_with_home<ReadEntries, Entries, Entry, InspectEntry>(
    args: CancelArgs,
    home: HomePaths,
    read_entries: ReadEntries,
    inspect_entry: InspectEntry,
) -> RunnerResult<ExitCode>
where
    ReadEntries: FnOnce(&std::path::Path) -> std::io::Result<Entries>,
    Entries: IntoIterator<Item = std::io::Result<Entry>>,
    InspectEntry: FnMut(Entry) -> std::io::Result<ClaimEntry>,
{
    if args.run.is_empty() {
        return Err(RunnerError::Config("run_id must not be empty".into()));
    }
    crate::group::validate_or_err(&args.group)?;

    let group_dir = home.groups_dir().join(&args.group);

    if !group_dir.is_dir() {
        return Err(RunnerError::Config(format!(
            "group directory does not exist: {}",
            group_dir.display()
        )));
    }
    local_queue::validate_group_dir(&group_dir).map_err(|e| {
        RunnerError::Config(format!(
            "invalid group directory {}: {e}",
            group_dir.display()
        ))
    })?;

    let run_id = resolve_run_id(&group_dir, &args.run, read_entries, inspect_entry)?;

    local_queue::ensure_cancels_dir(&group_dir)
        .map_err(|e| RunnerError::Internal(format!("create cancel dir: {e}")))?;
    let cancel_path = local_queue::cancel_path(&group_dir, run_id);
    local_queue::write_private_marker(&cancel_path, "local cancel marker")
        .map_err(|e| RunnerError::Internal(format!("write cancel file: {e}")))?;

    eprintln!("cancel request written for {run_id}");
    Ok(ExitCode::SUCCESS)
}

struct ClaimEntry {
    path: std::path::PathBuf,
    is_file: bool,
}

fn read_claim_entries(claims_dir: &std::path::Path) -> std::io::Result<std::fs::ReadDir> {
    std::fs::read_dir(claims_dir)
}

fn inspect_claim_entry(entry: std::fs::DirEntry) -> std::io::Result<ClaimEntry> {
    let path = entry.path();
    let is_file = entry
        .file_type()
        .map_err(|e| {
            std::io::Error::new(
                e.kind(),
                format!("inspect claim entry {}: {e}", path.display()),
            )
        })?
        .is_file();
    Ok(ClaimEntry { path, is_file })
}

/// Resolve a (possibly prefix) run ID against group-wide `.claim` files.
/// Returns an error if the prefix is ambiguous or matches nothing.
fn resolve_run_id<ReadEntries, Entries, Entry, InspectEntry>(
    group_dir: &std::path::Path,
    prefix: &str,
    read_entries: ReadEntries,
    mut inspect_entry: InspectEntry,
) -> RunnerResult<RunId>
where
    ReadEntries: FnOnce(&std::path::Path) -> std::io::Result<Entries>,
    Entries: IntoIterator<Item = std::io::Result<Entry>>,
    InspectEntry: FnMut(Entry) -> std::io::Result<ClaimEntry>,
{
    let Some(claims_dir) = validated_claims_dir(group_dir)? else {
        return Err(RunnerError::Config(format!(
            "no claimed job matches prefix '{prefix}'"
        )));
    };

    // Try exact UUID parse first.
    if let Ok(id) = prefix.parse::<RunId>() {
        let claim = local_queue::claim_path(group_dir, id);
        if local_queue::marker_file_exists(&claim, "claim file")
            .map_err(|e| RunnerError::Config(e.to_string()))?
        {
            return Ok(id);
        }
        return Err(RunnerError::Config(format!(
            "no claimed job found for {id}"
        )));
    }

    // Prefix match against .claim files.
    let entries = match read_entries(&claims_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(RunnerError::Config(format!(
                "no claimed job matches prefix '{prefix}'"
            )));
        }
        Err(e) => {
            return Err(RunnerError::Config(format!(
                "read claims directory {}: {e}",
                claims_dir.display()
            )));
        }
    };

    let mut matches = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            RunnerError::Config(format!(
                "read entry in claims directory {}: {e}",
                claims_dir.display()
            ))
        })?;
        let entry = inspect_entry(entry).map_err(|e| {
            RunnerError::Config(format!(
                "inspect entry in claims directory {}: {e}",
                claims_dir.display()
            ))
        })?;
        if !entry.is_file {
            continue;
        }
        let path = entry.path;
        if path.extension().and_then(|e| e.to_str()) != Some("claim") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.starts_with(prefix)
            && let Ok(id) = stem.parse::<RunId>()
        {
            matches.push(id);
        }
    }

    match matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "no claimed job matches prefix '{prefix}'"
        ))),
        [id] => Ok(*id),
        _ => {
            let n = matches.len();
            let ids: Vec<String> = matches.iter().map(|id| id.to_string()).collect();
            Err(RunnerError::Config(format!(
                "prefix '{prefix}' is ambiguous ({n} matches): {}",
                ids.join(", ")
            )))
        }
    }
}

fn validated_claims_dir(group_dir: &std::path::Path) -> RunnerResult<Option<std::path::PathBuf>> {
    let claims_dir = local_queue::claims_dir(group_dir);
    match std::fs::symlink_metadata(&claims_dir) {
        Ok(_) => local_queue::validate_claims_dir(group_dir)
            .map(Some)
            .map_err(|e| RunnerError::Config(format!("invalid claims directory: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(RunnerError::Config(format!("stat claims directory: {e}"))),
    }
}

#[cfg(test)]
mod tests;
