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

    /// Canonical physical hostname used for diagnostic attribution
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

    /// Okou API URL (`OKOU_API_BACKEND_URL`)
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
                workspace_disk_mb: def.workspace_disk_mb,
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
mod tests {
    use super::*;

    fn args_with_dirname(dirname: &str) -> ConfigArgs {
        ConfigArgs {
            profile: vec!["vm0/default".into()],
            rootfs_hash: vec!["dummy".into()],
            snapshot_hash: vec!["dummy".into()],
            hostname: None,
            group: "vm0/test".into(),
            runner_dirname: dirname.into(),
            max_concurrent: 0,
            concurrency_factor: 1.0,
            api_url: "http://localhost".into(),
            token: "x".into(),
        }
    }

    fn args_with_valid_image_hashes() -> ConfigArgs {
        let mut args = args_with_dirname("runner-01");
        args.rootfs_hash =
            vec!["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into()];
        args.snapshot_hash =
            vec!["fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210".into()];
        args
    }

    async fn write_rootfs(home: &HomePaths, rootfs_hash: &str) -> runner_host::paths::RootfsPaths {
        let rootfs = runner_host::paths::RootfsPaths::new(home, rootfs_hash);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();
        rootfs
    }

    async fn write_snapshot_without_complete_marker(
        rootfs: &runner_host::paths::RootfsPaths,
        snapshot_hash: &str,
    ) {
        let snapshot = rootfs.snapshot(snapshot_hash);
        tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
        for path in snapshot.required_artifacts() {
            tokio::fs::write(path, b"snapshot").await.unwrap();
        }
    }

    async fn write_complete_snapshot(
        rootfs: &runner_host::paths::RootfsPaths,
        snapshot_hash: &str,
    ) {
        let snapshot = rootfs.snapshot(snapshot_hash);
        write_snapshot_without_complete_marker(rootfs, snapshot_hash).await;
        tokio::fs::write(
            snapshot.complete_marker(),
            sandbox_firecracker::SNAPSHOT_COMPLETE_MARKER_CONTENT,
        )
        .await
        .unwrap();
    }

    /// Asserts that `--runner-dirname` validation is wired into `run_config`.
    /// Without the validator call at the top, a malicious dirname would
    /// reach `paths.runners_dir().join(...)` and escape the base dir.
    #[tokio::test]
    async fn run_config_rejects_traversal_runner_dirname() {
        let err = run_config(args_with_dirname("../etc")).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_absolute_runner_dirname() {
        let err = run_config(args_with_dirname("/etc")).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
    }

    /// Guards against a partial wiring: if someone ever splits the
    /// validator into "leading-char only" and "charset only" halves and
    /// only calls the first, the previous two tests would still pass.
    /// This test covers a charset-only violation (uppercase) that has no
    /// traversal intent, asserting the full validator is invoked.
    #[tokio::test]
    async fn run_config_rejects_charset_violation_runner_dirname() {
        let err = run_config(args_with_dirname("V0.3.0")).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
    }

    /// Empty string is a common user bug (unset shell variable expanded
    /// into `--runner-dirname ""`). It reaches the validator because
    /// clap does not reject empty arg values on its own. Covers the
    /// `is_empty()` branch, which is short-circuited before the other
    /// rejection conditions.
    #[tokio::test]
    async fn run_config_rejects_empty_runner_dirname() {
        let err = run_config(args_with_dirname("")).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_overlong_runner_dirname() {
        let dirname = "a".repeat(runner_host::runner_dirname::MAX_NAME_BYTES + 1);
        let err = run_config(args_with_dirname(&dirname)).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
        assert!(
            msg.contains(&format!(
                "at most {} bytes",
                runner_host::runner_dirname::MAX_NAME_BYTES
            )),
            "got: {msg}"
        );
        assert!(
            !msg.contains(&dirname),
            "overlong dirname should be previewed, not echoed in full: {msg}"
        );
    }

    #[tokio::test]
    async fn run_config_rejects_invalid_hostname_before_filesystem_setup() {
        let max_length = usize::try_from(
            api_contracts::generated::constants::runners::RUNNER_HOSTNAME_MAX_LENGTH,
        )
        .unwrap();
        for hostname in [String::new(), "a".repeat(max_length + 1)] {
            let mut args = args_with_valid_image_hashes();
            args.hostname = Some(hostname);

            let err = run_config(args).await.unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("hostname"), "got: {msg}");
            assert!(
                !msg.contains("rootfs not found"),
                "hostname validation should happen before image checks: {msg}"
            );
        }
    }

    #[tokio::test]
    async fn run_config_rejects_invalid_api_url_before_filesystem_setup() {
        let mut args = args_with_valid_image_hashes();
        args.api_url = "https://user:pass@api.example.com?token=secret".into();

        let err = run_config(args).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("server.url"), "got: {msg}");
        assert!(msg.contains("credentials"), "got: {msg}");
        assert!(
            !msg.contains("user:pass") && !msg.contains("token=secret"),
            "error should not echo sensitive URL components: {msg}"
        );
        assert!(
            !msg.contains("rootfs not found"),
            "API URL validation should happen before rootfs checks: {msg}"
        );
    }

    #[tokio::test]
    async fn run_config_rejects_cleartext_remote_api_url_before_filesystem_setup() {
        let mut args = args_with_valid_image_hashes();
        args.api_url = "http://api.example.com".into();

        let err = run_config(args).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("server.url"), "got: {msg}");
        assert!(msg.contains("https"), "got: {msg}");
        assert!(!msg.contains("api.example.com"), "got: {msg}");
        assert!(
            !msg.contains("rootfs not found"),
            "API URL validation should happen before image checks: {msg}"
        );
    }

