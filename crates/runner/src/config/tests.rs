use super::*;

/// 64 lowercase hex chars — matches `Sha256::digest(...).hex_encode()`.
const TEST_ROOTFS_HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SNAPSHOT_HASH: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const OTHER_ROOTFS_HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_SNAPSHOT_HASH: &str =
    "2222222222222222222222222222222222222222222222222222222222222222";

async fn assert_rootfs_lock_held(home: &HomePaths, hash: &str) {
    let error = runner_host::lock::try_acquire(home.rootfs_lock(hash))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("lock is already held"),
        "unexpected rootfs lock error: {error}"
    );
}

async fn assert_rootfs_lock_released(home: &HomePaths, hash: &str) {
    drop(
        runner_host::lock::try_acquire(home.rootfs_lock(hash))
            .await
            .unwrap(),
    );
}

struct ConfigFixture {
    dir: tempfile::TempDir,
    firecracker: std::path::PathBuf,
    kernel: std::path::PathBuf,
    home: HomePaths,
}

impl ConfigFixture {
    async fn new() -> Self {
        Self::with_artifacts(&[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await
    }

    async fn without_image_artifacts() -> Self {
        Self::with_artifacts(&[]).await
    }

    async fn with_artifacts(hashes: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let firecracker = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for path in [&firecracker, &kernel] {
            tokio::fs::write(path, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), hashes).await;

        Self {
            dir,
            firecracker,
            kernel,
            home,
        }
    }

    fn path(&self) -> &std::path::Path {
        self.dir.path()
    }

    fn config_path(&self) -> std::path::PathBuf {
        self.path().join("runner.yaml")
    }

    fn yaml(&self, body: &str) -> String {
        self.yaml_with_group("test/group", body)
    }

    fn yaml_with_group(&self, group: &str, body: &str) -> String {
        format!(
            r#"
group: {group}
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {firecracker}
  kernel: {kernel}
{body}"#,
            base_dir = self.path().display(),
            ca_dir = self.path().display(),
            firecracker = self.firecracker.display(),
            kernel = self.kernel.display(),
        )
    }

    fn yaml_with_default_profile(&self, extra: &str) -> String {
        self.yaml_with_profile("vm0/default", default_profile_config(), extra)
    }

    fn yaml_with_profile(&self, name: &str, profile: ProfileConfig, extra: &str) -> String {
        let mut profiles = BTreeMap::new();
        profiles.insert(name.to_string(), profile);
        let profiles_yaml = serde_yaml_ng::to_string(&profiles).unwrap();
        let profiles_yaml = profiles_yaml
            .strip_prefix("---\n")
            .unwrap_or(&profiles_yaml);
        let mut indented_profiles = String::new();
        for line in profiles_yaml.lines() {
            indented_profiles.push_str("  ");
            indented_profiles.push_str(line);
            indented_profiles.push('\n');
        }
        self.yaml(&format!("profiles:\n{indented_profiles}{extra}"))
    }

    async fn write_config(&self, yaml: &str) -> std::path::PathBuf {
        let config_path = self.config_path();
        tokio::fs::write(&config_path, yaml).await.unwrap();
        config_path
    }

    async fn load_config(
        &self,
        yaml: &str,
        validate_image_artifacts: bool,
    ) -> RunnerResult<RunnerConfig> {
        self.load_config_with_home(yaml, &self.home, validate_image_artifacts)
            .await
    }

    async fn load_config_with_home(
        &self,
        yaml: &str,
        home: &HomePaths,
        validate_image_artifacts: bool,
    ) -> RunnerResult<RunnerConfig> {
        let config_path = self.write_config(yaml).await;
        load_with_home(&config_path, home, validate_image_artifacts).await
    }
}

/// Create a HomePaths rooted in a temp dir and populate fake image files
/// for the given (rootfs_hash, snapshot_hash) pairs so config validation passes.
async fn test_home_with_artifacts(dir: &std::path::Path, hashes: &[(&str, &str)]) -> HomePaths {
    let home = HomePaths::with_root(dir.join("vm0-runner"));
    for &(rootfs_hash, snapshot_hash) in hashes {
        let rootfs = RootfsPaths::new(&home, rootfs_hash);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
        if !snapshot_hash.is_empty() {
            let snapshot = rootfs.snapshot(snapshot_hash);
            tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
            for path in snapshot.required_artifacts() {
                tokio::fs::write(&path, b"").await.unwrap();
            }
            tokio::fs::write(
                snapshot.complete_marker(),
                sandbox_firecracker::SNAPSHOT_COMPLETE_MARKER_CONTENT,
            )
            .await
            .unwrap();
        }
    }
    home
}

fn make_profiles() -> BTreeMap<String, ProfileConfig> {
    let mut profiles = BTreeMap::new();
    profiles.insert("vm0/default".into(), default_profile_config());
    profiles
}

fn default_profile_config() -> ProfileConfig {
    ProfileConfig {
        rootfs_hash: TEST_ROOTFS_HASH.into(),
        snapshot_hash: TEST_SNAPSHOT_HASH.into(),
        vcpu: 2,
        memory_mb: 4096,
        rootfs_disk_mb: 8192,
        workspace_disk_mb: 16384,
    }
}

#[cfg(unix)]
fn mode_of(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[track_caller]
fn assert_invalid_api_base_url(value: &str, expected: &str) {
    let error = normalize_api_base_url(value).unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("server.url"),
        "error should identify server.url, got: {message}"
    );
    assert!(
        message.contains(expected),
        "error should mention {expected}, got: {message}"
    );
    assert!(
        !message.contains(value),
        "error should not echo the raw URL: {message}"
    );
}

#[test]
fn normalize_api_base_url_accepts_http_https_and_preserves_path_prefix() {
    let cases = [
        ("https://api.example.com", "https://api.example.com"),
        ("https://api.example.com/", "https://api.example.com"),
        ("http://localhost:3000/api/", "http://localhost:3000/api"),
        ("http://LOCALHOST.:3000/api/", "http://localhost:3000/api"),
        ("http://127.0.0.2:8080/base/", "http://127.0.0.2:8080/base"),
        ("https://faß.de/base", "https://xn--fa-hia.de/base"),
        ("https://xn--fa-hia.de/base", "https://xn--fa-hia.de/base"),
        (
            "https://api。example.com.:8443/base/",
            "https://api.example.com:8443/base",
        ),
        (
            "https://api.example.com/prefix/v1",
            "https://api.example.com/prefix/v1",
        ),
        ("http://[::1]:8080/base/", "http://[::1]:8080/base"),
        (
            "https://[2001:0db8:0:0:0:0:0:1]:8443/base",
            "https://[2001:db8::1]:8443/base",
        ),
    ];

    for (input, expected) in cases {
        assert_eq!(normalize_api_base_url(input).unwrap(), expected);
    }
}

#[test]
fn normalize_api_base_url_rejects_cleartext_remote_hosts() {
    for input in [
        "http://api.example.com",
        "http://localhost.example.com",
        "http://10.0.0.5:3000",
        "http://192.0.2.10:8080/base",
        "http://[2001:db8::1]:8080/base",
    ] {
        assert_invalid_api_base_url(input, "https");
    }
}

#[test]
fn normalize_api_base_url_rejects_sensitive_or_non_base_components() {
    let cases = [
        ("https://user:pass@api.example.com", "credentials"),
        ("https://@api.example.com", "credentials"),
        ("https://api.example.com?token=secret", "query"),
        ("https://api.example.com#access-token", "fragment"),
        ("ftp://api.example.com", "http or https"),
        ("https://", "absolute http(s) URL"),
        ("api.example.com", "absolute http(s) URL"),
        (
            "https://ＦＯＯ.example.com",
            "unsafe IDNA compatibility mappings",
        ),
        ("http://127.1", "canonical IPv4"),
    ];

    for (input, expected) in cases {
        assert_invalid_api_base_url(input, expected);
    }
}

#[tokio::test]
async fn diagnostic_config_read_accepts_regular_yaml() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("runner.yaml");
    tokio::fs::write(&config, "name: test\n").await.unwrap();

    let content = read_diagnostic_config_to_string(&config).await.unwrap();

    assert_eq!(content.as_deref(), Some("name: test\n"));
}

#[cfg(unix)]
#[tokio::test]
async fn diagnostic_config_read_rejects_symlink() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.yaml");
    let link = dir.path().join("runner.yaml");
    tokio::fs::write(&target, "name: test\n").await.unwrap();
    symlink(&target, &link).unwrap();

