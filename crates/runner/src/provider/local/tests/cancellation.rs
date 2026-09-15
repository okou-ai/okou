use super::support::*;

#[tokio::test]
async fn claim_reconciles_without_waiting_for_unrelated_gate_and_wakes_watcher() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let blocked_id = RunId::new_v4();
    let claimed_id = RunId::new_v4();
    write_job(dir.path(), blocked_id, "activating");
    write_job(dir.path(), claimed_id, "claim me");
    std::fs::create_dir_all(local_queue::cancels_dir(dir.path())).unwrap();
    let blocked_marker = local_queue::cancel_path(dir.path(), blocked_id);
    let claimed_marker = local_queue::cancel_path(dir.path(), claimed_id);
    std::fs::write(&blocked_marker, b"").unwrap();
    std::fs::write(&claimed_marker, b"").unwrap();
    let provider = LocalProvider::new(
        dir.path().to_path_buf(),
        default_profiles(),
        CancellationToken::new(),
        tokens.clone(),
    );
    tokio::time::timeout(
        Duration::from_secs(2),
        provider.wait_for_cancel_scan_count(1),
    )
    .await
    .expect("initial scan should retain markers without registered handles");
    let blocked = insert_cancel_registration(&tokens, blocked_id).await;
    let guard = blocked.handle().transfer_guard().await;
    let claimed = insert_cancel_registration(&tokens, claimed_id).await;
    let candidate = JobCandidate::local(
        claimed_id,
        crate::profile::DEFAULT_PROFILE.to_owned(),
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, claimed_id).unwrap(),
    );

    let job = tokio::time::timeout(Duration::from_secs(2), provider.claim(candidate))
        .await
        .expect("claim must not wait for an unrelated cancellation gate")
        .expect("claim should succeed");
    assert_eq!(job.context().run_id, claimed_id);
    assert!(claimed.handle().is_hard_cancelled());
    assert!(!claimed_marker.exists());
    assert!(!blocked.is_cancelled());
    assert!(blocked_marker.exists());

    // No cancel file was published after the watcher's initial scan. The
    // claim's enqueue notification must wake it before the five-second timer.
    drop(guard);
    tokio::time::timeout(Duration::from_secs(2), blocked.token().cancelled())
        .await
        .expect("claim-time delivery should wake the idle watcher");
    assert!(
        blocked_marker.exists(),
        "the unrelated run is still pre-claim"
    );
    provider.shutdown().await;
}

#[tokio::test]
async fn claimed_cancelled_submit_survives_non_owner_scan() {
    let dir = tempfile::tempdir().unwrap();
    let owner_tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&owner_tokens, run_id).await;
    let job_token = registration.token();
    let signals = registration.handle().signals();
    let owner = default_provider(dir.path(), CancellationToken::new(), owner_tokens);
    write_job(dir.path(), run_id, "cancel me");
    let candidate = owner.find_unclaimed_job().unwrap();
    owner.claim(candidate).await.unwrap();

    let cancel_path = local_queue::cancel_path(dir.path(), run_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    crate::cmd::abandon_cancelled_submit_for_test(dir.path(), run_id);

    assert!(
        !local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id)
            .unwrap()
            .exists()
    );
    assert!(!local_queue::result_path(dir.path(), run_id).exists());
    assert!(local_queue::claim_path(dir.path(), run_id).exists());
    assert!(cancel_path.exists());

    let non_owner = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());
    non_owner.cancel_scanner.scan_cancel_files().await;

    assert!(cancel_path.exists());
    assert!(!job_token.is_cancelled());

    owner.cancel_scanner.scan_cancel_files().await;

    assert!(job_token.is_cancelled());
    assert!(signals.hard().is_cancelled());
    assert!(!signals.cooperative_user().is_cancelled());
    assert!(!cancel_path.exists());
}

