use super::support::*;

#[tokio::test]
async fn claim_attaches_active_input_source_when_requested() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job_with_active_input(dir.path(), job_id, "hello with active input");

    let candidate = provider.discover().await.unwrap();
    let claimed = provider.claim(candidate).await.unwrap();

    assert!(matches!(
        claimed.active_input_source(),
        Some(crate::active_input::ActiveInputSource::LocalQueue(source))
            if source.run_id == job_id && source.queue.group_dir() == dir.path()
    ));
}

#[tokio::test]
async fn claim_maps_secret_environment_into_context_and_masking() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job_with_environments(
        dir.path(),
        job_id,
        Some(HashMap::from([
            ("ANTHROPIC_MODEL".into(), "claude-haiku-4-5".into()),
            ("CUSTOM_RUNNER_KEY".into(), "ordinary-user-value".into()),
        ])),
        Some(HashMap::from([
            ("ANTHROPIC_API_KEY".into(), "sk-ant-local-secret".into()),
            ("CUSTOM_SECRET".into(), "ordinary-user-secret".into()),
        ])),
    );

    let candidate = provider.discover().await.unwrap();
    let claimed = provider.claim(candidate).await.unwrap();
    let ctx = claimed.context();
    let environment = ctx.environment.as_ref().unwrap();
    let secret_values = ctx.secret_values.as_ref().unwrap();
    let local_secret_env_keys = ctx.local_secret_env_keys.as_ref().unwrap();

    assert!(ctx.platform_environment.is_empty());
    assert_eq!(
        environment.get("ANTHROPIC_MODEL").map(String::as_str),
        Some("claude-haiku-4-5")
    );
    assert_eq!(
        environment.get("ANTHROPIC_API_KEY").map(String::as_str),
        Some("sk-ant-local-secret")
    );
    assert_eq!(
        environment.get("CUSTOM_RUNNER_KEY").map(String::as_str),
        Some("ordinary-user-value")
    );
    assert_eq!(
        environment.get("CUSTOM_SECRET").map(String::as_str),
        Some("ordinary-user-secret")
    );
    assert_eq!(secret_values.len(), 2);
    assert!(
        secret_values
            .iter()
            .any(|value| value == "sk-ant-local-secret")
    );
    assert!(
        secret_values
            .iter()
            .any(|value| value == "ordinary-user-secret")
    );
    assert!(local_secret_env_keys.contains("ANTHROPIC_API_KEY"));
    assert!(local_secret_env_keys.contains("CUSTOM_SECRET"));
}

#[tokio::test]
async fn claim_releases_claim_when_result_already_exists() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "already done");
    let candidate = JobCandidate::local(
        job_id,
        crate::profile::DEFAULT_PROFILE.to_owned(),
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, job_id).unwrap(),
    );
    assert!(provider.write_result(job_id, 0, None));

    assert!(provider.claim(candidate).await.is_none());
    assert!(
        !local_queue::claim_path(dir.path(), job_id).exists(),
        "claim attempt on an already-completed job must not strand a claim"
    );
}

/// Regression: if the job file is missing when claim() reads it, the
/// .claim file must be removed so the job doesn't get stranded forever.
#[tokio::test]
async fn claim_cleans_up_on_missing_job_file() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let run_id = RunId::new_v4();
    let claim_path = local_queue::claim_path(dir.path(), run_id);
    let job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    let candidate =
        JobCandidate::local(run_id, crate::profile::DEFAULT_PROFILE.to_owned(), job_path);

    // No .job file — claim() should fail at the read step.
    assert!(provider.claim(candidate).await.is_none());
    assert!(
        !claim_path.exists(),
        "claim file must be removed when job read fails"
    );
}

#[tokio::test]
async fn claim_marks_unreadable_job_path_failed() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let run_id = RunId::new_v4();
    let claim_path = local_queue::claim_path(dir.path(), run_id);
    let job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    let result_path = local_queue::result_path(dir.path(), run_id);
    std::fs::create_dir_all(&job_path).unwrap();
    let candidate = JobCandidate::local(
        run_id,
        crate::profile::DEFAULT_PROFILE.to_owned(),
        job_path.clone(),
    );

    assert!(provider.claim(candidate).await.is_none());

    assert!(!claim_path.exists(), "claim file must be removed");
    assert!(
        result_path.exists(),
        "unreadable job path should produce a terminal result"
    );
    let result = read_result(dir.path(), run_id);
    assert_ne!(result.exit_code, 0);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|e| e.contains("failed to read job file"))
    );
    assert!(
        provider.find_unclaimed_job().is_none(),
        "terminal result should stop rediscovery of the unreadable path"
    );
}

/// Malformed .job is a permanent error (submit writes atomically, so it
/// can't be "half-written"). claim() must delete the .job + .claim and
/// write a .result so the submitter unblocks and discover stops returning
/// the poisoned job on every scan.
#[tokio::test]
async fn claim_handles_poison_job_json() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let run_id = RunId::new_v4();
    let claim_path = local_queue::claim_path(dir.path(), run_id);
    let job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    let result_path = local_queue::result_path(dir.path(), run_id);
    std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
    std::fs::write(&job_path, b"not json").unwrap();
    let candidate = JobCandidate::local(
        run_id,
        crate::profile::DEFAULT_PROFILE.to_owned(),
        job_path.clone(),
    );

    assert!(provider.claim(candidate).await.is_none());

    assert!(!claim_path.exists(), "claim file must be removed");
    assert!(!job_path.exists(), "poison job file must be removed");
    assert!(
        result_path.exists(),
        ".result must be written for submitter"
    );

    let buf = std::fs::read(&result_path).unwrap();
    let resp: JobResponse = serde_json::from_slice(&buf).unwrap();
    assert_eq!(resp.run_id, run_id);
    assert_ne!(resp.exit_code, 0, "poison must report non-zero exit");
    assert!(
        resp.error
            .as_deref()
            .is_some_and(|e| e.contains("invalid job JSON")),
        "error must mention invalid JSON, got: {:?}",
        resp.error
    );

    // Next discover() scan must not re-surface the job.
    assert!(provider.find_unclaimed_job().is_none());
}

