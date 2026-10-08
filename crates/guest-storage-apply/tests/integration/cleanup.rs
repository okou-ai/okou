use crate::binary_logging::BinaryLoggingFixture;
use crate::process::CommandExecution;
use crate::support::run_guest_storage_apply_manifest_json;
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

fn cleanup_manifest(
    cleanup_paths: &[&Path],
    preserved_path: Option<&Path>,
) -> serde_json::Result<Vec<u8>> {
    let storage_mounts = preserved_path
        .map(|path| {
            vec![json!({
                "mountPath": path,
                "cached": true,
                "writeback": false
            })]
        })
        .unwrap_or_default();

    serde_json::to_vec(&json!({
        "storageMounts": storage_mounts,
        "cleanupPaths": cleanup_paths
    }))
}

#[test]
fn selective_cleanup_rejects_symlinked_root_and_stops() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("cleanup");
    let later_cleanup = dir.path().join("later-cleanup-path");
    let target = dir.path().join("target");
    let preserved = cleanup_root.join("keep");

    fs::create_dir_all(target.join("keep")).unwrap();
    fs::create_dir_all(target.join("unrelated")).unwrap();
    fs::write(target.join("keep/content.txt"), "keep").unwrap();
    fs::write(target.join("unrelated/content.txt"), "unrelated").unwrap();
    fs::write(target.join("unrelated.txt"), "unrelated").unwrap();
    fs::create_dir_all(&later_cleanup).unwrap();
    fs::write(later_cleanup.join("stale.txt"), "remove").unwrap();
    symlink(&target, &cleanup_root).unwrap();

    let manifest = cleanup_manifest(&[&cleanup_root, &later_cleanup], Some(&preserved)).unwrap();
    let success = run_guest_storage_apply_manifest_json(&manifest);

    assert!(!success);
    assert!(
        fs::symlink_metadata(&cleanup_root)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_to_string(target.join("keep/content.txt")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(target.join("unrelated/content.txt")).unwrap(),
        "unrelated"
    );
    assert_eq!(
        fs::read_to_string(target.join("unrelated.txt")).unwrap(),
        "unrelated"
    );
    assert_eq!(
        fs::read(later_cleanup.join("stale.txt")).unwrap(),
        b"remove"
    );
}

#[test]
fn whole_root_cleanup_rejects_symlinked_intermediate_component() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("parent");
    let target = dir.path().join("target");
    let target_stale = target.join("stale");
    let alias = parent.join("alias");
    let cleanup_path = alias.join("stale");

    fs::create_dir_all(&parent).unwrap();
    fs::create_dir_all(&target_stale).unwrap();
    fs::write(target_stale.join("content.txt"), "untouched").unwrap();
    symlink(&target, &alias).unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], None).unwrap();
    let success = run_guest_storage_apply_manifest_json(&manifest);

    assert!(!success);
    assert!(
        fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_to_string(target_stale.join("content.txt")).unwrap(),
        "untouched"
    );
}

#[test]
fn whole_root_cleanup_removes_final_symlink_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("cleanup");
    let target = dir.path().join("target");

    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("content.txt"), "untouched").unwrap();
    symlink(&target, &cleanup_root).unwrap();

    let manifest = cleanup_manifest(&[&cleanup_root], None).unwrap();
    let success = run_guest_storage_apply_manifest_json(&manifest);

    assert!(success);
    assert!(fs::symlink_metadata(&cleanup_root).is_err());
    assert_eq!(
        fs::read_to_string(target.join("content.txt")).unwrap(),
        "untouched"
    );
}

#[test]
fn selective_cleanup_preserves_cached_child_in_real_directory() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("cleanup");
    let preserved = cleanup_root.join("keep");

    fs::create_dir_all(&preserved).unwrap();
    fs::create_dir_all(cleanup_root.join("stale")).unwrap();
    fs::write(preserved.join("content.txt"), "keep").unwrap();
    fs::write(cleanup_root.join("stale/content.txt"), "remove").unwrap();
    fs::write(cleanup_root.join("stale.txt"), "remove").unwrap();

    let manifest = cleanup_manifest(&[&cleanup_root], Some(&preserved)).unwrap();
    let success = run_guest_storage_apply_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(preserved.join("content.txt")).unwrap(),
        "keep"
    );
    assert!(!cleanup_root.join("stale").exists());
    assert!(!cleanup_root.join("stale.txt").exists());
}