    let error = read_diagnostic_config_to_string(&link).await.unwrap_err();

    assert!(
        error.to_string().contains("open state file"),
        "unexpected error: {error}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn diagnostic_config_read_rejects_directory() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().join("runner.yaml");
    tokio::fs::create_dir(&config_dir).await.unwrap();

    let error = read_diagnostic_config_to_string(&config_dir)
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("not a regular state file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn diagnostic_config_read_rejects_oversized_file() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("runner.yaml");
    tokio::fs::write(
        &config,
        vec![b'a'; (DIAGNOSTIC_CONFIG_MAX_BYTES + 1) as usize],
    )
    .await
    .unwrap();

    let error = read_diagnostic_config_to_string(&config).await.unwrap_err();

    assert!(
        error
            .to_string()
            .contains(&format!("exceeds {DIAGNOSTIC_CONFIG_MAX_BYTES} bytes")),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn load_config_with_profiles() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_group(
        "vm0/prod",
        &format!(
            r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
sandbox:
  max_concurrent: 8
  concurrency_factor: 2.0
server:
  url: https://api.example.com
  token: secret
"#,
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        ),
    );

    let config = fixture.load_config(&yaml, true).await.unwrap();
    assert_eq!(config.hostname, None);
    assert_eq!(config.profiles.len(), 1);
    let default = &config.profiles["vm0/default"];
    assert_eq!(default.vcpu, 2);
    assert_eq!(default.rootfs_hash, TEST_ROOTFS_HASH);
    assert_eq!(default.rootfs_disk_mb, 8192);
    assert_eq!(default.workspace_disk_mb, 16384);
    assert_eq!(config.sandbox.max_concurrent, 8);
    assert!((config.sandbox.concurrency_factor - 2.0).abs() < f64::EPSILON);
    let server = config.server.unwrap();
    assert_eq!(server.url, "https://api.example.com");
    assert_eq!(server.token, "secret");
}

#[tokio::test]
async fn load_preserves_optional_hostname() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile("hostname: prod-1.aws.vm3.ai\n");

    let config = fixture.load_config(&yaml, true).await.unwrap();

    assert_eq!(config.hostname.as_deref(), Some("prod-1.aws.vm3.ai"));
}

#[tokio::test]
async fn load_enforces_api_hostname_length_semantics() {
    let fixture = ConfigFixture::new().await;
    let accepted = format!("{}a", "😀".repeat(127));
    let accepted_yaml = fixture.yaml_with_default_profile(&format!(
        "hostname: {}\n",
        serde_yaml_ng::to_string(&accepted).unwrap().trim()
    ));
    let config = fixture.load_config(&accepted_yaml, true).await.unwrap();
    assert_eq!(config.hostname.as_deref(), Some(accepted.as_str()));

    for rejected in [String::new(), "😀".repeat(128)] {
        let rejected_yaml = fixture.yaml_with_default_profile(&format!(
            "hostname: {}\n",
            serde_yaml_ng::to_string(&rejected).unwrap().trim()
        ));
        let err = fixture.load_config(&rejected_yaml, true).await.unwrap_err();
        assert!(err.to_string().contains("hostname"), "got: {err}");
    }
}

#[tokio::test]
async fn load_normalizes_server_url() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile(
        r#"server:
  url: https://api.example.com/prefix/
  token: secret
"#,
    );

    let config = fixture.load_config(&yaml, true).await.unwrap();
    let server = config.server.unwrap();
    assert_eq!(server.url, "https://api.example.com/prefix");
}

#[tokio::test]
async fn load_for_start_applies_api_url_override_before_server_url_validation() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile(
        r#"server:
  url: "https://user:pass@stale.example.com?token=secret#frag"
  token: secret
"#,
    );
    let config_path = fixture.write_config(&yaml).await;