#[tokio::test]
async fn claim_terminally_fails_oversized_sparse_job() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());
    let run_id = RunId::new_v4();
    let profile = crate::profile::DEFAULT_PROFILE;
    let job_path = local_queue::job_path(dir.path(), profile, run_id).unwrap();
    local_queue::ensure_profile_jobs_dir(dir.path(), profile).unwrap();
    local_queue::write_private_file(&job_path, b"", "oversized sparse test job").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&job_path)
        .unwrap()
        .set_len((local_queue::LOCAL_JOB_MAX_BYTES as u64) * 64)
        .unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), run_id);
    assert_eq!(candidate.reuse_key(), None);
    assert!(provider.claim(candidate).await.is_none());

    assert!(!job_path.exists(), "oversized job file must be removed");
    assert!(
        !local_queue::claim_path(dir.path(), run_id).exists(),
        "claim marker must be released after terminal failure"
    );
    let result = read_result(dir.path(), run_id);
    assert_ne!(result.exit_code, 0);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|error| error.contains(&format!(
                "exceeds {} bytes",
                local_queue::LOCAL_JOB_MAX_BYTES
            ))),
        "oversized job result must report the protocol limit, got: {:?}",
        result.error
    );
    assert!(
        provider.find_unclaimed_job().is_none(),
        "terminal result must prevent oversized job rediscovery"
    );
}

#[tokio::test]
async fn claim_failure_removes_duplicate_job_files_across_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let provider = provider_with_profiles(
        dir.path(),
        &[crate::profile::DEFAULT_PROFILE, "vm0/large"],
        CancellationToken::new(),
        empty_cancel_tokens(),
    );

    let run_id = RunId::new_v4();
    let default_job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    std::fs::create_dir_all(default_job_path.parent().unwrap()).unwrap();
    std::fs::write(&default_job_path, b"not json").unwrap();
    write_job_in_partition(
        dir.path(),
        "vm0/large",
        run_id,
        "large duplicate",
        Some("vm0/large"),
    );
    let large_job_path = local_queue::job_path(dir.path(), "vm0/large", run_id).unwrap();

    let candidate = provider.discover().await.unwrap();
    assert!(provider.claim(candidate).await.is_none());

    assert!(
        !default_job_path.exists(),
        "claim failure should remove the poisoned job"
    );
    assert!(
        !large_job_path.exists(),
        "claim failure should remove duplicate jobs for the same run id"
    );
    assert!(
        provider.find_unclaimed_job().is_none(),
        "terminal result should stop duplicate rediscovery"
    );
}

#[tokio::test]
async fn claim_rejects_job_id_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let filename_id = RunId::new_v4();
    let request_id = RunId::new_v4();
    write_job_in_partition(
        dir.path(),
        crate::profile::DEFAULT_PROFILE,
        request_id,
        "mismatch",
        Some(crate::profile::DEFAULT_PROFILE),
    );
    let request_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, request_id).unwrap();
    let job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, filename_id).unwrap();
    std::fs::rename(&request_path, &job_path).unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), filename_id);
    assert!(provider.claim(candidate).await.is_none());

    assert!(
        !local_queue::claim_path(dir.path(), filename_id).exists(),
        "claim file must be removed after rejecting mismatched job"
    );
    assert!(
        !job_path.exists(),
        "mismatched job file must be removed after terminal result"
    );
    let result = read_result(dir.path(), filename_id);
    assert_ne!(result.exit_code, 0);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|e| e.contains("job id mismatch"))
    );
    assert!(
        !local_queue::result_path(dir.path(), request_id).exists(),
        "the embedded request id must not receive the result"
    );
}

#[tokio::test]
async fn claim_rejects_missing_profile_in_non_default_partition() {
    let dir = tempfile::tempdir().unwrap();
    let provider = provider_with_profiles(
        dir.path(),
        &["vm0/large"],
        CancellationToken::new(),
        empty_cancel_tokens(),
    );

    let run_id = RunId::new_v4();
    write_job_in_partition(dir.path(), "vm0/large", run_id, "missing", None);

    let candidate = provider.discover().await.unwrap();
    assert!(provider.claim(candidate).await.is_none());
    let result = read_result(dir.path(), run_id);
    assert_ne!(result.exit_code, 0);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|e| e.contains("missing job profile"))
    );
}

#[tokio::test]
async fn claim_rejects_profile_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let provider = provider_with_profiles(
        dir.path(),
        &["vm0/large"],
        CancellationToken::new(),
        empty_cancel_tokens(),
    );

    let run_id = RunId::new_v4();
    write_job_in_partition(
        dir.path(),
        "vm0/large",
        run_id,
        "mismatch",
        Some(crate::profile::DEFAULT_PROFILE),
    );

    let candidate = provider.discover().await.unwrap();
    assert!(provider.claim(candidate).await.is_none());
    let result = read_result(dir.path(), run_id);
    assert_ne!(result.exit_code, 0);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|e| e.contains("job profile mismatch"))
    );
}
