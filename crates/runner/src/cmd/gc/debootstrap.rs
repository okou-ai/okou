use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tracing::{info, warn};

use crate::byte_size::human_bytes;
use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{next_entry_warn_or_stop, read_dir_or_missing};
use super::lock_file::{LockProbe, probe_lock};
use super::report::GcReport;

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
    let _lock = match probe_lock(&lock_path) {
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
        } else if let Err(e) = tokio::fs::remove_file(&file.path).await {
            warn!("remove {}: {e}", file.path.display());
            continue;
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

    // Older builders used host PIDs; PID namespaces require mktemp identities.
    (!identity.is_empty() && identity.bytes().all(|byte| byte.is_ascii_digit()))
        || identity.strip_prefix("mktemp.").is_some_and(|random| {
            random.len() == 6 && random.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nix::fcntl::{Flock, FlockArg};

    use super::*;
    use crate::cmd::gc::test_support::{old_gc_time, set_mtime, test_home};
    use runner_host::lock;

    #[tokio::test]
    async fn gc_debootstrap_missing_cache_dir_does_not_create_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());

        let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(report, GcReport::default());
        assert!(
            !home.debootstrap_dir().exists(),
            "missing debootstrap cache dir should remain absent"
        );
        assert!(
            !home.debootstrap_lock().exists(),
            "GC must not create the debootstrap lock when there is no cache dir"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_skips_when_cache_lock_is_held() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let cache_tar = debootstrap_dir.join("noble-amd64.tar");
        std::fs::write(&cache_tar, b"cached").unwrap();
        std::fs::File::open(&cache_tar)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
            )
            .unwrap();

        let lock_file = lock::open_lock_file(&home.debootstrap_lock()).unwrap();
        let _held = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

        let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(report, GcReport::default());
        assert!(
            cache_tar.exists(),
            "active debootstrap cache tarball must survive GC"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_keeps_its_lock_file() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let lock_path = home.debootstrap_lock();
        drop(lock::open_lock_file(&lock_path).unwrap());
        std::fs::File::open(&lock_path)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
            )
            .unwrap();

        let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(report, GcReport::default());
        assert!(
            lock_path.exists(),
            "debootstrap GC must not remove its own lock file"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_ignores_non_cache_files() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let unrelated = debootstrap_dir.join("README");
        let retired_tmp = debootstrap_dir.join("noble-amd64.tar.tmp.123");
        std::fs::write(&unrelated, b"metadata").unwrap();
        std::fs::write(&retired_tmp, b"retired partial").unwrap();
        for path in [&unrelated, &retired_tmp] {
            std::fs::File::open(path)
                .unwrap()
                .set_times(
                    FileTimes::new()
                        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
                )
                .unwrap();
        }

        let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(report, GcReport::default());
        assert!(
            unrelated.exists(),
            "debootstrap GC should only remove cache tarballs"
        );
        assert!(
            retired_tmp.exists(),
            "retired debootstrap temp tarball names are outside GC ownership"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_reports_zero_byte_removal_as_activity() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let cache_tar = debootstrap_dir.join("noble-amd64.tar");
        std::fs::write(&cache_tar, b"").unwrap();
        std::fs::File::open(&cache_tar)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
            )
            .unwrap();

        let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert!(
            !cache_tar.exists(),
            "eligible empty tarball should be removed"
        );
        assert_eq!(report.freed_bytes, 0);
        assert_eq!(report.activity_count, 1);
        assert!(!report.is_empty());
    }

    #[tokio::test]
    async fn gc_debootstrap_dry_run_preserves_and_reports_eligible_tarballs() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let stable_tar = debootstrap_dir.join("noble-amd64.tar");
        let temp_tar = debootstrap_dir.join("noble-amd64.tmp.123.tar");
        std::fs::write(&stable_tar, b"stable cache").unwrap();
        std::fs::write(&temp_tar, b"partial cache").unwrap();
        let expected_bytes = std::fs::metadata(&stable_tar).unwrap().len()
            + std::fs::metadata(&temp_tar).unwrap().len();
        let old_time = old_gc_time();
        set_mtime(&stable_tar, old_time);
        set_mtime(&temp_tar, old_time);

        let report = gc_debootstrap(&home, Some(0), true).await.unwrap();

        assert_eq!(report.freed_bytes, expected_bytes);
        assert_eq!(report.activity_count, 2);
        assert!(
            stable_tar.exists(),
            "dry-run must preserve an eligible stable tarball"
        );
        assert!(
            temp_tar.exists(),
            "dry-run must preserve an eligible temporary tarball"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_removes_stale_temp_tarballs_but_keeps_recent_ones() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let stale_tmp = debootstrap_dir.join("noble-amd64.tmp.123.tar");
        let recent_tmp = debootstrap_dir.join("noble-amd64.tmp.456.tar");
        std::fs::write(&stale_tmp, b"stale partial").unwrap();
        std::fs::write(&recent_tmp, b"recent partial").unwrap();
        let stale_size = std::fs::metadata(&stale_tmp).unwrap().len();
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&stale_tmp)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

        assert_eq!(report.freed_bytes, stale_size);
        assert_eq!(report.activity_count, 1);
        assert!(
            !stale_tmp.exists(),
            "stale debootstrap temp tarball should be GC'd"
        );
        assert!(
            recent_tmp.exists(),
            "recent debootstrap temp tarball may still belong to an active build"
        );
    }

    #[tokio::test]
    async fn gc_debootstrap_temp_tarballs_do_not_consume_keep_latest_slots() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let stable_tar = debootstrap_dir.join("noble-amd64.tar");
        let newer_tmp = debootstrap_dir.join("noble-amd64.tmp.789.tar");
        let random_tmp = debootstrap_dir.join("noble-amd64.tmp.mktemp.a9Bc2D.tar");
        std::fs::write(&stable_tar, b"stable").unwrap();
        std::fs::write(&newer_tmp, b"newer partial").unwrap();
        std::fs::write(&random_tmp, b"namespace partial").unwrap();
        let temp_size = std::fs::metadata(&newer_tmp).unwrap().len()
            + std::fs::metadata(&random_tmp).unwrap().len();
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let newer_time = old_time + Duration::from_secs(60);
        std::fs::File::open(&stable_tar)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();
        std::fs::File::open(&newer_tmp)
            .unwrap()
            .set_times(FileTimes::new().set_modified(newer_time))
            .unwrap();
        std::fs::File::open(&random_tmp)
            .unwrap()
            .set_times(FileTimes::new().set_modified(newer_time))
            .unwrap();

        let report = gc_debootstrap(&home, Some(1), false).await.unwrap();

        assert_eq!(report.freed_bytes, temp_size);
        assert_eq!(report.activity_count, 2);
        assert!(
            stable_tar.exists(),
            "keep_latest should protect the stable debootstrap tarball"
        );
        assert!(
            !newer_tmp.exists(),
            "stale temp tarballs must not consume keep_latest slots"
        );
        assert!(!random_tmp.exists());
    }

    #[tokio::test]
    async fn gc_debootstrap_non_pid_tmp_tarball_name_is_stable() {
        use std::fs::FileTimes;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let debootstrap_dir = home.debootstrap_dir();
        std::fs::create_dir_all(&debootstrap_dir).unwrap();
        let stable_tar = debootstrap_dir.join("noble-amd64.tmp.release.tar");
        let temp_tar = debootstrap_dir.join("noble-amd64.tmp.789.tar");
        std::fs::write(&stable_tar, b"stable").unwrap();
        std::fs::write(&temp_tar, b"temp").unwrap();
        let temp_size = std::fs::metadata(&temp_tar).unwrap().len();
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let newer_time = old_time + Duration::from_secs(60);
        std::fs::File::open(&temp_tar)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();
        std::fs::File::open(&stable_tar)
            .unwrap()
            .set_times(FileTimes::new().set_modified(newer_time))
            .unwrap();

        let report = gc_debootstrap(&home, Some(1), false).await.unwrap();

        assert_eq!(report.freed_bytes, temp_size);
        assert_eq!(report.activity_count, 1);
        assert!(
            stable_tar.exists(),
            "non-pid .tmp. tarball names should remain stable debootstrap cache tarballs"
        );
        assert!(
            !temp_tar.exists(),
            "pid-suffixed debootstrap temp tarball should be removed"
        );
    }
}