#[test]
fn cleanup_preserves_cached_path_across_equivalent_manifest_spellings() {
    let dir = tempfile::tempdir().unwrap();
    let alias = dir.path().join("alias");
    let cached = dir.path().join("cache");
    let cleanup_path = alias.join("..").join("cache");

    fs::create_dir_all(&alias).unwrap();
    fs::create_dir_all(&cached).unwrap();
    fs::write(cached.join("content.txt"), "keep").unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], Some(&cached)).unwrap();
    let success = run_guest_storage_apply_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(cached.join("content.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn cleanup_preserves_path_nested_below_cached_root() {
    let dir = tempfile::tempdir().unwrap();
    let alias = dir.path().join("alias");
    let cached = dir.path().join("cache");
    let nested = cached.join("nested");
    let cleanup_path = alias.join("..").join("cache").join("nested");

    fs::create_dir_all(&alias).unwrap();
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("content.txt"), "keep").unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], Some(&cached)).unwrap();
    let success = run_guest_storage_apply_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(nested.join("content.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn selective_cleanup_preserves_cached_child_across_equivalent_parent_spelling() {
    let dir = tempfile::tempdir().unwrap();
    let alias = dir.path().join("alias");
    let cleanup_root = dir.path().join("workspace");
    let cleanup_path = alias.join("..").join("workspace");
    let preserved = cleanup_root.join("keep");

    fs::create_dir_all(&alias).unwrap();
    fs::create_dir_all(&preserved).unwrap();
    fs::create_dir_all(cleanup_root.join("stale")).unwrap();
    fs::write(preserved.join("content.txt"), "keep").unwrap();
    fs::write(cleanup_root.join("stale/content.txt"), "remove").unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], Some(&preserved)).unwrap();
    let success = run_guest_storage_apply_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(preserved.join("content.txt")).unwrap(),
        "keep"
    );
    assert!(!cleanup_root.join("stale").exists());
}

