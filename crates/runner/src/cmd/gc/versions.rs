use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::{Duration, SystemTime};

use tracing::{info, warn};

use crate::cmd::service;
runner_test_support!(cmd_gc_build; #[cfg(test)]
use crate::error::RunnerError;);
use crate::error::RunnerResult;
use crate::host_file;
use crate::lock;
use crate::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{GcDirEntryReader, GcDirStatus, gc_path_dir_status, read_dir_or_missing};
use super::lock_file::{ExistingLockProbe, probe_existing_lock, remove_unused_lock_after_probe};
use super::report::GcReport;

type ServiceUninstallFuture<'a> = Pin<Box<dyn Future<Output = RunnerResult<()>> + 'a>>;
type ServiceUninstallFn = for<'a> fn(&'a service::RunnerServiceUnit) -> ServiceUninstallFuture<'a>;
type RemoveDirAllFuture<'a> = Pin<Box<dyn Future<Output = std::io::Result<()>> + 'a>>;
type RemoveDirAllFn = for<'a> fn(&'a Path) -> RemoveDirAllFuture<'a>;

fn real_uninstall_service_unit(unit: &service::RunnerServiceUnit) -> ServiceUninstallFuture<'_> {
    Box::pin(service::uninstall_service_unit(unit))
}

fn real_remove_dir_all(path: &Path) -> RemoveDirAllFuture<'_> {
    Box::pin(tokio::fs::remove_dir_all(path))
}

/// Parse `v<major>.<minor>.<patch>` into a tuple for ordering. Returns `None`
/// for non-semver names so callers can filter them out in one pass.
pub(super) fn parse_semver(name: &str) -> Option<(u32, u32, u32)> {
    let rest = name.strip_prefix('v')?;
    let mut parts = rest.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

async fn version_newest_mtime(home: &HomePaths, name: &str) -> SystemTime {
    let version_bin = home.bin_dir().join(name);
    let version_config = home.runners_dir().join(name);
    let version_binary = version_bin.join("runner");
    let version_config_file = version_config.join("runner.yaml");
    let mut newest_mtime = SystemTime::UNIX_EPOCH;
    for path in [
        &version_bin,
        &version_binary,
        &version_config,
        &version_config_file,
    ] {
        if let Ok(meta) = tokio::fs::symlink_metadata(path).await
            && let Ok(mtime) = meta.modified()
            && mtime > newest_mtime
        {
            newest_mtime = mtime;
        }
    }
    newest_mtime
}

async fn version_gc_age(home: &HomePaths, name: &str) -> Duration {
    SystemTime::now()
        .duration_since(version_newest_mtime(home, name).await)
        .unwrap_or_default()
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum VersionArtifactState {
    Missing,
    Directory,
    Other,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum VersionArtifactKind {
    Binary,
    Config,
}

impl VersionArtifactKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Binary => "binary",
            Self::Config => "config",
        }
    }
}

struct VersionArtifacts {
    version: (u32, u32, u32),
    binary: VersionArtifactState,
    config: VersionArtifactState,
}

impl VersionArtifacts {
    const fn new(version: (u32, u32, u32)) -> Self {
        Self {
            version,
            binary: VersionArtifactState::Missing,
            config: VersionArtifactState::Missing,
        }
    }

    const fn set_state(&mut self, kind: VersionArtifactKind, state: VersionArtifactState) {
        match kind {
            VersionArtifactKind::Binary => self.binary = state,
            VersionArtifactKind::Config => self.config = state,
        }
    }

    const fn has_directory(&self) -> bool {
        matches!(self.binary, VersionArtifactState::Directory)
            || matches!(self.config, VersionArtifactState::Directory)
    }

    const fn has_unexpected_type(&self) -> bool {
        matches!(self.binary, VersionArtifactState::Other)
            || matches!(self.config, VersionArtifactState::Other)
    }
}

struct VersionArtifactScan {
    entries: Vec<(String, (u32, u32, u32), VersionArtifactState)>,
    complete: bool,
}

/// Why a version survives the current GC pass.
#[derive(Debug, Clone, Eq, PartialEq)]
enum VersionRetentionReason {
    ProtectVersion,
    KeepLatest,
    IncompleteBinaryScan,
    UnexpectedArtifactType,
    Recent(Duration),
    InvalidServiceSuffix(String),
    ServiceLockHeld,
    ServiceLockProbeError(String),
    Active,
}

