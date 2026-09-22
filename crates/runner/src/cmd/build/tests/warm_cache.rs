use super::fixtures::*;
use super::*;

use aws_smithy_mocks::mock;

#[tokio::test]
async fn warm_cache_download_request_failure_is_fatal() {
    use aws_sdk_s3::Client;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let get = mock!(Client::get_object)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let cache = mock_r2_cache(&[&get]);
    let input = template_input(&home, TemplateCache::Required(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = home.images_dir().join("warm-attempt.tmp");

    let err = materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RemoteCacheOnly,
    )
    .await
    .unwrap_err();

    assert!(
        err.to_string()
            .contains("R2 template download failed while template cache is required"),
        "got {err}"
    );
    assert!(
        !work_dir.join("build-template-called").exists(),
        "required download failure must fail before local rebuild"
    );
}

#[tokio::test]
async fn warm_cache_existing_remote_uses_head_without_download_or_build() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let head = mock!(Client::head_object)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/test-template-hash.tar.zst")
        })
        .then_output(|| HeadObjectOutput::builder().build());
    let cache = mock_r2_cache(&[&head]);
    let input = template_input(&home, TemplateCache::Required(&cache));

    let guard = std::sync::Arc::new(
        lock::acquire(home.template_lock(input.template_hash))
            .await
            .unwrap(),
    );
    ensure_template_cached_under_lock(&input, guard)
        .await
        .unwrap();

    assert_eq!(head.num_calls(), 1);
    assert!(
        !template_warm_parent_dir(&home, "test-template-hash").exists(),
        "warm cache hit should not create local template staging"
    );
}

#[tokio::test]
async fn warm_cache_head_hit_cleans_stale_local_attempts() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let warm_parent = template_warm_parent_dir(&home, "test-template-hash");
    let stale_attempt = template_attempt_dir(&warm_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
    tokio::fs::create_dir_all(&stale_attempt).await.unwrap();
    tokio::fs::write(stale_attempt.join(TEMPLATE_FILE), b"stale")
        .await
        .unwrap();
    let head = mock!(Client::head_object)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/test-template-hash.tar.zst")
        })
        .then_output(|| HeadObjectOutput::builder().build());
    let cache = mock_r2_cache(&[&head]);
    let input = template_input(&home, TemplateCache::Required(&cache));

    let guard = std::sync::Arc::new(
        lock::acquire(home.template_lock(input.template_hash))
            .await
            .unwrap(),
    );
    ensure_template_cached_under_lock(&input, guard)
        .await
        .unwrap();

    assert_eq!(head.num_calls(), 1);
    assert!(
        !warm_parent.exists(),
        "warm HEAD hit must still clean stale local warm attempt residue"
    );
}

#[tokio::test]
async fn warm_cache_head_request_failure_is_fatal() {
    use aws_sdk_s3::Client;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let head = mock!(Client::head_object)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let cache = mock_r2_cache(&[&head]);
    let input = template_input(&home, TemplateCache::Required(&cache));

    let guard = std::sync::Arc::new(
        lock::acquire(home.template_lock(input.template_hash))
            .await
            .unwrap(),
    );
    let err = ensure_template_cached_under_lock(&input, guard)
        .await
        .unwrap_err();

    assert!(
        err.to_string()
            .contains("R2 template HEAD failed while warming cache"),
        "got {err}"
    );
    assert!(
        !template_warm_parent_dir(&home, "test-template-hash").exists(),
        "warm cache should fail before local template staging when HEAD fails"
    );
}

#[tokio::test]
async fn warm_cache_miss_builds_and_uploads_after_head_miss() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let head = template_head_miss_rule();
    let get = template_get_miss_rule();
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_r2_cache(&[&head, &get, &create, &upload_part, &complete]);
    let input = template_input(&home, TemplateCache::Required(&cache));
    let (mut scripts, _work_dir) = fake_rootfs_scripts().await;

    ensure_template_cached_under_lock_with_scripts(&input, &mut scripts)
        .await
        .unwrap();

    assert!(
        head.num_calls() >= 2,
        "warm miss should HEAD for warm preflight and upload dedup"
    );
    assert_eq!(get.num_calls(), 1);
    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
    assert!(
        !template_warm_parent_dir(&home, "test-template-hash").exists(),
        "successful warm miss should clean local template staging"
    );
}

