use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tracing::{info, warn};

use crate::byte_size::human_bytes;
use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{
    GcDirEntryReader, GcDirStatus, dir_stats, gc_entry_is_real_dir, gc_path_dir_status,
    next_entry_warn_or_stop, read_dir_or_missing,
};
use super::image_refs::{ProtectedImageRefs, is_protected_image_ref};
use super::lock_file::{LockProbe, probe_lock};
use super::report::GcReport;

const TEMPLATE_WARM_DIR_PREFIX: &str = "template-warm-";

/// Scan-time metadata for an unused snapshot eligible for global top-N.
struct GcCandidate {
    hash: String,
    size: u64,
    mtime: SystemTime,
    /// Index into the enclosing `Vec<RootfsState>`.
    rootfs_idx: usize,
}

#[derive(Clone, Copy)]
enum SnapshotDisposition {
    Keep,
    Delete,
}

/// Metadata for one rootfs whose initial snapshot inventory completed.
struct RootfsState {
    path: PathBuf,
    hash: String,
    snapshot_dispositions: HashMap<String, SnapshotDisposition>,
}

struct SnapshotDeletion {
    path: PathBuf,
    hash: String,
}

/// Try to delete an orphaned rootfs directory (no surviving snapshots).
///
/// Caller must hold the exclusive rootfs lock. Returns the freed bytes when
/// deletion succeeds or would occur, including `Some(0)` for zero-byte work.
async fn try_delete_orphan_rootfs(
    rootfs_path: &Path,
    rootfs_hash: &str,
    dry_run: bool,
) -> Option<u64> {
    match gc_path_dir_status(rootfs_path).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing | GcDirStatus::NotDirectory) => return None,
        Err(e) => {
            warn!("images/{rootfs_hash}: stat failed ({e}), skipping");
            return None;
        }
    }

    let (rootfs_size, rootfs_mtime) = dir_stats(rootfs_path).await;
    let age = SystemTime::now()
        .duration_since(rootfs_mtime)
        .unwrap_or_default();
    if age < GC_MIN_AGE {
        if dry_run {
            info!(
                "images/{rootfs_hash}: orphaned but too recent ({}s), keeping",
                age.as_secs()
            );
        }
        return None;
    }
    if dry_run {
        info!(
            "[dry-run] would delete orphaned rootfs images/{rootfs_hash} ({})",
            human_bytes(rootfs_size)
        );
    } else if let Err(e) = tokio::fs::remove_dir_all(rootfs_path).await {
        warn!("failed to remove orphaned rootfs images/{rootfs_hash}: {e}");
        return None;
    }
    Some(rootfs_size)
}

/// Try to delete an abandoned `runner build --warm-rootfs-cache` working dir.
///
/// The directory intentionally lives under `images/` so the warm download/build
/// uses the same data volume as normal rootfs builds. It is a template
/// warm dir, so it is guarded by the template lock rather than `image-*`.
async fn gc_template_warm_dir(
    home: &HomePaths,
    warm_path: &Path,
    warm_name: &str,
    template_hash: &str,
    dry_run: bool,
) -> Option<u64> {
    let lock_path = home.template_lock(template_hash);
    let _lock = match probe_lock(&lock_path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => {
            if dry_run {
                info!("images/{warm_name}: template warm dir in use, skipping");
            }
            return None;
        }
        LockProbe::Error(e) => {
            warn!("images/{warm_name}: template lock probe failed ({e}), skipping");
            return None;
        }
    };

    match gc_path_dir_status(warm_path).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing | GcDirStatus::NotDirectory) => return None,
        Err(e) => {
            warn!("images/{warm_name}: stat failed ({e}), skipping");
            return None;
        }
    }

    let (size, mtime) = dir_stats(warm_path).await;
    let age = SystemTime::now().duration_since(mtime).unwrap_or_default();
    if age < GC_MIN_AGE {
        if dry_run {
            info!(
                "images/{warm_name}: template warm dir too recent ({}s), keeping",
                age.as_secs()
            );
        }
        return None;
    }
    if dry_run {
        info!(
            "[dry-run] would delete template warm dir images/{warm_name} ({})",
            human_bytes(size)
        );
    } else if let Err(e) = tokio::fs::remove_dir_all(warm_path).await {
        warn!("failed to remove template warm dir images/{warm_name}: {e}");
        return None;
    }
    Some(size)
}

