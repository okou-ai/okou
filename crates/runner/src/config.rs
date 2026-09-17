//! Runner YAML config (`runner.yaml`) — the schema the operator writes.
//!
//! The file is loaded once at startup via [`load`], validated, and then
//! consumed by the rest of the runner. For each sandbox spawn, a profile is
//! turned into a [`sandbox::FactoryConfig`] via
//! [`RunnerConfig::factory_config`].
//!
//! # Lifecycle
//! 1. [`load`] reads the YAML, deserializes into [`RunnerConfig`], and
//!    resolves any relative paths against the config file's parent directory.
//! 2. `validate` checks group name, profile names, image hashes, static host
//!    paths, resource ceilings, and the concurrency factor.
//! 3. Callers that consume image artifacts call
//!    [`lock_and_validate_runner_image_artifacts`] (or the single-profile
//!    [`lock_and_validate_profile_image_artifacts`]) to hold the relevant
//!    rootfs/snapshot locks while validating artifact completeness.
//! 4. Callers derive runtime objects (e.g. [`sandbox::FactoryConfig`]) from
//!    the loaded config.
//!
//! # Image identity: two scoped hashes per profile
//! Each [`ProfileConfig`] carries two hashes with different scopes. They are
//! image identities, not just artifact byte digests: cache versions and local
//! build inputs can also affect them.
//! - `rootfs_hash` — identity of the bootable guest filesystem image on this
//!   runner. Shared across snapshot variants on the same host.
//! - `snapshot_hash` — host-local identity of the snapshot captured from that
//!   rootfs. It includes `rootfs_hash` plus VM/snapshot shape inputs such as
//!   `vcpu`, `memory_mb`, and `workspace_disk_mb`, along with
//!   Firecracker/kernel/provider config inputs. Snapshots are produced on each
//!   runner by booting the rootfs and capturing state, since the captured
//!   memory binds to host-specific state.
//!
//! `rootfs_disk_mb` affects `snapshot_hash` through `rootfs_hash`, not as a
//! separate direct snapshot input.
//!
//! Together they identify an exact boot image on this host.
//!
//! # Schema changes
//! Any change to the structs in this module is a change to the on-disk YAML
//! contract operators write. Add fields behind `#[serde(default)]` with a
//! sensible default; rename fields only with a migration plan.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::path::{Path, PathBuf};

use nix::fcntl::Flock;
use serde::{Deserialize, Serialize};

use api_contracts::generated::constants::runners::RUNNER_HOSTNAME_MAX_LENGTH;
use guest_contracts::process_containment::{
    MIN_PROFILE_MEMORY_MB, MIN_PROFILE_VCPU, WorkloadResourcePolicy,
};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, RootfsPaths, SnapshotPaths};
use crate::profile;

/// 0 means auto-detect from host CPU and memory at startup.
pub(crate) const DEFAULT_MAX_CONCURRENT: usize = 0;
/// No overcommit — CPU/memory budgets are taken at face value.
pub(crate) const DEFAULT_CONCURRENCY_FACTOR: f64 = 1.0;

const MAX_VCPU: u32 = 1024;
const MAX_MEMORY_MB: u32 = 1_048_576; // 1 TB
const MAX_DISK_MB: u32 = 1_048_576; // 1 TB
pub(crate) const DIAGNOSTIC_CONFIG_MAX_BYTES: u64 = 1024 * 1024;

/// Top-level runner configuration, deserialized from `runner.yaml`.
///
/// Relative paths for `base_dir`, `ca_dir`, and the `firecracker` binaries
/// are resolved against the YAML file's parent directory during [`load`].
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct RunnerConfig {
    /// Canonical physical host identity used only for diagnostic attribution.
    /// The raw configured value is preserved and never used for scheduling,
    /// authorization, targeting, or ownership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    /// Runner group in `org/name` format (e.g. `vm0/prod`). Used to scope
    /// runners on the server and to build on-disk paths; validated by
    /// [`crate::group::validate_or_err`].
    pub group: String,
    /// Runtime data root for this runner — holds per-sandbox workspaces, COW
    /// devices, sockets, etc. Locked exclusively on startup so two runner
    /// processes can't share the same directory.
    pub base_dir: PathBuf,
    /// Directory holding the MITM proxy's CA certificate and key, passed to
    /// the proxy via `confdir=…` so guests can trust intercepted HTTPS.
    pub ca_dir: PathBuf,
    /// Firecracker binary and guest kernel paths, shared across all profiles.
    pub firecracker: FirecrackerConfig,
    /// Sandbox concurrency and idle-pool tuning. Omit the key to accept
    /// defaults — `#[serde(default)]` fills in the whole sub-section.
    #[serde(default)]
    pub sandbox: SandboxConfig,
    /// Keyed by profile name (e.g. `vm0/default`). Validation requires at
    /// least one entry; each profile name is also checked for format.
    pub profiles: BTreeMap<String, ProfileConfig>,
    /// Control-plane endpoint and auth token. May be omitted in the YAML if
    /// `--api-url` / `--token` (or the corresponding canonical environment
    /// variables) are supplied at `start` time.
    pub server: Option<ServerConfig>,
}