#[tokio::test]
async fn warm_cache_head_miss_uses_template_uploaded_by_another_runner() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let head = template_head_miss_rule();
    let get = template_get_rule(template_archive_bytes(b"concurrent-template").await);
    let cache = mock_r2_cache(&[&head, &get]);
    let input = template_input(&home, TemplateCache::Required(&cache));
    let (mut scripts, work_dir) = fake_rootfs_scripts().await;

    ensure_template_cached_under_lock_with_scripts(&input, &mut scripts)
        .await
        .unwrap();

    assert_eq!(head.num_calls(), 1);
    assert_eq!(get.num_calls(), 1);
    assert!(
        !work_dir.join("build-template-called").exists(),
        "warm should not build locally when another runner uploaded after HEAD miss"
    );
    assert!(
        !template_warm_parent_dir(&home, "test-template-hash").exists(),
        "successful concurrent-upload warm should clean local template staging"
    );
}

#[tokio::test]
async fn warm_cache_upload_failure_is_fatal() {
    use aws_sdk_s3::Client;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let get = template_get_miss_rule();
    let head = mock!(Client::head_object)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let cache = mock_r2_cache(&[&get, &head]);
    let input = template_input(&home, TemplateCache::Required(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = home.images_dir().join("warm-attempt.tmp");

    let err = materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RemoteCacheOnly,
    )
    .await
    .unwrap_err();

    assert!(
        err.to_string()
            .contains("R2 upload failed while template cache is required"),
        "got {err}"
    );
    assert!(work_dir.join("build-template-called").exists());
    assert!(
        head.num_calls() >= 1,
        "SDK may retry upload preflight failures before returning required error"
    );
}

#[tokio::test]
async fn warm_cache_invalid_remote_object_force_overwrites_r2() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let get = template_get_rule(empty_template_archive_bytes().await);
    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_r2_cache(&[&get, &head, &create, &upload_part, &complete]);
    let input = template_input(&home, TemplateCache::Required(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = home.images_dir().join("warm-attempt.tmp");

    materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RemoteCacheOnly,
    )
    .await
    .unwrap();

    assert!(work_dir.join("build-template-called").exists());
    assert_eq!(
        head.num_calls(),
        0,
        "invalid remote object must force upload and skip head"
    );
    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

#[test]
fn warm_template_attempt_dir_stays_on_runner_image_volume() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let images_dir = home.images_dir();
    let warm_parent = template_warm_parent_dir(&home, "abc123");

    let warm_dir = template_attempt_dir(&warm_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
    let file_name = warm_dir.file_name().and_then(|name| name.to_str()).unwrap();

    assert!(warm_dir.starts_with(&images_dir));
    assert!(warm_dir.starts_with(&warm_parent));
    assert!(!is_template_attempt_dir_name(
        file_name,
        TEMPLATE_BUILD_DIR_PREFIX
    ));
    assert!(is_template_attempt_dir_name(
        file_name,
        TEMPLATE_WARM_ATTEMPT_DIR_PREFIX
    ));
}

#[tokio::test]
async fn template_warm_cleanup_removes_empty_parent() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let parent = template_warm_parent_dir(&home, "abc123");
    let attempt = template_attempt_dir(&parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
    tokio::fs::create_dir_all(&attempt).await.unwrap();

    finish_template_warm_dir_result(&parent, &attempt, Ok(()))
        .await
        .unwrap();

    assert!(!attempt.exists());
    assert!(
        !parent.exists(),
        "successful warm cleanup should not leave empty parent dirs"
    );
}

#[tokio::test]
async fn template_warm_cleanup_preserves_original_error_when_parent_cleanup_fails() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("not-a-dir");
    let attempt = parent.join("attempt");
    tokio::fs::write(&parent, b"file").await.unwrap();

    let err = finish_template_warm_dir_result(
        &parent,
        &attempt,
        Err(RunnerError::Internal("warm failed".into())),
    )
    .await
    .unwrap_err();

    assert!(err.to_string().contains("warm failed"));
}

#[tokio::test]
async fn template_warm_parent_cleanup_removes_stale_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let parent = template_warm_parent_dir(&home, "abc123");
    tokio::fs::create_dir_all(home.images_dir()).await.unwrap();
    tokio::fs::write(&parent, b"not a directory").await.unwrap();

    cleanup_template_warm_parent(&parent).await.unwrap();

    assert!(
        !parent.exists(),
        "malformed warm parent file must not block later warm attempts"
    );
}