#[tokio::test]
async fn cancel_file_triggers_token() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let tokens = empty_cancel_tokens();

    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();

    let provider = LocalProvider::new(dir.path().to_path_buf(), default_profiles(), cancel, tokens);
    provider.wait_for_cancel_scan_count(1).await;

    // Write a .cancel file and a dummy .job so discover returns.
    std::fs::create_dir_all(local_queue::cancels_dir(dir.path())).unwrap();
    std::fs::write(local_queue::cancel_path(dir.path(), run_id), b"").unwrap();
    let other_job = RunId::new_v4();
    write_job(dir.path(), other_job, "keep going");

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), other_job);
    tokio::time::timeout(Duration::from_secs(2), job_token.cancelled())
        .await
        .expect("cancel watcher should trigger token");
    provider.shutdown().await;
}

#[tokio::test]
async fn owned_cancel_file_is_deleted_after_provider_claim() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    let provider = LocalProvider::new(
        dir.path().to_path_buf(),
        default_profiles(),
        CancellationToken::new(),
        tokens,
    );
    provider.wait_for_cancel_scan_count(1).await;
    write_job(dir.path(), run_id, "owned");
    let candidate = provider.discover().await.unwrap();
    provider.claim(candidate).await.unwrap();
    let cancel_scans_before_marker = provider.cancel_scan_count();

    let cancel_path = local_queue::cancel_path(dir.path(), run_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    let other_job = RunId::new_v4();
    write_job(dir.path(), other_job, "next");

    let candidate = provider.discover().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), job_token.cancelled())
        .await
        .expect("cancel watcher should trigger token");
    provider
        .wait_for_cancel_scan_count(cancel_scans_before_marker + 1)
        .await;

    assert_eq!(candidate.run_id(), other_job);
    assert!(
        !cancel_path.exists(),
        "owned cancel file should be deleted after triggering the token"
    );
    provider.shutdown().await;
}

#[tokio::test]
async fn stale_cancel_file_is_deleted_before_provider_discovers_next_job() {
    let dir = tempfile::tempdir().unwrap();
    let provider = LocalProvider::new(
        dir.path().to_path_buf(),
        default_profiles(),
        CancellationToken::new(),
        empty_cancel_tokens(),
    );
    provider.wait_for_cancel_scan_count(1).await;
    let stale_id = RunId::new_v4();
    let cancel_path = local_queue::cancel_path(dir.path(), stale_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "still works");

    let candidate = provider.discover().await.unwrap();
    provider.wait_for_cancel_scan_count(2).await;

    assert_eq!(candidate.run_id(), job_id);
    assert!(
        !cancel_path.exists(),
        "stale cancel file should be deleted when no token, claim, or job remains"
    );
    provider.shutdown().await;
}

#[tokio::test]
async fn cancel_file_before_token_survives_until_provider_claim_token_exists() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let provider = default_provider(dir.path(), CancellationToken::new(), tokens.clone());
    let run_id = RunId::new_v4();
    let cancel_path = local_queue::cancel_path(dir.path(), run_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    write_job(dir.path(), run_id, "will be cancelled");

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), run_id);
    assert!(
        cancel_path.exists(),
        "cancel file should survive before the token is inserted"
    );

    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    provider.claim(candidate).await.unwrap();
    let other_job = RunId::new_v4();
    write_job(dir.path(), other_job, "next job");

    let candidate = provider.discover().await.unwrap();

    assert_eq!(candidate.run_id(), other_job);
    assert!(
        job_token.is_cancelled(),
        "token should be cancelled on the next provider scan"
    );
    assert!(
        !cancel_path.exists(),
        "cancel file should be deleted after this provider owns the claim"
    );
}

#[tokio::test]
async fn provider_cancel_watcher_triggers_owned_token_without_discover() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let provider = LocalProvider::new(
        dir.path().to_path_buf(),
        default_profiles(),
        CancellationToken::new(),
        tokens.clone(),
    );
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    write_job(dir.path(), run_id, "owned");
    let candidate = provider.discover().await.unwrap();
    provider.claim(candidate).await.unwrap();

    let cancel_path = local_queue::cancel_path(dir.path(), run_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::write(&cancel_path, b"").unwrap();

    tokio::time::timeout(Duration::from_secs(2), job_token.cancelled())
        .await
        .expect("provider cancel watcher should trigger token");
    provider.shutdown().await;
}