/// Paths to the Firecracker binary and guest kernel used by every profile.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct FirecrackerConfig {
    /// Firecracker VMM binary. Validated to exist on disk at load time.
    pub binary: PathBuf,
    /// Guest kernel image (e.g. `vmlinux`). Validated to exist on disk at
    /// load time.
    pub kernel: PathBuf,
}

/// A bootable image variant: rootfs + snapshot + resource shape.
///
/// See the module-level docs for the two-hash identity scheme
/// (`rootfs_hash` covers the local rootfs, `snapshot_hash` is local-only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileConfig {
    /// Local rootfs image identity, shared across snapshot variants on this host.
    pub rootfs_hash: String,
    /// Host-local snapshot identity, covering rootfs identity plus VM shape,
    /// workspace disk size, and provider/runtime inputs.
    pub snapshot_hash: String,
    /// Guest vCPU count. Must support Guest workload containment and be ≤ 1024.
    pub vcpu: u32,
    /// Guest RAM in MiB. Must support Guest workload containment and be ≤ 1 TiB.
    pub memory_mb: u32,
    /// Rootfs disk in MiB. Used to size the bootable rootfs image.
    /// Must be non-zero and ≤ 1 TiB.
    pub rootfs_disk_mb: u32,
    /// Workspace disk in MiB. Used to size the writable workspace drive.
    /// Must be non-zero and ≤ 1 TiB.
    pub workspace_disk_mb: u32,
}

/// Sandbox-level knobs for concurrency and the idle-sandbox pool.
///
/// All fields accept defaults via `#[serde(default)]`, so the whole
/// `sandbox:` block may be omitted from the YAML.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SandboxConfig {
    /// Hard cap on concurrent sandboxes. `0` auto-detects from host CPU and
    /// memory at startup (see [`DEFAULT_MAX_CONCURRENT`]).
    pub max_concurrent: usize,
    /// Overcommit factor applied to both CPU and memory budgets (default: 1.0).
    pub concurrency_factor: f64,
    /// Maximum number of idle sandboxes to keep (0 = no limit, default: 0).
    pub max_idle: usize,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            concurrency_factor: DEFAULT_CONCURRENCY_FACTOR,
            max_idle: 0,
        }
    }
}

/// Control-plane connection settings. Either field may be supplied via
/// CLI flag or env var at `start` time and override what's in the YAML.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Base URL of the Okou API (e.g. `https://api.example.com`). Overridable
    /// via `--api-url` / `OKOU_API_BACKEND_URL`.
    pub url: String,
    /// Runner auth token. Overridable via `--token` / `OKOU_RUNNER_TOKEN`.
    pub token: String,
}

/// Load and validate a runner config from a YAML file.
///
/// Relative paths in the config are resolved against the config file's parent directory.
pub async fn load(path: &Path) -> RunnerResult<RunnerConfig> {
    let home = HomePaths::new()?;
    // Image artifacts are mutable cache outputs. Runtime callers validate
    // them only after acquiring the matching shared rootfs/snapshot locks.
    load_with_home_inner(path, &home, false, None).await
}

/// Load a runner config for `runner start`, applying the API URL override
/// before validating `server.url`.
pub(crate) async fn load_for_start(
    path: &Path,
    api_url_override: Option<&str>,
) -> RunnerResult<RunnerConfig> {
    let home = HomePaths::new()?;
    load_with_home_inner(path, &home, false, api_url_override).await
}

/// Read a runner config selected by diagnostic/discovery code.
///
/// This does not replace normal startup config loading. It is for candidate
/// paths discovered from local process state, where the path itself is not a
/// trusted operator-supplied argument.
pub(crate) async fn read_diagnostic_config_to_string(path: &Path) -> RunnerResult<Option<String>> {
    crate::state_file::read_to_string(
        path,
        DIAGNOSTIC_CONFIG_MAX_BYTES,
        crate::state_file::OwnerCheck::CurrentEuid,
    )
    .await
}

