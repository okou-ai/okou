use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, SystemTime};

use super::*;
use crate::cmd::gc::GC_MIN_AGE;
use crate::cmd::gc::images::gc_nested_images_with_protected_refs;
use crate::cmd::gc::test_support::{old_gc_time, set_mtime, test_home};
use crate::cmd::gc::versions::{
    analyze_version_gc, analyze_version_gc_with_injected_config_scan_error,
    analyze_version_gc_with_injected_scan_error,
};
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

const ENABLED_SERVICE_SCENARIO_ENV: &str = "OKOU_RUN_GC_ENABLED_SERVICE_SCENARIO";
const ENABLED_SERVICE_CONFIG_ENV: &str = "OKOU_RUN_GC_ENABLED_SERVICE_CONFIG";
const ENABLED_SERVICE_HOME_ENV: &str = "OKOU_RUN_GC_ENABLED_SERVICE_HOME";
const ENABLED_SERVICE_SYSTEM_DIR_ENV: &str = "OKOU_RUN_GC_ENABLED_SERVICE_SYSTEM_DIR";
const ENABLED_SERVICE_STATE_DIR_ENV: &str = "OKOU_RUN_GC_ENABLED_SERVICE_STATE_DIR";
const ENABLED_SERVICE_INVOCATIONS_ENV: &str = "OKOU_RUN_GC_ENABLED_SERVICE_INVOCATIONS";
const ENABLED_SERVICE_CHILD_TEST: &str =
    "cmd::gc::image_refs::tests::enabled_service_systemctl_child";
const REFILL_SERVICE_SUFFIXES: [&str; 5] = ["gamma", "alpha", "epsilon", "beta", "delta"];
const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$OKOU_RUN_GC_ENABLED_SERVICE_INVOCATIONS"

if [ "$OKOU_RUN_GC_ENABLED_SERVICE_SCENARIO" = "refill" ]; then
  invocation="$*"
  printf 'started %s\n' "$invocation" >> "$OKOU_RUN_GC_ENABLED_SERVICE_STATE_DIR/events"
  trap 'printf "finished %s\n" "$invocation" >> "$OKOU_RUN_GC_ENABLED_SERVICE_STATE_DIR/events"' 0
fi

if [ "$1" = "is-enabled" ]; then
  unit="$2"
  if [ "$OKOU_RUN_GC_ENABLED_SERVICE_SCENARIO" = "bounded" ] || [ "$OKOU_RUN_GC_ENABLED_SERVICE_SCENARIO" = "refill" ]; then
    : > "$OKOU_RUN_GC_ENABLED_SERVICE_STATE_DIR/$unit.started"
    while [ ! -f "$OKOU_RUN_GC_ENABLED_SERVICE_STATE_DIR/$unit.release" ]; do :; done
    if [ "$unit" = "vm0-runner-disabled.service" ]; then
      printf '%s\n' 'disabled'
      exit 1
    fi
  fi
  if [ "$OKOU_RUN_GC_ENABLED_SERVICE_SCENARIO" = "enablement-error" ]; then
    printf '%s\n' 'cannot determine unit file state' >&2
    exit 1
  fi
  printf '%s\n' 'enabled'
  exit 0
fi

