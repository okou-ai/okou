use std::collections::HashMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::*;

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

fn ctime(path: &Path) -> (i64, i64) {
    let metadata = std::fs::metadata(path).unwrap();
    (metadata.ctime(), metadata.ctime_nsec())
}

fn write_job_request(group_dir: &Path, run_id: RunId, profile: &str) -> PathBuf {
    let job_path = super::super::job_path(group_dir, profile, run_id).unwrap();
    std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
    let request = JobRequest {
        job_id: run_id,
        prompt: "secret prompt".into(),
        cli_agent_type: "claude-code".into(),
        vars: None,
        environment: None,
        secret_environment: None,
        user_timezone: None,
        profile: Some(profile.to_owned()),
        reuse_key: None,
        session_id: Some("session-123".into()),
        feature_flags: None,
        active_input: None,
    };
    std::fs::write(&job_path, serde_json::to_vec(&request).unwrap()).unwrap();
    job_path
}

fn write_cancel_marker(group_dir: &Path, run_id: RunId) -> PathBuf {
    let cancel_path = super::super::cancel_path(group_dir, run_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    cancel_path
}

fn run_id(raw: &str) -> RunId {
    raw.parse().unwrap()
}

fn collect_marker_states(queue: &LocalQueue) -> HashMap<RunId, CancelTargetState> {
    queue
        .collect_cancel_markers_sync()
        .into_iter()
        .map(|marker| (marker.run_id, marker.target_state))
        .collect()
}

fn assert_marker_state(
    states: &HashMap<RunId, CancelTargetState>,
    run_id: RunId,
    expected: CancelTargetState,
) {
    assert_eq!(states.get(&run_id), Some(&expected));
}

#[test]
fn write_result_sync_creates_private_result_file() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();

    assert!(queue.write_result_sync(run_id, 1, Some("sensitive error")));

    assert_eq!(mode(&super::super::results_dir(group_dir)), 0o700);
    assert_eq!(mode(&super::super::result_path(group_dir, run_id)), 0o600);
}

#[test]
fn write_result_sync_tightens_existing_permissive_result_dir() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let result_dir = super::super::results_dir(group_dir);
    std::fs::create_dir_all(&result_dir).unwrap();
    std::fs::set_permissions(&result_dir, std::fs::Permissions::from_mode(0o1755)).unwrap();
    let queue = LocalQueue::new(group_dir.to_path_buf());

    assert!(queue.write_result_sync(RunId::new_v4(), 0, None));

    assert_eq!(mode(&result_dir), 0o700);
}

#[test]
fn claim_job_sync_creates_private_claim_file() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let profile = crate::profile::DEFAULT_PROFILE;
    let job_path = write_job_request(group_dir, run_id, profile);

    let claim = queue.claim_job_sync(run_id, profile, &job_path);

    assert!(matches!(claim, LocalClaimResult::Claimed { .. }));
    assert_eq!(mode(&super::super::claims_dir(group_dir)), 0o700);
    assert_eq!(mode(&super::super::claim_path(group_dir, run_id)), 0o600);
}

#[test]
fn active_input_write_creates_private_files_and_reads_requested_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    write_job_request(group_dir, run_id, crate::profile::DEFAULT_PROFILE);
    let entry_10 = ActiveInputEntry {
        run_id,
        sequence: 10,
        text: "ten".to_string(),
    };
    let entry_2 = ActiveInputEntry {
        run_id,
        sequence: 2,
        text: "two".to_string(),
    };

    queue.write_active_input_sync(&entry_10).unwrap();
    queue.write_active_input_sync(&entry_2).unwrap();

    assert_eq!(mode(&super::super::inputs_dir(group_dir)), 0o700);
    assert_eq!(
        mode(&super::super::run_inputs_dir(group_dir, run_id)),
        0o700
    );
    assert_eq!(
        mode(&super::super::active_input_path(group_dir, run_id, 2)),
        0o600
    );
    assert_eq!(queue.read_active_input_entry_sync(run_id, 2), Some(entry_2));
    assert_eq!(
        queue.read_active_input_entry_sync(run_id, 10),
        Some(entry_10)
    );
}