/// Apply the global snapshot decisions for one rootfs under a fresh rootfs lock.
///
/// The current snapshot directory is fully enumerated before deletion starts.
/// Each planned deletion then acquires and validates its snapshot lock while the
/// rootfs lock remains held, preserving the global rootfs-before-snapshot order.
async fn gc_rootfs_action(
    home: &HomePaths,
    state: &RootfsState,
    dry_run: bool,
    snapshot_entry_reader: &mut GcDirEntryReader,
) -> GcReport {
    let _rootfs_lock = match probe_lock(&home.rootfs_lock(&state.hash)) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => {
            if dry_run {
                info!("images/{}: rootfs in use, skipping", state.hash);
            }
            return GcReport::default();
        }
        LockProbe::Error(e) => {
            warn!("images/{}: lock probe failed ({e}), skipping", state.hash);
            return GcReport::default();
        }
    };

    match gc_path_dir_status(&state.path).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing) => return GcReport::default(),
        Ok(GcDirStatus::NotDirectory) => {
            warn!("images/{}: not a real directory, skipping", state.hash);
            return GcReport::default();
        }
        Err(e) => {
            warn!("images/{}: stat failed ({e}), skipping", state.hash);
            return GcReport::default();
        }
    }

    let snapshots_dir = state.path.join("snapshots");
    match gc_path_dir_status(&snapshots_dir).await {
        Ok(GcDirStatus::RealDir(_)) => {}
        Ok(GcDirStatus::Missing) => {
            return try_delete_orphan_rootfs(&state.path, &state.hash, dry_run)
                .await
                .map_or_else(GcReport::default, |freed_bytes| {
                    GcReport::cleanup(1, freed_bytes)
                });
        }
        Ok(GcDirStatus::NotDirectory) => {
            warn!(
                "images/{}/snapshots: not a real directory, skipping",
                state.hash
            );
            return GcReport::default();
        }
        Err(e) => {
            warn!(
                "images/{}/snapshots: stat failed ({e}), skipping",
                state.hash
            );
            return GcReport::default();
        }
    }

    let mut snapshot_entries = match tokio::fs::read_dir(&snapshots_dir).await {
        Ok(entries) => entries,
        Err(e) => {
            warn!(
                "images/{}/snapshots: read failed ({e}), skipping",
                state.hash
            );
            return GcReport::default();
        }
    };

    let mut any_snapshot_survives = false;
    let mut deletions = Vec::new();
    loop {
        let snap_entry = match snapshot_entry_reader
            .next_entry_warn(&mut snapshot_entries, "snapshots", &snapshots_dir)
            .await
        {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => return GcReport::default(),
        };
        let snap_path = snap_entry.path();
        let Some(snap_hash) = snap_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(String::from)
        else {
            any_snapshot_survives = true;
            continue;
        };

        match state.snapshot_dispositions.get(&snap_hash).copied() {
            Some(SnapshotDisposition::Delete) => deletions.push(SnapshotDeletion {
                path: snap_path,
                hash: snap_hash,
            }),
            Some(SnapshotDisposition::Keep) | None => any_snapshot_survives = true,
        }
    }

    let mut report = GcReport::default();
    let mut dry_run_snapshot_bytes = 0u64;
    for deletion in deletions {
        let lock_path = home.snapshot_lock(&deletion.hash);
        let _snapshot_lock = match probe_lock(&lock_path) {
            LockProbe::Free(lock) => lock,
            LockProbe::Held => {
                any_snapshot_survives = true;
                if dry_run {
                    info!(
                        "images/{}/snapshots/{}: in use, skipping",
                        state.hash, deletion.hash
                    );
                }
                continue;
            }
            LockProbe::Error(e) => {
                any_snapshot_survives = true;
                warn!(
                    "images/{}/snapshots/{}: lock probe failed ({e}), skipping",
                    state.hash, deletion.hash
                );
                continue;
            }
        };

        match gc_path_dir_status(&deletion.path).await {
            Ok(GcDirStatus::RealDir(_)) => {}
            Ok(GcDirStatus::Missing) => continue,
            Ok(GcDirStatus::NotDirectory) => {
                any_snapshot_survives = true;
                warn!(
                    "images/{}/snapshots/{}: not a real directory, skipping",
                    state.hash, deletion.hash
                );
                continue;
            }
            Err(e) => {
                any_snapshot_survives = true;
                warn!(
                    "images/{}/snapshots/{}: stat failed ({e}), skipping",
                    state.hash, deletion.hash
                );
                continue;
            }
        }

        let (size, mtime) = dir_stats(&deletion.path).await;
        let age = SystemTime::now().duration_since(mtime).unwrap_or_default();
        if age < GC_MIN_AGE {
            any_snapshot_survives = true;
            if dry_run {
                info!(
                    "images/{}/snapshots/{}: too recent ({}s), keeping",
                    state.hash,
                    deletion.hash,
                    age.as_secs()
                );
            }
            continue;
        }

        if dry_run {
            info!(
                "[dry-run] would delete images/{}/snapshots/{} ({})",
                state.hash,
                deletion.hash,
                human_bytes(size)
            );
            dry_run_snapshot_bytes = dry_run_snapshot_bytes.saturating_add(size);
        } else {
            match tokio::fs::remove_dir_all(&deletion.path).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    any_snapshot_survives = true;
                    warn!(
                        "failed to remove images/{}/snapshots/{}: {e}",
                        state.hash, deletion.hash
                    );
                    continue;
                }
            }
        }
        report += GcReport::cleanup(1, size);
    }

    if !any_snapshot_survives
        && let Some(rootfs_bytes) =
            try_delete_orphan_rootfs(&state.path, &state.hash, dry_run).await
    {
        let overlap = if dry_run { dry_run_snapshot_bytes } else { 0 };
        report += GcReport::cleanup(1, rootfs_bytes.saturating_sub(overlap));
    }

    report
}

