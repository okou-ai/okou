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

async fn write_complete_snapshot(rootfs: &runner_host::paths::RootfsPaths, snapshot_hash: &str) {
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
    let max_length =
        usize::try_from(api_contracts::generated::constants::runners::RUNNER_HOSTNAME_MAX_LENGTH)
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
    assert_eq!(profile.home_disk_mb, 24576);
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
