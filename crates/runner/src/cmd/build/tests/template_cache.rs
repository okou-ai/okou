use super::fixtures::*;
use super::*;

use aws_smithy_mocks::mock;
use tokio::io::AsyncReadExt;

#[tokio::test]
async fn best_effort_upload_allows_missing_r2_cache() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let template = dir.path().join(TEMPLATE_FILE);
    tokio::fs::write(&template, b"template").await.unwrap();
    let input = TemplateInput {
        paths: &home,
        template_hash: "best-effort-hash",
        cache: TemplateCache::Disabled,
        rootfs_disk_mb: 8192,
    };

    upload_template_to_r2(&input, &template, false)
        .await
        .unwrap();
}

#[tokio::test]
async fn full_image_r2_hit_materializes_without_local_build() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "r2-hit-rootfs");
    let archive = template_archive_bytes(b"downloaded-template").await;
    let get = template_get_rule(archive);
    let cache = mock_r2_cache(&[&get]);
    let input = template_input(&home, TemplateCache::BestEffort(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = rootfs.dir().join("attempt.tmp");
    let staging = rootfs.rootfs_staging();

    materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RootfsStaging(&staging),
    )
    .await
    .unwrap();

    let mut downloaded = tokio::fs::File::open(&staging).await.unwrap();
    let mut prefix = vec![0u8; b"downloaded-template".len()];
    downloaded.read_exact(&mut prefix).await.unwrap();
    assert_eq!(prefix, b"downloaded-template");
    assert_eq!(
        downloaded.metadata().await.unwrap().len(),
        TEST_TEMPLATE_DISK_BYTES
    );
    assert!(
        !work_dir.join("build-template-called").exists(),
        "valid R2 hit must not rebuild locally"
    );
    assert_eq!(get.num_calls(), 1);
}

#[tokio::test]
async fn full_image_download_request_failure_falls_back_to_local_build() {
    use aws_sdk_s3::Client;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "r2-download-fallback-rootfs");
    let get = mock!(Client::get_object)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let head = template_head_miss_rule();
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_r2_cache(&[&get, &head, &create, &upload_part, &complete]);
    let input = template_input(&home, TemplateCache::BestEffort(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = rootfs.dir().join("attempt.tmp");
    let staging = rootfs.rootfs_staging();

    materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RootfsStaging(&staging),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&staging).await.unwrap(), b"built-template");
    assert!(work_dir.join("build-template-called").exists());
    assert!(
        get.num_calls() >= 1,
        "SDK may retry request failures before best-effort fallback"
    );
    assert_eq!(head.num_calls(), 1, "force=false should consult head");
    assert_eq!(create.num_calls(), 1);
}

#[tokio::test]
async fn full_image_body_read_failure_uses_deduplicated_fallback() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "r2-body-read-fallback-rootfs");
    let archive = template_archive_bytes(b"downloaded-template").await;
    let get = template_get_body_error_rule(archive[..archive.len() / 2].to_vec());
    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let cache = mock_r2_cache(&[&get, &head]);
    let input = template_input(&home, TemplateCache::BestEffort(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = rootfs.dir().join("attempt.tmp");
    let staging = rootfs.rootfs_staging();

    materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RootfsStaging(&staging),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&staging).await.unwrap(), b"built-template");
    assert!(work_dir.join("build-template-called").exists());
    assert_eq!(get.num_calls(), 1);
    assert_eq!(
        head.num_calls(),
        1,
        "request failure must use deduplicated upload instead of force-overwriting R2"
    );
}

#[tokio::test]
async fn full_image_upload_failure_is_nonfatal_after_cache_miss() {
    use aws_sdk_s3::Client;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "r2-upload-best-effort-rootfs");
    let get = template_get_miss_rule();
    let head = mock!(Client::head_object)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let cache = mock_r2_cache(&[&get, &head]);
    let input = template_input(&home, TemplateCache::BestEffort(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = rootfs.dir().join("attempt.tmp");
    let staging = rootfs.rootfs_staging();

    materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RootfsStaging(&staging),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&staging).await.unwrap(), b"built-template");
    assert!(
        head.num_calls() >= 1,
        "SDK may retry upload preflight failures before best-effort fallback"
    );
}

#[tokio::test]
async fn full_image_invalid_remote_object_force_overwrites_r2() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "r2-invalid-rootfs");
    let get = template_get_rule(empty_template_archive_bytes().await);
    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_r2_cache(&[&get, &head, &create, &upload_part, &complete]);
    let input = template_input(&home, TemplateCache::BestEffort(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = rootfs.dir().join("attempt.tmp");
    let staging = rootfs.rootfs_staging();

    materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RootfsStaging(&staging),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&staging).await.unwrap(), b"built-template");
    assert_eq!(
        head.num_calls(),
        0,
        "invalid remote object must force upload and skip head"
    );
    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

#[tokio::test]
async fn full_image_failed_downloaded_template_verification_does_not_publish_bad_template() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "r2-verify-failed-rootfs");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs_staging(), b"old-staging")
        .await
        .unwrap();
    let get = template_get_rule(template_archive_bytes(b"verify-fail").await);
    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_r2_cache(&[&get, &head, &create, &upload_part, &complete]);
    let input = template_input(&home, TemplateCache::BestEffort(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = rootfs.dir().join("attempt.tmp");
    let staging = rootfs.rootfs_staging();

    materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RootfsStaging(&staging),
    )
    .await
    .unwrap();

    assert_eq!(
        tokio::fs::read(&staging).await.unwrap(),
        b"built-template",
        "failed downloaded verification must rebuild instead of publishing the bad file"
    );
    assert_eq!(
        head.num_calls(),
        0,
        "verification failure must force upload"
    );
    assert_eq!(create.num_calls(), 1);
}

#[test]
fn template_cache_full_image_can_run_without_r2() {
    let cache = TemplateCache::from_optional(BuildMode::FullImage, None).unwrap();

    assert!(cache.is_disabled());
}