    #[tokio::test]
    async fn run_config_rejects_mismatched_profile_arg_lengths() {
        let cases = [
            (
                "rootfs_hash",
                vec!["vm0/default".into(), "vm0/default".into()],
                vec!["dummy".into()],
                vec!["dummy".into(), "dummy".into()],
            ),
            (
                "snapshot_hash",
                vec!["vm0/default".into(), "vm0/default".into()],
                vec!["dummy".into(), "dummy".into()],
                vec!["dummy".into()],
            ),
        ];

        for (field, profile, rootfs_hash, snapshot_hash) in cases {
            let mut args = args_with_dirname("runner-01");
            args.profile = profile;
            args.rootfs_hash = rootfs_hash;
            args.snapshot_hash = snapshot_hash;

            let err = run_config(args).await.unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("same number of times"),
                "{field} mismatch returned unexpected error: {msg}"
            );
        }
    }

    #[tokio::test]
    async fn run_config_rejects_empty_profile_args() {
        let mut args = args_with_dirname("runner-01");
        args.profile.clear();
        args.rootfs_hash.clear();
        args.snapshot_hash.clear();

        let err = run_config(args).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("at least once"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_duplicate_profile_args() {
        let mut args = args_with_valid_image_hashes();
        args.profile.push("vm0/default".into());
        args.rootfs_hash.push(args.rootfs_hash[0].clone());
        args.snapshot_hash.push(args.snapshot_hash[0].clone());

        let err = run_config(args).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("more than once"), "got: {msg}");
        assert!(
            !msg.contains("rootfs not found"),
            "duplicate profile validation should happen before image artifact checks: {msg}"
        );
    }

    #[tokio::test]
    async fn run_config_rejects_incomplete_snapshot_without_writing_config() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let args = args_with_valid_image_hashes();
        let config_path = home
            .runners_dir()
            .join(&args.runner_dirname)
            .join("runner.yaml");
        let rootfs_hash = args.rootfs_hash[0].clone();
        let snapshot_hash = args.snapshot_hash[0].clone();
        let rootfs = write_rootfs(&home, &rootfs_hash).await;
        write_snapshot_without_complete_marker(&rootfs, &snapshot_hash).await;

        let err = run_config_with_home(args, home).await.unwrap_err();

        let msg = err.to_string();
        assert!(msg.contains(".snapshot-complete"), "got: {msg}");
        assert!(
            !config_path.exists(),
            "runner config should not be written when snapshot validation fails"
        );
    }

    #[tokio::test]
    async fn run_config_writes_config_and_refreshes_image_mtimes() {
        use std::fs::FileTimes;
        use std::time::{Duration, SystemTime};

        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let mut args = args_with_valid_image_hashes();
        args.hostname = Some("prod-1.aws.vm3.ai".to_string());
        let config_path = home
            .runners_dir()
            .join(&args.runner_dirname)
            .join("runner.yaml");
        let rootfs_hash = args.rootfs_hash[0].clone();
        let snapshot_hash = args.snapshot_hash[0].clone();
        let rootfs = write_rootfs(&home, &rootfs_hash).await;
        write_complete_snapshot(&rootfs, &snapshot_hash).await;
        let snapshot = rootfs.snapshot(&snapshot_hash);
        let old_mtime = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        for path in [rootfs.dir(), snapshot.dir()] {
            std::fs::File::open(path)
                .unwrap()
                .set_times(FileTimes::new().set_modified(old_mtime))
                .unwrap();
        }

        run_config_with_home(args, home).await.unwrap();

        let rootfs_mtime = std::fs::metadata(rootfs.dir()).unwrap().modified().unwrap();
        assert!(
            rootfs_mtime > old_mtime,
            "runner config should refresh the selected rootfs mtime"
        );
        let snapshot_mtime = std::fs::metadata(snapshot.dir())
            .unwrap()
            .modified()
            .unwrap();
        assert!(
            snapshot_mtime > old_mtime,
            "runner config should refresh the selected snapshot mtime"
        );

        let config_content = tokio::fs::read_to_string(config_path).await.unwrap();
        let runner_config: RunnerConfig = serde_yaml_ng::from_str(&config_content).unwrap();
        let profile = runner_config.profiles.get("vm0/default").unwrap();
        assert_eq!(profile.rootfs_hash, rootfs_hash);
        assert_eq!(profile.snapshot_hash, snapshot_hash);
        assert_eq!(profile.rootfs_disk_mb, 12288);
        assert_eq!(profile.workspace_disk_mb, 16384);
        assert_eq!(runner_config.hostname.as_deref(), Some("prod-1.aws.vm3.ai"));
    }

    fn args_with_concurrency_factor(factor: f64) -> ConfigArgs {
        ConfigArgs {
            profile: vec!["vm0/default".into()],
            rootfs_hash: vec!["dummy".into()],
            snapshot_hash: vec!["dummy".into()],
            hostname: None,
            group: "vm0/test".into(),
            runner_dirname: "runner-01".into(),
            max_concurrent: 0,
            concurrency_factor: factor,
            api_url: "http://localhost".into(),
            token: "x".into(),
        }
    }

    #[tokio::test]
    async fn run_config_rejects_zero_concurrency_factor() {
        let err = run_config(args_with_concurrency_factor(0.0))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("concurrency_factor"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_negative_concurrency_factor() {
        let err = run_config(args_with_concurrency_factor(-1.0))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("concurrency_factor"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_infinite_concurrency_factor() {
        let err = run_config(args_with_concurrency_factor(f64::INFINITY))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("concurrency_factor"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_nan_concurrency_factor() {
        let err = run_config(args_with_concurrency_factor(f64::NAN))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("concurrency_factor"), "got: {msg}");
    }
}