if [ "$1" = "--no-pager" ] && [ "$2" = "cat" ] && [ "$3" = "--" ]; then
  case "$OKOU_RUN_GC_ENABLED_SERVICE_SCENARIO" in
    cat-error)
      printf '%s\n' 'cannot read selected drop-in' >&2
      exit 1
      ;;
    cat-warning)
      printf '%s\n' '[Service]' 'ExecStart=/usr/bin/runner start --config /etc/stale.yaml'
      printf '%s\n' 'unit files changed on disk; daemon-reload required' >&2
      exit 0
      ;;
    unparseable)
      printf '%s\n' '[Service]' 'ExecStart=/usr/bin/true'
      exit 0
      ;;
    bounded|refill)
      unit="$4"
      if [ "$unit" = "vm0-runner-failure.service" ]; then
        printf '%s\n' 'cannot read selected drop-in' >&2
        exit 1
      fi
      suffix=${unit#vm0-runner-}
      suffix=${suffix%.service}
      printf '%s\n' \
        '[Service]' \
        "ExecStart=/usr/bin/runner start --config /configs/$suffix.yaml"
      exit 0
      ;;
    effective|malformed-config|comment-hash|comment-semicolon)
      printf '%s\n' \
        '# /etc/systemd/system/vm0-runner-test.service' \
        '[Service]' \
        'ExecStart=/usr/bin/runner start --config /etc/base.yaml' \
        '# /usr/lib/systemd/system/vm0-runner-.service.d/10-vendor.conf' \
        '[Service]' \
        'ExecStart=' \
        'ExecStart=/usr/bin/runner start --config /etc/vendor.yaml' \
        '# /run/systemd/system/vm0-runner-test.service.d/20-runtime.conf' \
        '[Service]' \
        'ExecStart='
      case "$OKOU_RUN_GC_ENABLED_SERVICE_SCENARIO" in
        comment-hash) printf '%s\n' '  # runner config example \' ;;
        comment-semicolon) printf '%s\n' '  ; runner config example \' ;;
      esac
      printf '%s\n' "ExecStart=/usr/bin/runner start --config $OKOU_RUN_GC_ENABLED_SERVICE_CONFIG"
      exit 0
      ;;
  esac
fi

printf '%s\n' "unexpected fake systemctl invocation: $*" >&2
exit 2
"#;

fn age_version_past_gc_min_age(home: &HomePaths, name: &str) {
    let old_time = SystemTime::now() - Duration::from_secs(GC_MIN_AGE.as_secs() + 60);
    for path in [
        home.bin_dir().join(name),
        home.bin_dir().join(name).join("runner"),
        home.runners_dir().join(name),
        home.runners_dir().join(name).join("runner.yaml"),
    ] {
        if path.exists() {
            std::fs::File::open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(old_time))
                .unwrap();
        }
    }
}

fn test_hash(ch: char) -> String {
    std::iter::repeat_n(ch, 64).collect()
}

fn write_test_runner_config(
    home: &HomePaths,
    version: &str,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> PathBuf {
    let config_dir = home.runners_dir().join(version);
    std::fs::create_dir_all(&config_dir).unwrap();
    let config_path = config_dir.join("runner.yaml");
    std::fs::write(
        &config_path,
        format!(
            r#"name: {version}
group: vm0/test
base_dir: /tmp/{version}
ca_dir: /tmp/{version}/ca
firecracker:
  binary: /tmp/firecracker
  kernel: /tmp/vmlinux
profiles:
  vm0/default:
    rootfs_hash: {rootfs_hash}
    snapshot_hash: {snapshot_hash}
    vcpu: 1
    memory_mb: 1024
    rootfs_disk_mb: 8192
    workspace_disk_mb: 8192
server:
  url: https://api.example.test
  token: test-secret-token
"#
        ),
    )
    .unwrap();
    config_path
}

fn create_test_version_with_config(
    home: &HomePaths,
    version: &str,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> PathBuf {
    std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    let config_path = write_test_runner_config(home, version, rootfs_hash, snapshot_hash);
    age_version_past_gc_min_age(home, version);
    config_path
}

fn create_old_test_snapshot(home: &HomePaths, rootfs_hash: &str, snapshot_hash: &str) -> PathBuf {
    let rootfs_dir = home.images_dir().join(rootfs_hash);
    let snapshot_dir = rootfs_dir.join("snapshots").join(snapshot_hash);
    std::fs::create_dir_all(&snapshot_dir).unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    std::fs::write(snapshot_dir.join("snapshot.bin"), b"snapshot").unwrap();
    let old_time = old_gc_time();
    for path in [&rootfs_dir, &snapshot_dir] {
        std::fs::File::open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old_time))
            .unwrap();
    }
    snapshot_dir
}

async fn protected_refs_from_versions(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
) -> ProtectedImageRefs {
    let analysis = analyze_version_gc(home, protect, keep_latest)
        .await
        .unwrap();
    let mut refs = ProtectedImageRefs::new();
    assert!(collect_retained_version_image_refs(home, &analysis, &mut refs).await);
    refs
}

