use super::support::*;

#[tokio::test]
async fn discover_returns_profile_from_job() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job_with_profile(dir.path(), job_id, "profiled job", Some("vm0/default"));

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job_id);
    assert_eq!(candidate.profile_name(), "vm0/default");
}

#[tokio::test]
async fn discover_and_claim_defaults_profile_when_missing() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job_in_partition(
        dir.path(),
        crate::profile::DEFAULT_PROFILE,
        job_id,
        "default job",
        None,
    );

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job_id);
    assert_eq!(candidate.profile_name(), crate::profile::DEFAULT_PROFILE);
    assert!(provider.claim(candidate).await.is_some());
}

#[tokio::test]
async fn unsupported_profile_partition_is_not_discovered_or_claimed() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let unsupported = RunId::new_v4();
    let supported = RunId::new_v4();
    write_job_with_profile(dir.path(), unsupported, "large", Some("vm0/large"));
    write_job(dir.path(), supported, "default");

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), supported);
    assert!(!local_queue::claim_path(dir.path(), unsupported).exists());
    assert!(!local_queue::result_path(dir.path(), unsupported).exists());
}

#[tokio::test]
async fn provider_for_non_default_profile_discovers_and_claims_that_partition() {
    let dir = tempfile::tempdir().unwrap();
    let provider = provider_with_profiles(
        dir.path(),
        &["vm0/large"],
        CancellationToken::new(),
        empty_cancel_tokens(),
    );

    let job_id = RunId::new_v4();
    write_job_with_profile(dir.path(), job_id, "large", Some("vm0/large"));

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job_id);
    assert_eq!(candidate.profile_name(), "vm0/large");
    assert!(provider.claim(candidate).await.is_some());
}

#[test]
fn multi_profile_scan_rotates_start_profile() {
    let dir = tempfile::tempdir().unwrap();
    let provider = provider_with_profiles(
        dir.path(),
        &[crate::profile::DEFAULT_PROFILE, "vm0/large"],
        CancellationToken::new(),
        empty_cancel_tokens(),
    );

    let default_id = RunId::new_v4();
    let large_id = RunId::new_v4();
    write_job(dir.path(), default_id, "default");
    write_job_with_profile(dir.path(), large_id, "large", Some("vm0/large"));

    let first = provider.find_unclaimed_job().unwrap();
    let second = provider.find_unclaimed_job().unwrap();
    assert_eq!(first.run_id(), default_id);
    assert_eq!(second.run_id(), large_id);
}
