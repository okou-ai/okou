//! Runner-local filesystem layout helpers.
//!
//! This module centralizes the paths the runner uses under
//! `/var/lib/vm0-runner` plus per-runner state rooted at a configured
//! `base_dir`. [`HomePaths`] describes shared runner home directories such as
//! images, logs, locks, dependencies, CA material, and storage archives.
//! [`RunnerPaths`] describes state scoped to one runner process. Rootfs builds
//! are addressed through [`RootfsPaths`] under `HomePaths::images_dir()`, and
//! snapshot output directories are nested below a rootfs. [`LogPaths`] formats
//! per-run log files under `HomePaths::logs_dir()`.
//!
//! Untrusted manifest-derived path components, currently storage name/version
//! pairs, are hashed before being embedded in directory or lock names. This
//! keeps cache paths compact, avoids path traversal and separator ambiguity,
//! and gives host cache paths and guest `file://` URLs a shared keying scheme.
//! Lock paths are owned by `HomePaths`, but their location is chosen per
//! resource; most shared-resource locks live in `locks/`, while the
//! debootstrap lock intentionally lives next to the debootstrap cache.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::HostResult;
use runner_types::ids::RunId;

// A fixed addressing domain; ordinary rootfs/runtime updates do not change it.
const HOME_IMAGE_CACHE_KEY_DOMAIN: &[u8] = b"home-image-cache:v2";
pub const HOME_DRIVE_LAYOUT: &str = "home-drive-v1";
pub(crate) const RUNNER_HOME_ROOT: &str = "/var/lib/vm0-runner";

/// Short hex digests for storage name and version components, used when
/// building filesystem paths from untrusted manifest fields.
///
/// Each component uses a 16-character / 64-bit prefix. That keeps directory
/// names compact for this bounded runner-local cache, but is not a
/// mathematical uniqueness guarantee or unbounded global key.
fn storage_key_hashes(name: &str, version: &str) -> (String, String) {
    (short_digest(name), short_digest(version))
}

/// Hex-encode the first 8 bytes of `SHA-256(s)` — 16 characters, collision
/// resistant enough for bounded runner-local bookkeeping and always a valid
/// path segment.
///
/// Exposed `pub` so the host-side cache dir (built here) and the
/// guest-side `file://` URL (built in `storage_cache`) share one source of
/// truth. A drift between two copies would silently route host writes and
/// guest reads to different logical blobs.
pub fn short_digest(s: &str) -> String {
    let digest = Sha256::digest(s.as_bytes());
    let prefix = digest.get(..8).unwrap_or(&digest);
    hex::encode(prefix)
}

pub fn base_dir_lock_name(base_dir: &Path) -> String {
    let hash = hex::encode(Sha256::digest(base_dir.as_os_str().as_encoded_bytes()));
    format!("base-dir-{hash}.lock")
}

/// Complete identity of a host-shared home baseline. Cwd is deliberately
/// absent: execution-path validation is separate from image identity. Rootfs
/// identifies the producing VM; the independently mounted home survives its updates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HomeImageCacheKey<'a> {
    pub cache_scope: &'a str,
    pub profile_name: &'a str,
    pub reuse_key: &'a str,
    pub drive_layout: &'a str,
    pub image_size_bytes: u64,
}

impl HomeImageCacheKey<'_> {
    /// Length framing avoids separator/NUL ambiguities in untrusted fields.
    pub fn digest(self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(HOME_IMAGE_CACHE_KEY_DOMAIN);
        for field in [
            self.cache_scope,
            self.profile_name,
            self.reuse_key,
            self.drive_layout,
        ] {
            hasher.update((field.len() as u64).to_le_bytes());
            hasher.update(field.as_bytes());
        }
        hasher.update(self.image_size_bytes.to_le_bytes());
        hex::encode(hasher.finalize())
    }
}

pub fn scoped_home_image_cache_key(
    cache_scope: &str,
    profile_name: &str,
    reuse_key: &str,
    image_size_bytes: u64,
) -> String {
    HomeImageCacheKey {
        cache_scope,
        profile_name,
        reuse_key,
        drive_layout: HOME_DRIVE_LAYOUT,
        image_size_bytes,
    }
    .digest()
}

/// Update a directory's mtime to now, so `runner gc` treats it as recently used.
pub fn touch_mtime(dir: &Path) {
    let Ok(f) = std::fs::File::open(dir) else {
        tracing::warn!("touch_mtime: cannot open {}", dir.display());
        return;
    };
    if let Err(e) =
        f.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()))
    {
        tracing::warn!("touch_mtime: set_times failed for {}: {e}", dir.display());
    }
}