fn protected_refs_from_pairs(pairs: &[(&str, &str)]) -> ProtectedImageRefs {
    let mut refs = ProtectedImageRefs::new();
    for (rootfs_hash, snapshot_hash) in pairs {
        insert_protected_image_ref(
            &mut refs,
            (*rootfs_hash).to_string(),
            (*snapshot_hash).to_string(),
        );
    }
    refs
}

#[tokio::test]
async fn protected_version_config_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    create_test_version_with_config(&home, "v1.0.0", &rootfs_hash, &snapshot_hash);
    let refs = protected_refs_from_versions(&home, Some("v1.0.0"), None).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert_eq!(freed.freed_bytes, 0);
    assert!(
        snapshot_dir.exists(),
        "protect-version config refs must keep the referenced snapshot"
    );
    assert!(home.images_dir().join(&rootfs_hash).exists());
}

#[tokio::test]
async fn protected_config_only_version_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    write_test_runner_config(&home, version, &rootfs_hash, &snapshot_hash);
    let refs = protected_refs_from_versions(&home, Some(version), None).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert_eq!(freed.freed_bytes, 0);
    assert!(
        snapshot_dir.exists(),
        "retained config-only version must protect its referenced snapshot"
    );
}

#[tokio::test]
async fn keep_latest_version_config_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let old_rootfs = test_hash('a');
    let old_snapshot = test_hash('b');
    let new_rootfs = test_hash('c');
    let new_snapshot = test_hash('d');
    let old_snapshot_dir = create_old_test_snapshot(&home, &old_rootfs, &old_snapshot);
    let new_snapshot_dir = create_old_test_snapshot(&home, &new_rootfs, &new_snapshot);
    create_test_version_with_config(&home, "v1.0.0", &old_rootfs, &old_snapshot);
    create_test_version_with_config(&home, "v2.0.0", &new_rootfs, &new_snapshot);
    let refs = protected_refs_from_versions(&home, None, Some(1)).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(
        new_snapshot_dir.exists(),
        "newest retained version should protect its config snapshot"
    );
    assert!(
        !old_snapshot_dir.exists(),
        "removable version config should not protect its snapshot"
    );
}

#[tokio::test]
async fn protected_image_refs_do_not_consume_keep_latest_slots() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let protected_rootfs = test_hash('a');
    let protected_snapshot = test_hash('b');
    let older_rootfs = test_hash('c');
    let older_snapshot = test_hash('d');
    let newer_rootfs = test_hash('e');
    let newer_snapshot = test_hash('f');
    let protected_dir = create_old_test_snapshot(&home, &protected_rootfs, &protected_snapshot);
    let older_dir = create_old_test_snapshot(&home, &older_rootfs, &older_snapshot);
    let newer_dir = create_old_test_snapshot(&home, &newer_rootfs, &newer_snapshot);
    set_mtime(&older_dir, old_gc_time());
    set_mtime(
        &newer_dir,
        SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000),
    );
    let refs = protected_refs_from_pairs(&[(&protected_rootfs, &protected_snapshot)]);

    let freed = gc_nested_images_with_protected_refs(&home, Some(1), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(protected_dir.exists(), "protected snapshot must survive");
    assert!(
        newer_dir.exists(),
        "image keep_latest slot should still apply to newest eligible snapshot"
    );
    assert!(
        !older_dir.exists(),
        "older eligible snapshot should be deleted"
    );
}

#[tokio::test]
async fn protected_image_ref_keeps_only_exact_snapshot_pair() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let protected_snapshot = test_hash('b');
    let sibling_snapshot = test_hash('c');
    let protected_dir = create_old_test_snapshot(&home, &rootfs_hash, &protected_snapshot);
    let sibling_dir = create_old_test_snapshot(&home, &rootfs_hash, &sibling_snapshot);
    let refs = protected_refs_from_pairs(&[(&rootfs_hash, &protected_snapshot)]);

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(
        protected_dir.exists(),
        "exact protected snapshot must survive"
    );
    assert!(
        !sibling_dir.exists(),
        "unreferenced sibling snapshot under same rootfs should remain eligible"
    );
    assert!(
        home.images_dir().join(&rootfs_hash).exists(),
        "rootfs with protected snapshot should survive"
    );
}