    let config = load_for_start(&config_path, Some("https://api.example.com/prefix/"))
        .await
        .unwrap();

    let server = config.server.unwrap();
    assert_eq!(server.url, "https://api.example.com/prefix");
    assert_eq!(server.token, "secret");
}

#[tokio::test]
async fn load_for_start_rejects_cleartext_remote_api_url_override() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile(
        r#"server:
  url: https://api.example.com
  token: secret
"#,
    );
    let config_path = fixture.write_config(&yaml).await;

    let error = load_for_start(&config_path, Some("http://api.example.com"))
        .await
        .unwrap_err();
    let message = error.to_string();

    assert!(message.contains("https"), "got: {message}");
    assert!(!message.contains("api.example.com"), "got: {message}");
}

#[tokio::test]
async fn load_for_start_without_api_url_override_uses_runner_yaml() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile(
        r#"server:
  url: https://yaml-api.example.com/prefix/
  token: secret
"#,
    );
    let config_path = fixture.write_config(&yaml).await;

    let config = load_for_start(&config_path, None).await.unwrap();

    let server = config.server.unwrap();
    assert_eq!(server.url, "https://yaml-api.example.com/prefix");
    assert_eq!(server.token, "secret");
}

#[tokio::test]
async fn load_rejects_server_url_with_sensitive_components() {
    let fixture = ConfigFixture::new().await;
    let cases = [
        ("https://user:pass@api.example.com", "credentials"),
        ("https://api.example.com?token=secret", "query"),
        ("https://api.example.com#access-token", "fragment"),
    ];

    for (url, expected) in cases {
        let yaml = fixture.yaml_with_default_profile(&format!(
            r#"server:
  url: "{url}"
  token: secret
"#
        ));

        let error = fixture.load_config(&yaml, true).await.unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains(expected),
            "expected {expected} error for {url}, got: {message}"
        );
        assert!(
            !message.contains(url),
            "error should not echo raw URL for {url}: {message}"
        );
    }
}

