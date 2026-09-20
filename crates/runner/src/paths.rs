//! Runner-local filesystem layout helpers.
//!
//! This module centralizes the paths the runner uses under
//! `/var/lib/vm0-runner` plus per-runner state rooted at a configured
//! `base_dir`. [`HomePaths`] describes shared runner home directories such as
//! images, logs, locks, dependencies, CA material, and storage archives.
//! [`RunnerPaths`] describes state scoped to one runner process. Rootfs builds
//! are addressed through [`RootfsPaths`] under `HomePaths::images_dir()`, and
//! snapshots are nested below a rootfs through [`SnapshotPaths`]. [`LogPaths`]
//! formats per-run log files under `HomePaths::logs_dir()`.
//!
//! Untrusted manifest-derived path components, currently storage name/version
//! pairs, are hashed before being embedded in directory or lock names. This
//! keeps cache paths compact, avoids path traversal and separator ambiguity,
//! and gives host cache paths and guest `file://` URLs a shared keying scheme.
//! Lock paths are owned by `HomePaths`, but their location is chosen per
//! resource; most shared-resource locks live in `locks/`, while the
//! debootstrap lock intentionally lives next to the debootstrap cache.

use std::path::{Path, PathBuf};

pub use sandbox_firecracker::SnapshotOutputPaths as SnapshotPaths;
use sha2::{Digest, Sha256};

use crate::error::RunnerResult;
use crate::ids::RunId;

const WORKSPACE_IMAGE_CACHE_KEY_DOMAIN: &[u8] = b"workspace-image-cache:v1\0";

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
/// Exposed `pub(crate)` so the host-side cache dir (built here) and the
/// guest-side `file://` URL (built in `storage_cache`) share one source of
/// truth. A drift between two copies would silently route host writes and
/// guest reads to different logical blobs.
pub(crate) fn short_digest(s: &str) -> String {
    let digest = Sha256::digest(s.as_bytes());
    let prefix = digest.get(..8).unwrap_or(&digest);
    hex::encode(prefix)
}

pub(crate) fn base_dir_lock_name(base_dir: &Path) -> String {
    let hash = hex::encode(Sha256::digest(base_dir.as_os_str().as_encoded_bytes()));
    format!("base-dir-{hash}.lock")
}

/// Versioned digest key for host-shared reuse-key workspace image baselines.
///
/// The raw reuse key is untrusted and must not be embedded directly in
/// host paths. The working-dir argument is intentionally ignored: workspace
/// image cache identity is based on canonical workspace semantics. The key
/// includes the cache scope, profile, drive layout version, and logical image
/// size so incompatible workspace images never share a host entry.
#[cfg(test)]
pub(crate) fn workspace_image_cache_key(reuse_key: &str, working_dir: &str) -> String {
    scoped_workspace_image_cache_key("", "vm0/default", reuse_key, working_dir, 5)
}

