use std::collections::BTreeMap;

use clap::Args;

#[cfg(test)]
use crate::config::RootfsSnapshotPathsExt;
use crate::config::{
    self, DEFAULT_CONCURRENCY_FACTOR, DEFAULT_MAX_CONCURRENT, FirecrackerConfig, ProfileConfig,
    RunnerConfig, SandboxConfig, ServerConfig, validate_concurrency_factor,
};
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::profile;
use runner_host::paths::{HomePaths, touch_mtime};

#[derive(Args)]
pub struct ConfigArgs {
    /// Profile entries: --profile vm0/default --rootfs-hash abc --snapshot-hash def
    /// Can be repeated for multiple profiles.
    #[arg(long, required = true)]
    profile: Vec<String>,
    /// Rootfs hash for the preceding --profile (one per profile, in order)
    #[arg(long, required = true)]
    rootfs_hash: Vec<String>,
    /// Snapshot hash for the preceding --profile (one per profile, in order)
    #[arg(long, required = true)]
    snapshot_hash: Vec<String>,

    /// Configured hostname for diagnostic attribution and advisory locality
    #[arg(long)]
    hostname: Option<String>,
    /// Runner group in `vm0/<name>` format (e.g. "vm0/production")
    #[arg(long)]
    group: String,
    /// Runner directory name (under /var/lib/vm0-runner/runners/)
    #[arg(long)]
    runner_dirname: String,

    /// Maximum concurrent sandboxes (0 = auto-detect from host CPU/memory)
    #[arg(long, default_value_t = DEFAULT_MAX_CONCURRENT)]
    max_concurrent: usize,
    /// Overcommit factor for auto-detected concurrency (must be > 0)
    #[arg(long, default_value_t = DEFAULT_CONCURRENCY_FACTOR)]
    concurrency_factor: f64,

    /// Okou API URL (`OKOU_API_BACKEND_URL`).
    /// Must be an absolute URL without credentials, query, or fragment.
    /// HTTPS is required except for HTTP hosts normalized to localhost, IPv4 loopback
    /// (127.0.0.0/8), or IPv6 loopback (::1). Private network addresses require HTTPS.
    #[arg(long, env = "OKOU_API_BACKEND_URL", hide_env_values = true)]
    api_url: String,
    /// Runner authentication token (`OKOU_RUNNER_TOKEN`)
    #[arg(long, env = "OKOU_RUNNER_TOKEN", hide_env_values = true)]
    token: String,
}

#[cfg(test)]
impl ConfigArgs {
    pub(crate) fn api_url_for_test(&self) -> &str {
        &self.api_url
    }

    pub(crate) fn token_for_test(&self) -> &str {
        &self.token
    }
}

pub async fn run_config(args: ConfigArgs) -> RunnerResult<()> {
    let paths = HomePaths::new()?;
    run_config_with_home(args, paths).await
}

async fn run_config_with_home(args: ConfigArgs, paths: HomePaths) -> RunnerResult<()> {
    // Pure-CPU validation first — fail fast before any filesystem I/O.
    if let Some(hostname) = args.hostname.as_deref() {
        config::validate_runner_hostname(hostname)?;
    }
    crate::group::validate_or_err(&args.group)?;
    runner_host::runner_dirname::validate_or_err(&args.runner_dirname)?;
    validate_concurrency_factor(args.concurrency_factor)?;
    if args.profile.len() != args.rootfs_hash.len()
        || args.profile.len() != args.snapshot_hash.len()
    {
        return Err(RunnerError::Config(
            "--profile, --rootfs-hash, and --snapshot-hash must be specified the same number of times".into(),
        ));
    }
    if args.profile.is_empty() {
        return Err(RunnerError::Config(
            "--profile, --rootfs-hash, and --snapshot-hash must be specified at least once".into(),
        ));
    }
    for profile_name in &args.profile {
        profile::validate_or_err(profile_name)?;
    }
    for h in args.rootfs_hash.iter().chain(args.snapshot_hash.iter()) {
        crate::image_hash::validate_or_err(h)?;
    }
    let api_url = config::normalize_api_base_url(&args.api_url)?;

    // Build profiles map.
    let mut profiles = BTreeMap::new();
    for (i, profile_name) in args.profile.iter().enumerate() {
        if profiles.contains_key(profile_name) {
            return Err(RunnerError::Config(format!(
                "--profile {profile_name} must not be specified more than once"
            )));
        }
        let def = profile::get(profile_name)?;
        // Length equality is validated above, so these indices are safe.
        let rootfs_hash = args
            .rootfs_hash
            .get(i)
            .ok_or_else(|| RunnerError::Internal(format!("missing rootfs_hash at index {i}")))?;
        let snapshot_hash = args
            .snapshot_hash
            .get(i)
            .ok_or_else(|| RunnerError::Internal(format!("missing snapshot_hash at index {i}")))?;

        profiles.insert(
            profile_name.clone(),
            ProfileConfig {
                rootfs_hash: rootfs_hash.clone(),
                snapshot_hash: snapshot_hash.clone(),
                vcpu: def.vcpu,
                memory_mb: def.memory_mb,
                rootfs_disk_mb: def.rootfs_disk_mb,
                home_disk_mb: def.home_disk_mb,
            },
        );
    }

    let runner_dir = paths.runners_dir().join(&args.runner_dirname);
    let runner_config = RunnerConfig {
        hostname: args.hostname,
        group: args.group,
        base_dir: runner_dir.clone(),
        ca_dir: paths.ca_dir(),
        firecracker: FirecrackerConfig {
            binary: paths.firecracker_bin(FIRECRACKER_VERSION),
            kernel: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        },
        profiles,
        sandbox: SandboxConfig {
            max_concurrent: args.max_concurrent,
            concurrency_factor: args.concurrency_factor,
            ..SandboxConfig::default()
        },
        server: Some(ServerConfig {
            url: api_url,
            token: args.token,
        }),
    };

    let image_artifact_guards =
        config::lock_and_validate_runner_image_artifacts(&runner_config.profiles, &paths).await?;

    config::generate(&runner_config).await?;
    for (_, profile_paths) in image_artifact_guards.profile_paths() {
        touch_mtime(profile_paths.rootfs_paths().dir());
        touch_mtime(profile_paths.snapshot_paths().dir());
    }
    let config_path = runner_dir.join("runner.yaml");
    tracing::info!("config written to {}", config_path.display());

    Ok(())
}

#[cfg(test)]
mod tests;
