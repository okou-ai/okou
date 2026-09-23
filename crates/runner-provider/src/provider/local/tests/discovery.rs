use super::support::*;

#[tokio::test]
async fn discover_claim_complete() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "hello world");
    let job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, job_id).unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job_id);
    assert_eq!(candidate.profile_name(), crate::profile::DEFAULT_PROFILE);

    let claimed = provider.claim(candidate).await.unwrap();
    assert!(claimed.active_input_source().is_none());
    let ctx = claimed.context();
    assert_eq!(ctx.run_id, job_id);
    assert_eq!(ctx.prompt, "hello world");

    provider
        .complete(complete_request(job_id, 0, None), CompletionAuth::local())
        .await;

    let resp = read_result(dir.path(), job_id);
    assert_eq!(resp.exit_code, 0);
    assert!(resp.error.is_none());
    assert!(
        !job_path.exists(),
        "complete() should remove the completed local job file"
    );
}

#[tokio::test]
async fn discover_carries_reuse_metadata_before_claim() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());
    let job_id = RunId::new_v4();
    let reuse_key = "thread:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    write_job_with_reuse_metadata(
        dir.path(),
        job_id,
        "continue",
        Some(reuse_key),
        Some("session-123"),
    );

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.reuse_key(), Some(reuse_key));

    let claimed = provider.claim(candidate).await.unwrap();
    assert_eq!(
        claimed.context().cli_agent_session_id(),
        Some("session-123")
    );
    assert_eq!(claimed.context().reuse_key(), Some(reuse_key));
}

#[tokio::test]
async fn session_only_job_resumes_without_reuse_key() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());
    let job_id = RunId::new_v4();

    write_job_with_session(dir.path(), job_id, "continue cold", "session-123");

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.reuse_key(), None);

    let claimed = provider.claim(candidate).await.unwrap();
    assert_eq!(
        claimed.context().cli_agent_session_id(),
        Some("session-123")
    );
    assert_eq!(claimed.context().reuse_key(), None);
}

#[tokio::test]
async fn reuse_key_is_available_before_a_session_exists() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());
    let job_id = RunId::new_v4();
    let reuse_key = "thread:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    write_job_with_reuse_metadata(dir.path(), job_id, "start warm", Some(reuse_key), None);

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.reuse_key(), Some(reuse_key));

    let claimed = provider.claim(candidate).await.unwrap();
    assert_eq!(claimed.context().cli_agent_session_id(), None);
    assert_eq!(claimed.context().reuse_key(), Some(reuse_key));
}

#[tokio::test]
async fn shutdown_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel.clone(), empty_cancel_tokens());

    cancel.cancel();
    assert!(provider.discover().await.is_none());
}

#[tokio::test]
async fn atomic_job_publication_wakes_idle_discovery() {
    let dir = tempfile::tempdir().unwrap();
    local_queue::ensure_profile_jobs_dir(dir.path(), crate::profile::DEFAULT_PROFILE).unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());
    let discover = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.discover().await })
    };
    provider.wait_for_job_scan_count(1).await;

    let job_id = RunId::new_v4();
    write_job_atomically(dir.path(), job_id, "published after idle");

    let candidate = tokio::time::timeout(Duration::from_secs(2), discover)
        .await
        .expect("job publication should wake discovery")
        .unwrap()
        .unwrap();
    assert_eq!(candidate.run_id(), job_id);
    assert_eq!(provider.job_scan_count(), 2);
}

#[tokio::test(start_paused = true)]
async fn idle_provider_scans_only_at_reconciliation_bound() {
    let dir = tempfile::tempdir().unwrap();
    local_queue::ensure_profile_jobs_dir(dir.path(), crate::profile::DEFAULT_PROFILE).unwrap();
    let cancel = CancellationToken::new();
    let provider = LocalProvider::new(
        dir.path().to_path_buf(),
        default_profiles(),
        cancel.clone(),
        empty_cancel_tokens(),
    );
    let discover = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.discover().await })
    };
    provider.wait_for_job_scan_count(1).await;
    provider.wait_for_cancel_scan_count(1).await;
    tokio::task::yield_now().await;
    let initial_job_scans = provider.job_scan_count();
    let initial_cancel_scans = provider.cancel_scan_count();

    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(provider.job_scan_count(), initial_job_scans);
    assert_eq!(provider.cancel_scan_count(), initial_cancel_scans);

    tokio::time::advance(RECONCILE_INTERVAL - Duration::from_secs(1)).await;
    provider
        .wait_for_job_scan_count(initial_job_scans + 1)
        .await;
    provider
        .wait_for_cancel_scan_count(initial_cancel_scans + 1)
        .await;

    cancel.cancel();
    assert!(discover.await.unwrap().is_none());
    provider.shutdown().await;
}

