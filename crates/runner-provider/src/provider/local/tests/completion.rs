use super::support::*;

#[tokio::test]
async fn complete_cleans_up_cancel_file() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let run_id = RunId::new_v4();
    let cancel_path = local_queue::cancel_path(dir.path(), run_id);
    let claim_path = local_queue::claim_path(dir.path(), run_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    std::fs::write(&claim_path, b"").unwrap();

    provider
        .complete(complete_request(run_id, 0, None), CompletionAuth::local())
        .await;

    assert!(
        !cancel_path.exists(),
        "complete() should clean up cancel file"
    );
    assert!(
        !claim_path.exists(),
        "complete() should clean up claim file"
    );
}

#[tokio::test]
async fn complete_removes_duplicate_job_files_across_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let run_id = RunId::new_v4();
    write_job_in_partition(
        dir.path(),
        crate::profile::DEFAULT_PROFILE,
        run_id,
        "default",
        Some(crate::profile::DEFAULT_PROFILE),
    );
    write_job_in_partition(dir.path(), "vm0/large", run_id, "large", Some("vm0/large"));
    let default_job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    let large_job_path = local_queue::job_path(dir.path(), "vm0/large", run_id).unwrap();

    provider
        .complete(complete_request(run_id, 0, None), CompletionAuth::local())
        .await;

    assert!(
        !default_job_path.exists(),
        "complete() should remove the default profile duplicate"
    );
    assert!(
        !large_job_path.exists(),
        "complete() should remove the large profile duplicate"
    );
}

#[tokio::test]
async fn complete_result_failure_removes_job_before_claim() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let run_id = RunId::new_v4();
    let job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    let claim_path = local_queue::claim_path(dir.path(), run_id);
    let cancel_path = local_queue::cancel_path(dir.path(), run_id);
    let result_dir = local_queue::results_dir(dir.path());
    std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();

    std::fs::write(&job_path, b"{}").unwrap();
    std::fs::write(&claim_path, b"").unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    std::fs::write(&result_dir, b"not a directory").unwrap();

    provider
        .complete(complete_request(run_id, 0, None), CompletionAuth::local())
        .await;

    assert!(
        !job_path.exists(),
        "job must be removed before releasing claim when result write fails"
    );
    assert!(
        !claim_path.exists(),
        "claim can be released after the job is no longer retryable"
    );
    assert!(
        !cancel_path.exists(),
        "cancel file should not be stranded after terminal cleanup"
    );
}

#[tokio::test]
async fn complete_result_failure_removes_duplicate_jobs_before_claim() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let run_id = RunId::new_v4();
    write_job_in_partition(
        dir.path(),
        crate::profile::DEFAULT_PROFILE,
        run_id,
        "default",
        Some(crate::profile::DEFAULT_PROFILE),
    );
    write_job_in_partition(dir.path(), "vm0/large", run_id, "large", Some("vm0/large"));
    let default_job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    let large_job_path = local_queue::job_path(dir.path(), "vm0/large", run_id).unwrap();
    let claim_path = local_queue::claim_path(dir.path(), run_id);
    let cancel_path = local_queue::cancel_path(dir.path(), run_id);
    let result_dir = local_queue::results_dir(dir.path());
    std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::write(&claim_path, b"").unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    std::fs::write(&result_dir, b"not a directory").unwrap();

    provider
        .complete(complete_request(run_id, 0, None), CompletionAuth::local())
        .await;

    assert!(
        !default_job_path.exists(),
        "default duplicate must be removed"
    );
    assert!(!large_job_path.exists(), "large duplicate must be removed");
    assert!(
        !claim_path.exists(),
        "claim can be released after all duplicate jobs are no longer retryable"
    );
    assert!(
        !cancel_path.exists(),
        "cancel file should not be stranded after terminal cleanup"
    );
}

#[tokio::test]
async fn complete_result_failure_keeps_state_when_job_scan_fails() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let run_id = RunId::new_v4();
    let claim_path = local_queue::claim_path(dir.path(), run_id);
    let cancel_path = local_queue::cancel_path(dir.path(), run_id);
    let result_dir = local_queue::results_dir(dir.path());
    std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();

    std::fs::write(&claim_path, b"").unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    std::fs::write(&result_dir, b"not a directory").unwrap();
    std::fs::write(local_queue::jobs_dir(dir.path()), b"not a directory").unwrap();

    provider
        .complete(complete_request(run_id, 0, None), CompletionAuth::local())
        .await;

    assert!(
        claim_path.exists(),
        "claim should stay when job-file cleanup cannot verify retry state"
    );
    assert!(
        cancel_path.exists(),
        "cancel file should stay when job-file cleanup cannot verify retry state"
    );
}