pub(crate) fn scoped_workspace_image_cache_key(
    cache_scope: &str,
    profile_name: &str,
    reuse_key: &str,
    _working_dir: &str,
    image_size_bytes: u64,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(WORKSPACE_IMAGE_CACHE_KEY_DOMAIN);
    hasher.update(cache_scope.as_bytes());
    hasher.update(b"\0");
    hasher.update(profile_name.as_bytes());
    hasher.update(b"\0workspace-drive-v1\0");
    hasher.update(image_size_bytes.to_le_bytes());
    hasher.update(b"\0");
    hasher.update(reuse_key.as_bytes());
    hex::encode(hasher.finalize())
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

/// Guest paths (must match rootfs layout).
pub mod guest {
    pub const STORAGE_MANIFEST: &str = guest_contracts::runtime_paths::STORAGE_MANIFEST_PATH;
    pub const STORAGE_APPLY_BIN: &str = guest_contracts::guest_binary::STORAGE_APPLY_PATH;
    pub const RUN_AGENT: &str = guest_contracts::guest_binary::AGENT_PATH;
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

    #[cfg(test)]
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

    pub fn workspaces_dir(&self) -> PathBuf {
        self.base_dir.join("workspaces")
    }

    pub fn workspace_dir(&self, sandbox_id: &sandbox::SandboxId) -> PathBuf {
        self.workspaces_dir().join(sandbox_id.to_string())
    }

    pub fn active_workspace_image(&self, sandbox_id: &sandbox::SandboxId) -> PathBuf {
        self.workspace_dir(sandbox_id).join("workspace.ext4")
    }

    #[cfg(test)]
    pub fn workspace_image_cache_dir(&self) -> PathBuf {
        self.base_dir.join("workspace-image-cache")
    }
}

/// Paths rooted at /var/lib/vm0-runner/.
#[derive(Clone)]
pub struct HomePaths {
    root: PathBuf,
}

impl HomePaths {
    pub fn new() -> RunnerResult<Self> {
        Ok(Self {
            root: PathBuf::from("/var/lib/vm0-runner"),
        })
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.root.join("bin")
    }

    pub fn firecracker_dir(&self, version: &str) -> PathBuf {
        self.root.join("firecracker").join(version)
    }

    pub fn firecracker_bin(&self, version: &str) -> PathBuf {
        self.firecracker_dir(version).join("firecracker")
    }

    pub fn kernel_bin(&self, fc_version: &str, kernel_version: &str) -> PathBuf {
        let kernel_name = format!("vmlinux-{kernel_version}");
        self.firecracker_dir(fc_version).join(kernel_name)
    }

    pub fn mitmproxy_dir(&self, version: &str) -> PathBuf {
        self.root.join("mitmproxy").join(version)
    }

    pub fn mitmdump_bin(&self, version: &str) -> PathBuf {
        self.mitmproxy_dir(version).join("mitmdump")
    }

    pub fn images_dir(&self) -> PathBuf {
        self.root.join("images")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn live_runner_instances_dir(&self) -> PathBuf {
        self.root.join("live-runner-instances")
    }

    pub(crate) fn runner_control_dir(&self) -> PathBuf {
        self.root.join("control")
    }

    pub fn live_runner_instance_record_path(&self, pid: u32, starttime: u64) -> PathBuf {
        self.live_runner_instances_dir()
            .join(format!("{pid}-{starttime}.json"))
    }

    pub fn runners_dir(&self) -> PathBuf {
        self.root.join("runners")
    }

    pub fn workspace_image_cache_dir(&self) -> PathBuf {
        self.root.join("workspace-image-cache")
    }

    pub fn groups_dir(&self) -> PathBuf {
        self.root.join("groups")
    }

    pub fn ca_dir(&self) -> PathBuf {
        self.root.join("ca")
    }

    pub fn debootstrap_dir(&self) -> PathBuf {
        self.root.join("debootstrap")
    }

    pub fn locks_dir(&self) -> PathBuf {
        self.root.join("locks")
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

    /// Root directory for the runner-side storage archive cache.
    ///
    /// Layout: `<storages_dir>/<hash(vasStorageName)>/<hash(vasVersionId)>/archive.tar.gz`.
    /// Populated by the cache writer (#10808) and reaped by `gc_storage_cache`.
    pub fn storages_dir(&self) -> PathBuf {
        self.root.join("storages")
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

pub(crate) fn workspace_image_cache_lock_path(lock_dir: &Path, cache_key: &str) -> PathBuf {
    lock_dir.join(format!("workspace-image-cache-{cache_key}.lock"))
}

pub(crate) fn workspace_image_cache_capacity_lock_path(lock_dir: &Path) -> PathBuf {
    lock_dir.join("workspace-image-cache-capacity.lock")
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

    /// Derive snapshot paths nested under this rootfs.
    pub fn snapshot(&self, snapshot_hash: &str) -> SnapshotPaths {
        SnapshotPaths::new(self.dir.join("snapshots").join(snapshot_hash))
    }

    /// Parent directory for all snapshots under this rootfs.
    #[cfg(test)]
    pub fn snapshots_dir(&self) -> PathBuf {
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
mod tests {
    use super::*;

    #[test]
    fn home_paths_structure() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        assert_eq!(home.bin_dir(), PathBuf::from("/test/bin"));
        assert_eq!(home.images_dir(), PathBuf::from("/test/images"));
        assert_eq!(home.logs_dir(), PathBuf::from("/test/logs"));
        assert_eq!(
            home.live_runner_instances_dir(),
            PathBuf::from("/test/live-runner-instances")
        );
        assert_eq!(
            home.live_runner_instance_record_path(123, 456),
            PathBuf::from("/test/live-runner-instances/123-456.json")
        );
        assert_eq!(home.runners_dir(), PathBuf::from("/test/runners"));
        assert_eq!(home.groups_dir(), PathBuf::from("/test/groups"));
        assert_eq!(home.ca_dir(), PathBuf::from("/test/ca"));
        assert_eq!(home.debootstrap_dir(), PathBuf::from("/test/debootstrap"));
        assert_eq!(home.locks_dir(), PathBuf::from("/test/locks"));
    }

    #[test]
    fn firecracker_paths() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        assert_eq!(
            home.firecracker_bin("v1.10.1"),
            PathBuf::from("/test/firecracker/v1.10.1/firecracker")
        );
        assert_eq!(
            home.kernel_bin("v1.10.1", "6.1"),
            PathBuf::from("/test/firecracker/v1.10.1/vmlinux-6.1")
        );
    }

    #[test]
    fn mitmdump_path() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        assert_eq!(
            home.mitmdump_bin("11.1.3"),
            PathBuf::from("/test/mitmproxy/11.1.3/mitmdump")
        );
    }

    #[test]
    fn mitmdump_runtime_paths() {
        let paths = RunnerPaths::new(PathBuf::from("/test/runner"));
        assert_eq!(
            paths.mitmdump_runtime_dir(),
            PathBuf::from("/test/runner/mitmdump-runtime")
        );
        assert_eq!(
            paths.mitmdump_runtime_lock(),
            PathBuf::from("/test/runner/mitmdump-runtime.lock")
        );
    }

    #[test]
    fn lock_paths() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let rootfs_lock = home.rootfs_lock("abc123");
        assert_eq!(rootfs_lock, PathBuf::from("/test/locks/rootfs-abc123.lock"));
        let template_lock = home.template_lock("def456");
        assert!(template_lock.starts_with("/test/locks/"));
        assert!(template_lock.to_string_lossy().contains("template-def456"));
        let ca_lock = home.ca_lock();
        assert_eq!(ca_lock, PathBuf::from("/test/locks/ca.lock"));
        let debootstrap_lock = home.debootstrap_lock();
        assert_eq!(debootstrap_lock, PathBuf::from("/test/debootstrap/.lock"));
    }

    #[test]
    fn systemd_daemon_reload_lock_path() {
        let home = HomePaths::with_root(PathBuf::from("/test"));

        assert_eq!(
            home.systemd_daemon_reload_lock(),
            PathBuf::from("/test/locks/systemd-daemon-reload.lock")
        );
    }

    #[test]
    fn base_dir_lock_is_deterministic() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let lock1 = home.base_dir_lock(Path::new("/data/runner-01"));
        let lock2 = home.base_dir_lock(Path::new("/data/runner-01"));
        assert_eq!(lock1, lock2);

        // Different base dirs produce different locks
        let lock3 = home.base_dir_lock(Path::new("/data/runner-02"));
        assert_ne!(lock1, lock3);
    }

    #[test]
    fn runner_paths_structure() {
        let rp = RunnerPaths::new(PathBuf::from("/data/r1"));
        assert_eq!(rp.status(), PathBuf::from("/data/r1/status.json"));
        assert_eq!(rp.mitm_addon_dir(), PathBuf::from("/data/r1/mitm-addon"));
        assert_eq!(
            rp.proxy_registry(),
            PathBuf::from("/data/r1/proxy-registry.json")
        );
        assert_eq!(
            rp.proxy_registry_lock(),
            PathBuf::from("/data/r1/proxy-registry.json.lock")
        );
    }

    #[test]
    fn rootfs_paths_layout() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let rp = RootfsPaths::new(&home, "aaa");
        assert_eq!(rp.dir(), Path::new("/test/images/aaa"));
        assert_eq!(rp.rootfs(), PathBuf::from("/test/images/aaa/rootfs.ext4"));
        assert_eq!(
            rp.rootfs_staging(),
            PathBuf::from("/test/images/aaa/rootfs.ext4.staging")
        );
        assert_ne!(
            rp.rootfs(),
            rp.rootfs_staging(),
            "staging and committed paths must differ"
        );
        assert_eq!(
            rp.snapshots_dir(),
            PathBuf::from("/test/images/aaa/snapshots")
        );
    }

    #[test]
    fn snapshot_paths_layout() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let sp = RootfsPaths::new(&home, "aaa").snapshot("bbb");
        assert_eq!(sp.dir(), Path::new("/test/images/aaa/snapshots/bbb"));
    }

    #[test]
    fn rootfs_expected_files() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let rp = RootfsPaths::new(&home, "aaa");
        let files = rp.expected_files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0], rp.rootfs());
    }

    #[test]
    fn snapshot_lock_path() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let lock = home.snapshot_lock("bbb");
        assert_eq!(lock, PathBuf::from("/test/locks/snapshot-bbb.lock"));
    }

    #[test]
    fn storages_paths_layout() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        assert_eq!(home.storages_dir(), PathBuf::from("/test/storages"));
        // `storage_lock` hashes its inputs: lockfile name is derived from
        // `(short_digest(name), short_digest(version))` so the only stable
        // invariants we can assert are the prefix, parent directory, and the
        // `.lock` suffix.
        let lock = home.storage_lock("system-bash", "v3");
        assert_eq!(lock.parent(), Some(home.locks_dir().as_path()));
        let file_name = lock.file_name().unwrap().to_str().unwrap();
        assert!(file_name.starts_with("storage-"));
        assert!(file_name.ends_with(".lock"));
    }

    #[test]
    fn log_paths_structure() {
        let lp = LogPaths::new(PathBuf::from("/test/logs"));
        let id = RunId::nil();
        let paths = [
            (
                lp.network_log(id),
                PathBuf::from(format!("/test/logs/network-{id}.jsonl")),
            ),
            (
                lp.system_log(id),
                PathBuf::from(format!("/test/logs/system-{id}.log")),
            ),
            (
                lp.system_stream_log(id),
                PathBuf::from(format!("/test/logs/system-stream-{id}.log")),
            ),
            (
                lp.metrics_log(id),
                PathBuf::from(format!("/test/logs/metrics-{id}.jsonl")),
            ),
            (
                lp.sandbox_ops_log(id),
                PathBuf::from(format!("/test/logs/sandbox-ops-{id}.jsonl")),
            ),
            (
                lp.proxy_log(id),
                PathBuf::from(format!("/test/logs/proxy-{id}.jsonl")),
            ),
        ];

        for (actual, expected) in paths {
            assert_eq!(actual, expected);
            let file_name = actual.file_name().and_then(|name| name.to_str()).unwrap();
            assert!(LogPaths::is_gc_eligible_log(file_name));
        }
    }

    #[test]
    fn is_gc_eligible_log_matching() {
        assert!(LogPaths::is_gc_eligible_log(
            "network-550e8400-e29b-41d4-a716-446655440000.jsonl"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            "system-550e8400-e29b-41d4-a716-446655440000.log"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            "system-stream-550e8400-e29b-41d4-a716-446655440000.log"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            "metrics-550e8400-e29b-41d4-a716-446655440000.jsonl"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            "sandbox-ops-550e8400-e29b-41d4-a716-446655440000.jsonl"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            "proxy-550e8400-e29b-41d4-a716-446655440000.jsonl"
        ));
        assert!(LogPaths::is_gc_eligible_log("runner-2026-04-01.log"));
        assert!(LogPaths::is_gc_eligible_log(
            ".system-550e8400-e29b-41d4-a716-446655440000.log.vm0tmp-101-7-1"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            ".system-stream-550e8400-e29b-41d4-a716-446655440000.log.vm0tmp-101-7-1"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            ".metrics-550e8400-e29b-41d4-a716-446655440000.jsonl.vm0tmp-101-7-2"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            ".sandbox-ops-550e8400-e29b-41d4-a716-446655440000.jsonl.vm0tmp-101-7-3"
        ));
    }

    #[test]
    fn is_gc_eligible_log_temp_matching() {
        let lp = LogPaths::new(PathBuf::from("/test/logs"));
        let id = RunId::nil();
        let paths = [
            lp.network_log(id),
            lp.system_log(id),
            lp.system_stream_log(id),
            lp.metrics_log(id),
            lp.oom_evidence_log(id),
            lp.sandbox_ops_log(id),
            lp.proxy_log(id),
        ];

        for path in paths {
            let file_name = path.file_name().and_then(|name| name.to_str()).unwrap();
            let temp_name = format!(".{file_name}.vm0tmp-101-7-1");
            assert!(LogPaths::is_gc_eligible_log(&temp_name));
        }

        assert!(LogPaths::is_gc_eligible_log(
            ".runner-default.2026-04-01.log.vm0tmp-101-7-6"
        ));
    }

    #[test]
    fn is_gc_eligible_log_non_matching() {
        assert!(!LogPaths::is_gc_eligible_log("config.yaml"));
        assert!(!LogPaths::is_gc_eligible_log("status.json"));
        assert!(!LogPaths::is_gc_eligible_log("network-.log")); // wrong extension
        assert!(!LogPaths::is_gc_eligible_log("system-.jsonl")); // wrong extension
        assert!(!LogPaths::is_gc_eligible_log("proxy-.log")); // wrong extension
        assert!(!LogPaths::is_gc_eligible_log("other-file.jsonl"));
        assert!(!LogPaths::is_gc_eligible_log(
            ".system-550e8400-e29b-41d4-a716-446655440000.log.vm0tmp-"
        ));
        assert!(!LogPaths::is_gc_eligible_log(
            ".other-file.jsonl.vm0tmp-101-7-1"
        ));
    }

    #[test]
    fn touch_mtime_nonexistent_dir_does_not_panic() {
        let temp_dir = tempfile::tempdir().unwrap();
        let missing_dir = temp_dir.path().join("missing");
        assert!(!missing_dir.exists());

        touch_mtime(&missing_dir);
    }

    #[test]
    fn storage_cache_dir_stays_inside_root_for_traversal_names() {
        // Regression guard: untrusted `vas_storage_name` / `vas_version_id`
        // must be hashed before being embedded in the path, so that inputs
        // like `../etc` or `foo/bar` cannot escape the cache root.
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let storages = home.storages_dir();

        for (name, version) in [
            ("../etc", "v1"),
            ("foo/bar", "v1"),
            ("foo", "../../etc"),
            ("foo", "v1/../../"),
            ("normal", "v1"),
        ] {
            let dir = home.storage_cache_dir(name, version);
            assert!(
                dir.starts_with(&storages),
                "cache dir {dir:?} escaped storages root for name={name:?} version={version:?}"
            );
            // Exactly two path components under `storages_dir()`:
            // `<hashed-name>/<hashed-version>`.
            let tail: Vec<_> = dir.strip_prefix(&storages).unwrap().components().collect();
            assert_eq!(tail.len(), 2, "expected two hashed components in {dir:?}");
        }
    }

    #[test]
    fn storage_lock_avoids_separator_ambiguity_and_stays_inside_locks_dir() {
        // Distinct (name, version) pairs that would collide under naive
        // `format!("storage-{name}-{version}.lock")` templating must produce
        // distinct lock paths for these examples after hashing.
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let locks = home.locks_dir();

        let a = home.storage_lock("foo", "bar-v1");
        let b = home.storage_lock("foo-bar", "v1");
        assert_ne!(
            a, b,
            "naive-ambiguous examples should not share a lock path: {a:?} vs {b:?}"
        );
        assert!(a.starts_with(&locks));
        assert!(b.starts_with(&locks));
        assert!(a.to_string_lossy().ends_with(".lock"));

        let cache_dir = home.storage_cache_dir("foo", "bar-v1");
        let cache_tail: Vec<_> = cache_dir
            .strip_prefix(home.storages_dir())
            .unwrap()
            .components()
            .collect();
        let name_hash = cache_tail[0].as_os_str().to_str().unwrap();
        let version_hash = cache_tail[1].as_os_str().to_str().unwrap();
        assert_eq!(a, home.storage_lock_for_cache_key(name_hash, version_hash));
    }

    #[test]
    fn storage_cache_dir_is_deterministic() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        assert_eq!(
            home.storage_cache_dir("foo", "v1"),
            home.storage_cache_dir("foo", "v1")
        );
        assert_ne!(
            home.storage_cache_dir("foo", "v1"),
            home.storage_cache_dir("foo", "v2")
        );
    }
}