/// Runner-level paths derived from the base directory.
#[derive(Clone)]
pub struct RunnerPaths {
    base_dir: PathBuf,
}

impl RunnerPaths {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub fn status(&self) -> PathBuf {
        self.base_dir.join("status.json")
    }

    pub fn mitm_addon_dir(&self) -> PathBuf {
        self.base_dir.join("mitm-addon")
    }

    pub fn mitmdump_runtime_dir(&self) -> PathBuf {
        self.base_dir.join("mitmdump-runtime")
    }

    pub fn mitmdump_runtime_lock(&self) -> PathBuf {
        self.base_dir.join("mitmdump-runtime.lock")
    }

    pub fn proxy_registry(&self) -> PathBuf {
        self.base_dir.join("proxy-registry.json")
    }

    pub fn proxy_registry_lock(&self) -> PathBuf {
        self.base_dir.join("proxy-registry.json.lock")
    }

    pub fn builtin_firewall_catalog_cache(&self) -> PathBuf {
        self.base_dir.join("builtin-firewall-catalog-cache.json")
    }

    pub fn builtin_firewall_catalog_cache_lock(&self) -> PathBuf {
        self.base_dir
            .join("builtin-firewall-catalog-cache.json.lock")
    }

    /// Factory-owned host workspaces contain COW state and the active home image.
    /// This host layout is independent of the guest `/home/user` mount and cwd.
    pub fn workspaces_dir(&self) -> PathBuf {
        self.base_dir.join("workspaces")
    }

    pub fn workspace_dir(&self, sandbox_id: &impl std::fmt::Display) -> PathBuf {
        self.workspaces_dir().join(sandbox_id.to_string())
    }

    /// The same backing image created and bound by the Firecracker factory.
    pub fn active_home_image(&self, sandbox_id: &impl std::fmt::Display) -> PathBuf {
        self.workspace_dir(sandbox_id).join("home.ext4")
    }
}

/// Paths rooted at /var/lib/vm0-runner/.
#[derive(Clone)]
pub struct HomePaths {
    root: PathBuf,
}