#[test]
fn active_input_read_ignores_malformed_or_mismatched_files() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    write_job_request(group_dir, run_id, crate::profile::DEFAULT_PROFILE);
    let other_run_id = RunId::new_v4();
    let valid = ActiveInputEntry {
        run_id,
        sequence: 1,
        text: "one".to_string(),
    };
    queue.write_active_input_sync(&valid).unwrap();
    let run_dir = super::super::run_inputs_dir(group_dir, run_id);
    std::fs::write(run_dir.join("00000000000000000002.json"), b"not-json").unwrap();
    std::fs::write(
        run_dir.join("00000000000000000003.json"),
        serde_json::to_vec(&ActiveInputEntry {
            run_id: other_run_id,
            sequence: 3,
            text: "wrong run".to_string(),
        })
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        run_dir.join("00000000000000000004.json"),
        serde_json::to_vec(&ActiveInputEntry {
            run_id,
            sequence: 5,
            text: "wrong sequence".to_string(),
        })
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        run_dir.join("00000000000000000005.json"),
        serde_json::to_vec(&ActiveInputEntry {
            run_id,
            sequence: 5,
            text: String::new(),
        })
        .unwrap(),
    )
    .unwrap();

    assert_eq!(queue.read_active_input_entry_sync(run_id, 1), Some(valid));
    for sequence in 2..=5 {
        assert_eq!(queue.read_active_input_entry_sync(run_id, sequence), None);
    }
}

#[test]
fn active_input_read_does_not_skip_missing_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    write_job_request(group_dir, run_id, crate::profile::DEFAULT_PROFILE);
    let entry_1 = ActiveInputEntry {
        run_id,
        sequence: 1,
        text: "one".to_string(),
    };
    let entry_3 = ActiveInputEntry {
        run_id,
        sequence: 3,
        text: "three".to_string(),
    };
    queue.write_active_input_sync(&entry_1).unwrap();
    queue.write_active_input_sync(&entry_3).unwrap();

    assert_eq!(queue.read_active_input_entry_sync(run_id, 0), None);
    assert_eq!(queue.read_active_input_entry_sync(run_id, 1), Some(entry_1));
    assert_eq!(queue.read_active_input_entry_sync(run_id, 2), None);
    assert_eq!(queue.read_active_input_entry_sync(run_id, 3), Some(entry_3));
}

#[test]
fn active_input_write_rejects_duplicate_sequence_without_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    write_job_request(group_dir, run_id, crate::profile::DEFAULT_PROFILE);
    let original = ActiveInputEntry {
        run_id,
        sequence: 1,
        text: "one".to_string(),
    };
    let duplicate = ActiveInputEntry {
        run_id,
        sequence: 1,
        text: "duplicate".to_string(),
    };

    queue.write_active_input_sync(&original).unwrap();
    let error = queue.write_active_input_sync(&duplicate).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(
        queue.read_active_input_entry_sync(run_id, 1),
        Some(original)
    );
}

#[test]
fn active_input_write_rejects_zero_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let queue = LocalQueue::new(dir.path().to_path_buf());

    let error = queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id: RunId::new_v4(),
            sequence: 0,
            text: "zero".to_string(),
        })
        .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
}

#[test]
fn active_input_write_rejects_terminal_result_with_retained_job() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let job_path = write_job_request(group_dir, run_id, crate::profile::DEFAULT_PROFILE);
    assert!(queue.write_result_sync(run_id, 0, None));

    let error = queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 1,
            text: "late".to_string(),
        })
        .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert!(job_path.exists());
    assert!(!super::super::inputs_dir(group_dir).exists());
}

#[test]
fn active_input_write_rejects_missing_job_despite_retained_claim() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    super::super::ensure_claims_dir(group_dir).unwrap();
    let claim_path = super::super::claim_path(group_dir, run_id);
    super::super::write_private_marker(&claim_path, "test claim").unwrap();

    let error = queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 1,
            text: "late".to_string(),
        })
        .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert!(claim_path.exists());
    assert!(!super::super::inputs_dir(group_dir).exists());
}

