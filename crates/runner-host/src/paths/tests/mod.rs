use super::*;

#[test]
fn home_image_identity_binds_every_partition_without_separator_ambiguity() {
    let key = HomeImageCacheKey {
        cache_scope: "group",
        profile_name: "vm0/default",
        reuse_key: "thread",
        drive_layout: HOME_DRIVE_LAYOUT,
        image_size_bytes: 24 * 1024 * 1024 * 1024,
    };
    let digest = key.digest();
    for other in [
        HomeImageCacheKey {
            cache_scope: "other",
            ..key
        },
        HomeImageCacheKey {
            profile_name: "other",
            ..key
        },
        HomeImageCacheKey {
            reuse_key: "other",
            ..key
        },
        HomeImageCacheKey {
            drive_layout: "other-layout",
            ..key
        },
        HomeImageCacheKey {
            image_size_bytes: key.image_size_bytes + 1,
            ..key
        },
    ] {
        assert_ne!(digest, other.digest());
    }
    assert_ne!(
        HomeImageCacheKey {
            cache_scope: "a\0b",
            profile_name: "c",
            ..key
        }
        .digest(),
        HomeImageCacheKey {
            cache_scope: "a",
            profile_name: "b\0c",
            ..key
        }
        .digest()
    );
    assert_eq!(digest.len(), 64);
    assert!(digest.bytes().all(|b| b.is_ascii_hexdigit()));
    let paths = RunnerPaths::new(PathBuf::from("/runner"));
    assert_eq!(
        paths.active_home_image(&"sandbox"),
        PathBuf::from("/runner/workspaces/sandbox/home.ext4")
    );
    assert_eq!(
        HomePaths::with_root(PathBuf::from("/host")).home_image_cache_dir(),
        PathBuf::from("/host/home-image-cache")
    );
}

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
    let snapshot_dir = RootfsPaths::new(&home, "aaa").snapshot_dir("bbb");
    assert_eq!(snapshot_dir, Path::new("/test/images/aaa/snapshots/bbb"));
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
    let id = RunId::from(uuid::Uuid::nil());
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
    let id = RunId::from(uuid::Uuid::nil());
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