#[cfg(test)]
async fn load_with_home(
    path: &Path,
    home: &HomePaths,
    validate_image_artifacts: bool,
) -> RunnerResult<RunnerConfig> {
    load_with_home_inner(path, home, validate_image_artifacts, None).await
}

async fn load_with_home_inner(
    path: &Path,
    home: &HomePaths,
    validate_image_artifacts: bool,
    api_url_override: Option<&str>,
) -> RunnerResult<RunnerConfig> {
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| RunnerError::Config(format!("read {}: {e}", path.display())))?;
    let mut config: RunnerConfig = serde_yaml_ng::from_str(&content)
        .map_err(|e| RunnerError::Config(format!("parse {}: {e}", path.display())))?;
    if let Some(config_dir) = path.parent() {
        config.resolve_relative_paths(config_dir);
    }
    if let Some(api_url) = api_url_override {
        let server = config.server.get_or_insert_with(|| ServerConfig {
            url: String::new(),
            token: String::new(),
        });
        server.url = api_url.to_string();
    }
    if let Some(server) = &mut config.server
        && !server.url.is_empty()
    {
        server.url = normalize_api_base_url(&server.url)?;
    }
    validate(&config, home, validate_image_artifacts).await?;
    Ok(config)
}

/// Generate a runner.yaml config file from a `RunnerConfig`.
pub async fn generate(config: &RunnerConfig) -> RunnerResult<()> {
    let runner_dir = &config.base_dir;
    crate::private_fs::ensure_private_dir(runner_dir).await?;

    let content = serde_yaml_ng::to_string(config)
        .map_err(|e| RunnerError::Config(format!("serialize config: {e}")))?;

    let config_path = runner_dir.join("runner.yaml");
    crate::private_fs::write_private_file(&config_path, content.as_bytes()).await?;
    Ok(())
}

/// Validate that `concurrency_factor` is a positive finite number.
///
/// Shared between `run_config()` (CLI entry) and `validate()` (config load)
/// so the invariant is defined in one place.
pub(crate) fn validate_concurrency_factor(value: f64) -> RunnerResult<()> {
    if !value.is_finite() || value <= 0.0 {
        return Err(RunnerError::Config(
            "concurrency_factor must be a positive finite number".into(),
        ));
    }
    Ok(())
}

/// Validate a configured hostname against the runner-facing API boundary.
///
/// Zod measures JavaScript string length in UTF-16 code units, so the Runner
/// uses the same rule before publishing this value.
pub(crate) fn validate_runner_hostname(value: &str) -> RunnerResult<()> {
    let within_bound = u64::try_from(value.encode_utf16().count())
        .is_ok_and(|length| length <= RUNNER_HOSTNAME_MAX_LENGTH);
    if value.is_empty() || !within_bound {
        return Err(RunnerError::Config(format!(
            "hostname must be a non-empty string of at most {RUNNER_HOSTNAME_MAX_LENGTH} UTF-16 code units"
        )));
    }
    Ok(())
}

/// Validate and normalize the runner API base URL.
///
/// The URL is used for authenticated requests and later copied into
/// guest-visible config and log-adjacent paths, so require HTTPS outside the
/// loopback development boundary and reject sensitive URL components.
pub(crate) fn normalize_api_base_url(value: &str) -> RunnerResult<String> {
    let mut parsed = url::Url::parse(value)
        .map_err(|_| RunnerError::Config("server.url must be an absolute http(s) URL".into()))?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(RunnerError::Config(
            "server.url must use the http or https scheme".into(),
        ));
    }
    if parsed.host_str().is_none() {
        return Err(RunnerError::Config("server.url must include a host".into()));
    }
    if parsed_has_userinfo(value, &parsed) {
        return Err(RunnerError::Config(
            "server.url must not include credentials".into(),
        ));
    }
    if parsed.query().is_some() {
        return Err(RunnerError::Config(
            "server.url must not include a query string".into(),
        ));
    }
    if parsed.fragment().is_some() {
        return Err(RunnerError::Config(
            "server.url must not include a fragment".into(),
        ));
    }

    let raw_authority = crate::firewall_hostname_policy::raw_url_authority(value)
        .ok_or_else(|| RunnerError::Config("server.url must include a host".into()))?;
    crate::firewall_hostname_policy::validate_raw_url_host(
        crate::firewall_hostname_policy::raw_host_from_authority(raw_authority),
        "server.url",
    )
    .map_err(RunnerError::Config)?;

    let host_without_trailing_dot = parsed
        .host_str()
        .and_then(|host| host.strip_suffix('.'))
        .map(str::to_owned);
    if let Some(host) = host_without_trailing_dot {
        parsed
            .set_host(Some(&host))
            .map_err(|_| RunnerError::Config("server.url has an invalid host".into()))?;
    }

    let host_is_loopback = match parsed.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if parsed.scheme() == "http" && !host_is_loopback {
        return Err(RunnerError::Config(
            "server.url must use https unless its host is localhost or a loopback IP address"
                .into(),
        ));
    }

    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn parsed_has_userinfo(raw_value: &str, url: &url::Url) -> bool {
    !url.username().is_empty()
        || url.password().is_some()
        || authority_has_userinfo_marker(raw_value)
        || authority_has_userinfo_marker(url.as_str())
}