#[test]
fn active_input_write_rejects_unreadable_result_state() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    write_job_request(group_dir, run_id, crate::profile::DEFAULT_PROFILE);
    let result_path = super::super::result_path(group_dir, run_id);
    std::fs::create_dir_all(&result_path).unwrap();

    let error = queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 1,
            text: "follow-up".to_string(),
        })
        .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    assert!(result_path.is_dir());
    assert!(!super::super::inputs_dir(group_dir).exists());
}

#[test]
fn active_input_write_rejects_failed_job_scan() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    std::fs::write(super::super::jobs_dir(group_dir), b"not a directory").unwrap();

    let error = queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 1,
            text: "follow-up".to_string(),
        })
        .unwrap_err();

    assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
    assert!(!super::super::inputs_dir(group_dir).exists());
}

#[test]
fn active_input_write_does_not_create_missing_group() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().join("missing-group");
    let queue = LocalQueue::new(group_dir.clone());

    let error = queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id: RunId::new_v4(),
            sequence: 1,
            text: "late".to_string(),
        })
        .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert!(!group_dir.exists());
}

#[test]
fn active_input_cleanup_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    write_job_request(group_dir, run_id, crate::profile::DEFAULT_PROFILE);
    queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 1,
            text: "one".to_string(),
        })
        .unwrap();

    queue.cleanup_active_inputs_sync(run_id);
    queue.cleanup_active_inputs_sync(run_id);

    assert!(!super::super::run_inputs_dir(group_dir, run_id).exists());
}

#[test]
fn active_input_cleanup_waits_for_admitted_publication_and_removes_it() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().to_path_buf();
    let run_id = RunId::new_v4();
    let publication_guard = super::super::fs::lock_active_inputs(&group_dir).unwrap();
    let cleanup_queue = LocalQueue::new(group_dir.clone());
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let cleanup = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        cleanup_queue.cleanup_active_inputs_sync(run_id);
        done_tx.send(()).unwrap();
    });

    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
    let entry = ActiveInputEntry {
        run_id,
        sequence: 1,
        text: "published while cleanup waits".to_string(),
    };
    let run_dir = super::super::ensure_run_inputs_dir(&group_dir, run_id).unwrap();
    super::super::write_private_file(
        &run_dir.join("00000000000000000001.json"),
        &serde_json::to_vec(&entry).unwrap(),
        "local active-input file",
    )
    .unwrap();

    drop(publication_guard);
    done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    cleanup.join().unwrap();
    assert!(!super::super::run_inputs_dir(&group_dir, run_id).exists());
}

#[test]
fn fail_claimed_job_sync_cleans_active_inputs_after_terminal_result() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let profile = crate::profile::DEFAULT_PROFILE;
    let job_path = write_job_request(group_dir, run_id, profile);
    queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 1,
            text: "one".to_string(),
        })
        .unwrap();

    queue.fail_claimed_job_sync(run_id, "failed before execution".to_string());

    assert!(queue.result_file_has_content(run_id));
    assert!(!job_path.exists());
    assert!(!super::super::run_inputs_dir(group_dir, run_id).exists());
}

#[test]
fn active_input_cleanup_does_not_follow_inputs_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().join("group");
    let target_dir = dir.path().join("target");
    let run_id = RunId::new_v4();
    std::fs::create_dir_all(&group_dir).unwrap();
    std::fs::create_dir_all(&target_dir).unwrap();
    let target_file = target_dir.join(run_id.to_string());
    std::fs::write(&target_file, b"do not delete").unwrap();
    symlink(&target_dir, super::super::inputs_dir(&group_dir)).unwrap();

    LocalQueue::new(group_dir).cleanup_active_inputs_sync(run_id);

    assert!(target_file.exists());
}

#[test]
fn discover_candidate_skips_job_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let profile = crate::profile::DEFAULT_PROFILE;
    let job_path = super::super::job_path(group_dir, profile, run_id).unwrap();
    std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-job");
    std::fs::write(&target, b"{}").unwrap();
    symlink(&target, &job_path).unwrap();

    assert!(
        queue
            .discover_candidate_sync(&[profile.to_owned()], 0)
            .is_none(),
        "job symlinks must not be discovered"
    );
}

