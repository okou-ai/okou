use tracing::warn;

use crate::cmd::service::RunnerServiceUnit;
use crate::error::RunnerResult;
use runner_host::paths::HomePaths;

use super::filesystem::{next_entry_warn_or_stop, read_dir_or_missing};
use super::lock_file::{ExistingLockProbe, probe_existing_lock, remove_unused_lock_after_probe};
use super::report::GcReport;
use super::versions::parse_semver;

fn version_service_unit_from_lock_file_name(name: &str) -> Option<RunnerServiceUnit> {
    let unit = RunnerServiceUnit::from_lock_file_name(name)?;
    parse_semver(unit.suffix())?;
    Some(unit)
}

async fn version_has_gc_enumerable_dir(home: &HomePaths, version: &str) -> Result<bool, String> {
    for (kind, path) in [
        ("binary", home.bin_dir().join(version)),
        ("config", home.runners_dir().join(version)),
    ] {
        match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) if meta.file_type().is_dir() => return Ok(true),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "stat version {kind} directory {}: {e}",
                    path.display()
                ));
            }
        }
    }
    Ok(false)
}

pub(super) async fn gc_orphaned_version_service_locks(
    home: &HomePaths,
    dry_run: bool,
) -> RunnerResult<GcReport> {
    gc_orphaned_version_service_locks_with_observer(home, dry_run, || {}).await
}

async fn gc_orphaned_version_service_locks_with_observer(
    home: &HomePaths,
    dry_run: bool,
    mut after_initial_missing_version_resource: impl FnMut(),
) -> RunnerResult<GcReport> {
    let locks_dir = home.locks_dir();
    let Some(mut entries) = read_dir_or_missing(&locks_dir).await? else {
        return Ok(GcReport::default());
    };

    let mut removed = 0u64;
    while let Some(entry) = next_entry_warn_or_stop(
        &mut entries,
        "gc_orphaned_version_service_locks",
        &locks_dir,
    )
    .await
    {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(unit) = version_service_unit_from_lock_file_name(name) else {
            continue;
        };
        let version = unit.suffix();

        match version_has_gc_enumerable_dir(home, version).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => {
                warn!("{e}");
                continue;
            }
        }

        after_initial_missing_version_resource();

        let lock_path = entry.path();
        match probe_existing_lock(&lock_path) {
            ExistingLockProbe::Free(lock) => {
                // A version can be recreated between the initial stat and
                // acquiring the free service lock.
                match version_has_gc_enumerable_dir(home, version).await {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(e) => {
                        warn!("{e}");
                        continue;
                    }
                }

                if remove_unused_lock_after_probe(&lock_path, lock, name, dry_run).await {
                    removed += 1;
                }
            }
            ExistingLockProbe::Held | ExistingLockProbe::Missing => {}
            ExistingLockProbe::Error(e) => warn!("cannot probe service lock {name}: {e}"),
        }
    }

    Ok(GcReport::version_service_locks_removed(removed))
}

#[cfg(test)]
mod tests;