impl VersionRetentionReason {
    fn log_skip(&self, name: &str, dry_run: bool) {
        match self {
            Self::ProtectVersion if dry_run => {
                info!("version {name}: protected (--protect-version), skipping");
            }
            Self::KeepLatest if dry_run => {
                info!("version {name}: within --keep-latest, skipping");
            }
            Self::IncompleteBinaryScan => {
                warn!("version {name}: binary directory scan incomplete, skipping");
            }
            Self::UnexpectedArtifactType => {
                warn!("version {name}: managed version path is not a directory, skipping");
            }
            Self::Recent(age) if dry_run => {
                info!("version {name}: too recent ({}s), skipping", age.as_secs());
            }
            Self::InvalidServiceSuffix(error) => {
                warn!("version {name}: invalid service unit suffix ({error}), skipping");
            }
            Self::ServiceLockHeld if dry_run => {
                info!("version {name}: service lock held, skipping");
            }
            Self::ServiceLockProbeError(error) => {
                warn!("version {name}: cannot probe service lock ({error}), skipping");
            }
            Self::Active if dry_run => {
                info!("version {name}: active, skipping");
            }
            Self::ProtectVersion
            | Self::KeepLatest
            | Self::Recent(_)
            | Self::ServiceLockHeld
            | Self::Active => {}
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct VersionGcEntry {
    name: String,
    retained: Option<VersionRetentionReason>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(super) struct VersionGcAnalysis {
    entries: Vec<VersionGcEntry>,
    binary_scan_complete: bool,
    config_scan_complete: bool,
}

impl VersionGcAnalysis {
    pub(super) fn retained_names(&self) -> impl Iterator<Item = &str> {
        self.entries
            .iter()
            .filter(|entry| entry.retained.is_some())
            .map(|entry| entry.name.as_str())
    }

    pub(super) const fn directory_scan_complete(&self) -> bool {
        self.binary_scan_complete && self.config_scan_complete
    }
}

runner_test_support!(cmd_gc_build; #[cfg(test)]
pub(super) fn empty_complete_version_gc_analysis() -> VersionGcAnalysis {
    VersionGcAnalysis {
        entries: Vec::new(),
        binary_scan_complete: true,
        config_scan_complete: true,
    }
});

pub(super) async fn analyze_version_gc(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
) -> RunnerResult<VersionGcAnalysis> {
    let mut binary_reader = GcDirEntryReader::new();
    let mut config_reader = GcDirEntryReader::new();
    analyze_version_gc_with_readers(
        home,
        protect,
        keep_latest,
        &mut binary_reader,
        &mut config_reader,
    )
    .await
}

async fn scan_version_artifacts(
    root: &Path,
    kind: VersionArtifactKind,
    entry_reader: &mut GcDirEntryReader,
) -> RunnerResult<VersionArtifactScan> {
    let Some(mut entries) = (match read_dir_or_missing(root).await {
        Ok(entries) => entries,
        Err(error) if kind == VersionArtifactKind::Binary => return Err(error),
        Err(error) => {
            warn!(
                "gc_versions: cannot scan {} root {} ({error}), marking inventory incomplete",
                kind.label(),
                root.display()
            );
            return Ok(VersionArtifactScan {
                entries: Vec::new(),
                complete: false,
            });
        }
    }) else {
        return Ok(VersionArtifactScan {
            entries: Vec::new(),
            complete: true,
        });
    };

    let mut version_entries = Vec::new();
    let mut complete = true;
    loop {
        let entry = match entry_reader
            .next_entry_warn(&mut entries, "gc_versions", root)
            .await
        {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => {
                complete = false;
                break;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(version) = parse_semver(name) else {
            continue;
        };
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(e) => {
                complete = false;
                warn!(
                    "{} version entry {}: cannot read file type ({e}), skipping",
                    kind.label(),
                    entry.path().display()
                );
                continue;
            }
        };
        let state = if file_type.is_dir() {
            VersionArtifactState::Directory
        } else {
            VersionArtifactState::Other
        };
        version_entries.push((name.to_string(), version, state));
    }

    Ok(VersionArtifactScan {
        entries: version_entries,
        complete,
    })
}

async fn analyze_version_gc_with_readers(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
    binary_reader: &mut GcDirEntryReader,
    config_reader: &mut GcDirEntryReader,
) -> RunnerResult<VersionGcAnalysis> {
    let binary_scan =
        scan_version_artifacts(&home.bin_dir(), VersionArtifactKind::Binary, binary_reader).await?;
    let config_scan = scan_version_artifacts(
        &home.runners_dir(),
        VersionArtifactKind::Config,
        config_reader,
    )
    .await?;

    let mut inventory: BTreeMap<String, VersionArtifacts> = BTreeMap::new();
    for (kind, scan) in [
        (VersionArtifactKind::Binary, &binary_scan),
        (VersionArtifactKind::Config, &config_scan),
    ] {
        for (name, version, state) in &scan.entries {
            inventory
                .entry(name.clone())
                .or_insert_with(|| VersionArtifacts::new(*version))
                .set_state(kind, *state);
        }
    }

    // Pick the top-N by semver descending. `keep_latest = None` means no
    // version-based protection (pre-#10411 behavior).
    let keep_count = keep_latest.unwrap_or(0);
    let kept_by_latest: HashSet<String> = if keep_count == 0 {
        HashSet::new()
    } else {
        let mut sorted: Vec<_> = inventory
            .iter()
            .filter(|(_, artifacts)| artifacts.binary == VersionArtifactState::Directory)
            .map(|(name, artifacts)| (name.clone(), artifacts.version))
            .collect();
        sorted.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        sorted
            .into_iter()
            .take(keep_count)
            .map(|(name, _)| name)
            .collect()
    };

    let mut entries = Vec::new();
    for (name, artifacts) in inventory {
        if !artifacts.has_directory() {
            continue;
        }
        let retained = if artifacts.has_unexpected_type() {
            Some(VersionRetentionReason::UnexpectedArtifactType)
        } else if !binary_scan.complete
            && artifacts.binary == VersionArtifactState::Missing
            && artifacts.config == VersionArtifactState::Directory
        {
            Some(VersionRetentionReason::IncompleteBinaryScan)
        } else {
            version_retention_reason(home, &name, protect, &kept_by_latest).await
        };
        entries.push(VersionGcEntry { name, retained });
    }

    Ok(VersionGcAnalysis {
        entries,
        binary_scan_complete: binary_scan.complete,
        config_scan_complete: config_scan.complete,
    })
}

runner_test_support!(cmd_gc_build; #[cfg(test)]
pub(super) async fn analyze_version_gc_with_injected_scan_error(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
    successful_entries: usize,
) -> RunnerResult<VersionGcAnalysis> {
    let mut binary_reader = GcDirEntryReader::failing_after(successful_entries);
    let mut config_reader = GcDirEntryReader::new();
    analyze_version_gc_with_readers(
        home,
        protect,
        keep_latest,
        &mut binary_reader,
        &mut config_reader,
    )
    .await
});

runner_test_support!(cmd_gc_build; #[cfg(test)]
pub(super) async fn analyze_version_gc_with_injected_config_scan_error(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
    successful_entries: usize,
) -> RunnerResult<VersionGcAnalysis> {
    let mut binary_reader = GcDirEntryReader::new();
    let mut config_reader = GcDirEntryReader::failing_after(successful_entries);
    analyze_version_gc_with_readers(
        home,
        protect,
        keep_latest,
        &mut binary_reader,
        &mut config_reader,
    )
    .await
});

async fn version_retention_reason(
    home: &HomePaths,
    name: &str,
    protect: Option<&str>,
    kept_by_latest: &HashSet<String>,
) -> Option<VersionRetentionReason> {
    if protect == Some(name) {
        return Some(VersionRetentionReason::ProtectVersion);
    }

    if kept_by_latest.contains(name) {
        return Some(VersionRetentionReason::KeepLatest);
    }

    let age = version_gc_age(home, name).await;
    if age < GC_MIN_AGE {
        return Some(VersionRetentionReason::Recent(age));
    }

    let unit = match service::RunnerServiceUnit::from_suffix(name) {
        Ok(unit) => unit,
        Err(e) => return Some(VersionRetentionReason::InvalidServiceSuffix(e.to_string())),
    };
    let service_lock_path = unit.lock_path(home);
    let service_lock_parent = host_file::file_parent(&service_lock_path);
    match tokio::fs::symlink_metadata(service_lock_parent).await {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => match probe_existing_lock(&service_lock_path) {
            ExistingLockProbe::Free(_) | ExistingLockProbe::Missing => {}
            ExistingLockProbe::Held => return Some(VersionRetentionReason::ServiceLockHeld),
            ExistingLockProbe::Error(e) => {
                return Some(VersionRetentionReason::ServiceLockProbeError(e));
            }
        },
        Err(e) => {
            return Some(VersionRetentionReason::ServiceLockProbeError(format!(
                "inspect service lock parent {}: {e}",
                service_lock_parent.display()
            )));
        }
    }

    match service::is_unit_active(&unit).await {
        Ok(true) => Some(VersionRetentionReason::Active),
        Ok(false) => None,
        Err(e) => {
            warn!("version {name}: cannot check unit status ({e}), assuming inactive");
            None
        }
    }
}

async fn version_paths_are_removable(
    version_bin: &Path,
    version_config: &Path,
    name: &str,
) -> bool {
    for (kind, path) in [
        (VersionArtifactKind::Config, version_config),
        (VersionArtifactKind::Binary, version_bin),
    ] {
        match gc_path_dir_status(path).await {
            Ok(GcDirStatus::RealDir(_) | GcDirStatus::Missing) => {}
            Ok(GcDirStatus::NotDirectory) => {
                warn!(
                    "version {name}: {} path {} is not a directory, skipping",
                    kind.label(),
                    path.display()
                );
                return false;
            }
            Err(error) => {
                warn!(
                    "version {name}: cannot inspect {} path {} ({error}), skipping",
                    kind.label(),
                    path.display()
                );
                return false;
            }
        }
    }
    true
}

async fn remove_version_dir(path: &Path, remove_dir_all: RemoveDirAllFn) -> bool {
    match remove_dir_all(path).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => {
            warn!("cannot remove {}: {error}", path.display());
            false
        }
    }
}

runner_test_support!(cmd_gc_build; #[cfg(test)]
fn successful_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async { Ok(()) })
});

runner_test_support!(cmd_gc_build; #[cfg(test)]
fn failing_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async { Err(RunnerError::Internal("fake uninstall failed".to_string())) })
});