#[test]
fn cleanup_normalization_does_not_bypass_intermediate_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let alias = dir.path().join("alias");
    let target = dir.path().join("target");
    let cache = dir.path().join("cache");
    let cleanup_path = alias.join("..").join("cache");

    fs::create_dir_all(&target).unwrap();
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("content.txt"), "keep").unwrap();
    symlink(&target, &alias).unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], None).unwrap();
    let success = run_guest_storage_apply_manifest_json(&manifest);

    assert!(!success);
    assert_eq!(
        fs::read_to_string(cache.join("content.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn cleanup_preserves_many_cached_siblings_and_unrelated_roots() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("workspace");
    let unrelated_root = dir.path().join("unrelated");
    let removed_root = dir.path().join("removed");
    let mut preserved = Vec::new();
    let mut stale = Vec::new();
    let mut cleanup_paths = vec![cleanup_root.clone(), removed_root.clone()];

    fs::create_dir_all(&removed_root).unwrap();
    fs::write(removed_root.join("content.txt"), "remove").unwrap();
    for i in 0..128 {
        let cached = cleanup_root.join(format!("cached-{i:03}"));
        let unrelated = unrelated_root.join(format!("cached-{i:03}"));
        let stale_sibling = cleanup_root.join(format!("cached-{i:03}-old"));
        for path in [&cached, &unrelated] {
            fs::create_dir_all(path.join("nested")).unwrap();
            fs::write(path.join("nested/content.txt"), "keep").unwrap();
            preserved.push(path.clone());
        }
        cleanup_paths.push(cached.join("nested"));
        fs::create_dir_all(&stale_sibling).unwrap();
        fs::write(stale_sibling.join("content.txt"), "remove").unwrap();
        stale.push(stale_sibling);
    }
    fs::write(cleanup_root.join("stale.txt"), "remove").unwrap();
    let storage_mounts: Vec<_> = preserved
        .iter()
        .enumerate()
        .map(|(i, path)| json!({"mountPath": path, "cached": true, "writeback": i % 2 == 0}))
        .collect();
    let manifest = serde_json::to_vec(&json!({
        "storageMounts": storage_mounts,
        "cleanupPaths": cleanup_paths
    }))
    .unwrap();

    assert!(run_guest_storage_apply_manifest_json(&manifest));

    for path in preserved {
        assert_eq!(
            fs::read_to_string(path.join("nested/content.txt")).unwrap(),
            "keep"
        );
    }
    assert!(stale.iter().all(|path| !path.exists()));
    assert!(!cleanup_root.join("stale.txt").exists());
    assert!(!removed_root.exists());
}

#[test]
fn cleanup_counts_distinct_nested_cached_paths_and_preserves_their_ancestors() {
    let fixture = BinaryLoggingFixture::new("cleanup-nested-cached-paths").unwrap();
    let root = fixture.dir.path().join("workspace");
    let group = root.join("group");
    let cached = group.join("cache");
    let nested = cached.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(group.join("alias")).unwrap();
    fs::write(nested.join("content.txt"), "keep").unwrap();
    fs::write(group.join("stale.txt"), "remove when group is cleaned").unwrap();
    fs::write(root.join("stale.txt"), "remove").unwrap();
    let storage_mounts = json!([
        {"mountPath": cached, "cached": true, "writeback": false},
        {"mountPath": nested, "cached": true, "writeback": true},
        {"mountPath": group.join("alias/../cache"), "cached": true, "writeback": false}
    ]);
    let manifest = serde_json::to_vec(&json!({
        "storageMounts": storage_mounts,
        "cleanupPaths": [root]
    }))
    .unwrap();

    assert!(
        fixture
            .run_manifest_stdin(&manifest)
            .unwrap()
            .status
            .success()
    );
    assert!(group.join("stale.txt").exists());
    assert!(!root.join("stale.txt").exists());

    let manifest = serde_json::to_vec(&json!({
        "storageMounts": storage_mounts,
        "cleanupPaths": [nested, cached, group]
    }))
    .unwrap();
    assert!(
        fixture
            .run_manifest_stdin(&manifest)
            .unwrap()
            .status
            .success()
    );

    assert_eq!(
        fs::read_to_string(nested.join("content.txt")).unwrap(),
        "keep"
    );
    assert!(!group.join("stale.txt").exists());
    assert!(!group.join("alias").exists());
    let log = fixture.read_system_log().unwrap();
    for path in [&root, &group] {
        assert!(log.contains(&format!(
            "Selectively cleaned {} (preserved 2 children)",
            path.display()
        )));
    }
}

#[test]
fn cleanup_preserves_relative_cached_paths_and_leading_parent_components() {
    let fixture = BinaryLoggingFixture::new("cleanup-relative-paths").unwrap();
    let workspace = fixture.dir.path().join("workspace");
    let outside = fixture.dir.path().join("outside");
    for root in [&workspace, &outside] {
        fs::create_dir_all(root.join("cache/nested")).unwrap();
        fs::write(root.join("cache/nested/content.txt"), "keep").unwrap();
        fs::write(root.join("stale.txt"), "remove").unwrap();
    }
    let manifest = serde_json::to_vec(&json!({
        "storageMounts": [
            {"mountPath": "cache", "cached": true, "writeback": false},
            {"mountPath": "../outside/cache", "cached": true, "writeback": true}
        ],
        "cleanupPaths": ["cache/nested", "../outside/cache/nested", "../outside", "."]
    }))
    .unwrap();
    let mut command = fixture.command();
    command.current_dir(&workspace).arg("--manifest-stdin");

    let output = CommandExecution::spawn(&mut command, Some(&manifest))
        .unwrap()
        .wait()
        .unwrap();

    assert!(output.status.success());
    for root in [&workspace, &outside] {
        assert_eq!(
            fs::read_to_string(root.join("cache/nested/content.txt")).unwrap(),
            "keep"
        );
        assert!(!root.join("stale.txt").exists());
    }
}

#[test]
fn cleanup_skips_absolute_paths_when_root_or_empty_prefix_is_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("workspace");
    fs::create_dir_all(&cleanup_root).unwrap();
    fs::write(cleanup_root.join("content.txt"), "keep").unwrap();

    for preserved in [Path::new("/"), Path::new(""), Path::new(".")] {
        let manifest = cleanup_manifest(&[&cleanup_root], Some(preserved)).unwrap();
        assert!(run_guest_storage_apply_manifest_json(&manifest));
        assert_eq!(
            fs::read_to_string(cleanup_root.join("content.txt")).unwrap(),
            "keep"
        );
    }
}