fn authority_has_userinfo_marker(value: &str) -> bool {
    let Some((_, after_scheme)) = value.split_once("://") else {
        return false;
    };
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    authority.contains('@')
}

async fn check_path_exists(path: &Path, label: &str) -> RunnerResult<()> {
    let exists = tokio::fs::try_exists(path)
        .await
        .map_err(|e| RunnerError::Config(format!("check {label}: {e}")))?;
    if !exists {
        return Err(RunnerError::Config(format!(
            "{label} not found: {}",
            path.display()
        )));
    }
    Ok(())
}

// This intentionally does not acquire resource locks. Runtime callers that
// consume image files must use `lock_and_validate_*_image_artifacts` instead.
async fn validate_profile_image_artifacts(
    name: &str,
    profile: &ProfileConfig,
    home: &HomePaths,
) -> RunnerResult<()> {
    let rootfs_paths = validate_profile_rootfs_artifacts(name, profile, home).await?;
    validate_profile_snapshot_artifacts(name, profile, &rootfs_paths).await?;
    Ok(())
}

async fn validate_profile_rootfs_artifacts(
    name: &str,
    profile: &ProfileConfig,
    home: &HomePaths,
) -> RunnerResult<RootfsPaths> {
    let rootfs_paths = RootfsPaths::new(home, &profile.rootfs_hash);
    for path in rootfs_paths.expected_files() {
        check_path_exists(&path, &format!("profile {name} rootfs")).await?;
    }
    Ok(rootfs_paths)
}

async fn validate_profile_snapshot_artifacts(
    name: &str,
    profile: &ProfileConfig,
    rootfs_paths: &RootfsPaths,
) -> RunnerResult<SnapshotPaths> {
    let snapshot_paths = rootfs_paths.snapshot(&profile.snapshot_hash);
    match sandbox_firecracker::validate_snapshot_output(&snapshot_paths).await {
        Ok(sandbox_firecracker::SnapshotOutputValidation::Complete) => Ok(snapshot_paths),
        Ok(validation) => Err(RunnerError::Config(format!(
            "profile {name} snapshot is incomplete: {validation}"
        ))),
        Err(error) => Err(RunnerError::Config(format!(
            "validate profile {name} snapshot: {error}"
        ))),
    }
}

pub(crate) struct LockedProfileImageArtifacts {
    _rootfs_locks: Vec<Flock<File>>,
    _snapshot_locks: Vec<Flock<File>>,
    snapshot_paths: SnapshotPaths,
}

impl LockedProfileImageArtifacts {
    pub(crate) fn snapshot_paths(&self) -> &SnapshotPaths {
        &self.snapshot_paths
    }
}

pub(crate) struct LockedProfileImageArtifactPaths {
    rootfs_paths: RootfsPaths,
    snapshot_paths: SnapshotPaths,
}

impl LockedProfileImageArtifactPaths {
    pub(crate) fn rootfs_paths(&self) -> &RootfsPaths {
        &self.rootfs_paths
    }

    pub(crate) fn snapshot_paths(&self) -> &SnapshotPaths {
        &self.snapshot_paths
    }
}

pub(crate) struct LockedRunnerImageArtifacts {
    _rootfs_locks: Vec<Flock<File>>,
    _snapshot_locks: Vec<Flock<File>>,
    profile_paths: BTreeMap<String, LockedProfileImageArtifactPaths>,
}