#[tokio::test]
async fn load_rejects_legacy_disk_mb_without_split_disk_fields() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 12288
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(
        err.to_string().contains("rootfs_disk_mb") || err.to_string().contains("workspace_disk_mb"),
        "unexpected error: {err}"
    );
}

#[tokio::test]
async fn load_defaults_for_sandbox() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile("");

    let config = fixture.load_config(&yaml, true).await.unwrap();
    assert_eq!(config.sandbox.max_concurrent, DEFAULT_MAX_CONCURRENT);
    assert!((config.sandbox.concurrency_factor - DEFAULT_CONCURRENCY_FACTOR).abs() < f64::EPSILON);
    assert!(config.server.is_none());
}

#[tokio::test]
async fn load_rejects_empty_profiles() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml("profiles: {}\n");

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(
        err.to_string().contains("profiles must not be empty"),
        "got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_invalid_profile_name() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile("bad-name", default_profile_config(), "");

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(
        err.to_string().contains("invalid profile name"),
        "got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_invalid_rootfs_hash() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    // `../etc` would escape `images_dir()` if joined unchecked. The
    // validator must reject this at config-load time, before any
    // filesystem I/O on the bad path.
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            rootfs_hash: "../etc".into(),
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("invalid image hash"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_invalid_snapshot_hash() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            snapshot_hash: "../etc".into(),
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("invalid image hash"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_zero_vcpu_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            vcpu: 0,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("non-zero"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_zero_memory_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            memory_mb: 0,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("non-zero"), "got: {err}");
}

#[tokio::test]
async fn load_accepts_calibrated_minimum_profile() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            vcpu: 1,
            memory_mb: 1024,
            ..default_profile_config()
        },
        "",
    );

    let config = fixture.load_config(&yaml, true).await.unwrap();
    assert_eq!(config.profiles["vm0/default"].vcpu, 1);
    assert_eq!(config.profiles["vm0/default"].memory_mb, 1024);
}

#[tokio::test]
async fn load_rejects_memory_below_calibrated_minimum() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            memory_mb: 1023,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(
        err.to_string()
            .contains("below workload-containment minimum (1024)"),
        "got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_arithmetic_only_memory_remainder() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            memory_mb: 641,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(
        err.to_string()
            .contains("below workload-containment minimum (1024)"),
        "got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_zero_rootfs_disk_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            rootfs_disk_mb: 0,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("non-zero"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_zero_workspace_disk_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            workspace_disk_mb: 0,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("non-zero"), "got: {err}");
}

#[tokio::test]
async fn load_accepts_vcpu_at_maximum() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            vcpu: 1024,
            ..default_profile_config()
        },
        "",
    );

    // vcpu == MAX_VCPU should be accepted (validation uses >, not >=)
    let result = fixture.load_config(&yaml, true).await;
    assert!(result.is_ok(), "got: {}", result.unwrap_err());
}