#[test]
fn claim_job_sync_rejects_job_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let profile = crate::profile::DEFAULT_PROFILE;

    // Prove the same bytes are claimable without a symlink. Use a separate
    // queue so the successful control's claim cannot mask the rejection.
    let regular_group_dir = dir.path().join("regular");
    let regular_job_path = write_job_request(&regular_group_dir, run_id, profile);
    let job_bytes = std::fs::read(&regular_job_path).unwrap();
    assert!(matches!(
        LocalQueue::new(regular_group_dir).claim_job_sync(run_id, profile, &regular_job_path),
        LocalClaimResult::Claimed { .. }
    ));

    let group_dir = dir.path().join("symlink");
    let queue = LocalQueue::new(group_dir.clone());
    let job_path = super::super::job_path(&group_dir, profile, run_id).unwrap();
    std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-job");
    std::fs::write(&target, &job_bytes).unwrap();
    symlink(&target, &job_path).unwrap();

    let claim = queue.claim_job_sync(run_id, profile, &job_path);

    assert!(matches!(claim, LocalClaimResult::NotClaimed));
    let response: JobResponse = serde_json::from_slice(
        &std::fs::read(super::super::result_path(&group_dir, run_id)).unwrap(),
    )
    .unwrap();
    assert_eq!(response.run_id, run_id);
    assert_eq!(response.exit_code, 1);
    assert!(
        response
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("failed to read job file:")),
        "symlink rejection must be a read failure, got {:?}",
        response.error
    );
    assert_eq!(
        std::fs::symlink_metadata(&job_path).unwrap_err().kind(),
        std::io::ErrorKind::NotFound,
        "failed symlink jobs should be removed after terminal result write"
    );
    assert_eq!(
        std::fs::symlink_metadata(super::super::claim_path(&group_dir, run_id))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound,
        "failed symlink jobs should release their claim"
    );
    assert_eq!(std::fs::read(&target).unwrap(), job_bytes);
}

#[test]
fn discover_candidate_skips_occupied_claim_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let profile = crate::profile::DEFAULT_PROFILE;
    write_job_request(group_dir, run_id, profile);
    let claims_dir = super::super::claims_dir(group_dir);
    std::fs::create_dir_all(&claims_dir).unwrap();
    let target = dir.path().join("target-claim");
    std::fs::write(&target, b"").unwrap();
    symlink(&target, super::super::claim_path(group_dir, run_id)).unwrap();

    assert!(
        queue
            .discover_candidate_sync(&[profile.to_owned()], 0)
            .is_none(),
        "an occupied claim path should be skipped because claim create_new cannot win it"
    );
}

#[test]
fn discover_candidate_skips_dangling_claim_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let profile = crate::profile::DEFAULT_PROFILE;
    write_job_request(group_dir, run_id, profile);
    let claims_dir = super::super::claims_dir(group_dir);
    std::fs::create_dir_all(&claims_dir).unwrap();
    symlink(
        dir.path().join("missing-target-claim"),
        super::super::claim_path(group_dir, run_id),
    )
    .unwrap();

    assert!(
        queue
            .discover_candidate_sync(&[profile.to_owned()], 0)
            .is_none(),
        "a dangling claim symlink should still occupy the atomic claim path"
    );
}