runner_test_support!(cmd_gc_build; /// GC for the nested image layout: `<images>/<rootfs>/snapshots/<snapshot>/`.
///
/// Three phases, with **global** top-N semantics across all rootfs:
///
/// 1. Inventory every rootfs with short-lived lock probes. Filter out
///    snapshots that must survive (in-use, too recent, malformed) and collect
///    the remaining eligible metadata into one flat candidate list. Rootfs
///    dirs with no `snapshots/` subdir are orphan-deleted inline.
/// 2. Global top-N: sort the candidate list by mtime (newest first) and record
///    keep/delete decisions per rootfs.
/// 3. Reacquire one rootfs lock at a time, complete a current snapshot scan,
///    then lock and revalidate each planned deletion. Delete the rootfs under
///    the same lock only when no snapshot survives.
///
/// Global (cross-rootfs) rather than per-rootfs so a host that has
/// accumulated many distinct rootfs hashes (e.g. per-PR builds) can be
/// trimmed down — per-rootfs top-N kept every rootfs forever whenever
/// each had ≤ N snapshots.
#[cfg(test)]
async fn gc_nested_images(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<u64> {
    let protected_image_refs = ProtectedImageRefs::new();
    let report =
        gc_nested_images_with_protected_refs(home, keep_latest, dry_run, &protected_image_refs)
            .await?;
    Ok(report.freed_bytes)
});

pub(super) async fn gc_nested_images_with_protected_refs(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
    protected_image_refs: &ProtectedImageRefs,
) -> RunnerResult<GcReport> {
    let mut inventory_entry_reader = GcDirEntryReader::new();
    let mut action_entry_reader = GcDirEntryReader::new();
    gc_nested_images_with_protected_refs_and_readers(
        home,
        keep_latest,
        dry_run,
        protected_image_refs,
        &mut inventory_entry_reader,
        &mut action_entry_reader,
    )
    .await
}

async fn gc_nested_images_with_protected_refs_and_readers(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
    protected_image_refs: &ProtectedImageRefs,
    inventory_entry_reader: &mut GcDirEntryReader,
    action_entry_reader: &mut GcDirEntryReader,
) -> RunnerResult<GcReport> {
    if !protected_image_refs.is_complete() {
        warn!("image protection inventory incomplete, skipping image GC");
        return Ok(GcReport::default());
    }

    let images_dir = home.images_dir();
    let Some(mut rootfs_entries) = read_dir_or_missing(&images_dir).await? else {
        return Ok(GcReport::default());
    };

    let mut report = GcReport::default();
    let mut rootfs_states: Vec<RootfsState> = Vec::new();
    let mut candidates: Vec<GcCandidate> = Vec::new();

    // Phase 1: walk all rootfs, collect candidates across the entire images tree.
    while let Some(rootfs_entry) =
        next_entry_warn_or_stop(&mut rootfs_entries, "images", &images_dir).await
    {
        let rootfs_path = rootfs_entry.path();
        let Some(rootfs_hash) = rootfs_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(String::from)
        else {
            continue;
        };

        // Skip non-directories (e.g. stale temp files) and symlinks.
        match gc_entry_is_real_dir(&rootfs_entry).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                warn!("images/{rootfs_hash}: cannot read file type ({e}), skipping");
                continue;
            }
        }

        if let Some(template_hash) = rootfs_hash
            .strip_prefix(TEMPLATE_WARM_DIR_PREFIX)
            .filter(|hash| !hash.is_empty())
        {
            if let Some(freed_bytes) =
                gc_template_warm_dir(home, &rootfs_path, &rootfs_hash, template_hash, dry_run).await
            {
                report += GcReport::cleanup(1, freed_bytes);
            }
            continue;
        }

        // Probe rootfs lock. If held (by start/build), skip the whole rootfs.
        // `runner start` acquires shared rootfs before shared snapshot; cleaning
        // snapshots while only the rootfs lock is held can race that acquisition
        // window and delete a snapshot the runner is about to lock.
        let rootfs_lock = match probe_lock(&home.rootfs_lock(&rootfs_hash)) {
            LockProbe::Free(lock) => lock,
            LockProbe::Held => {
                if dry_run {
                    info!("images/{rootfs_hash}: rootfs in use, skipping");
                }
                continue;
            }
            LockProbe::Error(e) => {
                warn!("images/{rootfs_hash}: lock probe failed ({e}), skipping");
                continue;
            }
        };

        let snapshots_dir = rootfs_path.join("snapshots");
        match gc_path_dir_status(&snapshots_dir).await {
            Ok(GcDirStatus::RealDir(_)) => {}
            Ok(GcDirStatus::Missing) => {
                // No snapshots/ subdirectory — orphaned rootfs, handle inline.
                if let Some(freed_bytes) =
                    try_delete_orphan_rootfs(&rootfs_path, &rootfs_hash, dry_run).await
                {
                    report += GcReport::cleanup(1, freed_bytes);
                }
                continue;
            }
            Ok(GcDirStatus::NotDirectory) => {
                warn!("images/{rootfs_hash}/snapshots: not a real directory, skipping");
                continue;
            }
            Err(e) => {
                warn!("images/{rootfs_hash}/snapshots: stat failed ({e}), skipping");
                continue;
            }
        }
        let mut snapshot_entries = match tokio::fs::read_dir(&snapshots_dir).await {
            Ok(rd) => rd,
            Err(e) => {
                warn!("images/{rootfs_hash}/snapshots: read failed ({e}), skipping");
                continue;
            }
        };

        let rootfs_idx = rootfs_states.len();
        let candidate_checkpoint = candidates.len();
        let scan_complete = loop {
            let snap_entry = match inventory_entry_reader
                .next_entry_warn(&mut snapshot_entries, "snapshots", &snapshots_dir)
                .await
            {
                Ok(Some(entry)) => entry,
                Ok(None) => break true,
                Err(_) => {
                    candidates.truncate(candidate_checkpoint);
                    break false;
                }
            };
            let snap_path = snap_entry.path();
            let Some(snap_hash) = snap_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(String::from)
            else {
                continue;
            };
            match gc_entry_is_real_dir(&snap_entry).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(e) => {
                    warn!(
                        "images/{rootfs_hash}/snapshots/{snap_hash}: cannot read file type ({e}), skipping"
                    );
                    continue;
                }
            }

            if is_protected_image_ref(protected_image_refs, &rootfs_hash, &snap_hash) {
                if dry_run {
                    info!(
                        "images/{rootfs_hash}/snapshots/{snap_hash}: referenced by retained runner or service config, keeping"
                    );
                }
                continue;
            }

            let lock_path = home.snapshot_lock(&snap_hash);
            match probe_lock(&lock_path) {
                LockProbe::Free(lock) => {
                    let (size, mtime) = dir_stats(&snap_path).await;
                    let age = SystemTime::now().duration_since(mtime).unwrap_or_default();
                    drop(lock);
                    if age < GC_MIN_AGE {
                        // Too recent to be safely deleted (races with
                        // `runner build` releasing its lock).
                        if dry_run {
                            info!(
                                "images/{rootfs_hash}/snapshots/{snap_hash}: too recent ({}s), keeping",
                                age.as_secs()
                            );
                        }
                    } else {
                        candidates.push(GcCandidate {
                            hash: snap_hash,
                            size,
                            mtime,
                            rootfs_idx,
                        });
                    }
                }
                LockProbe::Held => {
                    if dry_run {
                        info!("images/{rootfs_hash}/snapshots/{snap_hash}: in use, skipping");
                    }
                }
                LockProbe::Error(e) => {
                    warn!(
                        "images/{rootfs_hash}/snapshots/{snap_hash}: lock probe failed ({e}), skipping"
                    );
                }
            }
        };

        drop(rootfs_lock);
        if scan_complete {
            rootfs_states.push(RootfsState {
                path: rootfs_path,
                hash: rootfs_hash,
                snapshot_dispositions: HashMap::new(),
            });
        }
    }
    drop(rootfs_entries);

    // Phase 2: global sort by mtime descending and record each top-N decision.
    candidates.sort_by_key(|c| std::cmp::Reverse(c.mtime));
    let keep_count = keep_latest.unwrap_or(0);
    for (rank, candidate) in candidates.into_iter().enumerate() {
        let state = rootfs_states.get_mut(candidate.rootfs_idx).ok_or_else(|| {
            RunnerError::Internal(format!(
                "image GC candidate {} references missing rootfs state {}",
                candidate.hash, candidate.rootfs_idx
            ))
        })?;
        let disposition = if rank < keep_count {
            if dry_run {
                info!(
                    "images/{}/snapshots/{}: keeping (global top-{keep_count}, {})",
                    state.hash,
                    candidate.hash,
                    human_bytes(candidate.size)
                );
            }
            SnapshotDisposition::Keep
        } else {
            SnapshotDisposition::Delete
        };
        let _ = state
            .snapshot_dispositions
            .insert(candidate.hash, disposition);
    }

    // Phase 3: lock, rescan, and act on one rootfs at a time.
    for state in &rootfs_states {
        report += gc_rootfs_action(home, state, dry_run, action_entry_reader).await;
    }

    Ok(report)
}