impl LockedRunnerImageArtifacts {
    pub(crate) fn profile_paths(
        &self,
    ) -> impl Iterator<Item = (&str, &LockedProfileImageArtifactPaths)> {
        self.profile_paths
            .iter()
            .map(|(name, paths)| (name.as_str(), paths))
    }
}

pub(crate) async fn lock_and_validate_profile_image_artifacts(
    name: &str,
    profile: &ProfileConfig,
    home: &HomePaths,
) -> RunnerResult<LockedProfileImageArtifacts> {
    let mut profiles = BTreeMap::new();
    profiles.insert(name.to_string(), profile.clone());
    let mut locked = lock_and_validate_runner_image_artifacts(&profiles, home).await?;
    let paths = locked.profile_paths.remove(name).ok_or_else(|| {
        RunnerError::Internal(format!(
            "missing locked image artifact paths for profile {name}"
        ))
    })?;

    Ok(LockedProfileImageArtifacts {
        _rootfs_locks: locked._rootfs_locks,
        _snapshot_locks: locked._snapshot_locks,
        snapshot_paths: paths.snapshot_paths,
    })
}

pub(crate) async fn lock_and_validate_runner_image_artifacts(
    profiles: &BTreeMap<String, ProfileConfig>,
    home: &HomePaths,
) -> RunnerResult<LockedRunnerImageArtifacts> {
    if profiles.is_empty() {
        return Err(RunnerError::Config("profiles must not be empty".into()));
    }

    // Acquire all rootfs locks before any snapshot lock. A runner can use
    // multiple profiles, while builders and GC operate on one rootfs plus its
    // snapshots. Keeping a global rootfs-then-snapshot order prevents a runner
    // from holding one snapshot while waiting on another rootfs.
    let rootfs_hashes: BTreeSet<&str> = profiles
        .values()
        .map(|profile| profile.rootfs_hash.as_str())
        .collect();
    let snapshot_hashes: BTreeSet<&str> = profiles
        .values()
        .map(|profile| profile.snapshot_hash.as_str())
        .collect();

    let mut rootfs_locks = Vec::with_capacity(rootfs_hashes.len());
    for hash in rootfs_hashes {
        rootfs_locks.push(crate::lock::acquire_shared(home.rootfs_lock(hash)).await?);
    }

    let mut rootfs_paths = BTreeMap::new();
    for (name, profile) in profiles {
        rootfs_paths.insert(
            name.clone(),
            validate_profile_rootfs_artifacts(name, profile, home).await?,
        );
    }

    let mut snapshot_locks = Vec::with_capacity(snapshot_hashes.len());
    for hash in snapshot_hashes {
        snapshot_locks.push(crate::lock::acquire_shared(home.snapshot_lock(hash)).await?);
    }

    let mut profile_paths = BTreeMap::new();
    for (name, profile) in profiles {
        let rootfs_paths = rootfs_paths.remove(name).ok_or_else(|| {
            RunnerError::Internal(format!("missing locked rootfs paths for profile {name}"))
        })?;
        let snapshot_paths =
            validate_profile_snapshot_artifacts(name, profile, &rootfs_paths).await?;
        profile_paths.insert(
            name.clone(),
            LockedProfileImageArtifactPaths {
                rootfs_paths,
                snapshot_paths,
            },
        );
    }

    Ok(LockedRunnerImageArtifacts {
        _rootfs_locks: rootfs_locks,
        _snapshot_locks: snapshot_locks,
        profile_paths,
    })
}

