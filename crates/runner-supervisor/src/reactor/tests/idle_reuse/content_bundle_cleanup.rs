use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_overrides_and_api_url, push_job, shutdown,
    test_profiles, wait_idle_pool_reuse_keys,
};
use sha2::{Digest, Sha256};

#[tokio::test]
async fn content_bundle_paths_are_cleaned_after_finalization_and_exact_reuse() {
    let api = httpmock::MockServer::start_async().await;
    let first_run = RunId::new_v4();
    let next_run = RunId::new_v4();
    let mount = "/home/user/.claude/skills/retired-workflow";
    api.mock(|when, then| {
        when.method(httpmock::Method::PUT);
        then.status(204);
    });
    api.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/api/webhooks/agent/telemetry");
        then.status(200)
            .json_body(serde_json::json!({"success": true, "id": "test"}));
    });
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        8,
        32_768,
        4,
        Arc::clone(&overrides),
        &api.base_url(),
    );
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut tar = tar::Builder::new(encoder);
    let body = b"current body";
    let mut header = tar::Header::new_gnu();
    header.set_mode(0o600);
    header.set_size(body.len() as u64);
    header.set_cksum();
    tar.append_data(&mut header, "SKILL.md", body.as_slice())
        .unwrap();
    let archive = tar.into_inner().unwrap().finish().unwrap();
    let hash = hex::encode(Sha256::digest(&archive));
    let cache = config.exec_config.home.bundles_dir();
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join(format!("{hash}.tar.gz")), &archive).unwrap();
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let runner = tokio::spawn(run(config));
    let reuse_key = "content-bundle-cleanup";
    let mut first = context_with_session(first_run, reuse_key);
    first.content_bundles = serde_json::from_value(serde_json::json!({
        "format": "tar-gzip-v1", "skills": [{
            "sha256": hash, "archiveBytes": archive.len(),
            "downloadUrl": "https://unreachable.invalid/already-cached", "mountPath": mount,
        }],
    }))
    .unwrap();
    push_job(&env, first_run, "vm0/default", Some(first));
    let completed = env
        .handle
        .wait_completion(first_run, Duration::from_secs(5))
        .await
        .expect("first Workflow Run must complete");
    assert_eq!(completed.exit_code, 0, "{:?}", completed.error);
    assert!(
        overrides
            .private_write_files_calls()
            .iter()
            .flat_map(|call| &call.files)
            .any(|file| file.content == archive)
    );
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;

    let next = context_with_session(next_run, reuse_key);
    push_job(&env, next_run, "vm0/default", Some(next));
    let reused = env
        .handle
        .wait_completion(next_run, Duration::from_secs(5))
        .await
        .expect("following Run must complete");
    assert_eq!(reused.exit_code, 0, "{:?}", reused.error);
    assert_eq!(reused.sandbox_id, completed.sandbox_id);
    assert!(
        overrides.storage_manifest_calls().iter().any(|call| {
            if call.run_id != next_run.to_string() {
                return false;
            }
            let manifest: guest_contracts::storage_manifest::Manifest =
                serde_json::from_slice(&call.manifest_json).unwrap();
            manifest.cleanup_paths.iter().any(|path| path == mount)
        }),
        "the retained bundle path must be removed before the next Agent starts"
    );
    assert_eq!(overrides.start_agent_process_calls().len(), 2);
    shutdown(&env, runner).await;
}