#[tokio::test]
async fn load_rejects_excessive_vcpu_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            vcpu: 2048,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_excessive_memory_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            memory_mb: 2000000,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_excessive_rootfs_disk_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            rootfs_disk_mb: 2000000,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_excessive_workspace_disk_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_profile(
        "vm0/default",
        ProfileConfig {
            workspace_disk_mb: 2000000,
            ..default_profile_config()
        },
        "",
    );

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_incomplete_image() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    // Create rootfs.ext4 but NO snapshot files — validation should fail.
    let home = HomePaths::with_root(fixture.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();

    let yaml = fixture.yaml_with_default_profile("");

    let err = fixture
        .load_config_with_home(&yaml, &home, true)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "expected missing file error, got: {err}"
    );
}

#[tokio::test]
async fn load_defers_missing_image_checks() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_default_profile("");
    let config_path = fixture.write_config(&yaml).await;

    let config = load(&config_path).await.unwrap();
    let profile = config.profiles.get("vm0/default").unwrap();
    assert_eq!(profile.rootfs_hash, TEST_ROOTFS_HASH);
    assert_eq!(profile.snapshot_hash, TEST_SNAPSHOT_HASH);
}

#[tokio::test]
async fn load_defers_malformed_complete_marker_check() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    let home = HomePaths::with_root(fixture.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in snapshot.required_artifacts() {
        tokio::fs::write(&path, b"").await.unwrap();
    }
    tokio::fs::write(snapshot.complete_marker(), b"partial marker")
        .await
        .unwrap();

    let yaml = fixture.yaml_with_default_profile("");

    let config = fixture
        .load_config_with_home(&yaml, &home, false)
        .await
        .unwrap();
    let profile = config.profiles.get("vm0/default").unwrap();
    let err = validate_profile_image_artifacts("vm0/default", profile, &home)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("complete marker") && err.to_string().contains("invalid"),
        "expected deferred invalid complete marker error, got: {err}"
    );
}

#[tokio::test]
async fn validate_profile_image_artifacts_rejects_missing_cow_bitmap() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in [snapshot.snapshot(), snapshot.memory(), snapshot.cow()] {
        tokio::fs::write(&path, b"").await.unwrap();
    }
    tokio::fs::write(
        snapshot.complete_marker(),
        sandbox_firecracker::SNAPSHOT_COMPLETE_MARKER_CONTENT,
    )
    .await
    .unwrap();

    let profile = ProfileConfig {
        rootfs_hash: TEST_ROOTFS_HASH.into(),
        snapshot_hash: TEST_SNAPSHOT_HASH.into(),
        vcpu: 2,
        memory_mb: 4096,
        rootfs_disk_mb: 8192,
        workspace_disk_mb: 16384,
    };
    let err = validate_profile_image_artifacts("vm0/default", &profile, &home)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("cow.img.bitmap"),
        "expected missing cow bitmap error, got: {err}"
    );
}

#[tokio::test]
async fn lock_and_validate_profile_image_artifacts_rejects_directory_snapshot_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let home =
        test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;
    let snapshot = RootfsPaths::new(&home, TEST_ROOTFS_HASH).snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::remove_file(snapshot.snapshot()).await.unwrap();
    tokio::fs::create_dir(snapshot.snapshot()).await.unwrap();

    let err = match lock_and_validate_profile_image_artifacts(
        "vm0/default",
        &default_profile_config(),
        &home,
    )
    .await
    {
        Ok(_) => panic!("expected directory snapshot artifact error"),
        Err(err) => err,
    };
    let message = err.to_string();
    assert!(
        message.contains("profile vm0/default snapshot"),
        "got: {err}"
    );
    assert!(message.contains("not a regular file"), "got: {err}");
    assert!(message.contains("snapshot.bin"), "got: {err}");
}