#[tokio::test]
async fn skips_already_claimed_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job1 = RunId::new_v4();
    let job2 = RunId::new_v4();
    write_job(dir.path(), job1, "claimed");
    write_job(dir.path(), job2, "available");
    std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
    std::fs::write(local_queue::claim_path(dir.path(), job1), b"").unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job2);
}

#[test]
fn skips_jobs_with_existing_result() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "already done");
    assert!(provider.write_result(job_id, 0, None));

    assert!(
        provider.find_unclaimed_job().is_none(),
        "a durable result should prevent a completed job from being rediscovered"
    );
}

#[test]
fn ignores_tmp_and_invalid_job_files() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let profile_dir =
        local_queue::profile_jobs_dir(dir.path(), crate::profile::DEFAULT_PROFILE).unwrap();
    std::fs::create_dir_all(&profile_dir).unwrap();
    std::fs::write(
        profile_dir.join(format!("{}.job.tmp", RunId::new_v4())),
        b"{}",
    )
    .unwrap();
    std::fs::write(profile_dir.join("not-a-run-id.job"), b"{}").unwrap();

    assert!(
        provider.find_unclaimed_job().is_none(),
        "tmp and invalid job files must not be discovered"
    );
}

#[tokio::test]
async fn empty_result_does_not_hide_retryable_job() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "retry me");
    let result_path = local_queue::result_path(dir.path(), job_id);
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    std::fs::write(&result_path, b"").unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job_id);
    let claimed = provider.claim(candidate).await.unwrap();
    let ctx = claimed.context();
    assert_eq!(ctx.prompt, "retry me");

    provider
        .complete(complete_request(job_id, 0, None), CompletionAuth::local())
        .await;
    let resp = read_result(dir.path(), job_id);
    assert_eq!(resp.exit_code, 0);
}

#[tokio::test]
async fn concurrent_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job1 = RunId::new_v4();
    let job2 = RunId::new_v4();
    write_job(dir.path(), job1, "job1");

    let candidate1 = provider.discover().await.unwrap();
    let run_id1 = candidate1.run_id();
    let claimed1 = provider.claim(candidate1).await.unwrap();
    let ctx1 = claimed1.context();
    assert_eq!(ctx1.prompt, "job1");

    write_job(dir.path(), job2, "job2");

    let candidate2 = provider.discover().await.unwrap();
    let run_id2 = candidate2.run_id();
    let claimed2 = provider.claim(candidate2).await.unwrap();
    let ctx2 = claimed2.context();
    assert_eq!(ctx2.prompt, "job2");
    assert_ne!(run_id1, run_id2);

    provider
        .complete(complete_request(run_id1, 0, None), CompletionAuth::local())
        .await;
    provider
        .complete(
            complete_request(run_id2, 1, Some("test error")),
            CompletionAuth::local(),
        )
        .await;

    let resp1 = read_result(dir.path(), job1);
    assert_eq!(resp1.exit_code, 0);
    assert!(resp1.error.is_none());

    let resp2 = read_result(dir.path(), job2);
    assert_eq!(resp2.exit_code, 1);
    assert_eq!(resp2.error.as_deref(), Some("test error"));
}

#[tokio::test]
async fn large_ineligible_queue_discovers_and_claims_eligible_job() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());
    std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();

    for index in 1..=40 {
        let run_id: RunId = format!("00000000-0000-0000-0000-{index:012x}")
            .parse()
            .unwrap();
        write_job(dir.path(), run_id, &format!("job {index}"));
        if index < 40 {
            if index % 2 == 0 {
                assert!(provider.write_result(run_id, 0, None));
            } else {
                std::fs::write(local_queue::claim_path(dir.path(), run_id), b"").unwrap();
            }
        }
    }
    let expected_run_id: RunId = "00000000-0000-0000-0000-000000000028".parse().unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), expected_run_id);

    let claimed = provider.claim(candidate).await.unwrap();
    let ctx = claimed.context();
    assert_eq!(ctx.run_id, expected_run_id);
    assert_eq!(ctx.prompt, "job 40");
}

#[tokio::test]
async fn group_claim_only_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();

    let tokens = empty_cancel_tokens();
    let provider_a = default_provider(dir.path(), cancel.clone(), tokens.clone());
    let provider_b = default_provider(dir.path(), cancel, tokens);

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "shared");

    let candidate_a = provider_a.discover().await.unwrap();
    let candidate_b = provider_b.discover().await.unwrap();
    assert_eq!(candidate_a.run_id(), job_id);
    assert_eq!(candidate_b.run_id(), job_id);

    let claim_a = provider_a.claim(candidate_a).await;
    let claim_b = provider_b.claim(candidate_b).await;

    assert!(
        claim_a.is_some() ^ claim_b.is_some(),
        "exactly one runner should win the claim"
    );
}