#[tokio::test]
async fn removable_version_config_does_not_protect_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    create_test_version_with_config(&home, "v1.0.0", &rootfs_hash, &snapshot_hash);
    let refs = protected_refs_from_versions(&home, None, None).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(
        !snapshot_dir.exists(),
        "old removable version config should not pin image artifacts"
    );
}

#[tokio::test]
async fn malformed_retained_version_config_skips_image_gc() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    let config_path = create_test_version_with_config(&home, version, &rootfs_hash, &snapshot_hash);
    std::fs::write(
        config_path,
        "server:\n  token: should-not-appear-in-errors\nprofiles: [",
    )
    .unwrap();

    let analysis = analyze_version_gc(&home, Some(version), None)
        .await
        .unwrap();
    let refs = protected_image_refs_for_gc(&home, &analysis).await;

    assert!(!refs.is_complete());
    let report = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert_eq!(report.freed_bytes, 0);
    assert_eq!(report.activity_count, 0);
    assert!(snapshot_dir.exists());
    assert!(home.images_dir().join(rootfs_hash).exists());
}

#[tokio::test]
async fn missing_retained_version_config_makes_protection_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    let analysis = analyze_version_gc(&home, Some(version), None)
        .await
        .unwrap();

    let refs = protected_image_refs_for_gc(&home, &analysis).await;

    assert!(!refs.is_complete());
}

#[tokio::test]
async fn invalid_retained_version_profile_hash_makes_protection_inventory_incomplete() {
    for (rootfs_hash, snapshot_hash) in [
        ("invalid".to_string(), test_hash('b')),
        (test_hash('a'), "invalid".to_string()),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let version = "v1.0.0";
        create_test_version_with_config(&home, version, &rootfs_hash, &snapshot_hash);
        let analysis = analyze_version_gc(&home, Some(version), None)
            .await
            .unwrap();

        let refs = protected_image_refs_for_gc(&home, &analysis).await;

        assert!(!refs.is_complete());
    }
}

#[tokio::test]
async fn service_config_image_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    let config_path =
        write_test_runner_config(&home, "service-config", &rootfs_hash, &snapshot_hash);
    let mut refs = ProtectedImageRefs::new();
    assert!(collect_config_image_refs(&config_path, "enabled service", &mut refs).await);

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert_eq!(freed.freed_bytes, 0);
    assert!(
        snapshot_dir.exists(),
        "enabled service config refs must keep the referenced snapshot"
    );
}

#[tokio::test]
async fn enabled_service_directory_scan_reports_iteration_error() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("unrelated-a.service"), "").unwrap();
    std::fs::write(dir.path().join("unrelated-b.service"), "").unwrap();
    let mut entry_reader = GcDirEntryReader::failing_after(1);

    let scan = enabled_runner_service_config_paths_with_reader(dir.path(), &mut entry_reader).await;

    assert!(!scan.inventory_complete);
    assert!(scan.paths.is_empty());
}

#[tokio::test]
async fn enabled_service_discovery_overlaps_with_a_fixed_bound() {
    let invocations = run_enabled_service_scenario("bounded").await;

    assert_eq!(
        invocations
            .iter()
            .filter(|invocation| invocation.starts_with("is-enabled "))
            .count(),
        5
    );
    assert_eq!(
        invocations
            .iter()
            .filter(|invocation| invocation.starts_with("--no-pager cat -- "))
            .count(),
        4
    );
    for suffix in ["alpha", "beta", "failure", "gamma"] {
        let unit = format!("vm0-runner-{suffix}.service");
        let enablement = format!("is-enabled {unit}");
        let config = format!("--no-pager cat -- {unit}");
        let enablement_position = invocations
            .iter()
            .position(|invocation| invocation == &enablement)
            .unwrap();
        let config_position = invocations
            .iter()
            .position(|invocation| invocation == &config)
            .unwrap();
        assert!(enablement_position < config_position);
    }
    assert!(
        !invocations
            .iter()
            .any(|invocation| invocation == "--no-pager cat -- vm0-runner-disabled.service")
    );
}

#[tokio::test]
async fn enabled_service_discovery_refills_before_first_unit_finishes() {
    run_enabled_service_scenario("refill").await;
}

