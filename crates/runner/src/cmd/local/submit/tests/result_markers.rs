use std::os::unix::fs::{MetadataExt, symlink};

use super::super::{result_file_is_empty, try_read_result, write_abandoned_result_marker};
use super::support::{mode, submit_queue_entry};
use runner_provider::local_queue;
use runner_types::ids::RunId;

#[test]
fn try_read_result_nonexistent_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("does-not-exist.result");
    assert!(try_read_result(&path).is_none());
}

#[test]
fn try_read_result_empty_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.result");
    std::fs::write(&path, b"").unwrap();
    assert!(try_read_result(&path).is_none());
}

#[test]
fn try_read_result_with_content_returns_some() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("valid.result");
    std::fs::write(&path, b"{\"exit_code\":0}").unwrap();
    let result = try_read_result(&path).unwrap();
    assert_eq!(result, b"{\"exit_code\":0}");
}

#[test]
fn try_read_result_ignores_result_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let result_path = local_queue::result_path(group_dir, RunId::new_v4());
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-result");
    std::fs::write(&target, b"{\"exit_code\":0}").unwrap();
    symlink(&target, &result_path).unwrap();

    assert!(try_read_result(&result_path).is_none());
}

#[test]
fn result_file_is_empty_ignores_result_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let result_path = local_queue::result_path(group_dir, RunId::new_v4());
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-result");
    std::fs::write(&target, b"").unwrap();
    symlink(&target, &result_path).unwrap();

    assert!(!result_file_is_empty(&result_path));
}

#[test]
fn abandoned_marker_write_publishes_without_tmp_residue() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let result_path = local_queue::result_path(group_dir, job_id);

    let marker =
        write_abandoned_result_marker(&result_path, job_id, "local submit abandoned").unwrap();

    assert_eq!(std::fs::read(&result_path).unwrap(), marker.bytes);
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

    let marker =
        write_abandoned_result_marker(&result_path, job_id, "local submit abandoned").unwrap();

    assert_eq!(std::fs::read(&result_path).unwrap(), marker.bytes);
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

    let marker = write_abandoned_result_marker(&result_path, job_id, "local submit abandoned");

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

    let marker = write_abandoned_result_marker(&result_path, job_id, "local submit abandoned");

    assert!(marker.is_none());
    assert!(result_file_is_empty(&result_path));
    let result_dir = local_queue::results_dir(group_dir);
    let tmp_files: Vec<_> = std::fs::read_dir(result_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
        .collect();
    assert!(tmp_files.is_empty(), "tmp files left behind: {tmp_files:?}");
}

#[test]
fn abandoned_cleanup_keeps_replaced_result_with_same_content() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    let marker =
        write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned").unwrap();
    let replacement_path = queue.result.with_extension("replacement");
    std::fs::write(&replacement_path, &marker.bytes).unwrap();
    std::fs::rename(&replacement_path, &queue.result).unwrap();

    queue.cleanup_abandoned(Some(&marker));

    assert!(
        queue.result.exists(),
        "cleanup must not remove a result that replaced the submit marker"
    );
}

#[test]
fn abandoned_cleanup_keeps_mutated_result_with_same_marker_inode() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    let marker =
        write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned").unwrap();
    let marker_metadata = std::fs::metadata(&queue.result).unwrap();
    let runner_result = b"runner result";
    let mut result_file = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&queue.result)
        .unwrap();
    std::io::Write::write_all(&mut result_file, runner_result).unwrap();
    drop(result_file);
    let current_metadata = std::fs::metadata(&queue.result).unwrap();
    assert_eq!(marker_metadata.dev(), current_metadata.dev());
    assert_eq!(marker_metadata.ino(), current_metadata.ino());

    queue.cleanup_abandoned(Some(&marker));

    assert!(!queue.job.exists());
    assert_eq!(std::fs::read(&queue.result).unwrap(), runner_result);
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}
