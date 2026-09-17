use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use futures_util::{StreamExt, stream};
use tracing::warn;

use crate::cmd::service;
use crate::config;
use crate::image_hash;
use crate::paths::HomePaths;

use super::filesystem::{GcDirEntryReader, read_dir_or_missing};
use super::versions::VersionGcAnalysis;

type ProtectedImageRefMap = HashMap<String, HashSet<String>>;

const ENABLED_SERVICE_QUERY_CONCURRENCY: usize = 4;

pub(super) enum ProtectedImageRefs {
    Complete(ProtectedImageRefMap),
    Incomplete,
}

impl ProtectedImageRefs {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) const fn is_complete(&self) -> bool {
        matches!(self, Self::Complete(_))
    }

    #[cfg(test)]
    pub(super) const fn incomplete() -> Self {
        Self::Incomplete
    }
}

impl Default for ProtectedImageRefs {
    fn default() -> Self {
        Self::Complete(HashMap::new())
    }
}

#[derive(serde::Deserialize)]
struct ConfigImageRefs {
    profiles: BTreeMap<String, ConfigProfileImageRef>,
}

#[derive(serde::Deserialize)]
struct ConfigProfileImageRef {
    rootfs_hash: String,
    snapshot_hash: String,
}

fn insert_protected_image_ref(
    protected_image_refs: &mut ProtectedImageRefs,
    rootfs_hash: String,
    snapshot_hash: String,
) {
    if let ProtectedImageRefs::Complete(refs) = protected_image_refs {
        refs.entry(rootfs_hash).or_default().insert(snapshot_hash);
    }
}

