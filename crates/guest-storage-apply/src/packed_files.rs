//! A packed request carries complete decoded batches in their original order.

use crate::{LOG_TAG, run_manifest_with_files_in_runtime};
use guest_contracts::storage_files::{PACKED_BATCH_FILE_URL, PACKED_BATCH_START_URL, StorageFiles};
use guest_contracts::storage_manifest::Manifest;
use guest_telemetry::log_error;
use std::path::Path;

pub(super) fn is_packed(manifest: &Manifest) -> bool {
    manifest
        .storages
        .first()
        .map(|entry| entry.archive_url.as_deref())
        .or_else(|| {
            manifest
                .artifacts
                .first()
                .map(|entry| entry.archive_url.as_deref())
        })
        .flatten()
        == Some(PACKED_BATCH_START_URL)
}

pub(super) fn apply(
    manifest: Manifest,
    files: Vec<StorageFiles<&[u8]>>,
    runtime_dir: Option<&Path>,
    independent: bool,
) -> bool {
    let Some(sizes) = batch_sizes(&manifest, &files) else {
        log_error!(LOG_TAG, "Invalid packed storage batch order");
        return false;
    };
    let mut storages = manifest.storages.into_iter();
    let mut artifacts = manifest.artifacts.into_iter();
    let mut files = files.into_iter();
    sizes.into_iter().all(|size| {
        let storages = storages.by_ref().take(size).collect::<Vec<_>>();
        let artifacts = artifacts.by_ref().take(size - storages.len()).collect();
        let batch = Manifest {
            storages,
            artifacts,
            cleanup_paths: Vec::new(),
            instruction_cleanups: Vec::new(),
            archive_readiness: None,
        };
        run_manifest_with_files_in_runtime(
            batch,
            files.by_ref().take(size).collect(),
            None,
            runtime_dir,
            independent,
        )
    })
}

fn batch_sizes(manifest: &Manifest, files: &[StorageFiles<&[u8]>]) -> Option<Vec<usize>> {
    if manifest.archive_readiness.is_some()
        || !manifest.cleanup_paths.is_empty()
        || !manifest.instruction_cleanups.is_empty()
        || files.len() != manifest.storages.len() + manifest.artifacts.len()
    {
        return None;
    }

    let mounts = manifest
        .storages
        .iter()
        .map(|entry| (&entry.mount_path, entry.archive_url.as_deref()))
        .chain(
            manifest
                .artifacts
                .iter()
                .map(|entry| (&entry.mount_path, entry.archive_url.as_deref())),
        );
    let mut sizes = Vec::new();
    for ((mount, url), group) in mounts.zip(files) {
        if mount != &group.mount_path {
            return None;
        }
        match url {
            Some(PACKED_BATCH_START_URL) => sizes.push(0),
            Some(PACKED_BATCH_FILE_URL) => {}
            _ => return None,
        }
        *sizes.last_mut()? += 1;
    }
    Some(sizes)
}
