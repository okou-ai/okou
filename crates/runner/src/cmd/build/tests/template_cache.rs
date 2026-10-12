use super::fixtures::*;
use super::*;

use aws_smithy_mocks::mock;
use bytes::Bytes;
use http_body::{Body, Frame};
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::layer::SubscriberExt;
use tracing_test_support::CapturedEvents;

struct NeverEndsBody {
    bytes: Option<Bytes>,
    blocked: Arc<Notify>,
}

impl Body for NeverEndsBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if let Some(bytes) = self.bytes.take() {
            return Poll::Ready(Some(Ok(Frame::data(bytes))));
        }
        self.blocked.notify_one();
        Poll::Pending
    }
}

#[tokio::test]
async fn cached_template_materializes_while_template_writer_is_active() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "independent-cache-reader");
    let get = template_get_rule(template_archive_bytes(b"independent-reader").await);
    let cache = mock_r2_cache(&[&get]);
    let input = template_input(&home, TemplateCache::BestEffort(&cache));
    let _writer = lock::acquire(home.template_lock(input.template_hash))
        .await
        .unwrap();
    let (mut scripts, work_dir) = fake_rootfs_scripts().await;

    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        obtain_template_to_staging(&input, &rootfs, &mut scripts),
    )
    .await
    .expect("an independent cached reader must not queue behind the template writer")
    .unwrap();
    let mut output = tokio::fs::File::open(rootfs.rootfs_staging())
        .await
        .unwrap();
    let mut prefix = [0u8; 18];
    output.read_exact(&mut prefix).await.unwrap();
    assert_eq!(&prefix, b"independent-reader");
    assert!(!work_dir.join("build-template-called").exists());
    assert_eq!(get.num_calls(), 1);
}

#[tokio::test]
async fn missing_template_rechecks_repaired_object_after_writer_finishes() {
    use aws_sdk_s3::{
        Client,
        operation::get_object::{GetObjectError, GetObjectOutput},
        types::error::NoSuchKey,
    };

    let dir = tempfile::tempdir().unwrap();
    let home = Arc::new(HomePaths::with_root(dir.path().to_path_buf()));
    let _writer = lock::acquire(home.template_lock("test-template-hash"))
        .await
        .unwrap();
    let observed_miss = Arc::new(Notify::new());
    let observed_for_rule = Arc::clone(&observed_miss);
    let archive = Bytes::from(template_archive_bytes(b"repaired-template").await);
    let lock_path = home.template_lock("test-template-hash");
    let get = mock!(Client::get_object)
        .sequence()
        .error(move || {
            observed_for_rule.notify_one();
            GetObjectError::NoSuchKey(NoSuchKey::builder().build())
        })
        .output(move || {
            assert!(
                matches!(
                    lock::try_acquire_or_busy_blocking(&lock_path).unwrap(),
                    lock::TryLock::Busy
                ),
                "repair recheck must own the template write lock"
            );
            GetObjectOutput::builder()
                .body(aws_sdk_s3::primitives::ByteStream::from(archive.clone()))
                .build()
        })
        .build();
    let cache = mock_r2_cache(&[&get]);
    let rootfs = RootfsPaths::new(&home, "repaired-cache-reader");
    let staging = rootfs.rootfs_staging();
    let (mut scripts, work_dir) = fake_rootfs_scripts().await;
    let transfer = tokio::spawn(async move {
        let input = template_input(&home, TemplateCache::BestEffort(&cache));
        obtain_template_to_staging(&input, &rootfs, &mut scripts).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), observed_miss.notified())
        .await
        .unwrap();
    drop(_writer);
    tokio::time::timeout(std::time::Duration::from_secs(5), transfer)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let mut output = tokio::fs::File::open(staging).await.unwrap();
    let mut prefix = [0u8; 17];
    output.read_exact(&mut prefix).await.unwrap();
    assert_eq!(&prefix, b"repaired-template");
    assert!(!work_dir.join("build-template-called").exists());
    assert_eq!(get.num_calls(), 2);
}

#[tokio::test]
async fn transfer_deadline_is_fatal_without_rebuild_or_remote_overwrite() {
    use aws_sdk_s3::{Client, operation::get_object::GetObjectOutput, primitives::ByteStream};

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "deadline-rootfs");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    let staging = rootfs.rootfs_staging();
    tokio::fs::write(&staging, b"existing-output")
        .await
        .unwrap();
    let blocked = Arc::new(Notify::new());
    let blocked_for_rule = Arc::clone(&blocked);
    let archive = Bytes::from(template_archive_bytes(b"downloaded-template").await);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from_body_1_x(NeverEndsBody {
                bytes: Some(archive.clone()),
                blocked: Arc::clone(&blocked_for_rule),
            }))
            .build()
    });
    let cache = mock_r2_cache(&[&get]);
    let input = template_input(&home, TemplateCache::BestEffort(&cache));
    let (_scripts, work_dir) = fake_rootfs_scripts().await;
    let attempt_dir = rootfs.dir().join("attempt.tmp");
    let transfer = materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RootfsStaging(&staging),
    );
    tokio::pin!(transfer);
    tokio::select! {
        _ = blocked.notified() => {},
        result = &mut transfer => panic!("expected a pending response body: {result:?}"),
    }
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(8 * 60)).await;
    tokio::time::resume();
    let error = tokio::time::timeout(std::time::Duration::from_secs(5), transfer)
        .await
        .unwrap()
        .unwrap_err();
    assert!(
        error.to_string().contains("transfer deadline exceeded"),
        "{error}"
    );
    assert_eq!(tokio::fs::read(&staging).await.unwrap(), b"existing-output");
    assert!(!work_dir.join("build-template-called").exists());
    assert_eq!(get.num_calls(), 1);
}

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
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    materialize_template_from_r2_or_build(
        &input,
        &attempt_dir,
        &work_dir,
        TemplateMaterializationTarget::RootfsStaging(&staging),
    )
    .with_subscriber(subscriber)
    .await
    .unwrap();

    let events = captured.entries();
    let downloads = events
        .iter()
        .filter(|event| {
            event.fields.get("message").is_some_and(|message| {
                message.starts_with("[OK] template downloaded from R2 into staging:")
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(downloads.len(), 1);
    assert_eq!(downloads[0].level, tracing::Level::INFO);
    assert_eq!(
        downloads[0].fields.get("r2_key").map(String::as_str),
        Some("runner-templates/test-template-hash.tar.zst")
    );
    assert!(
        events.iter().all(
            |event| event.level == tracing::Level::INFO || !event.fields.contains_key("r2_key")
        )
    );

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