pub(super) fn is_protected_image_ref(
    protected_image_refs: &ProtectedImageRefs,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> bool {
    match protected_image_refs {
        ProtectedImageRefs::Complete(refs) => refs
            .get(rootfs_hash)
            .is_some_and(|snapshot_hashes| snapshot_hashes.contains(snapshot_hash)),
        // Preserve fail-closed behavior if a future caller checks a pair
        // without first rejecting the incomplete inventory.
        ProtectedImageRefs::Incomplete => true,
    }
}

pub(super) async fn protected_image_refs_for_gc(
    home: &HomePaths,
    version_analysis: &VersionGcAnalysis,
) -> ProtectedImageRefs {
    if !version_analysis.directory_scan_complete() {
        warn!("runner image refs: version directory scan incomplete, skipping image GC");
        return ProtectedImageRefs::Incomplete;
    }

    let mut refs = ProtectedImageRefs::new();
    if !collect_retained_version_image_refs(home, version_analysis, &mut refs).await {
        return ProtectedImageRefs::Incomplete;
    }
    if !collect_enabled_service_image_refs(&mut refs).await {
        return ProtectedImageRefs::Incomplete;
    }
    refs
}

async fn collect_retained_version_image_refs(
    home: &HomePaths,
    version_analysis: &VersionGcAnalysis,
    refs: &mut ProtectedImageRefs,
) -> bool {
    for name in version_analysis.retained_names() {
        let config_path = home.runners_dir().join(name).join("runner.yaml");
        if !collect_config_image_refs(&config_path, "retained version", refs).await {
            return false;
        }
    }
    true
}

async fn collect_enabled_service_image_refs(refs: &mut ProtectedImageRefs) -> bool {
    collect_enabled_service_image_refs_from_dir(Path::new("/etc/systemd/system"), refs).await
}

async fn collect_enabled_service_image_refs_from_dir(
    system_dir: &Path,
    refs: &mut ProtectedImageRefs,
) -> bool {
    let scan = enabled_runner_service_config_paths(system_dir).await;
    if !scan.inventory_complete {
        return false;
    }
    for config_path in scan.paths {
        if !collect_config_image_refs(&config_path, "enabled service", refs).await {
            return false;
        }
    }
    true
}

struct EnabledRunnerServiceConfigPaths {
    paths: Vec<PathBuf>,
    inventory_complete: bool,
}

struct EnabledRunnerServiceConfigPathResult {
    path: Option<PathBuf>,
    inventory_complete: bool,
}

async fn enabled_runner_service_config_paths(system_dir: &Path) -> EnabledRunnerServiceConfigPaths {
    let mut entry_reader = GcDirEntryReader::new();
    enabled_runner_service_config_paths_with_reader(system_dir, &mut entry_reader).await
}

async fn enabled_runner_service_config_paths_with_reader(
    system_dir: &Path,
    entry_reader: &mut GcDirEntryReader,
) -> EnabledRunnerServiceConfigPaths {
    let Some(mut entries) = (match read_dir_or_missing(system_dir).await {
        Ok(entries) => entries,
        Err(e) => {
            warn!(
                "runner service image refs: cannot read {} ({e}), skipping service-derived refs",
                system_dir.display()
            );
            return EnabledRunnerServiceConfigPaths {
                paths: Vec::new(),
                inventory_complete: false,
            };
        }
    }) else {
        return EnabledRunnerServiceConfigPaths {
            paths: Vec::new(),
            inventory_complete: true,
        };
    };

    let mut units = Vec::new();
    let mut inventory_complete = true;
    loop {
        let entry = match entry_reader
            .next_entry_warn(&mut entries, "runner_service_config_refs", system_dir)
            .await
        {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => {
                inventory_complete = false;
                break;
            }
        };
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(unit) = service::RunnerServiceUnit::from_file_name(file_name) else {
            continue;
        };
        units.push(unit);
    }

    let mut scan = enabled_runner_service_config_paths_for_units(units).await;
    scan.inventory_complete &= inventory_complete;
    scan
}

async fn enabled_runner_service_config_paths_for_units(
    units: Vec<service::RunnerServiceUnit>,
) -> EnabledRunnerServiceConfigPaths {
    let mut results = stream::iter(units)
        .enumerate()
        .map(|(index, unit)| async move { (index, enabled_runner_service_config_path(unit).await) })
        .buffer_unordered(ENABLED_SERVICE_QUERY_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    // Restore encounter order after collection so a slow unit cannot delay admission of later units.
    results.sort_unstable_by_key(|(index, _)| *index);
    let mut paths = Vec::new();
    let mut inventory_complete = true;
    for (_, result) in results {
        if let Some(path) = result.path {
            paths.push(path);
        }
        inventory_complete &= result.inventory_complete;
    }
    EnabledRunnerServiceConfigPaths {
        paths,
        inventory_complete,
    }
}

async fn enabled_runner_service_config_path(
    unit: service::RunnerServiceUnit,
) -> EnabledRunnerServiceConfigPathResult {
    match service::is_unit_enabled(&unit).await {
        Ok(true) => {}
        Ok(false) => {
            return EnabledRunnerServiceConfigPathResult {
                path: None,
                inventory_complete: true,
            };
        }
        Err(e) => {
            warn!(
                "runner service image refs: cannot check whether {} is enabled ({e}), protection inventory incomplete",
                unit.service_name()
            );
            return EnabledRunnerServiceConfigPathResult {
                path: None,
                inventory_complete: false,
            };
        }
    }
    match service::read_unit_config_path(&unit).await {
        Ok(Some(path)) => EnabledRunnerServiceConfigPathResult {
            path: Some(path),
            inventory_complete: true,
        },
        Ok(None) => {
            warn!(
                "runner service image refs: enabled service {} has no parseable config path, skipping",
                unit.service_name()
            );
            EnabledRunnerServiceConfigPathResult {
                path: None,
                inventory_complete: true,
            }
        }
        Err(e) => {
            warn!(
                "runner service image refs: cannot read effective config for enabled service {} ({e}), protection inventory incomplete",
                unit.service_name()
            );
            EnabledRunnerServiceConfigPathResult {
                path: None,
                inventory_complete: false,
            }
        }
    }
}

async fn collect_config_image_refs(
    config_path: &Path,
    source: &str,
    refs: &mut ProtectedImageRefs,
) -> bool {
    let Some(content) = (match config::read_diagnostic_config_to_string(config_path).await {
        Ok(content) => content,
        Err(e) => {
            warn!(
                "runner image refs: cannot read {source} config {} ({e}), protection inventory incomplete",
                config_path.display()
            );
            return false;
        }
    }) else {
        warn!(
            "runner image refs: {source} config {} is missing, protection inventory incomplete",
            config_path.display()
        );
        return false;
    };

    let config = match serde_yaml_ng::from_str::<ConfigImageRefs>(&content) {
        Ok(config) => config,
        Err(_) => {
            warn!(
                "runner image refs: cannot parse {source} config {}, protection inventory incomplete",
                config_path.display()
            );
            return false;
        }
    };
    for (_, profile_ref) in config.profiles {
        if image_hash::validate_or_err(&profile_ref.rootfs_hash).is_err() {
            warn!(
                "runner image refs: {source} config {} has a profile with an invalid rootfs hash, protection inventory incomplete",
                config_path.display()
            );
            return false;
        }
        if image_hash::validate_or_err(&profile_ref.snapshot_hash).is_err() {
            warn!(
                "runner image refs: {source} config {} has a profile with an invalid snapshot hash, protection inventory incomplete",
                config_path.display()
            );
            return false;
        }
        insert_protected_image_ref(refs, profile_ref.rootfs_hash, profile_ref.snapshot_hash);
    }
    true
}

#[cfg(test)]
mod tests;