#[test]
fn discover_candidate_returns_first_eligible_job_in_lexicographic_order() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let profile = crate::profile::DEFAULT_PROFILE;
    let claimed = run_id("00000000-0000-0000-0000-000000000001");
    let completed = run_id("00000000-0000-0000-0000-000000000002");
    let eligible = run_id("00000000-0000-0000-0000-000000000003");
    let later = run_id("00000000-0000-0000-0000-000000000004");

    write_job_request(group_dir, later, profile);
    let eligible_path = write_job_request(group_dir, eligible, profile);
    write_job_request(group_dir, completed, profile);
    write_job_request(group_dir, claimed, profile);

    let profile_dir = super::super::profile_jobs_dir(group_dir, profile).unwrap();
    std::fs::write(
        profile_dir.join("00000000-0000-0000-0000-000000000000x.job"),
        b"{}",
    )
    .unwrap();
    std::fs::create_dir_all(super::super::claims_dir(group_dir)).unwrap();
    std::fs::write(super::super::claim_path(group_dir, claimed), b"").unwrap();
    assert!(queue.write_result_sync(completed, 0, None));

    let candidate = queue
        .discover_candidate_sync(&[profile.to_owned()], 0)
        .expect("eligible job should be discovered");

    assert_eq!(candidate.run_id, eligible);
    assert_eq!(candidate.job_path, eligible_path);
}

#[test]
fn discover_candidate_removes_completed_leftover_job() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let profile = crate::profile::DEFAULT_PROFILE;
    let completed = run_id("00000000-0000-0000-0000-000000000001");
    let eligible = run_id("00000000-0000-0000-0000-000000000002");
    let completed_path = write_job_request(group_dir, completed, profile);
    let eligible_path = write_job_request(group_dir, eligible, profile);
    assert!(queue.write_result_sync(completed, 0, None));

    let candidate = queue
        .discover_candidate_sync(&[profile.to_owned()], 0)
        .expect("eligible job should be discovered after completed leftover");

    assert_eq!(candidate.run_id, eligible);
    assert_eq!(candidate.job_path, eligible_path);
    assert!(
        !completed_path.exists(),
        "completed leftover job should be removed during discovery"
    );
    assert!(
        queue.result_file_has_content(completed),
        "discovery must not remove the terminal result"
    );
}

#[test]
fn discover_candidate_keeps_empty_result_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let profile = crate::profile::DEFAULT_PROFILE;
    let run_id = run_id("00000000-0000-0000-0000-000000000001");
    let job_path = write_job_request(group_dir, run_id, profile);
    let result_path = super::super::result_path(group_dir, run_id);
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    std::fs::write(&result_path, b"").unwrap();

    let candidate = queue
        .discover_candidate_sync(&[profile.to_owned()], 0)
        .expect("empty result should leave the job retryable");

    assert_eq!(candidate.run_id, run_id);
    assert_eq!(candidate.job_path, job_path);
    assert!(job_path.exists());
}

#[test]
fn discover_candidate_keeps_result_symlink_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let profile = crate::profile::DEFAULT_PROFILE;
    let run_id = run_id("00000000-0000-0000-0000-000000000001");
    let job_path = write_job_request(group_dir, run_id, profile);
    let result_path = super::super::result_path(group_dir, run_id);
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-result");
    std::fs::write(&target, b"terminal").unwrap();
    symlink(&target, &result_path).unwrap();

    let candidate = queue
        .discover_candidate_sync(&[profile.to_owned()], 0)
        .expect("result symlink should leave the job retryable");

    assert_eq!(candidate.run_id, run_id);
    assert_eq!(candidate.job_path, job_path);
    assert!(job_path.exists());
}

#[test]
fn discover_candidate_uses_snapshot_for_large_ineligible_queue() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let profile = crate::profile::DEFAULT_PROFILE;
    let mut completed_paths = Vec::new();
    let eligible = run_id(&format!(
        "00000000-0000-0000-0000-{:012x}",
        DISCOVERY_SNAPSHOT_CANDIDATE_THRESHOLD + 1
    ));
    let eligible_path = write_job_request(group_dir, eligible, profile);
    std::fs::create_dir_all(super::super::claims_dir(group_dir)).unwrap();

    for index in (1..=DISCOVERY_SNAPSHOT_CANDIDATE_THRESHOLD).rev() {
        let run_id = run_id(&format!("00000000-0000-0000-0000-{index:012x}"));
        let job_path = write_job_request(group_dir, run_id, profile);
        if index % 2 == 0 {
            assert!(queue.write_result_sync(run_id, 0, None));
            completed_paths.push(job_path);
        } else {
            std::fs::write(super::super::claim_path(group_dir, run_id), b"").unwrap();
        }
    }

    let candidate = queue
        .discover_candidate_sync(&[profile.to_owned()], 0)
        .expect("eligible job should be discovered after snapshot skips");

    assert_eq!(candidate.run_id, eligible);
    assert_eq!(candidate.job_path, eligible_path);
    for path in completed_paths {
        assert!(
            !path.exists(),
            "completed snapshot candidates should be cleaned up"
        );
    }
}

