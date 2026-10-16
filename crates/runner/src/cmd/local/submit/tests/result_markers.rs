use std::os::unix::fs::{MetadataExt, symlink};

use super::super::{result_file_is_empty, try_read_result};
use super::support::submit_queue_entry;
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
fn abandoned_cleanup_keeps_replaced_result_with_same_content() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    let marker = local_queue::LocalQueue::new(group_dir.to_path_buf())
        .write_abandoned_result_marker_sync(job_id, "local submit abandoned")
        .unwrap();
    let replacement_path = queue.result.with_extension("replacement");
    std::fs::write(&replacement_path, std::fs::read(&queue.result).unwrap()).unwrap();
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
    let marker = local_queue::LocalQueue::new(group_dir.to_path_buf())
        .write_abandoned_result_marker_sync(job_id, "local submit abandoned")
        .unwrap();
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