// Declare shared top-level directories once so their getters and private-state
// reservation inventory cannot drift apart. `runners` is intentionally separate.
macro_rules! shared_home_dirs {
    ($($(#[$meta:meta])* $vis:vis fn $method:ident => $component:literal;)+) => {
        impl HomePaths {
            $(
                $(#[$meta])*
                $vis fn $method(&self) -> PathBuf {
                    self.root.join($component)
                }
            )+

            pub(crate) fn shared_subtree_roots(&self) -> impl Iterator<Item = PathBuf> {
                [$(self.$method(),)+].into_iter()
            }
        }
    };
}

shared_home_dirs! {
    pub fn bin_dir => "bin";
    pub fn ca_dir => "ca";
    pub fn runner_control_dir => "control";
    pub fn debootstrap_dir => "debootstrap";
    fn firecracker_root_dir => "firecracker";
    pub fn groups_dir => "groups";
    pub fn images_dir => "images";
    pub fn locks_dir => "locks";
    pub fn live_runner_instances_dir => "live-runner-instances";
    pub fn logs_dir => "logs";
    fn mitmproxy_root_dir => "mitmproxy";
    /// Root directory for the runner-side storage archive cache.
    ///
    /// Layout: `<storages_dir>/<hash(vasStorageName)>/<hash(vasVersionId)>/archive.tar.gz`.
    /// Populated by the cache writer (#10808) and reaped by `gc_storage_cache`.
    pub fn storages_dir => "storages";
    /// Immutable input archives addressed by their complete SHA-256.
    pub fn bundles_dir => "bundles-v1";
    pub fn home_image_cache_dir => "home-image-cache";
}

impl HomePaths {
    pub fn new() -> HostResult<Self> {
        Ok(Self {
            root: PathBuf::from(RUNNER_HOME_ROOT),
        })
    }

    pub fn with_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub fn firecracker_dir(&self, version: &str) -> PathBuf {
        self.firecracker_root_dir().join(version)
    }

    pub fn firecracker_bin(&self, version: &str) -> PathBuf {
        self.firecracker_dir(version).join("firecracker")
    }

    pub fn kernel_bin(&self, fc_version: &str, kernel_version: &str) -> PathBuf {
        let kernel_name = format!("vmlinux-{kernel_version}");
        self.firecracker_dir(fc_version).join(kernel_name)
    }

    pub fn mitmproxy_dir(&self, version: &str) -> PathBuf {
        self.mitmproxy_root_dir().join(version)
    }

    pub fn mitmdump_bin(&self, version: &str) -> PathBuf {
        self.mitmproxy_dir(version).join("mitmdump")
    }

    pub fn live_runner_instance_record_path(&self, pid: u32, starttime: u64) -> PathBuf {
        self.live_runner_instances_dir()
            .join(format!("{pid}-{starttime}.json"))
    }

    pub fn runners_dir(&self) -> PathBuf {
        self.root.join("runners")
    }

    pub fn debootstrap_lock(&self) -> PathBuf {
        self.debootstrap_dir().join(".lock")
    }

    /// Host-global lock for systemd manager reload coordination.
    pub fn systemd_daemon_reload_lock(&self) -> PathBuf {
        self.locks_dir().join("systemd-daemon-reload.lock")
    }

    /// Host-global lock serializing complete garbage collection runs.
    pub fn gc_lock(&self) -> PathBuf {
        // Keep the historical filename so runner-owned locking coordinates
        // with deployment processes that acquired the external lock.
        self.locks_dir().join("deployment-gc.lock")
    }

    pub fn base_dir_lock(&self, base_dir: &Path) -> PathBuf {
        self.locks_dir().join(base_dir_lock_name(base_dir))
    }

    pub fn rootfs_lock(&self, hash: &str) -> PathBuf {
        self.locks_dir().join(format!("rootfs-{hash}.lock"))
    }

    pub fn template_lock(&self, hash: &str) -> PathBuf {
        self.locks_dir().join(format!("template-{hash}.lock"))
    }

    pub fn ca_lock(&self) -> PathBuf {
        self.locks_dir().join("ca.lock")
    }

    pub fn snapshot_lock(&self, hash: &str) -> PathBuf {
        self.locks_dir().join(format!("snapshot-{hash}.lock"))
    }

    /// Cache directory for a specific storage (name, version) pair.
    ///
    /// `name` and `version` come from untrusted manifest fields
    /// (`vas_storage_name` / `vas_version_id`) so they are hashed before use.
    /// Hashing also avoids separator ambiguity between the two path components
    /// and provides compact collision-resistant cache keys under the truncated
    /// hash model.
    pub fn storage_cache_dir(&self, name: &str, version: &str) -> PathBuf {
        let (name_hash, version_hash) = storage_key_hashes(name, version);
        self.storages_dir().join(name_hash).join(version_hash)
    }

    /// Per-version flock path guarding `storage_cache_dir(name, version)`.
    ///
    /// Same hashing rationale as `storage_cache_dir`: the lock filename must
    /// use the same compact cache key components and be safe to embed in a
    /// path segment.
    pub fn storage_lock(&self, name: &str, version: &str) -> PathBuf {
        let (name_hash, version_hash) = storage_key_hashes(name, version);
        self.storage_lock_for_cache_key(&name_hash, &version_hash)
    }

    /// Per-version flock path from already-hashed cache directory components.
    ///
    /// This is for disk walkers such as `runner gc`, which discover
    /// `<storages>/<name_hash>/<version_hash>/` and must use the exact same
    /// lock as `storage_lock(name, version)`, not hash those components again.
    pub fn storage_lock_for_cache_key(&self, name_hash: &str, version_hash: &str) -> PathBuf {
        self.locks_dir()
            .join(format!("storage-{name_hash}-{version_hash}.lock"))
    }
}

pub fn home_image_cache_lock_path(lock_dir: &Path, cache_key: &str) -> PathBuf {
    lock_dir.join(format!("home-image-cache-{cache_key}.lock"))
}

/// Collector singleton and successful routine-maintenance completion marker.
pub fn home_image_cache_routine_gc_lock_path(lock_dir: &Path) -> PathBuf {
    lock_dir.join("home-image-cache-routine-gc.lock")
}

/// Paths for a rootfs build output, keyed by rootfs hash.
///
/// Layout: `<images_dir>/<rootfs_hash>/rootfs.ext4`
pub struct RootfsPaths {
    dir: PathBuf,
}

impl RootfsPaths {
    pub fn new(home: &HomePaths, rootfs_hash: &str) -> Self {
        Self {
            dir: home.images_dir().join(rootfs_hash),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn rootfs(&self) -> PathBuf {
        self.dir.join("rootfs.ext4")
    }

    /// Pre-commit staging path for the rootfs image.
    ///
    /// Rootfs customization runs against this path. Only after every
    /// post-processing step succeeds does
    /// the build command atomically rename `rootfs.ext4.staging → rootfs.ext4` —
    /// so `rootfs()` exists on disk if and only if the full assembly
    /// pipeline completed. A leftover `rootfs.ext4.staging` is always
    /// a crash residue from a previous build and is safe to delete once
    /// the rootfs flock is held.
    pub fn rootfs_staging(&self) -> PathBuf {
        self.dir.join("rootfs.ext4.staging")
    }

    /// All files that must exist for the rootfs to be considered complete.
    pub fn expected_files(&self) -> [PathBuf; 1] {
        [self.rootfs()]
    }

    /// Sidecar copy of the Okou CLI manifest installed into this rootfs.
    ///
    /// Written by `runner build` before `rootfs.ext4` is committed and only
    /// when the build installed a versioned CLI artifact, so its absence means
    /// the rootfs launches the CLI through the legacy commit-addressed path.
    pub fn okou_cli_manifest(&self) -> PathBuf {
        self.dir.join("okou-cli.json")
    }

    /// Derive the snapshot output directory nested under this rootfs.
    pub fn snapshot_dir(&self, snapshot_hash: &str) -> PathBuf {
        self.dir.join("snapshots").join(snapshot_hash)
    }

    /// Parent directory for all snapshots under this rootfs.
    #[cfg(test)]
    pub(crate) fn snapshots_dir(&self) -> PathBuf {
        self.dir.join("snapshots")
    }
}

/// Log file paths derived from `HomePaths::logs_dir()`.
#[derive(Clone)]
pub struct LogPaths {
    dir: PathBuf,
}

#[derive(Clone, Copy)]
struct LogFilenamePattern {
    prefix: &'static str,
    suffix: &'static str,
}

impl LogFilenamePattern {
    fn path(self, dir: &Path, run_id: RunId) -> PathBuf {
        dir.join(format!("{}{run_id}{}", self.prefix, self.suffix))
    }

    fn matches(self, name: &str) -> bool {
        name.starts_with(self.prefix) && name.ends_with(self.suffix)
    }
}

macro_rules! define_per_run_logs {
    ($($method:ident => ($prefix:literal, $suffix:literal)),+ $(,)?) => {
        const PER_RUN_LOG_PATTERNS: &[LogFilenamePattern] = &[
            $(
                LogFilenamePattern {
                    prefix: $prefix,
                    suffix: $suffix,
                },
            )+
        ];

        impl LogPaths {
            $(
                pub fn $method(&self, run_id: RunId) -> PathBuf {
                    LogFilenamePattern {
                        prefix: $prefix,
                        suffix: $suffix,
                    }
                    .path(&self.dir, run_id)
                }
            )+
        }
    };
}

define_per_run_logs! {
    network_log => ("network-", ".jsonl"),
    proxy_log => ("proxy-", ".jsonl"),
    system_log => ("system-", ".log"),
    system_stream_log => ("system-stream-", ".log"),
    metrics_log => ("metrics-", ".jsonl"),
    oom_evidence_log => ("oom-evidence-", ".json"),
    sandbox_ops_log => ("sandbox-ops-", ".jsonl"),
}

const RUNNER_INSTANCE_LOG_PATTERN: LogFilenamePattern = LogFilenamePattern {
    prefix: "runner-",
    suffix: ".log",
};

impl LogPaths {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Whether `name` matches any GC-eligible log file pattern.
    ///
    /// Includes per-job log patterns declared by `PER_RUN_LOG_PATTERNS`,
    /// runner instance logs (`runner-*.log`), and stale `.vm0tmp-*` copies
    /// of those files left behind by a killed runner.
    pub fn is_gc_eligible_log(name: &str) -> bool {
        Self::is_final_gc_eligible_log(name) || Self::is_gc_eligible_log_temp(name)
    }

    fn is_final_gc_eligible_log(name: &str) -> bool {
        PER_RUN_LOG_PATTERNS
            .iter()
            .any(|pattern| pattern.matches(name))
            || RUNNER_INSTANCE_LOG_PATTERN.matches(name)
    }

    fn is_gc_eligible_log_temp(name: &str) -> bool {
        let Some(name) = name.strip_prefix('.') else {
            return false;
        };
        let Some((base, suffix)) = name.split_once(".vm0tmp-") else {
            return false;
        };
        !suffix.is_empty() && Self::is_final_gc_eligible_log(base)
    }
}

#[cfg(test)]
mod tests;