#[test]
fn discover_candidate_falls_back_when_snapshot_claim_dir_is_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let profile = crate::profile::DEFAULT_PROFILE;
    let claimed = run_id("00000000-0000-0000-0000-000000000001");
    let eligible = run_id("00000000-0000-0000-0000-000000000002");
    let target_claims_dir = dir.path().join("target-claims");
    std::fs::create_dir_all(&target_claims_dir).unwrap();
    std::fs::write(target_claims_dir.join(format!("{claimed}.claim")), b"").unwrap();
    symlink(&target_claims_dir, super::super::claims_dir(group_dir)).unwrap();

    for index in 1..=DISCOVERY_SNAPSHOT_CANDIDATE_THRESHOLD + 1 {
        let run_id = run_id(&format!("00000000-0000-0000-0000-{index:012x}"));
        write_job_request(group_dir, run_id, profile);
    }

    let candidate = queue
        .discover_candidate_sync(&[profile.to_owned()], 0)
        .expect("fallback should still discover an eligible job");

    assert_eq!(candidate.run_id, eligible);
}

#[test]
fn collect_cancel_markers_keeps_private_cancel_dir_ctime() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let cancel_dir = super::super::ensure_cancels_dir(group_dir).unwrap();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let before = ctime(&cancel_dir);
    // Separate filesystem clock ticks so an unexpected chmod changes the observed ctime.
    std::thread::sleep(Duration::from_millis(20));

    assert!(queue.collect_cancel_markers_sync().is_empty());

    assert_eq!(ctime(&cancel_dir), before);
}

#[test]
fn collect_cancel_markers_ignores_claim_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let claims_dir = super::super::claims_dir(group_dir);
    std::fs::create_dir_all(&claims_dir).unwrap();
    let target = dir.path().join("target-claim");
    std::fs::write(&target, b"").unwrap();
    symlink(&target, super::super::claim_path(group_dir, run_id)).unwrap();
    write_cancel_marker(group_dir, run_id);

    let states = collect_marker_states(&queue);

    assert_marker_state(&states, run_id, CancelTargetState::NotPending);
}

#[test]
fn result_file_has_content_ignores_result_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let result_path = super::super::result_path(group_dir, run_id);
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-result");
    std::fs::write(&target, b"terminal").unwrap();
    symlink(&target, &result_path).unwrap();

    assert!(
        !queue.result_file_has_content(run_id),
        "result symlinks must not be treated as terminal markers"
    );
}

#[test]
fn collect_cancel_markers_ignores_result_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let profile = crate::profile::DEFAULT_PROFILE;
    write_job_request(group_dir, run_id, profile);
    let result_path = super::super::result_path(group_dir, run_id);
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-result");
    std::fs::write(&target, b"terminal").unwrap();
    symlink(&target, &result_path).unwrap();
    write_cancel_marker(group_dir, run_id);

    let states = collect_marker_states(&queue);

    assert_marker_state(&states, run_id, CancelTargetState::Pending);
}

#[test]
fn collect_cancel_markers_resolves_batch_job_presence_across_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let default_job = RunId::new_v4();
    let large_job = RunId::new_v4();
    let missing = RunId::new_v4();
    let terminal = RunId::new_v4();
    let claimed = RunId::new_v4();

    write_job_request(group_dir, default_job, crate::profile::DEFAULT_PROFILE);
    write_job_request(group_dir, large_job, "vm0/large");
    write_job_request(group_dir, terminal, crate::profile::DEFAULT_PROFILE);
    assert!(queue.write_result_sync(terminal, 0, None));
    std::fs::create_dir_all(super::super::claims_dir(group_dir)).unwrap();
    std::fs::write(super::super::claim_path(group_dir, claimed), b"").unwrap();

    for run_id in [default_job, large_job, missing, terminal, claimed] {
        write_cancel_marker(group_dir, run_id);
    }

    let states = collect_marker_states(&queue);

    assert_marker_state(&states, default_job, CancelTargetState::Pending);
    assert_marker_state(&states, large_job, CancelTargetState::Pending);
    assert_marker_state(&states, missing, CancelTargetState::NotPending);
    assert_marker_state(&states, terminal, CancelTargetState::NotPending);
    assert_marker_state(&states, claimed, CancelTargetState::Pending);
}

