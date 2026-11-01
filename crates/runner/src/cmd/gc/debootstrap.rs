use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use runner_host::byte_size::human_bytes;
use runner_host::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{next_entry_warn_or_stop, read_dir_or_missing};
use super::lock_file::{LockProbe, probe_lock};
use super::report::GcReport;

mod removal;

use removal::remove_cache_file;

/// Remove cached debootstrap tarballs, keeping the `keep_latest` most recent.
pub(super) async fn gc_debootstrap(
    home: &HomePaths,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<GcReport> {
    let dir = home.debootstrap_dir();
    if !dir.try_exists().map_err(|e| {
        RunnerError::Internal(format!("check debootstrap dir {}: {e}", dir.display()))
    })? {
        return Ok(GcReport::default());
    }

    let lock_path = home.debootstrap_lock();
    let mut cache_lock = match probe_lock(&lock_path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => {
            if dry_run {
                info!("debootstrap cache: in use, skipping");
            }
            return Ok(GcReport::default());
        }
        LockProbe::Error(e) => {
            warn!("debootstrap cache: lock probe failed ({e}), skipping");
            return Ok(GcReport::default());
        }
    };

    let Some(mut entries) = read_dir_or_missing(&dir).await? else {
        return Ok(GcReport::default());
    };

    let mut files: Vec<DeBootstrapCacheFile> = Vec::new();
    while let Some(entry) = next_entry_warn_or_stop(&mut entries, "gc_debootstrap", &dir).await {
        let path = entry.path();
        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let Some(kind) = debootstrap_cache_file_kind(&path) else {
            continue;
        };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        files.push(DeBootstrapCacheFile {
            path,
            size: meta.len(),
            mtime,
            is_temp: matches!(kind, DeBootstrapCacheFileKind::Temp),
        });
    }

    // Skip files touched recently (same GC_MIN_AGE as rootfs/snapshots).
    let now = SystemTime::now();
    files.retain(|file| {
        let age = now.duration_since(file.mtime).unwrap_or_default();
        if age < GC_MIN_AGE {
            if dry_run {
                info!(
                    "debootstrap cache: {} too recent ({}s old), skipping",
                    file.path.display(),
                    age.as_secs()
                );
            }
            false
        } else {
            true
        }
    });

    // Sort newest first, keep the N most recent stable tarballs. Stale temp
    // tarballs are cancellation residue and must not consume a keep_latest slot
    // that would otherwise protect a usable cache tarball.
    files.sort_by_key(|f| std::cmp::Reverse(f.mtime));
    let keep = keep_latest.unwrap_or(0);
    let mut stable_seen = 0usize;

    let mut report = GcReport::default();
    for file in files.iter() {
        if !file.is_temp && stable_seen < keep {
            stable_seen += 1;
            continue;
        }
        if dry_run {
            info!(
                "debootstrap cache: would remove {} ({})",
                file.path.display(),
                human_bytes(file.size)
            );
        } else {
            let (returned_lock, result) = remove_cache_file(&file.path, cache_lock).await;
            cache_lock = returned_lock;
            if let Err(e) = result {
                warn!("remove {}: {e}", file.path.display());
                continue;
            }
        }
        report += GcReport::cleanup(1, file.size);
    }
    Ok(report)
}

struct DeBootstrapCacheFile {
    path: PathBuf,
    size: u64,
    mtime: SystemTime,
    is_temp: bool,
}

enum DeBootstrapCacheFileKind {
    Stable,
    Temp,
}

fn debootstrap_cache_file_kind(path: &Path) -> Option<DeBootstrapCacheFileKind> {
    let name = path.file_name().and_then(|name| name.to_str())?;
    if is_debootstrap_temp_tarball_name(name) {
        Some(DeBootstrapCacheFileKind::Temp)
    } else if name.ends_with(".tar") {
        Some(DeBootstrapCacheFileKind::Stable)
    } else {
        None
    }
}

fn is_debootstrap_temp_tarball_name(name: &str) -> bool {
    let Some(identity) = name
        .strip_suffix(".tar")
        .and_then(|stem| stem.rsplit_once(".tmp.").map(|(_, identity)| identity))
    else {
        return false;
    };

    identity.strip_prefix("mktemp.").is_some_and(|random| {
        random.len() == 6 && random.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

#[cfg(test)]
mod tests;