#[tokio::test]
async fn effective_enabled_service_config_ref_keeps_image_snapshot() {
    let invocations = run_enabled_service_scenario("effective").await;

    assert_eq!(
        invocations,
        vec![
            "is-enabled vm0-runner-test.service",
            "--no-pager cat -- vm0-runner-test.service",
        ]
    );
}

#[tokio::test]
async fn enabled_service_config_after_backslash_ended_comment_keeps_image_snapshot() {
    for scenario in ["comment-hash", "comment-semicolon"] {
        run_enabled_service_scenario(scenario).await;
    }
}

#[tokio::test]
async fn enabled_service_discovery_failures_make_inventory_incomplete() {
    for scenario in ["enablement-error", "cat-error", "cat-warning"] {
        run_enabled_service_scenario(scenario).await;
    }
}

#[tokio::test]
async fn malformed_enabled_service_config_makes_inventory_incomplete() {
    run_enabled_service_scenario("malformed-config").await;
}

#[tokio::test]
async fn readable_unit_without_runner_config_remains_best_effort() {
    run_enabled_service_scenario("unparseable").await;
}

async fn run_enabled_service_scenario(scenario: &str) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let fake_systemctl = dir.path().join("systemctl");
    std::fs::write(&fake_systemctl, FAKE_SYSTEMCTL).unwrap();
    let mut permissions = std::fs::metadata(&fake_systemctl).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_systemctl, permissions).unwrap();

    let system_dir = dir.path().join("system");
    std::fs::create_dir(&system_dir).unwrap();
    let suffixes: &[&str] = match scenario {
        "bounded" => &["alpha", "beta", "disabled", "failure", "gamma"],
        "refill" => &REFILL_SERVICE_SUFFIXES,
        _ => &["test"],
    };
    for suffix in suffixes {
        std::fs::write(system_dir.join(format!("vm0-runner-{suffix}.service")), "").unwrap();
    }

    let home_root = dir.path().join("home");
    let home = test_home(&home_root);
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    let config_path = write_test_runner_config(&home, "effective", &rootfs_hash, &snapshot_hash);
    if scenario == "malformed-config" {
        std::fs::write(
            &config_path,
            "server:\n  token: should-not-appear-in-errors\nprofiles: [",
        )
        .unwrap();
    }

    let invocations_path = dir.path().join("invocations");
    let state_dir = dir.path().join("state");
    std::fs::create_dir(&state_dir).unwrap();
    run_ignored_child_test(
        ENABLED_SERVICE_CHILD_TEST,
        (ENABLED_SERVICE_SCENARIO_ENV, scenario),
        &[
            ("PATH", Some(utf8_path(dir.path()))),
            (ENABLED_SERVICE_CONFIG_ENV, Some(utf8_path(&config_path))),
            (ENABLED_SERVICE_HOME_ENV, Some(utf8_path(&home_root))),
            (ENABLED_SERVICE_SYSTEM_DIR_ENV, Some(utf8_path(&system_dir))),
            (ENABLED_SERVICE_STATE_DIR_ENV, Some(utf8_path(&state_dir))),
            (
                ENABLED_SERVICE_INVOCATIONS_ENV,
                Some(utf8_path(&invocations_path)),
            ),
        ],
        Duration::from_secs(10),
    )
    .await;

    std::fs::read_to_string(invocations_path)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect()
}

fn utf8_path(path: &Path) -> &str {
    path.to_str().expect("temporary path must be UTF-8")
}

