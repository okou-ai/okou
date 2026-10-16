use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

use crate::local_queue::{self, JobResponse, LocalQueue};
use runner_types::ids::RunId;

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn assert_result(path: &Path, run_id: RunId, exit_code: i32, error: Option<&str>) {
    let result: JobResponse = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(result.run_id, run_id);
    assert_eq!(result.exit_code, exit_code);
    assert_eq!(result.error.as_deref(), error);
}

#[test]
fn abandoned_marker_write_publishes_without_tmp_residue() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let result_path = local_queue::result_path(group_dir, job_id);

    let _marker = LocalQueue::new(group_dir.to_path_buf())
        .write_abandoned_result_marker_sync(job_id, "local submit abandoned")
        .unwrap();

    assert_result(&result_path, job_id, 1, Some("local submit abandoned"));
    assert_eq!(mode(&result_path), 0o600);
    let result_dir = local_queue::results_dir(group_dir);
    assert_eq!(mode(&result_dir), 0o700);
    let tmp_files: Vec<_> = std::fs::read_dir(result_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
        .collect();
    assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
}

#[test]
fn abandoned_marker_write_creates_missing_group_dir_as_shared_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().join("groups").join("org").join("group");
    let job_id = RunId::new_v4();
    let result_path = local_queue::result_path(&group_dir, job_id);

    let _marker = LocalQueue::new(group_dir.to_path_buf())
        .write_abandoned_result_marker_sync(job_id, "local submit abandoned")
        .unwrap();

    assert_result(&result_path, job_id, 1, Some("local submit abandoned"));
    assert_eq!(
        mode(&group_dir),
        runner_host::host_file::SHARED_TRUSTED_DIR_MODE
    );
    assert_eq!(mode(&local_queue::results_dir(&group_dir)), 0o700);
    assert_eq!(mode(&result_path), 0o600);
}

#[test]
fn abandoned_marker_write_cleans_tmp_when_publish_fails() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let result_path = local_queue::result_path(group_dir, job_id);
    std::fs::create_dir_all(&result_path).unwrap();

    let marker = LocalQueue::new(group_dir.to_path_buf())
        .write_abandoned_result_marker_sync(job_id, "local submit abandoned");

    assert!(marker.is_none());
    assert!(result_path.is_dir());
    let result_dir = local_queue::results_dir(group_dir);
    let tmp_files: Vec<_> = std::fs::read_dir(result_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
        .collect();
    assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
}

#[test]
fn abandoned_marker_write_preserves_existing_empty_result() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let result_path = local_queue::result_path(group_dir, job_id);
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    std::fs::write(&result_path, b"").unwrap();

    let marker = LocalQueue::new(group_dir.to_path_buf())
        .write_abandoned_result_marker_sync(job_id, "local submit abandoned");

    assert!(marker.is_none());
    assert_eq!(std::fs::read(&result_path).unwrap(), b"");
    let result_dir = local_queue::results_dir(group_dir);
    let tmp_files: Vec<_> = std::fs::read_dir(result_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
        .collect();
    assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
}

#[test]
fn receipt_removes_only_its_original_run_path_with_identical_inode_aliases() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().join("original");
    let other_group_dir = dir.path().join("other");
    let run_id = RunId::new_v4();
    let queue = LocalQueue::new(group_dir.clone());
    let marker = queue
        .write_abandoned_result_marker_sync(run_id, "abandoned")
        .unwrap();
    let original = local_queue::result_path(&group_dir, run_id);
    let other_run = local_queue::result_path(&group_dir, RunId::new_v4());
    let other_group = local_queue::result_path(&other_group_dir, run_id);
    local_queue::ensure_results_dir(&other_group_dir).unwrap();
    std::fs::hard_link(&original, &other_run).unwrap();
    std::fs::hard_link(&original, &other_group).unwrap();
    let bytes = std::fs::read(&original).unwrap();
    drop(queue);

    marker.remove_if_unchanged();

    assert!(!original.exists());
    assert_eq!(std::fs::read(other_run).unwrap(), bytes);
    assert_eq!(std::fs::read(other_group).unwrap(), bytes);
    marker.remove_if_unchanged();
}

#[test]
fn abandoned_marker_preserves_existing_runner_result() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = LocalQueue::new(dir.path().to_path_buf());
    assert!(queue.write_result_sync(run_id, 0, None));
    let result_path = local_queue::result_path(dir.path(), run_id);
    let bytes = std::fs::read(&result_path).unwrap();

    assert!(
        queue
            .write_abandoned_result_marker_sync(run_id, "abandoned")
            .is_none()
    );

    assert_eq!(std::fs::read(&result_path).unwrap(), bytes);
    assert_result(&result_path, run_id, 0, None);
}

#[test]
fn ordinary_runner_result_replaces_abandoned_marker_and_survives_receipt_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = LocalQueue::new(dir.path().to_path_buf());
    let marker = queue
        .write_abandoned_result_marker_sync(run_id, "abandoned")
        .unwrap();
    let result_path = local_queue::result_path(dir.path(), run_id);
    assert_result(&result_path, run_id, 1, Some("abandoned"));

    assert!(queue.write_result_sync(run_id, 0, None));
    marker.remove_if_unchanged();

    assert_result(&result_path, run_id, 0, None);
}

#[test]
fn abandoned_marker_publication_preserves_result_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = LocalQueue::new(dir.path().to_path_buf());
    let result_dir = local_queue::ensure_results_dir(dir.path()).unwrap();
    let result_path = local_queue::result_path(dir.path(), run_id);
    let target = dir.path().join("runner-result");
    std::fs::write(&target, b"runner result").unwrap();
    symlink(&target, &result_path).unwrap();

    assert!(
        queue
            .write_abandoned_result_marker_sync(run_id, "abandoned")
            .is_none()
    );

    assert!(result_path.is_symlink());
    assert_eq!(std::fs::read(target).unwrap(), b"runner result");
    assert_eq!(std::fs::read_dir(result_dir).unwrap().count(), 1);
}

#[test]
fn receipt_cleanup_preserves_result_symlink_and_its_target() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = LocalQueue::new(dir.path().to_path_buf());
    let marker = queue
        .write_abandoned_result_marker_sync(run_id, "abandoned")
        .unwrap();
    let result_path = local_queue::result_path(dir.path(), run_id);
    let target = result_path.with_extension("saved");
    std::fs::rename(&result_path, &target).unwrap();
    let bytes = std::fs::read(&target).unwrap();
    symlink(&target, &result_path).unwrap();

    marker.remove_if_unchanged();

    assert!(result_path.is_symlink());
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}
