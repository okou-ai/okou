use std::os::unix::fs::symlink;
use std::path::Path;

use super::super::write_abandoned_result_marker;
use super::support::{submit_queue_entry, write_queue_job_file};
use crate::ids::RunId;
use crate::local_queue::{self, JobResponse};

fn write_orphaned_active_input(group_dir: &Path, job_id: RunId) {
    local_queue::ensure_run_inputs_dir(group_dir, job_id).unwrap();
    let entry = local_queue::ActiveInputEntry {
        run_id: job_id,
        sequence: 1,
        text: "orphaned follow-up".to_string(),
    };
    local_queue::write_private_file(
        &local_queue::active_input_path(group_dir, job_id, entry.sequence),
        &serde_json::to_vec(&entry).unwrap(),
        "test orphaned active input",
    )
    .unwrap();
}

#[test]
fn cancelled_abandon_preserves_active_claim_without_result() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&queue.claim, b"").unwrap();
    local_queue::LocalQueue::new(group_dir.to_path_buf())
        .write_active_input_sync(&local_queue::ActiveInputEntry {
            run_id: job_id,
            sequence: 1,
            text: "one".to_string(),
        })
        .unwrap();

    queue.abandon_cancelled();

    assert!(!queue.job.exists());
    assert!(
        !queue.result.exists(),
        "cancelled cleanup must not publish a terminal result while a runner owns the claim"
    );
    assert!(
        queue.cancel.exists(),
        "abandoned cleanup must not delete files while a runner owns the claim"
    );
    assert!(queue.claim.exists());
    assert!(
        local_queue::run_inputs_dir(group_dir, job_id).exists(),
        "abandoned cleanup must leave active inputs for claimed jobs"
    );
}

#[test]
fn abandoned_cleanup_removes_unclaimed_job_without_claim_marker() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    local_queue::LocalQueue::new(group_dir.to_path_buf())
        .write_active_input_sync(&local_queue::ActiveInputEntry {
            run_id: job_id,
            sequence: 1,
            text: "one".to_string(),
        })
        .unwrap();

    queue.abandon_cancelled();

    assert!(!queue.job.exists());
    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(
        !queue.claim.exists(),
        "abandoned cleanup should not create a temporary claim"
    );
    assert!(
        !local_queue::run_inputs_dir(group_dir, job_id).exists(),
        "abandoned cleanup should remove active inputs for unclaimed jobs"
    );
}

#[test]
fn abandoned_cleanup_ignores_claim_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    let target = dir.path().join("target-claim");
    std::fs::write(&target, b"").unwrap();
    symlink(&target, &queue.claim).unwrap();

    queue.abandon_cancelled();

    assert!(!queue.job.exists());
    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn abandoned_cleanup_removes_duplicate_unclaimed_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    let default_job = write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
    let large_job = write_queue_job_file(group_dir, "vm0/large", job_id);
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.cancel, b"").unwrap();

    queue.abandon_cancelled();

    assert!(!default_job.exists());
    assert!(!large_job.exists());
    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(
        !queue.claim.exists(),
        "abandoned cleanup should not create a temporary claim"
    );
}

#[test]
fn abandoned_cleanup_removes_marker_when_job_already_absent() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.cancel, b"").unwrap();
    let marker =
        write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned").unwrap();

    queue.cleanup_abandoned(Some(&marker));

    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn abandoned_cleanup_removes_unclaimed_active_inputs_when_job_already_absent() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    let marker =
        write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned").unwrap();
    write_orphaned_active_input(group_dir, job_id);

    queue.cleanup_abandoned(Some(&marker));

    assert!(!local_queue::run_inputs_dir(group_dir, job_id).exists());
    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn abandoned_cleanup_removes_late_unclaimed_active_inputs_after_job_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();

    queue.abandon_cancelled();
    write_orphaned_active_input(group_dir, job_id);

    queue.cleanup_abandoned(None);

    assert!(!local_queue::run_inputs_dir(group_dir, job_id).exists());
    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn timeout_abandon_keeps_marker_when_duplicate_job_cannot_be_removed() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    let default_job = write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
    let blocked_job = local_queue::job_path(group_dir, "vm0/large", job_id).unwrap();
    std::fs::create_dir_all(&blocked_job).unwrap();
    queue.abandon("timed out");

    assert!(!default_job.exists());
    assert!(blocked_job.exists());
    assert!(
        queue.result.exists(),
        "terminal marker must remain if any duplicate job path could not be removed"
    );
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn cancelled_abandon_keeps_claim_when_job_is_already_absent() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&queue.claim, b"").unwrap();

    queue.abandon_cancelled();

    assert!(!queue.result.exists());
    assert!(queue.cancel.exists());
    assert!(queue.claim.exists());
}

#[test]
fn abandoned_cleanup_removes_stale_empty_result_after_unclaimed_job() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.result, b"").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();

    queue.abandon("timed out");

    assert!(!queue.job.exists());
    assert!(
        !queue.result.exists(),
        "empty stale result should not strand an unclaimed abandoned job"
    );
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn abandoned_cleanup_keeps_runner_result_published_over_empty_result() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.result, b"").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    let marker = write_abandoned_result_marker(&queue.result, job_id, "local submit abandoned");
    assert!(marker.is_none());

    let runner_queue = local_queue::LocalQueue::new(group_dir.to_path_buf());
    assert!(runner_queue.write_result_sync(job_id, 0, None));

    queue.cleanup_abandoned(None);

    assert!(!queue.job.exists());
    let response: JobResponse =
        serde_json::from_slice(&std::fs::read(&queue.result).unwrap()).unwrap();
    assert_eq!(response.run_id, job_id);
    assert_eq!(response.exit_code, 0);
    assert!(response.error.is_none());
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn abandoned_cleanup_removes_unclaimed_job_when_marker_cannot_be_written() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    let result_dir = local_queue::results_dir(group_dir);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&result_dir, b"not a directory").unwrap();

    queue.abandon("timed out");

    assert!(
        !queue.job.exists(),
        "timed-out unclaimed job should not remain executable after marker write failure"
    );
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
    assert!(result_dir.is_file());
}

#[test]
fn abandoned_cleanup_keeps_completed_result() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.result, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();

    queue.abandon("timed out");

    assert!(!queue.job.exists());
    assert!(
        queue.result.exists(),
        "abandoned cleanup must not delete a non-empty result written by a runner"
    );
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn abandoned_cleanup_keeps_completed_result_when_claimed() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.result, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&queue.claim, b"").unwrap();

    queue.abandon("timed out");

    assert!(!queue.job.exists());
    assert!(queue.result.exists());
    assert!(queue.cancel.exists());
    assert!(queue.claim.exists());
}

#[test]
fn cancelled_abandon_keeps_unremoved_job_pending() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(&queue.job).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();

    std::fs::write(&queue.cancel, b"").unwrap();

    queue.abandon_cancelled();

    assert!(
        !queue.result.exists(),
        "cancelled cleanup must not publish a terminal result"
    );
    assert!(queue.cancel.exists());
    assert!(!queue.claim.exists());
}