#[tokio::test]
#[ignore = "spawned by enabled service image ref systemctl tests"]
async fn enabled_service_systemctl_child() {
    let Ok(scenario) = std::env::var(ENABLED_SERVICE_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((ENABLED_SERVICE_SCENARIO_ENV, &scenario)) {
        return;
    }

    let system_dir = PathBuf::from(std::env::var(ENABLED_SERVICE_SYSTEM_DIR_ENV).unwrap());
    match scenario.as_str() {
        "bounded" => assert_bounded_enabled_service_discovery(&system_dir).await,
        "refill" => assert_enabled_service_discovery_refills_before_first_finishes().await,
        "effective" | "comment-hash" | "comment-semicolon" => {
            let home = test_home(Path::new(&std::env::var(ENABLED_SERVICE_HOME_ENV).unwrap()));
            let rootfs_hash = test_hash('a');
            let snapshot_hash = test_hash('b');
            let snapshot_dir = home
                .images_dir()
                .join(&rootfs_hash)
                .join("snapshots")
                .join(&snapshot_hash);
            let mut refs = ProtectedImageRefs::new();

            assert!(collect_enabled_service_image_refs_from_dir(&system_dir, &mut refs).await);
            let report = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
                .await
                .unwrap();

            assert_eq!(report.freed_bytes, 0);
            assert!(
                snapshot_dir.exists(),
                "effective enabled-service config must protect its image pair"
            );
        }
        "enablement-error" | "cat-error" | "cat-warning" => {
            let scan = enabled_runner_service_config_paths(&system_dir).await;

            assert!(!scan.inventory_complete);
            assert!(scan.paths.is_empty());
        }
        "malformed-config" => {
            let mut refs = ProtectedImageRefs::new();

            assert!(!collect_enabled_service_image_refs_from_dir(&system_dir, &mut refs).await);
        }
        "unparseable" => {
            let scan = enabled_runner_service_config_paths(&system_dir).await;

            assert!(scan.inventory_complete);
            assert!(scan.paths.is_empty());
        }
        unexpected => panic!("unexpected enabled service scenario: {unexpected}"),
    }
}

async fn assert_bounded_enabled_service_discovery(system_dir: &Path) {
    let state_dir = PathBuf::from(std::env::var(ENABLED_SERVICE_STATE_DIR_ENV).unwrap());
    let system_dir = system_dir.to_path_buf();
    let discovery =
        tokio::spawn(async move { enabled_runner_service_config_paths(&system_dir).await });

    wait_for_started_enabled_service_queries(&state_dir, ENABLED_SERVICE_QUERY_CONCURRENCY).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let first_batch = started_enabled_service_queries(&state_dir);
    assert_eq!(first_batch.len(), ENABLED_SERVICE_QUERY_CONCURRENCY);
    release_enabled_service_queries(&state_dir, &first_batch);

    wait_for_started_enabled_service_queries(&state_dir, ENABLED_SERVICE_QUERY_CONCURRENCY + 1)
        .await;
    release_enabled_service_queries(&state_dir, &started_enabled_service_queries(&state_dir));

    let mut scan = tokio::time::timeout(Duration::from_secs(5), discovery)
        .await
        .expect("bounded enabled-service discovery should finish after releases")
        .unwrap();
    scan.paths.sort();
    assert_eq!(
        scan.paths,
        vec![
            PathBuf::from("/configs/alpha.yaml"),
            PathBuf::from("/configs/beta.yaml"),
            PathBuf::from("/configs/gamma.yaml"),
        ]
    );
    assert!(!scan.inventory_complete);
}

async fn assert_enabled_service_discovery_refills_before_first_finishes() {
    let state_dir = PathBuf::from(std::env::var(ENABLED_SERVICE_STATE_DIR_ENV).unwrap());
    let units: Vec<_> = REFILL_SERVICE_SUFFIXES
        .iter()
        .map(|suffix| {
            service::RunnerServiceUnit::from_file_name(&format!("vm0-runner-{suffix}.service"))
                .unwrap()
        })
        .collect();
    let service_names: Vec<_> = units
        .iter()
        .map(|unit| unit.service_name().to_string())
        .collect();
    let first_unit = service_names.first().unwrap();
    let last_unit = service_names.last().unwrap();
    let discovery = tokio::spawn(enabled_runner_service_config_paths_for_units(units));

    wait_for_started_enabled_service_queries(&state_dir, ENABLED_SERVICE_QUERY_CONCURRENCY).await;
    let first_batch = started_enabled_service_queries(&state_dir);
    assert_eq!(first_batch.len(), ENABLED_SERVICE_QUERY_CONCURRENCY);
    assert!(first_batch.contains(first_unit));
    assert!(!first_batch.contains(last_unit));
    let later_units: Vec<_> = first_batch
        .into_iter()
        .filter(|unit| unit != first_unit)
        .collect();
    release_enabled_service_queries(&state_dir, &later_units);

    // A completed later pipeline must admit the fifth unit while the first is still gated.
    wait_for_started_enabled_service_queries(&state_dir, service_names.len()).await;
    release_enabled_service_queries(&state_dir, std::slice::from_ref(last_unit));
    let last_config_finished = format!("finished --no-pager cat -- {last_unit}");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let events = std::fs::read_to_string(state_dir.join("events")).unwrap();
            if events.lines().any(|event| event == last_config_finished) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the fifth unit should finish before releasing the first");
    assert!(!discovery.is_finished());
    assert!(!state_dir.join(format!("{first_unit}.release")).exists());
    release_enabled_service_queries(&state_dir, std::slice::from_ref(first_unit));

    let scan = tokio::time::timeout(Duration::from_secs(5), discovery)
        .await
        .expect("discovery should finish after releasing the first unit")
        .unwrap();
    assert!(scan.inventory_complete);
    assert_eq!(
        scan.paths,
        REFILL_SERVICE_SUFFIXES.map(|suffix| PathBuf::from(format!("/configs/{suffix}.yaml")))
    );

    let events = std::fs::read_to_string(state_dir.join("events")).unwrap();
    let mut active_queries = HashSet::new();
    let mut completed_queries = HashSet::new();
    let mut max_active_queries = 0;
    for event in events.lines() {
        if let Some(invocation) = event.strip_prefix("started ") {
            if let Some(unit) = invocation.strip_prefix("--no-pager cat -- ") {
                assert!(completed_queries.contains(&format!("is-enabled {unit}")));
            }
            assert!(active_queries.insert(invocation.to_string()));
            max_active_queries = max_active_queries.max(active_queries.len());
            assert!(active_queries.len() <= ENABLED_SERVICE_QUERY_CONCURRENCY);
        } else {
            let invocation = event.strip_prefix("finished ").unwrap();
            assert!(active_queries.remove(invocation));
            assert!(completed_queries.insert(invocation.to_string()));
        }
    }
    assert!(active_queries.is_empty());
    assert_eq!(completed_queries.len(), service_names.len() * 2);
    assert_eq!(max_active_queries, ENABLED_SERVICE_QUERY_CONCURRENCY);
}

async fn wait_for_started_enabled_service_queries(state_dir: &Path, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if started_enabled_service_queries(state_dir).len() >= expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fake systemctl enablement queries should reach the gate");
}

fn started_enabled_service_queries(state_dir: &Path) -> Vec<String> {
    std::fs::read_dir(state_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter_map(|name| name.strip_suffix(".started").map(str::to_string))
        .collect()
}

fn release_enabled_service_queries(state_dir: &Path, units: &[String]) {
    for unit in units {
        std::fs::write(state_dir.join(format!("{unit}.release")), "").unwrap();
    }
}

#[tokio::test]
async fn incomplete_version_scan_makes_protection_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    for version in ["v1.0.0", "v2.0.0"] {
        std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    }
    let analysis = analyze_version_gc_with_injected_scan_error(&home, None, None, 1)
        .await
        .unwrap();

    let refs = protected_image_refs_for_gc(&home, &analysis).await;

    assert!(!refs.is_complete());
}

#[tokio::test]
async fn incomplete_config_scan_makes_protection_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.runners_dir()).unwrap();
    let analysis = analyze_version_gc_with_injected_config_scan_error(&home, None, None, 0)
        .await
        .unwrap();

    let refs = protected_image_refs_for_gc(&home, &analysis).await;

    assert!(!analysis.directory_scan_complete());
    assert!(!refs.is_complete());
}

#[tokio::test]
async fn incomplete_protection_inventory_skips_image_gc() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);

    let report = gc_nested_images_with_protected_refs(
        &home,
        Some(0),
        false,
        &ProtectedImageRefs::incomplete(),
    )
    .await
    .unwrap();

    assert_eq!(report.freed_bytes, 0);
    assert_eq!(report.activity_count, 0);
    assert!(snapshot_dir.exists());
    assert!(home.images_dir().join(rootfs_hash).exists());
}