runner_test_support!(cmd_gc_build; #[cfg(test)]
fn failing_fake_remove_config_dir(path: &Path) -> RemoveDirAllFuture<'_> {
    Box::pin(async move {
        if path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "runners")
        {
            Err(std::io::Error::other(
                "injected runner config removal failure",
            ))
        } else {
            tokio::fs::remove_dir_all(path).await
        }
    })
});

runner_test_support!(cmd_gc_build; #[cfg(test)]
async fn gc_versions(
    home: &HomePaths,
    dry_run: bool,
    protect: Option<&str>,
    keep_latest: Option<usize>,
) -> RunnerResult<Vec<String>> {
    let analysis = analyze_version_gc(home, protect, keep_latest).await?;
    gc_versions_with_analysis_and_uninstall(
        home,
        dry_run,
        analysis,
        successful_fake_uninstall_service_unit,
    )
    .await
});

/// Remove old deployment version directories that are not actively running.
///
/// Scans the binary and runner-config roots for semver-named subdirectories
/// (e.g. `v0.2.0`) and deletes inactive versions and their systemd units.
///
/// Survival rules (any one keeps the version):
/// - `--protect-version` matches the name.
/// - A binary version is in the top `keep_latest` by semver descending. This
///   covers the "staged but not yet installed" case where two overlapping
///   releases race: the older release's promote must not wipe the newer
///   release's just-staged binary even though the newer unit isn't active yet.
/// - The version binary, config file, or their directories are too recent to
///   safely delete.
/// - The corresponding service lifecycle lock is held by another install,
///   uninstall, or GC pass.
/// - The corresponding systemd unit is active.
pub(super) async fn gc_versions_with_analysis(
    home: &HomePaths,
    dry_run: bool,
    analysis: VersionGcAnalysis,
) -> RunnerResult<GcReport> {
    let removed = gc_versions_with_analysis_and_uninstall(
        home,
        dry_run,
        analysis,
        real_uninstall_service_unit,
    )
    .await?;
    Ok(GcReport::removed_versions(removed))
}