async fn validate(
    config: &RunnerConfig,
    home: &HomePaths,
    validate_image_artifacts: bool,
) -> RunnerResult<()> {
    // Pure-CPU checks first — fail fast before any filesystem I/O.
    if let Some(hostname) = config.hostname.as_deref() {
        validate_runner_hostname(hostname)?;
    }
    crate::group::validate_or_err(&config.group)?;
    if config.profiles.is_empty() {
        return Err(RunnerError::Config("profiles must not be empty".into()));
    }
    for name in config.profiles.keys() {
        profile::validate_or_err(name)?;
    }
    for profile in config.profiles.values() {
        crate::image_hash::validate_or_err(&profile.rootfs_hash)?;
        crate::image_hash::validate_or_err(&profile.snapshot_hash)?;
    }

    check_path_exists(&config.ca_dir, "ca_dir").await?;
    check_path_exists(&config.firecracker.binary, "firecracker binary").await?;
    check_path_exists(&config.firecracker.kernel, "kernel").await?;

    for (name, profile) in &config.profiles {
        if profile.vcpu == 0
            || profile.memory_mb == 0
            || profile.rootfs_disk_mb == 0
            || profile.workspace_disk_mb == 0
        {
            return Err(RunnerError::Config(format!(
                "profile {name}: vcpu, memory_mb, rootfs_disk_mb, and workspace_disk_mb must be non-zero"
            )));
        }
        if profile.vcpu > MAX_VCPU {
            return Err(RunnerError::Config(format!(
                "profile {name}: vcpu ({}) exceeds maximum ({MAX_VCPU})",
                profile.vcpu
            )));
        }
        if profile.vcpu < MIN_PROFILE_VCPU {
            return Err(RunnerError::Config(format!(
                "profile {name}: vcpu ({}) is below workload-containment minimum ({MIN_PROFILE_VCPU})",
                profile.vcpu
            )));
        }
        if profile.memory_mb > MAX_MEMORY_MB {
            return Err(RunnerError::Config(format!(
                "profile {name}: memory_mb ({}) exceeds maximum ({MAX_MEMORY_MB})",
                profile.memory_mb
            )));
        }
        if profile.memory_mb < MIN_PROFILE_MEMORY_MB {
            return Err(RunnerError::Config(format!(
                "profile {name}: memory_mb ({}) is below workload-containment minimum ({MIN_PROFILE_MEMORY_MB})",
                profile.memory_mb
            )));
        }
        WorkloadResourcePolicy::for_guest_capacity(
            profile.vcpu,
            u64::from(profile.memory_mb) * 1024 * 1024,
            true,
        )
        .map_err(|error| RunnerError::Config(format!("profile {name}: {error}")))?;
        if profile.rootfs_disk_mb > MAX_DISK_MB {
            return Err(RunnerError::Config(format!(
                "profile {name}: rootfs_disk_mb ({}) exceeds maximum ({MAX_DISK_MB})",
                profile.rootfs_disk_mb
            )));
        }
        if profile.workspace_disk_mb > MAX_DISK_MB {
            return Err(RunnerError::Config(format!(
                "profile {name}: workspace_disk_mb ({}) exceeds maximum ({MAX_DISK_MB})",
                profile.workspace_disk_mb
            )));
        }
        if validate_image_artifacts {
            validate_profile_image_artifacts(name, profile, home).await?;
        }
    }

    validate_concurrency_factor(config.sandbox.concurrency_factor)?;
    Ok(())
}

impl RunnerConfig {
    /// Resolve relative paths against `config_dir` (the directory containing the YAML file).
    pub(crate) fn resolve_relative_paths(&mut self, config_dir: &Path) {
        let resolve = |p: &mut PathBuf| {
            if p.is_relative() {
                *p = config_dir.join(&*p);
            }
        };
        resolve(&mut self.base_dir);
        resolve(&mut self.ca_dir);
        resolve(&mut self.firecracker.binary);
        resolve(&mut self.firecracker.kernel);
    }

    /// Build a [`sandbox::FactoryConfig`] for a given profile.
    ///
    /// Resolves rootfs and snapshot paths from the profile's image hash
    /// using the standard content-addressed storage layout.
    pub fn factory_config(
        &self,
        profile_name: &str,
        profile: &ProfileConfig,
        home: &HomePaths,
    ) -> sandbox::FactoryConfig {
        Self::build_factory_config(
            &self.firecracker,
            &self.base_dir,
            profile_name,
            profile,
            home,
        )
    }

    /// Build a [`sandbox::FactoryConfig`] from components.
    ///
    /// Static variant of [`factory_config`](Self::factory_config) for
    /// use after `RunnerConfig` has been destructured.
    pub fn build_factory_config(
        firecracker: &FirecrackerConfig,
        base_dir: &Path,
        profile_name: &str,
        profile: &ProfileConfig,
        home: &HomePaths,
    ) -> sandbox::FactoryConfig {
        let rootfs_paths = RootfsPaths::new(home, &profile.rootfs_hash);
        let snapshot_paths = rootfs_paths.snapshot(&profile.snapshot_hash);
        sandbox::FactoryConfig {
            profile: profile_name.to_string(),
            binary_path: firecracker.binary.clone(),
            kernel_path: firecracker.kernel.clone(),
            rootfs_path: rootfs_paths.rootfs(),
            base_dir: base_dir.to_path_buf(),
            snapshot: Some(sandbox::SnapshotRef {
                output_dir: snapshot_paths.dir().to_path_buf(),
                hash: profile.snapshot_hash.clone(),
            }),
        }
    }
}

#[cfg(test)]
mod tests;