#[test]
fn collect_cancel_markers_keeps_unresolved_targets_unknown_when_job_scan_fails() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    write_cancel_marker(group_dir, run_id);
    std::fs::write(super::super::jobs_dir(group_dir), b"not a directory").unwrap();

    let states = collect_marker_states(&queue);

    assert_marker_state(&states, run_id, CancelTargetState::Unknown);
}

#[test]
fn batch_job_lookup_preserves_found_targets_when_later_path_stat_fails() {
    let dir = tempfile::tempdir().unwrap();
    let found_run_id = RunId::new_v4();
    let unresolved_run_id = RunId::new_v4();
    let profile_dir = dir.path().join("profile");
    std::fs::create_dir(&profile_dir).unwrap();
    std::fs::write(profile_dir.join(format!("{found_run_id}.job")), b"{}").unwrap();
    let not_a_profile_dir = dir.path().join("not-a-profile-dir");
    std::fs::write(&not_a_profile_dir, b"not a directory").unwrap();

    let scan = lookup_job_files_in_profile_dirs(
        &[found_run_id, unresolved_run_id],
        &[profile_dir, not_a_profile_dir],
        true,
    );

    assert_eq!(scan.target_state(found_run_id), CancelTargetState::Pending);
    assert_eq!(
        scan.target_state(unresolved_run_id),
        CancelTargetState::Unknown
    );
}

#[test]
fn collect_cancel_markers_ignores_job_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let job_path =
        super::super::job_path(group_dir, crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-job");
    std::fs::write(&target, b"{}").unwrap();
    symlink(&target, &job_path).unwrap();
    write_cancel_marker(group_dir, run_id);

    let states = collect_marker_states(&queue);

    assert_marker_state(&states, run_id, CancelTargetState::NotPending);
}

#[test]
fn collect_cancel_markers_ignores_unrelated_job_filenames() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let unrelated_run_id = RunId::new_v4();
    let profile_dir =
        super::super::profile_jobs_dir(group_dir, crate::profile::DEFAULT_PROFILE).unwrap();
    std::fs::create_dir_all(&profile_dir).unwrap();
    std::fs::write(profile_dir.join("not-a-run-id.job"), b"{}").unwrap();
    std::fs::write(profile_dir.join(format!("{unrelated_run_id}.job")), b"{}").unwrap();
    write_cancel_marker(group_dir, run_id);

    let states = collect_marker_states(&queue);

    assert_marker_state(&states, run_id, CancelTargetState::NotPending);
}

#[test]
fn collect_cancel_markers_ignores_cancel_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let queue = LocalQueue::new(group_dir.to_path_buf());
    let run_id = RunId::new_v4();
    let cancel_path = super::super::cancel_path(group_dir, run_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    let target = dir.path().join("target-cancel");
    std::fs::write(&target, b"").unwrap();
    symlink(&target, &cancel_path).unwrap();

    assert!(queue.collect_cancel_markers_sync().is_empty());
}

#[test]
fn collect_cancel_markers_rejects_cancel_dir_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path().join("group");
    std::fs::create_dir(&group_dir).unwrap();
    let target = dir.path().join("target-cancels");
    std::fs::create_dir(&target).unwrap();
    let run_id = RunId::new_v4();
    std::fs::write(target.join(format!("{run_id}.cancel")), b"").unwrap();
    symlink(&target, super::super::cancels_dir(&group_dir)).unwrap();
    let queue = LocalQueue::new(group_dir);

    assert!(queue.collect_cancel_markers_sync().is_empty());
}