async fn gc_versions_with_analysis_and_uninstall(
    home: &HomePaths,
    dry_run: bool,
    analysis: VersionGcAnalysis,
    uninstall_service: ServiceUninstallFn,
) -> RunnerResult<Vec<String>> {
    gc_versions_with_analysis_and_operations(
        home,
        dry_run,
        analysis,
        uninstall_service,
        real_remove_dir_all,
    )
    .await
}

async fn gc_versions_with_analysis_and_operations(
    home: &HomePaths,
    dry_run: bool,
    analysis: VersionGcAnalysis,
    uninstall_service: ServiceUninstallFn,
    remove_dir_all: RemoveDirAllFn,
) -> RunnerResult<Vec<String>> {
    let bin_dir = home.bin_dir();
    let mut removed: Vec<String> = Vec::new();
    for entry in &analysis.entries {
        let name = &entry.name;
        if let Some(reason) = &entry.retained {
            reason.log_skip(name, dry_run);
            continue;
        }

        let version_bin = bin_dir.join(name);
        let version_config = home.runners_dir().join(name);
        let age = version_gc_age(home, name).await;
        if age < GC_MIN_AGE {
            if dry_run {
                info!("version {name}: too recent ({}s), skipping", age.as_secs());
            }
            continue;
        }

        let unit = match service::RunnerServiceUnit::from_suffix(name) {
            Ok(u) => u,
            Err(_) => continue,
        };
        let service_lock_path = unit.lock_path(home);
        let service_lock_name = service_lock_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("service lock")
            .to_string();
        let service_lock = if dry_run {
            let service_lock_parent = host_file::file_parent(&service_lock_path);
            match tokio::fs::symlink_metadata(service_lock_parent).await {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Ok(_) => match probe_existing_lock(&service_lock_path) {
                    ExistingLockProbe::Free(lock) => Some(lock),
                    ExistingLockProbe::Missing => None,
                    ExistingLockProbe::Held => {
                        info!("version {name}: service lock held, skipping");
                        continue;
                    }
                    ExistingLockProbe::Error(e) => {
                        warn!("version {name}: cannot probe service lock ({e}), skipping");
                        continue;
                    }
                },
                Err(e) => {
                    warn!(
                        "version {name}: cannot inspect service lock parent {} before dry-run ({e}), skipping",
                        service_lock_parent.display()
                    );
                    continue;
                }
            }
        } else {
            match lock::try_acquire_or_busy(service_lock_path.clone()).await {
                Ok(lock::TryLock::Acquired(lock)) => Some(lock),
                Ok(lock::TryLock::Busy) => continue,
                Err(e) => {
                    warn!("version {name}: cannot acquire service lock ({e}), skipping");
                    continue;
                }
            }
        };

        if !version_paths_are_removable(&version_bin, &version_config, name).await {
            continue;
        }

        let age = version_gc_age(home, name).await;
        if age < GC_MIN_AGE {
            if dry_run {
                info!(
                    "version {name}: became too recent before delete ({}s), skipping",
                    age.as_secs()
                );
            }
            continue;
        }

        // Check while holding the service lifecycle lock so install cannot
        // race between the active probe and the remove path.
        match service::is_unit_active(&unit).await {
            Ok(true) => {
                if dry_run {
                    info!("version {name}: active, skipping");
                }
                continue;
            }
            Ok(false) => {}
            Err(e) => {
                // systemctl may be unavailable on non-systemd hosts. Continue
                // to the uninstall step; it will refuse deletion if it cannot
                // prove the service is stopped.
                warn!("version {name}: cannot check unit status ({e}), assuming inactive");
            }
        }

        if dry_run {
            info!("[dry-run] would remove version {name}");
        } else {
            let Some(service_lock) = service_lock.as_ref() else {
                warn!("version {name}: service lock missing before delete, skipping");
                continue;
            };
            // Uninstall is best-effort for missing/inactive units, but it
            // returns an error when it cannot prove the service is stopped.
            // In that case the version may still be backing a live runner, so
            // keep the bin/config directories for the next GC pass.
            if let Err(e) = uninstall_service(&unit).await {
                warn!("version {name}: cannot uninstall service safely ({e}), skipping");
                continue;
            }

            // Remove credential-bearing config before its binary discovery
            // anchor. Failures leave the version visible for a later GC pass.
            if !remove_version_dir(&version_config, remove_dir_all).await {
                continue;
            }

            if !remove_version_dir(&version_bin, remove_dir_all).await {
                continue;
            }

            remove_unused_lock_after_probe(
                &service_lock_path,
                service_lock,
                &service_lock_name,
                false,
            )
            .await;
        }
        removed.push(name.clone());
    }

    Ok(removed)
}

runner_test_group!(cmd_gc_build; #[cfg(test)]
mod tests;);