#[tokio::test]
async fn lock_and_validate_profile_image_artifacts_rejects_symlink_snapshot_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let home =
        test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;
    let snapshot = RootfsPaths::new(&home, TEST_ROOTFS_HASH).snapshot(TEST_SNAPSHOT_HASH);
    let target = dir.path().join("snapshot-target.bin");
    tokio::fs::write(&target, b"snapshot").await.unwrap();
    tokio::fs::remove_file(snapshot.snapshot()).await.unwrap();
    std::os::unix::fs::symlink(&target, snapshot.snapshot()).unwrap();

    let err = match lock_and_validate_profile_image_artifacts(
        "vm0/default",
        &default_profile_config(),
        &home,
    )
    .await
    {
        Ok(_) => panic!("expected symlink snapshot artifact error"),
        Err(err) => err,
    };
    let message = err.to_string();
    assert!(
        message.contains("profile vm0/default snapshot"),
        "got: {err}"
    );
    assert!(message.contains("not a regular file"), "got: {err}");
    assert!(message.contains("snapshot.bin"), "got: {err}");
}

#[tokio::test]
async fn lock_and_validate_profile_image_artifacts_holds_resource_locks() {
    let dir = tempfile::tempdir().unwrap();
    let home =
        test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;
    let profile = default_profile_config();

    let guard = lock_and_validate_profile_image_artifacts("vm0/default", &profile, &home)
        .await
        .unwrap();

    assert_rootfs_lock_held(&home, TEST_ROOTFS_HASH).await;

    let snapshot_err = runner_host::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
        .await
        .unwrap_err();
    assert!(
        snapshot_err.to_string().contains("lock is already held"),
        "got: {snapshot_err}"
    );

    drop(guard);
    assert_rootfs_lock_released(&home, TEST_ROOTFS_HASH).await;
    let released_lock = runner_host::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
        .await
        .unwrap();
    drop(released_lock);
}

#[tokio::test]
async fn lock_and_validate_runner_image_artifacts_releases_locks_on_validation_error() {
    let dir = tempfile::tempdir().unwrap();
    let home =
        test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;
    let snapshot = RootfsPaths::new(&home, TEST_ROOTFS_HASH).snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::remove_file(snapshot.cow_bitmap()).await.unwrap();
    let profiles = make_profiles();

    let err = match lock_and_validate_runner_image_artifacts(&profiles, &home).await {
        Ok(_) => panic!("expected missing cow bitmap error"),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("cow.img.bitmap"),
        "expected missing cow bitmap error, got: {err}"
    );

    assert_rootfs_lock_released(&home, TEST_ROOTFS_HASH).await;
    let snapshot_lock = runner_host::lock::try_acquire(home.snapshot_lock(TEST_SNAPSHOT_HASH))
        .await
        .unwrap();
    drop(snapshot_lock);
}

#[tokio::test]
async fn lock_and_validate_runner_image_artifacts_rejects_empty_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("vm0-runner"));
    let profiles = BTreeMap::new();

    let err = match lock_and_validate_runner_image_artifacts(&profiles, &home).await {
        Ok(_) => panic!("expected empty profiles error"),
        Err(err) => err,
    };

    assert!(
        err.to_string().contains("profiles must not be empty"),
        "got: {err}"
    );
}

#[tokio::test]
async fn lock_and_validate_runner_image_artifacts_holds_all_resource_locks() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home_with_artifacts(
        dir.path(),
        &[
            (TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH),
            (OTHER_ROOTFS_HASH, OTHER_SNAPSHOT_HASH),
        ],
    )
    .await;
    let mut other_profile = default_profile_config();
    other_profile.rootfs_hash = OTHER_ROOTFS_HASH.into();
    other_profile.snapshot_hash = OTHER_SNAPSHOT_HASH.into();
    let mut profiles = BTreeMap::new();
    profiles.insert("vm0/default".to_string(), default_profile_config());
    profiles.insert("vm0/other".to_string(), other_profile);

    let guard = lock_and_validate_runner_image_artifacts(&profiles, &home)
        .await
        .unwrap();

    for (rootfs_hash, snapshot_hash) in [
        (TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH),
        (OTHER_ROOTFS_HASH, OTHER_SNAPSHOT_HASH),
    ] {
        assert_rootfs_lock_held(&home, rootfs_hash).await;
        let snapshot_err = runner_host::lock::try_acquire(home.snapshot_lock(snapshot_hash))
            .await
            .unwrap_err();
        assert!(
            snapshot_err.to_string().contains("lock is already held"),
            "got: {snapshot_err}"
        );
    }

    drop(guard);
    for (rootfs_hash, snapshot_hash) in [
        (TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH),
        (OTHER_ROOTFS_HASH, OTHER_SNAPSHOT_HASH),
    ] {
        assert_rootfs_lock_released(&home, rootfs_hash).await;
        let released_lock = runner_host::lock::try_acquire(home.snapshot_lock(snapshot_hash))
            .await
            .unwrap();
        drop(released_lock);
    }
}

