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
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn mode(path: &std::path::Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn resolve_run_id_from_fs(group_dir: &std::path::Path, prefix: &str) -> RunnerResult<RunId> {
        resolve_run_id(group_dir, prefix, read_claim_entries, inspect_claim_entry)
    }

    async fn run_cancel_with_fs(args: CancelArgs, home: HomePaths) -> RunnerResult<ExitCode> {
        run_cancel_with_home(args, home, read_claim_entries, inspect_claim_entry).await
    }

    fn fail_prefix_read(
        _claims_dir: &std::path::Path,
    ) -> std::io::Result<std::iter::Empty<std::io::Result<ClaimEntry>>> {
        Err(std::io::Error::other("prefix reader must not be called"))
    }

    #[test]
    fn resolve_exact_uuid() {
        let dir = tempfile::tempdir().unwrap();
        let id = RunId::new_v4();
        std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), id), b"").unwrap();

        let resolved = resolve_run_id_from_fs(dir.path(), &id.to_string()).unwrap();
        assert_eq!(resolved, id);
    }

    #[test]
    fn resolve_prefix_match() {
        let dir = tempfile::tempdir().unwrap();
        let id = RunId::new_v4();
        std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), id), b"").unwrap();

        let prefix = &id.to_string()[..8];
        let resolved = resolve_run_id_from_fs(dir.path(), prefix).unwrap();
        assert_eq!(resolved, id);
    }

    #[test]
    fn resolve_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_run_id_from_fs(dir.path(), "deadbeef").unwrap_err();
        assert!(err.to_string().contains("no claimed job"), "got: {err}");
    }

    #[test]
    fn resolve_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = RunId::new_v4();
        let id2 = RunId::new_v4();
        std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), id1), b"").unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), id2), b"").unwrap();

        // Empty prefix matches every `.claim` file, so two files guarantee ambiguity.
        let err = resolve_run_id_from_fs(dir.path(), "").unwrap_err();
        assert!(err.to_string().contains("ambiguous"), "got: {err}");
    }

    #[test]
    fn resolve_exact_uuid_no_claim() {
        let dir = tempfile::tempdir().unwrap();
        let id = RunId::new_v4();
        // No .claim file written.
        let err = resolve_run_id_from_fs(dir.path(), &id.to_string()).unwrap_err();
        assert!(err.to_string().contains("no claimed job"), "got: {err}");
    }

    #[test]
    fn resolve_ignores_claim_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let id = RunId::new_v4();
        let claims_dir = local_queue::claims_dir(dir.path());
        std::fs::create_dir_all(&claims_dir).unwrap();
        let target = dir.path().join("target-claim");
        std::fs::write(&target, b"").unwrap();
        symlink(&target, local_queue::claim_path(dir.path(), id)).unwrap();

        let exact_err = resolve_run_id_from_fs(dir.path(), &id.to_string()).unwrap_err();
        assert!(
            exact_err.to_string().contains("no claimed job"),
            "got: {exact_err}"
        );
        let prefix_err = resolve_run_id_from_fs(dir.path(), &id.to_string()[..8]).unwrap_err();
        assert!(
            prefix_err.to_string().contains("no claimed job"),
            "got: {prefix_err}"
        );
    }

    #[tokio::test]
    async fn run_cancel_exact_uuid_skips_prefix_reader_and_writes_cancel_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group_dir = home.groups_dir().join("test/group");
        std::fs::create_dir_all(local_queue::claims_dir(&group_dir)).unwrap();
        let run_id = RunId::new_v4();
        std::fs::write(local_queue::claim_path(&group_dir, run_id), b"").unwrap();

        let code = run_cancel_with_home(
            CancelArgs {
                run: run_id.to_string(),
                group: "test/group".into(),
            },
            home,
            fail_prefix_read,
            Ok,
        )
        .await
        .unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        let cancel_path = local_queue::cancel_path(&group_dir, run_id);
        assert!(cancel_path.exists());
        assert_eq!(mode(&local_queue::cancels_dir(&group_dir)), 0o700);
        assert_eq!(mode(&cancel_path), 0o600);
    }

    #[tokio::test]
    async fn run_cancel_rejects_incomplete_claim_enumeration_without_marker() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group_dir = home.groups_dir().join("test/group");
        let claims_dir = local_queue::ensure_claims_dir(&group_dir).unwrap();
        let run_id = RunId::new_v4();
        let claim_path = local_queue::claim_path(&group_dir, run_id);
        local_queue::write_private_marker(&claim_path, "test claim marker").unwrap();
        let entries = vec![
            Ok(ClaimEntry {
                path: claim_path.clone(),
                is_file: true,
            }),
            Err(std::io::Error::other("injected enumeration failure")),
        ];

        let err = run_cancel_with_home(
            CancelArgs {
                run: run_id.to_string()[..8].into(),
                group: "test/group".into(),
            },
            home,
            move |_claims_dir| Ok(entries.into_iter()),
            Ok,
        )
        .await
        .unwrap_err();

        let message = err.to_string();
        assert!(
            message.contains(&claims_dir.display().to_string()),
            "got: {err}"
        );
        assert!(
            message.contains("injected enumeration failure"),
            "got: {err}"
        );
        assert!(!local_queue::cancel_path(&group_dir, run_id).exists());
        assert!(!local_queue::cancels_dir(&group_dir).exists());
    }

    #[tokio::test]
    async fn run_cancel_rejects_claim_inspection_error_without_marker() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group_dir = home.groups_dir().join("test/group");
        let claims_dir = local_queue::ensure_claims_dir(&group_dir).unwrap();
        let run_id = RunId::new_v4();
        let claim_path = local_queue::claim_path(&group_dir, run_id);
        local_queue::write_private_marker(&claim_path, "test claim marker").unwrap();
        let entries = vec![Ok(claim_path.clone())];

        let err = run_cancel_with_home(
            CancelArgs {
                run: run_id.to_string()[..8].into(),
                group: "test/group".into(),
            },
            home,
            move |_claims_dir| Ok(entries.into_iter()),
            |path: std::path::PathBuf| -> std::io::Result<ClaimEntry> {
                Err(std::io::Error::other(format!(
                    "inspect claim entry {}: injected file type failure",
                    path.display()
                )))
            },
        )
        .await
        .unwrap_err();

        let message = err.to_string();
        assert!(
            message.contains(&claims_dir.display().to_string()),
            "got: {err}"
        );
        assert!(
            message.contains(&claim_path.display().to_string()),
            "got: {err}"
        );
        assert!(message.contains("injected file type failure"), "got: {err}");
        assert!(!local_queue::cancel_path(&group_dir, run_id).exists());
        assert!(!local_queue::cancels_dir(&group_dir).exists());
    }

    #[tokio::test]
    async fn run_cancel_rejects_group_symlink_before_claim_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let groups_dir = home.groups_dir();
        std::fs::create_dir_all(&groups_dir).unwrap();
        let target = dir.path().join("target-group");
        std::fs::create_dir(&target).unwrap();
        let org_dir = groups_dir.join("test");
        std::fs::create_dir(&org_dir).unwrap();
        let group_dir = org_dir.join("group");
        symlink(&target, &group_dir).unwrap();

        let err = run_cancel_with_fs(
            CancelArgs {
                run: RunId::new_v4().to_string(),
                group: "test/group".into(),
            },
            home,
        )
        .await
        .unwrap_err();

        assert!(
            err.to_string().contains("invalid group directory"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn run_cancel_rejects_claims_symlink_before_prefix_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group_dir = home.groups_dir().join("test/group");
        std::fs::create_dir_all(&group_dir).unwrap();
        let target = dir.path().join("target-claims");
        std::fs::create_dir(&target).unwrap();
        let run_id = RunId::new_v4();
        std::fs::write(target.join(format!("{run_id}.claim")), b"").unwrap();
        symlink(&target, local_queue::claims_dir(&group_dir)).unwrap();

        let err = run_cancel_with_fs(
            CancelArgs {
                run: run_id.to_string()[..8].into(),
                group: "test/group".into(),
            },
            home,
        )
        .await
        .unwrap_err();

        assert!(
            err.to_string().contains("invalid claims directory"),
            "got: {err}"
        );
    }
}