runner_test_support!(cmd_gc_build; #[cfg(test)]
async fn gc_nested_images_with_injected_snapshot_scan_error(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
    protected_image_refs: &ProtectedImageRefs,
    successful_entries: usize,
) -> RunnerResult<GcReport> {
    let mut inventory_entry_reader = GcDirEntryReader::failing_after(successful_entries);
    let mut action_entry_reader = GcDirEntryReader::new();
    gc_nested_images_with_protected_refs_and_readers(
        home,
        keep_latest,
        dry_run,
        protected_image_refs,
        &mut inventory_entry_reader,
        &mut action_entry_reader,
    )
    .await
});

runner_test_support!(cmd_gc_build; #[cfg(test)]
async fn gc_nested_images_with_injected_action_scan_error(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
    protected_image_refs: &ProtectedImageRefs,
    successful_entries: usize,
) -> RunnerResult<GcReport> {
    let mut inventory_entry_reader = GcDirEntryReader::new();
    let mut action_entry_reader = GcDirEntryReader::failing_after(successful_entries);
    gc_nested_images_with_protected_refs_and_readers(
        home,
        keep_latest,
        dry_run,
        protected_image_refs,
        &mut inventory_entry_reader,
        &mut action_entry_reader,
    )
    .await
});

runner_test_group!(cmd_gc_build; #[cfg(test)]
mod tests;);