#[tokio::test]
async fn load_rejects_snapshot_without_complete_marker() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    let home = HomePaths::with_root(fixture.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in snapshot.required_artifacts() {
        tokio::fs::write(&path, b"").await.unwrap();
    }

    let yaml = fixture.yaml_with_default_profile("");

    let err = fixture
        .load_config_with_home(&yaml, &home, true)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains(".snapshot-complete"),
        "expected missing complete marker error, got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_snapshot_with_malformed_complete_marker() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    let home = HomePaths::with_root(fixture.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in snapshot.required_artifacts() {
        tokio::fs::write(&path, b"").await.unwrap();
    }
    tokio::fs::write(snapshot.complete_marker(), b"partial marker")
        .await
        .unwrap();

    let yaml = fixture.yaml_with_default_profile("");

    let err = fixture
        .load_config_with_home(&yaml, &home, true)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("complete marker") && err.to_string().contains("invalid"),
        "expected invalid complete marker error, got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_invalid_concurrency_factor() {
    let fixture = ConfigFixture::new().await;

    for bad_value in ["0.0", "-1.0", ".nan", ".inf", "-.inf"] {
        let yaml = fixture.yaml_with_default_profile(&format!(
            r#"sandbox:
  concurrency_factor: {bad_value}
"#
        ));

        let err = fixture.load_config(&yaml, true).await.unwrap_err();
        assert!(
            err.to_string().contains("concurrency_factor"),
            "expected concurrency_factor error for {bad_value}, got: {err}"
        );
    }
}

#[tokio::test]
async fn generate_then_load_round_trip() {
    let fixture = ConfigFixture::new().await;
    let runner_dir = fixture.path().join("my-runner");
    let config = RunnerConfig {
        hostname: Some("prod-1.aws.vm3.ai".into()),
        group: "vm0/prod".into(),
        base_dir: runner_dir.clone(),
        ca_dir: fixture.path().to_path_buf(),
        firecracker: FirecrackerConfig {
            binary: fixture.firecracker.clone(),
            kernel: fixture.kernel.clone(),
        },
        profiles: make_profiles(),
        sandbox: SandboxConfig {
            max_concurrent: 8,
            concurrency_factor: 2.0,
            ..SandboxConfig::default()
        },
        server: Some(ServerConfig {
            url: "https://api.example.com".into(),
            token: "secret".into(),
        }),
    };

    generate(&config).await.unwrap();

    let config_path = runner_dir.join("runner.yaml");
    let generated = tokio::fs::read_to_string(&config_path).await.unwrap();
    assert!(generated.contains("rootfs_disk_mb: 8192"));
    assert!(generated.contains("workspace_disk_mb: 16384"));
    assert!(
        generated
            .lines()
            .all(|line| !line.trim_start().starts_with("disk_mb:"))
    );
    #[cfg(unix)]
    {
        assert_eq!(mode_of(&runner_dir), 0o700);
        assert_eq!(mode_of(&config_path), 0o600);
    }

    let loaded = load_with_home(&config_path, &fixture.home, true)
        .await
        .unwrap();
    assert_eq!(loaded, config);
}

#[cfg(unix)]
#[tokio::test]
async fn generate_tightens_existing_runner_dir_and_config_file() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = ConfigFixture::new().await;
    let runner_dir = fixture.path().join("my-runner");
    tokio::fs::create_dir_all(&runner_dir).await.unwrap();
    std::fs::set_permissions(&runner_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_path = runner_dir.join("runner.yaml");
    tokio::fs::write(&config_path, "server:\n  token: old\n")
        .await
        .unwrap();
    std::fs::set_permissions(&config_path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let config = RunnerConfig {
        hostname: None,
        group: "vm0/prod".into(),
        base_dir: runner_dir.clone(),
        ca_dir: fixture.path().to_path_buf(),
        firecracker: FirecrackerConfig {
            binary: fixture.firecracker.clone(),
            kernel: fixture.kernel.clone(),
        },
        profiles: make_profiles(),
        sandbox: SandboxConfig::default(),
        server: Some(ServerConfig {
            url: "https://api.example.com".into(),
            token: "secret".into(),
        }),
    };

    generate(&config).await.unwrap();

    assert_eq!(mode_of(&runner_dir), 0o700);
    assert_eq!(mode_of(&config_path), 0o600);
    let loaded = load_with_home(&config_path, &fixture.home, true)
        .await
        .unwrap();
    assert_eq!(loaded, config);
}

#[tokio::test]
async fn load_resolves_relative_paths() {
    let dir = tempfile::tempdir().unwrap();

    let sub = dir.path().join("artifacts");
    tokio::fs::create_dir_all(&sub).await.unwrap();
    for name in ["firecracker", "vmlinux"] {
        tokio::fs::write(sub.join(name), b"").await.unwrap();
    }
    let home =
        test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

    let yaml = format!(
        r#"
group: test/group
base_dir: my-runner
ca_dir: artifacts
firecracker:
  binary: artifacts/firecracker
  kernel: artifacts/vmlinux
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    );

    let config_path = dir.path().join("runner.yaml");
    tokio::fs::write(&config_path, yaml).await.unwrap();

    let config = load_with_home(&config_path, &home, true).await.unwrap();

    assert!(config.base_dir.is_absolute());
    assert_eq!(config.base_dir, dir.path().join("my-runner"));
    assert_eq!(config.ca_dir, sub);
    assert_eq!(config.firecracker.binary, sub.join("firecracker"));
    assert_eq!(config.firecracker.kernel, sub.join("vmlinux"));
}

#[test]
fn factory_config_resolves_paths() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());

    let config = RunnerConfig {
        hostname: None,
        group: "test/group".into(),
        base_dir: dir.path().join("runner"),
        ca_dir: dir.path().join("ca"),
        firecracker: FirecrackerConfig {
            binary: dir.path().join("firecracker"),
            kernel: dir.path().join("vmlinux"),
        },
        profiles: make_profiles(),
        sandbox: SandboxConfig::default(),
        server: None,
    };

    let profile = &config.profiles["vm0/default"];
    let fc = config.factory_config("vm0/default", profile, &home);

    assert_eq!(fc.binary_path, dir.path().join("firecracker"));
    assert_eq!(fc.kernel_path, dir.path().join("vmlinux"));
    let rootfs_paths = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    assert_eq!(fc.rootfs_path, rootfs_paths.rootfs());
    assert_eq!(fc.profile, "vm0/default");
    let snap = fc.snapshot.unwrap();
    assert_eq!(snap.hash, TEST_SNAPSHOT_HASH);
    let snapshot_paths = RootfsPaths::new(&home, TEST_ROOTFS_HASH).snapshot(TEST_SNAPSHOT_HASH);
    assert_eq!(snap.output_dir, snapshot_paths.dir().to_path_buf());
}

#[tokio::test]
async fn idle_pool_config_round_trip() {
    let fixture = ConfigFixture::new().await;
    let runner_dir = fixture.path().join("my-runner");
    let config = RunnerConfig {
        hostname: None,
        group: "vm0/prod".into(),
        base_dir: runner_dir.clone(),
        ca_dir: fixture.path().to_path_buf(),
        firecracker: FirecrackerConfig {
            binary: fixture.firecracker.clone(),
            kernel: fixture.kernel.clone(),
        },
        profiles: make_profiles(),
        sandbox: SandboxConfig {
            max_concurrent: 4,
            concurrency_factor: 1.5,
            max_idle: 10,
        },
        server: None,
    };

    generate(&config).await.unwrap();

    let loaded = load_with_home(&runner_dir.join("runner.yaml"), &fixture.home, true)
        .await
        .unwrap();
    assert_eq!(loaded.sandbox.max_idle, 10);
    assert_eq!(loaded, config);
}

#[tokio::test]
async fn idle_pool_defaults_when_omitted() {
    // YAML without any idle pool fields
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile("");

    let config = fixture.load_config(&yaml, true).await.unwrap();
    assert_eq!(config.sandbox.max_idle, 0);
}
